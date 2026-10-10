// LAN party file share. No dependencies: run with `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream');
const { crc32 } = require('zlib');

const PORT = Number(process.env.PORT) || 8080;
const SHARE_DIR = path.join(__dirname, 'shared');
const INCOMING_DIR = path.join(__dirname, 'incoming'); // partial uploads, moved into SHARE_DIR when complete
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const CHAT_FILE = path.join(__dirname, 'chat.jsonl'); // one message per line, kept forever
const MODS_FILE = path.join(__dirname, 'mods.json');
const POIS_FILE = path.join(__dirname, 'pois.json');
const RELEASES_FILE = path.join(__dirname, 'releases.json');
const INSTALLER_DIR = 'Mods Installer'; // folder inside shared/ that holds one subfolder per installer version
const CHUNK = 1 << 20; // 1 MB stream buffers for faster transfers

fs.mkdirSync(SHARE_DIR, { recursive: true });
fs.rmSync(INCOMING_DIR, { recursive: true, force: true }); // drop leftovers from a crash
fs.mkdirSync(INCOMING_DIR, { recursive: true });

const chat = [];
if (fs.existsSync(CHAT_FILE)) {
  for (const line of fs.readFileSync(CHAT_FILE, 'utf8').split('\n')) {
    try { if (line.trim()) chat.push(JSON.parse(line)); } catch { /* skip a corrupt line */ }
  }
}
let nextChatId = chat.length ? chat[chat.length - 1].id + 1 : 1;

function loadList(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } // nothing saved yet
}

function saveList(file, list) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(file + '.tmp', file); // never leaves a half-written file
}

let mods = loadList(MODS_FILE);
let nextModId = mods.reduce((max, m) => Math.max(max, m.id), 0) + 1;
const saveMods = () => saveList(MODS_FILE, mods);

let pois = loadList(POIS_FILE);
let nextPoiId = pois.reduce((max, p) => Math.max(max, p.id), 0) + 1;
const savePois = () => saveList(POIS_FILE, pois);

// Mods installer versions. Files live in shared/Mods Installer/<folder>; this list holds version, tags and notes.
let releases = loadList(RELEASES_FILE);
for (const r of releases) if (r.status === 'uploading') r.status = 'incomplete'; // server stopped mid-upload
let nextReleaseId = releases.reduce((max, r) => Math.max(max, r.id), 0) + 1;
const saveReleases = () => saveList(RELEASES_FILE, releases);
const releaseTokens = new Map(); // release id -> secret given to the uploader, so only they can finish or cancel it
const RELEASE_TAGS = ['Recent', 'Stable', 'Beta', 'Hotfix'];

const POI_TYPES = ['Base', 'Farm', 'Village', 'Portal', 'Spawner', 'Mine / Cave', 'Structure', 'Biome', 'Shop', 'Build', 'Danger', 'Other'];
const DIMENSIONS = ['overworld', 'the_nether', 'the_end'];

