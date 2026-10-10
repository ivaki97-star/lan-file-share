// LAN party file share. No dependencies: run with `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream');
const zlib = require('zlib');
const { crc32 } = zlib;

const PORT = Number(process.env.PORT) || 8080;
const SHARE_DIR = path.join(__dirname, 'shared');
const INCOMING_DIR = path.join(__dirname, 'incoming'); // partial uploads, moved into SHARE_DIR when complete
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const CHAT_FILE = path.join(__dirname, 'chat.jsonl'); // one message per line, kept forever
const MODS_FILE = path.join(__dirname, 'mods.json');
const POIS_FILE = path.join(__dirname, 'pois.json');
const RELEASES_FILE = path.join(__dirname, 'releases.json');
const MODELS_FILE = path.join(__dirname, 'models.json');
const MODELS_DIR = 'Models'; // folder inside shared/ with one subfolder per Easy Model Entities model
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

async function downloadZip(req, res, folder, customEntries) {
  const entries = customEntries || zipEntries(folder.full, folder.name);

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


// ---------- models (Easy Model Entities packages) ----------
// A model is one jar: a data pack (server profile) plus a resource pack (render profile, .bbmodel, textures) with a
// fabric.mod.json so Fabric loads it from the mods folder on the server and on every client. People upload a jar or
// a zip; the server checks the layout, adds fabric.mod.json / pack.mcmeta when missing, and keeps it in
// shared/Models/<name>/. Skins are PNGs baked into the jar as extra textures; the admin switches them on per entity
// in game. Status "proposed" = waiting for the admin, "uploaded" = on the Minecraft server.

let models = loadList(MODELS_FILE);
let nextModelId = models.reduce((max, m) => Math.max(max, m.id), 0) + 1;
const saveModels = () => saveList(MODELS_FILE, models);
const MODEL_MAX = 64 * 1024 * 1024;
const SKIN_MAX = 4 * 1024 * 1024;
const PACK_FORMAT = 101; // Minecraft 26.3 resource/data pack format, only used when a pack has no pack.mcmeta
const RL = '[a-z0-9_.\\/-]+'; // what Minecraft accepts in resource locations

// Whole request body as one buffer; cb(null, true) when it is over `limit` bytes.
function readRaw(req, limit, cb) {
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
  req.on('end', () => cb(size > limit ? null : Buffer.concat(chunks), size > limit));
  req.on('error', () => cb(null, false));
}

function parseJsonSafe(buf) {
  try { return JSON.parse(buf.toString('utf8').replace(/^﻿/, '')); } catch { return null; }
}

function pngInfo(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Reads a small zip/jar fully into memory: Map of path -> Buffer (folders skipped).
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('That is not a zip or jar file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === MAX32 || count === 0xffff) throw new Error('Zip64 archives are not supported, keep the model under 4 GB');
  const files = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip file is damaged');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.includes('../')) continue;
    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('The zip file is damaged');
    const start = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`"${name}" uses a compression method this server cannot read`);
    if (data.length !== usize) throw new Error(`"${name}" inside the zip is damaged`);
    files.set(name, data);
  }
  return files;
}