// Turn whatever the browser sent into a safe Windows file name inside SHARE_DIR.
function cleanName(raw) {
  let name = String(raw || '').split(/[\\/]/).pop();
  name = name.replace(/[<>:"|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  if (!name || name === '.' || name === '..') name = 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name;
  if (name.length > 200) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

// "game.zip" -> "game (1).zip" if the name is taken in that folder.
function uniqueName(dir, name, isFolder = false) {
  const ext = isFolder ? '' : path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 1; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${base} (${i})${ext}`;
  return candidate;
}

// "a/b/c" -> ['a', 'b', 'c'], or null if any part isn't already a clean name (blocks "..", "C:" and the like).
function parseRel(raw, decode) {
  const segs = [];
  for (let s of String(raw || '').split('/')) {
    if (!s) continue;
    if (decode) {
      try { s = decodeURIComponent(s); } catch { return null; }
    }
    if (cleanName(s) !== s) return null;
    segs.push(s);
  }
  return segs;
}

// Existing file or folder inside SHARE_DIR, or null.
function sharedPath(segs) {
  if (!segs) return null;
  const full = path.join(SHARE_DIR, ...segs);
  if (full !== SHARE_DIR && !full.startsWith(SHARE_DIR + path.sep)) return null;
  try {
    return { segs, full, name: segs[segs.length - 1] || '', stat: fs.statSync(full) };
  } catch { return null; }
}

// Folder totals are cached, so polling a big game folder doesn't re-scan thousands of files every few seconds.
const folderCache = new Map(); // full path -> { time, size, count, mtime }
const folderActivity = new Map(); // full path -> last time an upload touched it

function folderStats(full) {
  const cached = folderCache.get(full);
  if (cached && Date.now() - cached.time < 30000) return cached;
  const stats = { time: Date.now(), size: 0, count: 0, mtime: 0 };
  const stack = [full];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try {
        const s = fs.statSync(p);
        stats.size += s.size;
        stats.count++;
        stats.mtime = Math.max(stats.mtime, s.mtimeMs);
      } catch { /* deleted meanwhile */ }
    }
  }
  if (!stats.mtime) {
    try { stats.mtime = fs.statSync(full).mtimeMs; } catch { /* gone */ }
  }
  folderCache.set(full, stats);
  return stats;
}

// Something changed at `full`: drop cached totals for it and every folder above it.
function touched(full, uploading) {
  for (let p = full; p.startsWith(SHARE_DIR + path.sep); p = path.dirname(p)) {
    folderCache.delete(p);
    if (uploading) folderActivity.set(p, Date.now());
  }
}

function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function clientIp(req) {
  return (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function log(req, msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${clientIp(req).padEnd(15)} ${msg}`);
}

// Contents of one folder (?path=a/b, empty for the top level).
function listFiles(req, res, url) {
  const dir = sharedPath(parseRel(url.searchParams.get('path'), false));
  if (!dir || !dir.stat.isDirectory()) return sendJson(res, 404, { error: 'Folder not found' });

  const entries = [];
  for (const entry of fs.readdirSync(dir.full, { withFileTypes: true })) {
    const full = path.join(dir.full, entry.name);
    try {
      if (entry.isFile()) {
        const stat = fs.statSync(full);
        entries.push({ type: 'file', name: entry.name, size: stat.size, mtime: stat.mtimeMs });
      } else if (entry.isDirectory()) {
        const s = folderStats(full);
        const uploading = Date.now() - (folderActivity.get(full) || 0) < 15000;
        entries.push({ type: 'folder', name: entry.name, size: s.size, count: s.count, mtime: s.mtime, uploading });
      }
    } catch { /* deleted while listing */ }
  }
  let free = null;
  try {
    const s = fs.statfsSync(SHARE_DIR);
    free = s.bavail * s.bsize;
  } catch { /* not supported */ }
  sendJson(res, 200, { path: dir.segs.join('/'), entries, free, canDelete: isLocal(req) });
}

// A folder upload starts by reserving its name, so two people uploading "Mods" get "Mods" and "Mods (1)".
const folderUploads = new Map(); // token -> full path, lets the uploader remove it again if they cancel

function reserveFolder(req, res, url) {
  const parent = sharedPath(parseRel(url.searchParams.get('path'), false));
  if (!parent || !parent.stat.isDirectory()) return sendJson(res, 404, { error: 'Folder not found' });
  const name = uniqueName(parent.full, cleanName(url.searchParams.get('name')), true);
  const full = path.join(parent.full, name);
  fs.mkdirSync(full);
  touched(full, true);
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  folderUploads.set(token, full);
  log(req, `folder upload    ${[...parent.segs, name].join('/')}`);
  sendJson(res, 201, { path: [...parent.segs, name].join('/'), token });
}

function cancelFolder(req, res, token) {
  const full = folderUploads.get(token);
  if (!full) return sendJson(res, 404, { error: 'Unknown upload' });
  folderUploads.delete(token);
  fs.rmSync(full, { recursive: true, force: true });
  touched(full, false);
  log(req, `folder cancelled ${path.relative(SHARE_DIR, full)}`);
  sendJson(res, 200, { ok: true });
}

// Messages newer than ?after=<id>. The first load (after=0) gets the latest 500.
function getChat(req, res, url) {
  const after = Number(url.searchParams.get('after')) || 0;
  const messages = chat.filter((m) => m.id > after).slice(-500);
  sendJson(res, 200, { messages });
}

// Read a small JSON request body; calls back with null if it's missing, invalid or over `limit` bytes.
function readJson(req, cb, limit = 8192) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size <= limit) chunks.push(c);
  });
  req.on('end', () => {
    if (size > limit) return cb(null, true);
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* bad JSON */ }
    cb(body && typeof body === 'object' ? body : null, false);
  });
}

function postChat(req, res) {
  // No message length limit, only a 1 MB ceiling so one giant paste can't bloat the chat everyone loads.
  readJson(req, (body, tooBig) => {
    if (tooBig) return sendJson(res, 413, { error: 'That message is over 1 MB' });
    if (!body) return sendJson(res, 400, { error: 'Bad message' });
    const name = String(body.name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 24);
    const text = String(body.text || '').replace(/\r/g, '').trim();
    if (!name || !text) return sendJson(res, 400, { error: 'Name and message are required' });

    const msg = { id: nextChatId++, name, text, time: Date.now() };
    chat.push(msg);
    fs.appendFileSync(CHAT_FILE, JSON.stringify(msg) + '\n');
    log(req, `chat  ${name}: ${text.split('\n')[0].slice(0, 60)}`);
    sendJson(res, 201, msg);
  }, 1024 * 1024);
}

// ---------- mods ----------