// Map of path -> Buffer to a zip buffer (deflated, UTF-8 names).
function writeZip(files) {
  const parts = [];
  const cd = [];
  let offset = 0;
  const t = dosTime(Date.now());
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const method = deflated.length < data.length ? 8 : 0;
    const body = method ? deflated : data;
    const crc = crc32(data);
    const local = packLE([[0x04034b50, 4], [20, 2], [0x0800, 2], [method, 2], [t.time, 2], [t.date, 2], [crc, 4],
      [body.length, 4], [data.length, 4], [nameBuf.length, 2], [0, 2]]);
    parts.push(local, nameBuf, body);
    cd.push(packLE([[0x02014b50, 4], [20, 2], [20, 2], [0x0800, 2], [method, 2], [t.time, 2], [t.date, 2], [crc, 4],
      [body.length, 4], [data.length, 4], [nameBuf.length, 2], [0, 2], [0, 2], [0, 2], [0, 2], [0x20, 4], [offset, 4]]), nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(cd);
  return Buffer.concat([...parts, cdBuf, packLE([[0x06054b50, 4], [0, 2], [0, 2], [files.size, 2], [files.size, 2], [cdBuf.length, 4], [offset, 4], [0, 2]])]);
}

// Reads the Easy Model Entities layout out of a pack: which entity profiles, models and textures it has, and what is wrong.
function inspectModel(files) {
  const info = { namespaces: new Set(), profiles: [], textures: [], errors: [], warnings: [] };
  const renderRe = new RegExp(`^assets/(${RL})/easy_model_entities/render_profiles/entity/(${RL})\\.json$`);
  const serverRe = new RegExp(`^data/(${RL})/easy_model_entities/profiles/entity/(${RL})\\.json$`);
  const modelRe = new RegExp(`^assets/(${RL})/easy_model_entities/models/(${RL})\\.bbmodel$`);
  const textureRe = new RegExp(`^assets/(${RL})/textures/entity/(${RL})\\.png$`);
  const renders = new Map();
  const servers = new Map();
  const bbmodels = new Map();
  for (const [name, data] of files) {
    let m;
    if ((m = renderRe.exec(name))) { renders.set(`${m[1]}:${m[2]}`, parseJsonSafe(data)); info.namespaces.add(m[1]); }
    else if ((m = serverRe.exec(name))) { servers.set(`${m[1]}:${m[2]}`, parseJsonSafe(data)); info.namespaces.add(m[1]); }
    else if ((m = modelRe.exec(name))) bbmodels.set(`${m[1]}:easy_model_entities/models/${m[2]}`, parseJsonSafe(data));
    else if ((m = textureRe.exec(name))) {
      const png = pngInfo(data);
      info.textures.push({ namespace: m[1], name: m[2], id: `${m[1]}:textures/entity/${m[2]}.png`, path: name, width: png ? png.width : 0, height: png ? png.height : 0 });
    } else if (/^(assets|data)\//.test(name) && !new RegExp(`^${RL}$`).test(name)) {
      info.warnings.push(`"${name}" has characters Minecraft refuses (use lowercase a-z, 0-9, _ - .)`);
    }
  }
  for (const [id, render] of renders) {
    const server = servers.get(id);
    if (!server) { info.errors.push(`Render profile ${id} has no server profile (data/<pack>/easy_model_entities/profiles/entity/<name>.json)`); continue; }
    const [ns, part] = id.split(':');
    const modelId = (render && render.model) || `${ns}:easy_model_entities/models/${part}`;
    const bbm = bbmodels.get(modelId);
    if (!bbm) info.errors.push(`${id}: model "${modelId}.bbmodel" is missing`);
    const texture = (render && render.texture) || `${ns}:textures/entity/${part}.png`;
    if (!info.textures.some((t) => t.id === texture)) info.errors.push(`${id}: texture "${texture}" is missing`);
    info.profiles.push({
      id, summon: `${ns}:entity/${part}`, namespace: ns, name: part, model: modelId, texture,
      preset: (render && render.preset_type) || (server && server.preset_type) || '',
      version: (render && render.version) || '',
      animations: Array.isArray(bbm && bbm.animations) ? bbm.animations.map((a) => a && a.name).filter(Boolean).slice(0, 40) : [],
    });
  }
  for (const id of servers.keys()) if (!renders.has(id)) info.errors.push(`Server profile ${id} has no render profile (assets/<pack>/easy_model_entities/render_profiles/entity/<name>.json)`);
  if (!info.profiles.length && !info.errors.length) {
    info.errors.push('No Easy Model Entities entity profiles found. Expected data/<pack>/easy_model_entities/profiles/entity/<name>.json and assets/<pack>/easy_model_entities/render_profiles/entity/<name>.json');
  }
  return info;
}

const modIdOf = (ns) => ns.replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z]+/, 'm').slice(0, 63);

// Makes sure the pack is a loadable Fabric mod. Returns the original bytes untouched when nothing had to change,
// so a jar someone built themselves is stored exactly as they made it.
function buildModelJar(original, files, info, meta, version) {
  const ns = [...info.namespaces][0];
  const fmjRaw = files.get('fabric.mod.json');
  let fmj = fmjRaw ? parseJsonSafe(fmjRaw) : null;
  const needsFmj = !fmj || !fmj.id || (version && fmj.version !== version);
  const needsMeta = !files.has('pack.mcmeta');
  if (!needsFmj && !needsMeta && !meta.changed) return { data: original, version: fmj.version || '' };
  const out = new Map(files);
  fmj = fmj && typeof fmj === 'object' ? fmj : {};
  fmj = {
    schemaVersion: 1, id: modIdOf(ns), name: meta.name, description: `Easy Model Entities model: ${meta.name}`, environment: '*',
    ...fmj,
    version: version || fmj.version || '1.0.0',
    depends: { fabricloader: '*', easy_model_entities: '*', ...(fmj.depends && typeof fmj.depends === 'object' ? fmj.depends : {}) },
  };
  if (meta.by && !(Array.isArray(fmj.authors) && fmj.authors.length)) fmj.authors = [meta.by];
  out.set('fabric.mod.json', Buffer.from(JSON.stringify(fmj, null, 2)));
  if (needsMeta) {
    out.set('pack.mcmeta', Buffer.from(JSON.stringify({ pack: { description: `${meta.name} resources`, min_format: PACK_FORMAT, max_format: PACK_FORMAT } }, null, 2)));
  }
  return { data: writeZip(out), version: fmj.version };
}