const cleanText = (v, max) => String(v ?? '').replace(/[\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Only http(s) links are stored, so nothing like javascript: can end up in the page.
function cleanUrl(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : 'https://' + s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function postMod(req, res) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const url = cleanUrl(body.url);
    if (url === null) return sendJson(res, 400, { error: 'That link doesn\'t look valid' });
    const name = cleanText(body.name, 150);
    if (!name) return sendJson(res, 400, { error: 'The mod needs a name' });
    const by = cleanText(body.by, 24);
    const mod = { id: nextModId++, name, url, note: cleanText(body.note, 200), installed: !!body.installed, by, added: Date.now() };
    mods.push(mod);
    saveMods();
    log(req, `mod added        ${name}${mod.installed ? ' (installed)' : ''}${by ? ' by ' + by : ''}`);
    sendJson(res, 201, mod);
  });
}

function patchMod(req, res, mod) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    if ('name' in body) {
      const name = cleanText(body.name, 150);
      if (!name) return sendJson(res, 400, { error: 'The mod needs a name' });
      mod.name = name;
    }
    if ('note' in body) mod.note = cleanText(body.note, 200);
    if ('url' in body) {
      const url = cleanUrl(body.url);
      if (url === null) return sendJson(res, 400, { error: 'That link doesn\'t look valid' });
      mod.url = url;
    }
    if ('installed' in body) mod.installed = !!body.installed;
    saveMods();
    log(req, `mod updated      ${mod.name}${mod.installed ? ' (installed)' : ''}`);
    sendJson(res, 200, mod);
  });
}

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    try {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    } catch { return m; }
    return named[e.toLowerCase()] ?? m;
  });
}

// Strip the site name that mod sites put around the mod's own name.
function cleanTitle(t) {
  t = decodeEntities(t).replace(/\s+/g, ' ').trim();
  t = t.replace(/^Steam (Workshop|Community)\s*::\s*/i, '');
  t = t.replace(/\s+at\s+.+?\s+Nexus\s*[-–]\s*Mods and Community$/i, ''); // Nexus Mods
  t = t.replace(/\s+(mod|addon|map|file)s? for .+?\s*[-–]\s*Mod ?DB$/i, ''); // ModDB
  t = t.replace(/\s*[-–|]\s*(.+?\s*[-–|]\s*)?CurseForge$/i, ''); // CurseForge
  t = t.replace(/\s*[-–]\s*(Minecraft|Hytale)\s+(Mod|Modpack|Plugin|Resource ?Pack|Shader|Data ?Pack)s?$/i, ''); // Modrinth
  t = t.replace(/\s*[|–-]\s*Thunderstore.*$/i, '');
  t = t.replace(/^GitHub - [^/]+\/([^:]+?)(:.*)?$/i, '$1'); // "GitHub - owner/repo: description"
  t = t.replace(/\s*[-–]\s*[^-–]*\b(Mod|Skin|Map|Tool|Sound|Texture|GUI|Effect)s? for .+$/i, ''); // GameBanana
  t = t.replace(/\s*[-–|]\s*(GitHub|Mod ?DB|GameBanana|Nexus ?Mods)$/i, '');
  return t.trim().slice(0, 150);
}