const modelDir = (m) => path.join(SHARE_DIR, MODELS_DIR, m.folder);

// Writes the jar and the texture previews into the model's folder and refreshes the stored facts about it.
function storeModel(m, jarData, files, info) {
  const dir = modelDir(m);
  fs.mkdirSync(path.join(dir, 'textures'), { recursive: true });
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && e.name.toLowerCase().endsWith('.jar') && e.name !== m.file) fs.rmSync(path.join(dir, e.name), { force: true });
  }
  fs.writeFileSync(path.join(dir, m.file), jarData);
  fs.rmSync(path.join(dir, 'textures'), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'textures'));
  m.textures = info.textures.map((t) => {
    const file = `${t.namespace}__${t.name.replace(/\//g, '__')}.png`;
    fs.writeFileSync(path.join(dir, 'textures', file), files.get(t.path));
    return { id: t.id, name: t.name, file, width: t.width, height: t.height };
  });
  m.profiles = info.profiles;
  m.namespace = [...info.namespaces][0];
  m.size = jarData.length;
  m.sha256 = require('crypto').createHash('sha256').update(jarData).digest('hex');
  m.warnings = info.warnings.slice(0, 10);
  touched(dir, false);
}

function modelInfo(m, req) {
  const host = req.headers.host || 'localhost';
  return {
    ...m,
    path: [MODELS_DIR, m.folder].join('/'),
    download: '/files/' + encSegs([MODELS_DIR, m.folder, m.file]),
    url: `http://${host}/files/${encSegs([MODELS_DIR, m.folder, m.file])}`,
    textures: (m.textures || []).map((t) => ({ ...t, src: `/api/models/${m.id}/texture/${encodeURIComponent(t.file)}` })),
    pending: m.status === 'uploaded' && m.uploadedFile !== m.file, // changed since the admin last put it on the server
  };
}

function listModels(req, res) {
  const list = [];
  for (const m of models) if (fs.existsSync(path.join(modelDir(m), m.file))) list.push(modelInfo(m, req));
  if (list.length !== models.length) { // folders removed in the Files tab
    models = models.filter((m) => list.some((i) => i.id === m.id));
    saveModels();
  }
  sendJson(res, 200, {
    models: list, canDelete: isLocal(req),
    packEntriesUrl: `http://${req.headers.host || 'localhost'}/api/models/pack-entries?status=uploaded`,
  });
}