// Fallback when the site can't be read: the last readable part of the link, e.g. ".../mods/brutal-doom" -> "brutal doom".
function nameFromUrl(u) {
  const skip = new Set(['mods', 'mod', 'files', 'file', 'sharedfiles', 'filedetails', 'download', 'downloads', 'project', 'addons', 'releases']);
  const last = u.pathname.split('/').filter(Boolean).pop() || '';
  let slug = last;
  try { slug = decodeURIComponent(last); } catch { /* keep as is */ }
  if (!slug || /^\d+$/.test(slug) || skip.has(slug.toLowerCase())) return '';
  return slug.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ').trim();
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// Nexus Mods and CurseForge block plain page fetches (Cloudflare), so ask their public APIs instead.
async function siteApiTitle(u) {
  const host = u.hostname.replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  if (host === 'nexusmods.com' && parts[1] === 'mods' && /^\d+$/.test(parts[2] || '')) {
    const query = 'query($ids: [CompositeDomainWithIdInput!]!) { legacyModsByDomain(ids: $ids) { nodes { name } } }';
    const r = await fetch('https://api.nexusmods.com/v2/graphql', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: [{ gameDomain: parts[0], modId: Number(parts[2]) }] } }),
    });
    const data = await r.json();
    return data?.data?.legacyModsByDomain?.nodes?.[0]?.name || '';
  }
  if (host === 'curseforge.com' && parts.length >= 3) {
    const r = await fetch(`https://api.cfwidget.com/${parts.slice(0, 3).map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(8000) });
    if (r.status !== 200) return '';
    return (await r.json()).title || '';
  }
  return '';
}

// Anyone can trigger a title lookup, so don't let it be used to poke at the host's own network (router pages etc).
function isPrivateHost(hostname) {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || !h.includes('.') && !h.includes(':')) return true;
  if (/^(127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return h.includes(':') && (h === '::1' || /^(fc|fd|fe80)/.test(h) || h.startsWith('::ffff:'));
}

async function getTitle(req, res, url) {
  const link = cleanUrl(url.searchParams.get('url'));
  if (!link) return sendJson(res, 400, { error: 'That link doesn\'t look valid' });
  const u = new URL(link);
  if (isPrivateHost(u.hostname)) return sendJson(res, 200, { title: '', guessed: true });
  let title = '';
  try { title = cleanText(await siteApiTitle(u), 150); } catch { /* API down, fall back to the page */ }
  if (!title) title = await pageTitle(link);
  log(req, `title lookup     ${u.hostname} -> ${title || '(failed, guessed from link)'}`);
  sendJson(res, 200, { title: title || nameFromUrl(u), guessed: !title });
}

async function pageTitle(link) {
  let title = '';
  try {
    let r = await fetch(link, {
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    // Follow redirects by hand (max 5) so a public link can't bounce us onto a private address.
    let hops = 0;
    while (r.status >= 300 && r.status < 400 && r.headers.get('location') && hops++ < 5) {
      const nextUrl = new URL(r.headers.get('location'), link);
      if (!/^https?:$/.test(nextUrl.protocol) || isPrivateHost(nextUrl.hostname)) return '';
      link = nextUrl.href;
      r = await fetch(link, {
        signal: AbortSignal.timeout(8000),
        redirect: 'manual',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
      });
    }
    // The title is in <head>, so stop reading once we have it (pages can be huge).
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < 1_000_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});

    let og = '';
    for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
      if (!/(property|name)\s*=\s*["'](og:title|twitter:title)["']/i.test(tag)) continue;
      const m = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
      if (m) { og = m[2] ?? m[3]; break; }
    }
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    title = cleanTitle(og || (t ? t[1] : ''));
    // Bot-protection pages have useless titles.
    if (/^(just a moment|attention required|access denied|403|404|forbidden|not found|error|loading)/i.test(title)) title = '';
  } catch { /* offline, blocked or timed out */ }
  return title;
}

// ---------- POIs (points of interest with coordinates) ----------

function parseCoord(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= 30_000_000 ? Math.round(n * 100) / 100 : null;
}

// Validates `body` onto a copy of `poi`; returns [updatedPoi, null] or [null, errorMessage].
function applyPoi(poi, body) {
  const next = { ...poi };
  const isNew = !poi.id;
  if (isNew || 'title' in body) {
    next.title = cleanText(body.title, 100);
    if (!next.title) return [null, 'The place needs a title'];
  }
  for (const k of ['x', 'y', 'z']) {
    if (!isNew && !(k in body)) continue;
    next[k] = parseCoord(body[k]);
    if (next[k] === null) return [null, 'X, Y and Z need to be numbers'];
  }
  if (isNew || 'dim' in body) next.dim = DIMENSIONS.includes(body.dim) ? body.dim : 'overworld';
  if (isNew || 'type' in body) next.type = POI_TYPES.includes(body.type) ? body.type : '';
  return [next, null];
}

function postPoi(req, res) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const [poi, error] = applyPoi({}, body);
    if (error) return sendJson(res, 400, { error });
    poi.id = nextPoiId++;
    poi.by = cleanText(body.by, 24);
    poi.added = Date.now();
    pois.push(poi);
    savePois();
    log(req, `poi added        ${poi.title} (${poi.x} ${poi.y} ${poi.z})${poi.by ? ' by ' + poi.by : ''}`);
    sendJson(res, 201, poi);
  });
}

function patchPoi(req, res, poi) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const [updated, error] = applyPoi(poi, body);
    if (error) return sendJson(res, 400, { error });
    Object.assign(poi, updated);
    savePois();
    log(req, `poi updated      ${poi.title}`);
    sendJson(res, 200, poi);
  });
}

// ---------- mods installer versions ----------
// Upload flow: POST /api/releases creates the version folder, the page uploads files into it with the normal
// upload, then POST /api/releases/:id/done?token= publishes it. Cancel/fail: DELETE /api/releases/:id?token=.

const encSegs = (segs) => segs.map(encodeURIComponent).join('/');

function cleanTags(tags) {
  return Array.isArray(tags) ? RELEASE_TAGS.filter((t) => tags.includes(t)) : [];
}

// "Recent" means "the one to use now", so only one version can have it.
function claimRecent(release) {
  if (!release.tags.includes('Recent')) return;
  for (const r of releases) if (r !== release) r.tags = r.tags.filter((t) => t !== 'Recent');
}

// Adds size, file count and the download link. A version that is a single file downloads directly, a folder as ZIP.
function releaseInfo(r) {
  const segs = [INSTALLER_DIR, r.folder];
  const full = path.join(SHARE_DIR, ...segs);
  let entries;
  try { entries = fs.readdirSync(full, { withFileTypes: true }); } catch { return null; }
  const s = folderStats(full);
  const single = entries.length === 1 && entries[0].isFile() ? entries[0].name : null;
  return {
    ...r,
    size: s.size,
    count: s.count,
    path: segs.join('/'),
    download: single ? '/files/' + encSegs([...segs, single]) : '/zip/' + encSegs(segs),
    downloadName: single || r.folder + '.zip',
  };
}

function listReleases(req, res) {
  const list = [];
  for (const r of releases) {
    const info = releaseInfo(r);
    if (info) list.push(info);
  }
  // Versions whose folder was deleted in the Files tab disappear from the list too.
  if (list.length !== releases.length) {
    releases = releases.filter((r) => list.some((i) => i.id === r.id));
    saveReleases();
  }
  sendJson(res, 200, { releases: list, tags: RELEASE_TAGS, canDelete: isLocal(req) });
}

function postRelease(req, res) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const version = cleanText(body.version, 40).replace(/^v(?=\d)/i, '');
    if (!version) return sendJson(res, 400, { error: 'The version needs a name, e.g. 1.4.2' });
    if (releases.some((r) => r.version.toLowerCase() === version.toLowerCase())) {
      return sendJson(res, 409, { error: `Version ${version} already exists. Use a new version number.` });
    }
    const parent = path.join(SHARE_DIR, INSTALLER_DIR);
    fs.mkdirSync(parent, { recursive: true });
    const folder = uniqueName(parent, cleanName(`Mods Installer ${/^\d/.test(version) ? 'v' : ''}${version}`), true);
    const full = path.join(parent, folder);
    fs.mkdirSync(full);
    touched(full, true);

    const release = {
      id: nextReleaseId++, version, tags: cleanTags(body.tags), note: String(body.note || '').replace(/\r/g, '').trim().slice(0, 500),
      by: cleanText(body.by, 24), added: Date.now(), folder, status: 'uploading',
    };
    releases.push(release);
    saveReleases();
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    releaseTokens.set(release.id, token);
    log(req, `installer upload ${folder}${release.by ? ' by ' + release.by : ''}`);
    sendJson(res, 201, { release, token, path: [INSTALLER_DIR, folder].join('/') });
  });
}

function finishRelease(req, res, release, url) {
  if (releaseTokens.get(release.id) !== url.searchParams.get('token')) return sendJson(res, 403, { error: 'Not your upload' });
  releaseTokens.delete(release.id);
  release.status = 'ready';
  release.added = Date.now();
  claimRecent(release);
  saveReleases();
  log(req, `installer ready  ${release.folder} [${release.tags.join(', ')}]`);
  sendJson(res, 200, release);
}

function patchRelease(req, res, release) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    if ('tags' in body) release.tags = cleanTags(body.tags);
    if ('note' in body) release.note = String(body.note || '').replace(/\r/g, '').trim().slice(0, 500);
    claimRecent(release);
    saveReleases();
    log(req, `installer edited ${release.folder} [${release.tags.join(', ')}]`);
    sendJson(res, 200, release);
  });
}

function deleteRelease(req, res, release, url) {
  // The uploader may cancel their own unfinished upload; anything else is host-only, like deleting files.
  const ownUpload = release.status === 'uploading' && releaseTokens.get(release.id) === url.searchParams.get('token');
  if (!ownUpload && !isLocal(req)) return sendJson(res, 403, { error: 'Only the host PC can delete versions' });
  const full = path.join(SHARE_DIR, INSTALLER_DIR, release.folder);
  fs.rmSync(full, { recursive: true, force: true });
  touched(full, false);
  releases = releases.filter((r) => r !== release);
  releaseTokens.delete(release.id);
  saveReleases();
  log(req, `installer removed ${release.folder}`);
  sendJson(res, 200, { ok: true });
}

// PUT /api/upload?path=<folder>&name=<file>. Subfolders in `path` are created as needed (folder uploads).
function upload(req, res, url) {
  const name = cleanName(url.searchParams.get('name'));
  // Folder names come from people's disks, so clean them rather than reject them.
  const segs = String(url.searchParams.get('path') || '').split('/').filter(Boolean).map(cleanName);
  const dir = path.join(SHARE_DIR, ...segs);
  const shown = [...segs, name].join('/');
  const tmp = path.join(INCOMING_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.part`);
  const size = Number(req.headers['content-length']) || 0;
  const inFolder = segs.length > 0;
  if (inFolder) touched(dir, true);
  else log(req, `upload started   ${shown} (${formatSize(size)})`);

  pipeline(req, fs.createWriteStream(tmp, { highWaterMark: CHUNK }), (err) => {
    if (err) {
      fs.rm(tmp, { force: true }, () => {});
      log(req, `upload FAILED    ${shown} (${err.code || err.message})`);
      if (!res.headersSent && !res.destroyed) {
        sendJson(res, err.code === 'ENOSPC' ? 507 : 500, { error: err.code === 'ENOSPC' ? 'Host disk is full' : 'Upload failed' });
      }
      return;
    }
    let finalName;
    try {
      fs.mkdirSync(dir, { recursive: true });
      finalName = uniqueName(dir, name); // sync check + rename, so two uploads can't grab the same name
      fs.renameSync(tmp, path.join(dir, finalName));
    } catch (e) {
      fs.rm(tmp, { force: true }, () => {});
      log(req, `upload FAILED    ${shown} (${e.code || e.message})`);
      return sendJson(res, 409, { error: 'Could not save the file there' });
    }
    if (inFolder) touched(dir, true);
    else log(req, `upload done      ${finalName}`);
    sendJson(res, 201, { name: finalName });
  });
}

// ---------- folder download as ZIP ----------
// Built on the fly while sending: files are stored uncompressed (game files are usually compressed already),
// with ZIP64 so folders and files over 4 GB work. The exact size is known up front, so browsers show progress.

const MAX32 = 0xffffffff;

function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zipEntries(rootFull, rootName) {
  const entries = [];
  const walk = (full, zipPath) => {
    entries.push({ dir: true, full, zipPath: zipPath + '/', size: 0, mtime: fs.statSync(full).mtimeMs });
    const children = fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const c of children) {
      const p = path.join(full, c.name);
      if (c.isDirectory()) walk(p, zipPath + '/' + c.name);
      else if (c.isFile()) {
        const s = fs.statSync(p);
        entries.push({ dir: false, full: p, zipPath: zipPath + '/' + c.name, size: s.size, mtime: s.mtimeMs });
      }
    }
  };
  walk(rootFull, rootName);
  return entries;
}

// Writes `fields` ([value, byteCount] pairs) little-endian into one buffer.
function packLE(fields) {
  const buf = Buffer.alloc(fields.reduce((n, [, bytes]) => n + bytes, 0));
  let o = 0;
  for (const [v, bytes] of fields) {
    if (bytes === 2) buf.writeUInt16LE(v, o);
    else if (bytes === 4) buf.writeUInt32LE(v, o);
    else buf.writeBigUInt64LE(BigInt(v), o);
    o += bytes;
  }
  return buf;
}