// PUT /api/models/upload?name=&note=&by=&filename=   body = the jar or zip
function uploadModel(req, res, url) {
  readRaw(req, MODEL_MAX, (buf, tooBig) => {
    if (tooBig) return sendJson(res, 413, { error: `Models are limited to ${formatSize(MODEL_MAX)}` });
    if (!buf || !buf.length) return sendJson(res, 400, { error: 'No file received' });
    let files;
    let info;
    try { files = readZip(buf); info = inspectModel(files); } catch (e) { return sendJson(res, 400, { error: e.message }); }
    if (info.errors.length) return sendJson(res, 400, { error: 'This is not a complete Easy Model Entities pack:\n' + info.errors.join('\n') });
    const ns = [...info.namespaces][0];
    const fmj = files.has('fabric.mod.json') ? parseJsonSafe(files.get('fabric.mod.json')) : null;
    const name = cleanText(url.searchParams.get('name'), 80) || cleanText(fmj && fmj.name, 80) || ns.replace(/[_-]+/g, ' ');
    if (models.some((m) => m.namespace === ns)) return sendJson(res, 409, { error: `A model with the pack name "${ns}" already exists. Delete it first or use a different namespace.` });

    const uploadedName = cleanName(url.searchParams.get('filename') || `${ns}.jar`);
    const modId = modIdOf(ns);
    let file = uploadedName.toLowerCase().endsWith('.jar') && uploadedName.toLowerCase().startsWith(modId + '-') ? uploadedName : null;
    const built = buildModelJar(buf, files, info, { name, by: cleanText(url.searchParams.get('by'), 24), changed: false }, null);
    if (!file) file = cleanName(`${modId}-${(built.version || '1.0.0').replace(/[^\w.+-]/g, '_')}.jar`);
    const parent = path.join(SHARE_DIR, MODELS_DIR);
    fs.mkdirSync(parent, { recursive: true });
    const folder = uniqueName(parent, cleanName(name), true);
    const m = {
      id: nextModelId++, name, note: cleanText(url.searchParams.get('note'), 300), by: cleanText(url.searchParams.get('by'), 24),
      added: Date.now(), folder, file, baseFile: file, build: 1, version: built.version || '', status: 'proposed', uploadedFile: null, uploadedAt: null, skins: [],
    };
    try { storeModel(m, built.data, files, info); } catch (e) { return sendJson(res, 500, { error: 'Could not save the model: ' + e.message }); }
    models.push(m);
    saveModels();
    log(req, `model added      ${name} (${file}, ${formatSize(m.size)})${m.by ? ' by ' + m.by : ''}`);
    sendJson(res, 201, modelInfo(m, req));
  });
}

// PUT /api/models/:id/skins?name=&by=   body = a PNG. It becomes assets/<pack>/textures/entity/<name>.png in a rebuilt jar.
function uploadSkin(req, res, m, url) {
  readRaw(req, SKIN_MAX, (buf, tooBig) => {
    if (tooBig) return sendJson(res, 413, { error: `Skins are limited to ${formatSize(SKIN_MAX)}` });
    const png = buf && pngInfo(buf);
    if (!png) return sendJson(res, 400, { error: 'Skins must be PNG files' });
    if (png.width > 2048 || png.height > 2048) return sendJson(res, 400, { error: 'Easy Model Entities ignores textures over 2048 pixels' });
    const skin = String(url.searchParams.get('name') || '').toLowerCase().replace(/\.png$/, '').replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!skin) return sendJson(res, 400, { error: 'The skin needs a name (letters, numbers, _ or -)' });
    const texturePath = `assets/${m.namespace}/textures/entity/${skin}.png`;
    let files;
    try { files = readZip(fs.readFileSync(path.join(modelDir(m), m.file))); } catch (e) { return sendJson(res, 500, { error: 'Could not read the stored model: ' + e.message }); }
    if (files.has(texturePath)) return sendJson(res, 409, { error: `This model already has a texture called "${skin}"` });
    files.set(texturePath, buf);
    const info = inspectModel(files);
    m.build += 1;
    const base = (m.version || '1.0.0').replace(/\+b\d+$/, '');
    const version = `${base}+b${m.build}`;
    m.file = m.baseFile.replace(/\.jar$/i, '') + `+b${m.build}.jar`;
    const built = buildModelJar(null, files, info, { name: m.name, by: m.by, changed: true }, version);
    m.version = built.version;
    try { storeModel(m, built.data, files, info); } catch (e) { return sendJson(res, 500, { error: 'Could not save the model: ' + e.message }); }
    m.skins.push({ name: skin, id: `${m.namespace}:textures/entity/${skin}.png`, by: cleanText(url.searchParams.get('by'), 24), added: Date.now(), width: png.width, height: png.height });
    saveModels();
    log(req, `skin added       ${m.name}: ${skin} -> ${m.file}`);
    sendJson(res, 201, modelInfo(m, req));
  });
}

function patchModel(req, res, m) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    if ('note' in body) m.note = cleanText(body.note, 300);
    if ('name' in body) {
      const name = cleanText(body.name, 80);
      if (!name) return sendJson(res, 400, { error: 'The model needs a name' });
      m.name = name;
    }
    if ('status' in body) {
      if (body.status === 'uploaded') { m.status = 'uploaded'; m.uploadedFile = typeof body.file === 'string' && body.file ? body.file : m.file; m.uploadedAt = Date.now(); }
      else if (body.status === 'proposed') { m.status = 'proposed'; m.uploadedFile = null; m.uploadedAt = null; }
    }
    saveModels();
    log(req, `model updated    ${m.name} (${m.status}${m.uploadedFile && m.uploadedFile !== m.file ? ', update pending' : ''})`);
    sendJson(res, 200, modelInfo(m, req));
  });
}