async function downloadZip(req, res, folder) {
  const entries = zipEntries(folder.full, folder.name);

  // Pass 1: work out every offset and the total size.
  let offset = 0;
  for (const e of entries) {
    e.name = Buffer.from(e.zipPath, 'utf8');
    e.offset = offset;
    e.zip64 = e.size >= MAX32;
    e.localLen = 30 + e.name.length + (e.zip64 ? 20 : 0);
    e.descLen = e.dir ? 0 : (e.zip64 ? 24 : 16);
    e.cdExtra = [];
    if (e.size >= MAX32) e.cdExtra.push(e.size, e.size);
    if (e.offset >= MAX32) e.cdExtra.push(e.offset);
    offset += e.localLen + e.size + e.descLen;
  }
  const cdStart = offset;
  const cdLen = entries.reduce((n, e) => n + 46 + e.name.length + (e.cdExtra.length ? 4 + 8 * e.cdExtra.length : 0), 0);
  const zip64End = entries.length >= 0xffff || cdStart >= MAX32 || cdLen >= MAX32;
  const total = cdStart + cdLen + (zip64End ? 56 + 20 : 0) + 22;

  const fileName = folder.name + '.zip';
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': total,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  });
  if (req.method === 'HEAD') return res.end();
  log(req, `download zip     ${folder.segs.join('/')} (${entries.filter((e) => !e.dir).length} files, ${formatSize(total)})`);

  const write = (buf) => new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('client left'));
    if (res.write(buf)) return resolve();
    const ok = () => { res.off('close', gone); resolve(); };
    const gone = () => { res.off('drain', ok); reject(new Error('client left')); };
    res.once('drain', ok);
    res.once('close', gone);
  });

  // Opening files is slow on Windows (antivirus checks each one), so small files are read a few at a time ahead.
  const SMALL = 256 * 1024;
  const ahead = new Map(); // entry index -> Promise<Buffer>
  const readAhead = (i) => {
    const e = entries[i];
    if (!e || e.dir || e.size > SMALL || ahead.has(i)) return;
    const p = e.size ? fs.promises.readFile(e.full) : Promise.resolve(Buffer.alloc(0));
    p.catch(() => {}); // handled when awaited; avoids an unhandled rejection if the download is abandoned
    ahead.set(i, p);
  };

  try {
    // Pass 2: local header, file data, then a data descriptor holding the CRC computed while streaming.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      for (let j = i; j < i + 16; j++) readAhead(j);
      const t = dosTime(e.mtime);
      const flags = 0x0800 | (e.dir ? 0 : 0x0008); // UTF-8 names; CRC follows the data
      const header = Buffer.concat([
        packLE([[0x04034b50, 4], [e.zip64 ? 45 : 20, 2], [flags, 2], [0, 2], [t.time, 2], [t.date, 2], [0, 4],
          [e.zip64 ? MAX32 : e.size, 4], [e.zip64 ? MAX32 : e.size, 4], [e.name.length, 2], [e.zip64 ? 20 : 0, 2]]),
        e.name,
        e.zip64 ? packLE([[0x0001, 2], [16, 2], [e.size, 8], [e.size, 8]]) : Buffer.alloc(0),
      ]);
      const descriptor = (crc) => packLE(e.zip64
        ? [[0x08074b50, 4], [crc, 4], [e.size, 8], [e.size, 8]]
        : [[0x08074b50, 4], [crc, 4], [e.size, 4], [e.size, 4]]);
      if (e.dir) {
        e.crc = 0;
        await write(header);
        continue;
      }

      if (e.size <= SMALL) {
        // Small file: one read and one write (game folders often hold thousands of these).
        const data = await ahead.get(i);
        ahead.delete(i);
        if (data.length !== e.size) throw new Error(`${e.zipPath} changed while zipping`);
        e.crc = crc32(data);
        await write(Buffer.concat([header, data, descriptor(e.crc)]));
        continue;
      }

      await write(header);
      let crc = 0;
      let read = 0;
      for await (const chunk of fs.createReadStream(e.full, { start: 0, end: e.size - 1, highWaterMark: CHUNK })) {
        crc = crc32(chunk, crc);
        read += chunk.length;
        await write(chunk);
      }
      if (read !== e.size) throw new Error(`${e.zipPath} changed while zipping`);
      e.crc = crc;
      await write(descriptor(crc));
    }

    // Central directory.
    const cd = [];
    for (const e of entries) {
      const t = dosTime(e.mtime);
      const needs64 = e.cdExtra.length > 0;
      cd.push(packLE([[0x02014b50, 4], [45, 2], [needs64 || e.zip64 ? 45 : 20, 2], [0x0800 | (e.dir ? 0 : 0x0008), 2], [0, 2],
        [t.time, 2], [t.date, 2], [e.crc, 4], [e.size >= MAX32 ? MAX32 : e.size, 4], [e.size >= MAX32 ? MAX32 : e.size, 4],
        [e.name.length, 2], [needs64 ? 4 + 8 * e.cdExtra.length : 0, 2], [0, 2], [0, 2], [0, 2], [e.dir ? 0x10 : 0x20, 4],
        [e.offset >= MAX32 ? MAX32 : e.offset, 4]]));
      cd.push(e.name);
      if (needs64) cd.push(packLE([[0x0001, 2], [8 * e.cdExtra.length, 2], ...e.cdExtra.map((v) => [v, 8])]));
    }
    if (zip64End) {
      const at = cdStart + cdLen;
      cd.push(packLE([[0x06064b50, 4], [44, 8], [45, 2], [45, 2], [0, 4], [0, 4], [entries.length, 8], [entries.length, 8], [cdLen, 8], [cdStart, 8]]));
      cd.push(packLE([[0x07064b50, 4], [0, 4], [at, 8], [1, 4]]));
    }
    const n16 = Math.min(entries.length, 0xffff);
    cd.push(packLE([[0x06054b50, 4], [0, 2], [0, 2], [n16, 2], [n16, 2], [Math.min(cdLen, MAX32), 4], [Math.min(cdStart, MAX32), 4], [0, 2]]));
    await write(Buffer.concat(cd));
    res.end();
  } catch (err) {
    if (err.message !== 'client left') log(req, `zip FAILED       ${folder.segs.join('/')} (${err.message})`);
    res.destroy();
  }
}

function download(req, res, file) {
  const { size } = file.stat;
  let start = 0;
  let end = size - 1;
  let status = 200;

  // Range support lets browsers resume big downloads that got interrupted.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
    } else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
  }

  const ascii = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size ? end - start + 1 : 0,
    'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'Accept-Ranges': 'bytes',
    'Last-Modified': file.stat.mtime.toUTCString(),
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || size === 0) return res.end();

  if (start === 0) log(req, `download         ${file.name} (${formatSize(size)})`);
  pipeline(fs.createReadStream(file.full, { start, end, highWaterMark: CHUNK }), res, () => {});
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(INDEX_FILE).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/files') return listFiles(req, res, url);
    if (req.method === 'PUT' && p === '/api/upload') return upload(req, res, url);
    if (req.method === 'POST' && p === '/api/folder') return reserveFolder(req, res, url);
    if (req.method === 'DELETE' && p.startsWith('/api/folder/')) return cancelFolder(req, res, p.slice('/api/folder/'.length));
    if (req.method === 'GET' && p === '/api/chat') return getChat(req, res, url);
    if (req.method === 'POST' && p === '/api/chat') return postChat(req, res);

    // Mods and POIs: everyone can add and edit, only the host PC can delete (same as files).
    if (req.method === 'GET' && p === '/api/title') return getTitle(req, res, url);
    if (req.method === 'GET' && p === '/api/mods') return sendJson(res, 200, { mods, canDelete: isLocal(req) });
    if (req.method === 'POST' && p === '/api/mods') return postMod(req, res);
    if (p.startsWith('/api/mods/')) {
      const mod = mods.find((m) => `/api/mods/${m.id}` === p);
      if (!mod) return sendJson(res, 404, { error: 'Mod not found' });
      if (req.method === 'PATCH') return patchMod(req, res, mod);
      if (req.method === 'DELETE') {
        if (!isLocal(req)) return sendJson(res, 403, { error: 'Only the host PC can remove mods' });
        mods = mods.filter((m) => m !== mod);
        saveMods();
        log(req, `mod removed      ${mod.name}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && p === '/api/releases') return listReleases(req, res);
    if (req.method === 'POST' && p === '/api/releases') return postRelease(req, res);
    if (p.startsWith('/api/releases/')) {
      const [idPart, action] = p.slice('/api/releases/'.length).split('/');
      const release = releases.find((r) => String(r.id) === idPart);
      if (!release) return sendJson(res, 404, { error: 'Version not found' });
      if (req.method === 'POST' && action === 'done') return finishRelease(req, res, release, url);
      if (req.method === 'PATCH' && !action) return patchRelease(req, res, release);
      if (req.method === 'DELETE' && !action) return deleteRelease(req, res, release, url);
    }

    if (req.method === 'GET' && p === '/api/pois') return sendJson(res, 200, { pois, types: POI_TYPES, canDelete: isLocal(req) });
    if (req.method === 'POST' && p === '/api/pois') return postPoi(req, res);
    if (p.startsWith('/api/pois/')) {
      const poi = pois.find((x) => `/api/pois/${x.id}` === p);
      if (!poi) return sendJson(res, 404, { error: 'Place not found' });
      if (req.method === 'PATCH') return patchPoi(req, res, poi);
      if (req.method === 'DELETE') {
        if (!isLocal(req)) return sendJson(res, 403, { error: 'Only the host PC can delete places' });
        pois = pois.filter((x) => x !== poi);
        savePois();
        log(req, `poi deleted      ${poi.title}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/files/')) {
      const file = sharedPath(parseRel(p.slice('/files/'.length), true));
      return file && file.stat.isFile() ? download(req, res, file) : sendJson(res, 404, { error: 'File not found' });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p.startsWith('/zip/')) {
      const folder = sharedPath(parseRel(p.slice('/zip/'.length), true));
      if (!folder || !folder.segs.length || !folder.stat.isDirectory()) return sendJson(res, 404, { error: 'Folder not found' });
      return downloadZip(req, res, folder).catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Could not zip that folder' });
        else res.destroy();
      });
    }

    if (req.method === 'DELETE' && p.startsWith('/api/files/')) {
      if (!isLocal(req)) return sendJson(res, 403, { error: 'Only the host PC can delete files' });
      const item = sharedPath(parseRel(p.slice('/api/files/'.length), true));
      if (!item || !item.segs.length) return sendJson(res, 404, { error: 'File not found' });
      fs.rmSync(item.full, { recursive: true });
      touched(item.full, false);
      log(req, `deleted          ${item.segs.join('/')}${item.stat.isDirectory() ? '/' : ''}`);
      return sendJson(res, 200, { ok: true });
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error' });
    else res.destroy();
  }
});

// Node's default 5 minute request timeout would kill large uploads.
server.requestTimeout = 0;
server.timeout = 0;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other server or set PORT, e.g.  set PORT=8081`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  LAN File Share is running.\n');
  console.log('  Tell your friends to open one of these in their browser:\n');
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`    http://${a.address}:${PORT}    (${ifname})`);
    }
  }
  console.log(`\n  On this PC:  http://localhost:${PORT}`);
  console.log(`  Files are stored in: ${SHARE_DIR}`);
  console.log(`  Chat is saved in:    ${CHAT_FILE} (${chat.length} messages)`);
  console.log(`  Mods are saved in:   ${MODS_FILE} (${mods.length} mods)`);
  console.log(`  Places are saved in: ${POIS_FILE} (${pois.length} places)`);
  console.log(`  Installer versions:  ${RELEASES_FILE} (${releases.length} versions)`);
  console.log('  Close this window to stop the server.\n');
});