// What the installer and the admin's apply command read: one entry per model in the pack.json mod format.
function modelPackEntries(req, res, url) {
  const status = url.searchParams.get('status') || 'uploaded';
  const host = req.headers.host || 'localhost';
  const list = models
    .filter((m) => status === 'all' || (status === 'proposed' ? m.status !== 'uploaded' || m.uploadedFile !== m.file : m.status === 'uploaded'))
    .filter((m) => fs.existsSync(path.join(modelDir(m), m.file)))
    .map((m) => ({
      id: m.id, name: m.name, match: `${modIdOf(m.namespace)}-*.jar`, file: m.file, sha256: m.sha256,
      url: `http://${host}/files/${encSegs([MODELS_DIR, m.folder, m.file])}`,
      page: `http://${host}/#models`, status: m.status, pending: m.status === 'uploaded' && m.uploadedFile !== m.file,
    }));
  sendJson(res, 200, list);
}

function downloadModels(req, res, url) {
  const status = url.searchParams.get('status') || 'all';
  const chosen = models.filter((m) => status === 'all' || (status === 'proposed' ? m.status !== 'uploaded' || m.uploadedFile !== m.file : m.status === 'uploaded'));
  const entries = [{ dir: true, full: path.join(SHARE_DIR, MODELS_DIR), zipPath: 'models/', size: 0, mtime: Date.now() }];
  for (const m of chosen) {
    const full = path.join(modelDir(m), m.file);
    try {
      const s = fs.statSync(full);
      entries.push({ dir: false, full, zipPath: 'models/' + m.file, size: s.size, mtime: s.mtimeMs });
    } catch { /* missing jar, skip it */ }
  }
  if (entries.length === 1) return sendJson(res, 404, { error: 'No models to download' });
  // ?mark=1 is the admin's "download for the server" button: every model in the zip counts as uploaded from now on.
  if (url.searchParams.get('mark') === '1' && req.method === 'GET') {
    for (const m of chosen) { m.status = 'uploaded'; m.uploadedFile = m.file; m.uploadedAt = Date.now(); }
    saveModels();
    log(req, `models marked    ${chosen.length} model${chosen.length === 1 ? '' : 's'} as uploaded (download)`);
  }
  return downloadZip(req, res, { full: path.join(SHARE_DIR, MODELS_DIR), name: 'models', segs: [MODELS_DIR] }, entries);
}

function modelTexture(req, res, m, fileRaw) {
  let file = '';
  try { file = decodeURIComponent(fileRaw); } catch { /* bad escape */ }
  const t = (m.textures || []).find((x) => x.file === file);
  const full = t && path.join(modelDir(m), 'textures', t.file);
  if (!t || !fs.existsSync(full)) return sendJson(res, 404, { error: 'Texture not found' });
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  fs.createReadStream(full).pipe(res);
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

    if (req.method === 'GET' && p === '/api/models') return listModels(req, res);
    if (req.method === 'PUT' && p === '/api/models/upload') return uploadModel(req, res, url);
    if (req.method === 'GET' && p === '/api/models/pack-entries') return modelPackEntries(req, res, url);
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/api/models/download') return downloadModels(req, res, url);
    if (p.startsWith('/api/models/')) {
      const [idPart, action, extra] = p.slice('/api/models/'.length).split('/');
      const m = models.find((x) => String(x.id) === idPart);
      if (!m) return sendJson(res, 404, { error: 'Model not found' });
      if (req.method === 'GET' && action === 'texture' && extra) return modelTexture(req, res, m, extra);
      if (req.method === 'PUT' && action === 'skins') return uploadSkin(req, res, m, url);
      if (req.method === 'PATCH' && !action) return patchModel(req, res, m);
      if (req.method === 'DELETE' && !action) {
        if (!isLocal(req)) return sendJson(res, 403, { error: 'Only the host PC can delete models' });
        fs.rmSync(modelDir(m), { recursive: true, force: true });
        touched(modelDir(m), false);
        models = models.filter((x) => x !== m);
        saveModels();
        log(req, `model removed    ${m.name}`);
        return sendJson(res, 200, { ok: true });
      }
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
  console.log(`  Models:              ${MODELS_FILE} (${models.length} models)`);
  console.log('  Close this window to stop the server.\n');
});
