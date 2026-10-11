// LAN party file share. No dependencies: run with `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pipeline } = require('stream');
const zlib = require('zlib');
const crypto = require('crypto');
const net = require('net');
const { crc32 } = zlib;

// ---------- configuration ----------
// Settings come from the environment or a .env file next to server.js (KEY=value lines). Nothing is needed for a
// LAN party: the defaults are the old behaviour. For a hosted server set MODE=hosted (see README, "Hosting").
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* no .env, or Node < 20.12 */ }
const MODE = (process.env.MODE || 'lan').toLowerCase() === 'hosted' ? 'hosted' : 'lan';
const AUTH = (process.env.AUTH || (MODE === 'hosted' ? 'on' : 'off')).toLowerCase() === 'on'; // accounts + login
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname); // where shared/ and the json files live
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, ''); // e.g. https://share.example.com, used in links the installer follows
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // lets the deploy command on the Minecraft server act as admin
const INVITE_CODE = process.env.INVITE_CODE || ''; // needed to register when set
const TRUST_PROXY = (process.env.TRUST_PROXY || (MODE === 'hosted' ? 'on' : 'off')).toLowerCase() === 'on'; // behind Caddy/nginx
const BIND = process.env.BIND || '0.0.0.0';
const MC_SERVER = process.env.MC_SERVER || ''; // host:port of the Minecraft server, shows who is online

const PORT = Number(process.env.PORT) || 8080;
const SHARE_DIR = path.join(DATA_DIR, 'shared');
const INCOMING_DIR = path.join(DATA_DIR, 'incoming'); // partial uploads, moved into SHARE_DIR when complete
const INDEX_FILE = path.join(__dirname, 'public', 'index.html');
const CHAT_FILE = path.join(DATA_DIR, 'chat.jsonl'); // one message per line, kept forever
const MODS_FILE = path.join(DATA_DIR, 'mods.json');
const POIS_FILE = path.join(DATA_DIR, 'pois.json');
const RELEASES_FILE = path.join(DATA_DIR, 'releases.json');
const MODELS_FILE = path.join(DATA_DIR, 'models.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DEPLOYS_FILE = path.join(DATA_DIR, 'deploys.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key'); // signs session cookies, created on first start
const DATA_FILES = ['chat.jsonl', 'mods.json', 'pois.json', 'releases.json', 'models.json', 'users.json', 'deploys.json'];
const MODELS_DIR = 'Models'; // folder inside shared/ with one subfolder per Easy Model Entities model
const INSTALLER_DIR = 'Mods Installer'; // folder inside shared/ that holds one subfolder per installer version
const SHIPPED_INSTALLER = path.join(__dirname, 'tools', 'Install-MinecraftMods.cmd'); // put into every version zip
const CHUNK = 1 << 20; // 1 MB stream buffers for faster transfers

fs.mkdirSync(SHARE_DIR, { recursive: true });
fs.rmSync(INCOMING_DIR, { recursive: true, force: true }); // drop leftovers from a crash
fs.mkdirSync(INCOMING_DIR, { recursive: true });

// node server.js --export backup.zip   /   node server.js --import backup.zip   (see the bottom of this file)
const CLI = process.argv[2] && process.argv[2].startsWith('--') ? { cmd: process.argv[2].slice(2), file: process.argv[3] } : null;

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
  if (TRUST_PROXY) return false; // behind a proxy every request looks local; rights come from accounts instead
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function clientIp(req) {
  const fwd = TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
}

// Who may delete things and manage the site: an admin account, the deploy command's token, or (LAN mode without
// accounts) the host PC itself, as before.
function isAdmin(req) {
  if (req.user && req.user.role === 'admin') return true;
  if (ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN) return true;
  return !AUTH && isLocal(req);
}

// The site's own address for links that other machines follow (the installer, the deploy command).
function siteBase(req) {
  return PUBLIC_URL || `http://${req.headers.host || 'localhost'}`;
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
  sendJson(res, 200, { path: dir.segs.join('/'), entries, free, canDelete: isAdmin(req) });
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
    const name = req.user ? req.user.name : String(body.name || '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 24);
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
    const by = req.user ? req.user.name : cleanText(body.by, 24);
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
    poi.by = req.user ? req.user.name : cleanText(body.by, 24);
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
    download: single ? '/files/' + encSegs([...segs, single]) : `/api/releases/${r.id}/download`,
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
  sendJson(res, 200, { releases: list, tags: RELEASE_TAGS, canDelete: isAdmin(req) });
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
      by: req.user ? req.user.name : cleanText(body.by, 24), added: Date.now(), folder, status: 'uploading',
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
  if (!ownUpload && !isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can delete versions' });
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
    if (!e || e.dir || e.data || e.size > SMALL || ahead.has(i)) return;
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

      if (e.data || e.size <= SMALL) {
        // Small file: one read and one write (game folders often hold thousands of these).
        const data = e.data || await ahead.get(i);
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
  m.sha256 = crypto.createHash('sha256').update(jarData).digest('hex');
  m.warnings = info.warnings.slice(0, 10);
  touched(dir, false);
}

function modelInfo(m, req) {
  return {
    ...m,
    path: [MODELS_DIR, m.folder].join('/'),
    download: '/files/' + encSegs([MODELS_DIR, m.folder, m.file]),
    url: `${siteBase(req)}/files/${encSegs([MODELS_DIR, m.folder, m.file])}`,
    textures: (m.textures || []).map((t) => ({ ...t, src: `/api/models/${m.id}/texture/${encodeURIComponent(t.file)}` })),
    profiles: (m.profiles || []).map((p) => ({ ...p, bbmodel: `/api/models/${m.id}/bbmodel/${encodeURIComponent(p.name)}` })),
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
    models: list, canDelete: isAdmin(req),
    packEntriesUrl: `${siteBase(req)}/api/models/pack-entries?status=uploaded`,
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
      id: nextModelId++, name, note: cleanText(url.searchParams.get('note'), 300), by: req.user ? req.user.name : cleanText(url.searchParams.get('by'), 24),
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
  const base = siteBase(req);
  const list = models
    .filter((m) => status === 'all' || (status === 'proposed' ? m.status !== 'uploaded' || m.uploadedFile !== m.file : m.status === 'uploaded'))
    .filter((m) => fs.existsSync(path.join(modelDir(m), m.file)))
    .map((m) => ({
      id: m.id, name: m.name, match: `${modIdOf(m.namespace)}-*.jar`, file: m.file, sha256: m.sha256,
      url: `${base}/files/${encSegs([MODELS_DIR, m.folder, m.file])}`,
      page: `${base}/#models`, status: m.status, pending: m.status === 'uploaded' && m.uploadedFile !== m.file,
    }));
  sendJson(res, 200, list);
}


// "2026-10-11.3" -> "2026-10-11.4", "1.4.2" -> "1.4.3", "beta" -> "beta.1"; keeps going until the version is unused.
function nextVersion(version) {
  let v = version;
  do {
    const m = /^(.*?)(\d+)$/.exec(v);
    v = m ? m[1] + (Number(m[2]) + 1) : v + '.1';
  } while (releases.some((r) => r.version.toLowerCase() === v.toLowerCase()));
  return v;
}

// After models were marked as uploaded: publish a new installer version based on the current Recent one, so players
// see "updated" in the banner. Its pack.json gets the bumped version, this site's model feed under modListUrls, and the
// uploaded model jars bundled as a fallback for when the site is unreachable.
function autoReleasePack(req, changedModels) {
  const ready = releases.filter((r) => r.status === 'ready').sort((a, b) => b.added - a.added);
  const base = ready.find((r) => r.tags.includes('Recent')) || ready[0];
  if (!base) return null;
  const baseDir = path.join(SHARE_DIR, INSTALLER_DIR, base.folder);
  const packFile = path.join(baseDir, 'pack.json');
  if (!fs.existsSync(packFile)) { log(req, `pack update      skipped: ${base.folder} has no pack.json at its top level`); return null; }
  const pack = parseJsonSafe(fs.readFileSync(packFile));
  if (!pack || !Array.isArray(pack.mods)) { log(req, `pack update      skipped: ${base.folder}/pack.json is not readable`); return null; }

  const version = nextVersion(String(pack.packVersion || base.version || '1'));
  const parent = path.join(SHARE_DIR, INSTALLER_DIR);
  const folder = uniqueName(parent, cleanName(`Mods Installer ${/^\d/.test(version) ? 'v' : ''}${version}`), true);
  const dir = path.join(parent, folder);
  fs.cpSync(baseDir, dir, { recursive: true });

  const feed = `${siteBase(req)}/api/models/pack-entries?status=uploaded`;
  pack.packVersion = version;
  pack.modListUrls = [...(Array.isArray(pack.modListUrls) ? pack.modListUrls : []).filter((u) => typeof u === 'string' && !/FRIEND-PC|\/api\/models\/pack-entries/.test(u)), feed];
  fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
  for (const m of models.filter((x) => x.status === 'uploaded')) {
    const match = `${modIdOf(m.namespace)}-*.jar`;
    for (const e of fs.readdirSync(path.join(dir, 'mods'))) {
      if (e.startsWith(`${modIdOf(m.namespace)}-`) && e.toLowerCase().endsWith('.jar') && e !== m.file) fs.rmSync(path.join(dir, 'mods', e), { force: true });
    }
    try { fs.copyFileSync(path.join(modelDir(m), m.file), path.join(dir, 'mods', m.file)); } catch { continue; }
    const entry = { name: m.name, match, localFile: `mods/${m.file}` };
    const i = pack.mods.findIndex((x) => x && x.match === match);
    if (i >= 0) pack.mods[i] = { ...pack.mods[i], ...entry }; else pack.mods.push(entry);
  }
  fs.writeFileSync(packFile.replace(baseDir, dir), JSON.stringify(pack, null, 2) + '\n');
  touched(dir, false);

  const names = changedModels.map((m) => m.name).join(', ');
  const release = {
    id: nextReleaseId++, version, tags: ['Recent'], note: `Models updated: ${names}`, by: 'models', added: Date.now(), folder, status: 'ready',
  };
  releases.push(release);
  claimRecent(release);
  saveReleases();
  log(req, `pack update      ${folder} from ${base.folder} (${names})`);
  return release;
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
    const changed = chosen.filter((m) => m.status !== 'uploaded' || m.uploadedFile !== m.file);
    for (const m of chosen) { m.status = 'uploaded'; m.uploadedFile = m.file; m.uploadedAt = Date.now(); }
    saveModels();
    log(req, `models marked    ${chosen.length} model${chosen.length === 1 ? '' : 's'} as uploaded (download)`);
    if (changed.length) autoReleasePack(req, changed); // new installer version so players know to run it again
  }
  return downloadZip(req, res, { full: path.join(SHARE_DIR, MODELS_DIR), name: 'models', segs: [MODELS_DIR] }, entries);
}

// GET /api/models/:id/bbmodel/<profile name>  -> the Blockbench model JSON of that profile, read out of the jar.
function modelBBModel(req, res, m, nameRaw) {
  let name = '';
  try { name = decodeURIComponent(nameRaw); } catch { /* bad escape */ }
  const profile = (m.profiles || []).find((x) => x.name === name);
  if (!profile) return sendJson(res, 404, { error: 'Profile not found' });
  const [ns, modelPath] = profile.model.split(':');
  try {
    const files = readZip(fs.readFileSync(path.join(modelDir(m), m.file)));
    const data = files.get(`assets/${ns}/${modelPath}.bbmodel`);
    if (!data) return sendJson(res, 404, { error: 'Model file not found in the jar' });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (e) { sendJson(res, 500, { error: 'Could not read the model: ' + e.message }); }
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


// ---------- accounts, sessions, install tracking, deploy reports ----------
// AUTH=on (default in hosted mode): every API call needs a signed-in user. Passwords are scrypt-hashed. A session is
// a signed cookie; the installer and the deploy command use a bearer token instead (each user has one).

let users = loadList(USERS_FILE);
let nextUserId = users.reduce((max, u) => Math.max(max, u.id), 0) + 1;
const saveUsers = () => saveList(USERS_FILE, users);
let deploys = loadList(DEPLOYS_FILE); // reports from the Minecraft server's deploy command, newest last
const saveDeploys = () => saveList(DEPLOYS_FILE, deploys);

let SECRET = process.env.SESSION_SECRET || '';
if (!SECRET) {
  try { SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim(); } catch { /* first start */ }
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 }); }
}
const SESSION_DAYS = 60;
const loginAttempts = new Map(); // ip -> { count, until }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function checkPassword(user, password) {
  const { hash } = hashPassword(password, user.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
}
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

function sessionCookie(user) {
  const data = `${user.id}.${Date.now() + SESSION_DAYS * 864e5}`;
  const secure = PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
  return `sid=${data}.${sign(data)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, created: u.created, lastSeen: u.lastSeen, install: u.install || null };
}

// Sets req.user from the session cookie, or from "Authorization: Bearer <install token>" / ?token= (installer, feed links).
function authenticate(req, url) {
  req.user = null;
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (m) {
    const [id, exp, sig] = m[1].split('.');
    if (id && exp && sig && sign(`${id}.${exp}`) === sig && Number(exp) > Date.now()) {
      req.user = users.find((u) => u.id === Number(id)) || null;
    }
  }
  if (!req.user) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    const token = (bearer && bearer[1]) || url.searchParams.get('token');
    if (token) req.user = users.find((u) => u.token === token) || null;
  }
  if (req.user) req.user.lastSeen = Date.now(); // saved with the next change, not worth a write per request
}

function postRegister(req, res) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const name = cleanText(body.name, 24);
    const password = String(body.password || '');
    if (!/^[\w .-]{2,24}$/.test(name)) return sendJson(res, 400, { error: 'Name: 2 to 24 letters, numbers, spaces, . _ -' });
    if (password.length < 6) return sendJson(res, 400, { error: 'Password: at least 6 characters' });
    if (INVITE_CODE && String(body.invite || '') !== INVITE_CODE) return sendJson(res, 403, { error: 'Wrong invite code' });
    if (users.some((u) => u.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 409, { error: 'That name is taken' });
    const user = {
      id: nextUserId++, name, role: users.length ? 'member' : 'admin', ...hashPassword(password),
      token: crypto.randomBytes(24).toString('base64url'), created: Date.now(), lastSeen: Date.now(), install: null,
    };
    users.push(user);
    saveUsers();
    log(req, `account created  ${name} (${user.role})`);
    res.setHeader('Set-Cookie', sessionCookie(user));
    sendJson(res, 201, { user: publicUser(user) });
  });
}

function postLogin(req, res) {
  const ip = clientIp(req);
  const a = loginAttempts.get(ip);
  if (a && a.count >= 10 && Date.now() < a.until) return sendJson(res, 429, { error: 'Too many attempts, wait 10 minutes' });
  readJson(req, (body) => {
    const name = cleanText(body && body.name, 24);
    const user = users.find((u) => u.name.toLowerCase() === name.toLowerCase());
    if (!user || !checkPassword(user, String((body && body.password) || ''))) {
      const next = a && Date.now() < a.until ? a : { count: 0, until: 0 };
      next.count++;
      next.until = Date.now() + 10 * 60 * 1000;
      loginAttempts.set(ip, next);
      log(req, `login FAILED     ${name}`);
      return sendJson(res, 401, { error: 'Wrong name or password' });
    }
    loginAttempts.delete(ip);
    user.lastSeen = Date.now();
    saveUsers();
    log(req, `login            ${user.name}`);
    res.setHeader('Set-Cookie', sessionCookie(user));
    sendJson(res, 200, { user: publicUser(user) });
  });
}

function getMe(req, res) {
  const current = currentRelease();
  sendJson(res, 200, {
    auth: AUTH, mode: MODE, user: req.user ? { ...publicUser(req.user), token: req.user.token } : null, admin: isAdmin(req),
    inviteNeeded: !!INVITE_CODE, usersExist: users.length > 0, current: current ? current.version : null,
    server: deploys.length ? deploys[deploys.length - 1] : null,
  });
}

function patchUser(req, res, target) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const self = req.user && req.user.id === target.id;
    if ('password' in body) {
      if (!self && !isAdmin(req)) return sendJson(res, 403, { error: 'Not allowed' });
      if (String(body.password).length < 6) return sendJson(res, 400, { error: 'Password: at least 6 characters' });
      Object.assign(target, hashPassword(String(body.password)));
    }
    if ('role' in body) {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can change roles' });
      if (self && body.role !== 'admin') return sendJson(res, 400, { error: 'You cannot remove your own admin role' });
      target.role = body.role === 'admin' ? 'admin' : 'member';
    }
    if (body.newToken) {
      if (!self && !isAdmin(req)) return sendJson(res, 403, { error: 'Not allowed' });
      target.token = crypto.randomBytes(24).toString('base64url');
    }
    saveUsers();
    log(req, `account updated  ${target.name}`);
    sendJson(res, 200, { user: publicUser(target) });
  });
}

// The installer posts this at the end of every run (token identifies the player; the deploy command adds target=server).
function postInstallReport(req, res) {
  readJson(req, (body) => {
    if (!body) return sendJson(res, 400, { error: 'Bad request' });
    const report = {
      packVersion: cleanText(body.packVersion, 40), ok: !!body.ok, time: Date.now(),
      minecraft: cleanText(body.minecraft, 20), problems: Array.isArray(body.problems) ? body.problems.map((p) => cleanText(p, 300)).slice(0, 20) : [],
      mods: Array.isArray(body.mods) ? body.mods.map((m) => cleanText(m, 120)).slice(0, 200) : [],
      machine: cleanText(body.machine, 60),
    };
    if (body.target === 'server') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Server deploy reports need the admin token' });
      report.by = req.user ? req.user.name : 'deploy command';
      deploys.push(report);
      if (deploys.length > 100) deploys = deploys.slice(-100);
      saveDeploys();
      log(req, `server deploy    pack ${report.packVersion} (${report.mods.length} mods, ${report.ok ? 'ok' : 'with problems'})`);
      return sendJson(res, 201, { ok: true });
    }
    if (!req.user) return sendJson(res, 401, { error: 'Unknown install token. Download the installer again from the site while signed in.' });
    req.user.install = report;
    saveUsers();
    log(req, `install report   ${req.user.name}: pack ${report.packVersion} (${report.ok ? 'ok' : 'with problems'})`);
    sendJson(res, 201, { ok: true });
  }, 64 * 1024);
}

function currentRelease() {
  const ready = releases.filter((r) => r.status === 'ready').sort((a, b) => b.added - a.added);
  return ready.find((r) => r.tags.includes('Recent')) || ready[0] || null;
}

// Installer download for a signed-in user: the zip's pack.json gets the report address and the user's token, so the
// installer can fetch the model feed and report back. Without accounts it is the plain folder zip.
function downloadRelease(req, res, release) {
  const segs = [INSTALLER_DIR, release.folder];
  const folder = sharedPath(segs);
  if (!folder || !folder.stat.isDirectory()) return sendJson(res, 404, { error: 'Version not found' });
  const entries = zipEntries(folder.full, folder.name);
  // The zip always carries the installer this app ships (tools/), not the copy that was uploaded with the version:
  // older copies know nothing about server mode or install reports, and the deploy command needs both.
  const installerEntry = entries.find((e) => !e.dir && e.zipPath === folder.name + '/Install-MinecraftMods.cmd');
  if (installerEntry && fs.existsSync(SHIPPED_INSTALLER)) {
    installerEntry.data = fs.readFileSync(SHIPPED_INSTALLER);
    installerEntry.size = installerEntry.data.length;
    installerEntry.mtime = fs.statSync(SHIPPED_INSTALLER).mtimeMs;
  }
  const packEntry = entries.find((e) => !e.dir && e.zipPath === folder.name + '/pack.json');
  if (packEntry && req.user) {
    const pack = parseJsonSafe(fs.readFileSync(packEntry.full));
    if (pack && typeof pack === 'object') {
      pack.report = { url: `${siteBase(req)}/api/installs`, token: req.user.token, user: req.user.name };
      packEntry.data = Buffer.from(JSON.stringify(pack, null, 2) + '\n');
      packEntry.size = packEntry.data.length;
    }
  }
  return downloadZip(req, res, folder, entries);
}

// Everything under DATA_DIR as one zip: the shared files plus the json files. Restore with  node server.js --import
function exportEntries() {
  const entries = zipEntries(SHARE_DIR, 'shared');
  for (const f of DATA_FILES) {
    const full = path.join(DATA_DIR, f);
    if (!fs.existsSync(full)) continue;
    const st = fs.statSync(full);
    entries.push({ dir: false, full, zipPath: f, size: st.size, mtime: st.mtimeMs });
  }
  return entries;
}


// ---------- Minecraft server status (the same ping the multiplayer screen does) ----------
let mcStatus = { enabled: !!MC_SERVER, online: false, checked: 0 };

function varint(n) {
  const out = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function readVarint(buf, pos) {
  let n = 0, shift = 0, i = pos;
  for (;;) {
    if (i >= buf.length) return null;
    const b = buf[i++];
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: n, next: i };
    shift += 7;
    if (shift > 35) return null;
  }
}
function packet(id, payload) {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
}
function motdText(d) {
  if (!d) return '';
  if (typeof d === 'string') return d;
  return (d.text || '') + (Array.isArray(d.extra) ? d.extra.map(motdText).join('') : '');
}

function pingMinecraft(address) {
  return new Promise((resolve) => {
    const [host, portStr] = address.split(':');
    const port = Number(portStr) || 25565;
    const sock = net.createConnection({ host, port });
    const chunks = [];
    let done = false;
    const finish = (result) => { if (!done) { done = true; sock.destroy(); resolve(result); } };
    const timer = setTimeout(() => finish({ online: false, error: 'timeout' }), 5000);
    const started = Date.now();
    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const handshake = Buffer.concat([varint(-1 >>> 0), varint(hostBuf.length), hostBuf, Buffer.from([port >> 8, port & 0xff]), varint(1)]);
      sock.write(Buffer.concat([packet(0, handshake), packet(0, Buffer.alloc(0))]));
    });
    sock.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const len = readVarint(buf, 0);
      if (!len || buf.length < len.next + len.value) return;
      const id = readVarint(buf, len.next);
      const strLen = id && readVarint(buf, id.next);
      if (!strLen) return finish({ online: false, error: 'bad response' });
      clearTimeout(timer);
      try {
        const j = JSON.parse(buf.toString('utf8', strLen.next, strLen.next + strLen.value));
        finish({
          online: true, latency: Date.now() - started,
          players: (j.players && j.players.online) || 0, max: (j.players && j.players.max) || 0,
          names: ((j.players && j.players.sample) || []).map((p) => p.name).filter(Boolean).sort(),
          version: (j.version && j.version.name) || '', motd: motdText(j.description).slice(0, 120),
        });
      } catch { finish({ online: false, error: 'bad json' }); }
    });
    sock.on('error', (e) => { clearTimeout(timer); finish({ online: false, error: e.code || e.message }); });
    sock.on('close', () => { clearTimeout(timer); finish({ online: false, error: 'closed' }); });
  });
}

async function refreshMcStatus() {
  if (!MC_SERVER) return;
  const r = await pingMinecraft(MC_SERVER);
  mcStatus = { enabled: true, address: MC_SERVER, checked: Date.now(), ...r };
}

// ---------- changelog: what changed between installer versions, from each version's pack.json ----------
function modKey(m) { return String((m && (m.match || m.name)) || '').toLowerCase(); }
function modSig(m) { return String((m && (m.localFile || m.file || m.url || m.modrinth)) || ''); }

function changelog() {
  const ready = releases.filter((r) => r.status === 'ready').sort((a, b) => a.added - b.added);
  const out = [];
  let prev = null;
  for (const r of ready) {
    const packFile = path.join(SHARE_DIR, INSTALLER_DIR, r.folder, 'pack.json');
    const pack = fs.existsSync(packFile) ? parseJsonSafe(fs.readFileSync(packFile)) : null;
    const mods = pack && Array.isArray(pack.mods) ? pack.mods.filter((m) => m && m.name) : null;
    const entry = { id: r.id, version: r.version, tags: r.tags, note: r.note, by: r.by, added: r.added, minecraft: pack && pack.minecraftVersion || '', mods: mods ? mods.map((m) => m.name) : null, diff: null };
    if (mods && prev) {
      const before = new Map(prev.map((m) => [modKey(m), m]));
      const after = new Map(mods.map((m) => [modKey(m), m]));
      entry.diff = {
        added: mods.filter((m) => !before.has(modKey(m))).map((m) => m.name),
        removed: prev.filter((m) => !after.has(modKey(m))).map((m) => m.name),
        changed: mods.filter((m) => before.has(modKey(m)) && modSig(before.get(modKey(m))) !== modSig(m)).map((m) => `${m.name}: ${path.basename(modSig(before.get(modKey(m)))) || '?'} -> ${path.basename(modSig(m)) || '?'}`),
      };
    }
    if (mods) prev = mods;
    out.push(entry);
  }
  return out.reverse();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  try {
    authenticate(req, url);
    // Account routes work without a session; everything else needs one when AUTH is on.
    if (p === '/api/me' && req.method === 'GET') return getMe(req, res);
    if (p === '/api/register' && req.method === 'POST') return postRegister(req, res);
    if (p === '/api/login' && req.method === 'POST') return postLogin(req, res);
    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; Max-Age=0');
      return sendJson(res, 200, { ok: true });
    }
    const isPage = (req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/model-viewer.js');
    if (AUTH && !req.user && !isPage && !(ADMIN_TOKEN && req.headers['x-admin-token'] === ADMIN_TOKEN)) {
      return sendJson(res, 401, { error: 'Sign in first', login: true });
    }

    if (p === '/api/installs' && req.method === 'POST') return postInstallReport(req, res);
    if (p === '/api/installs/manual' && req.method === 'POST') {
      // "I installed vX" without running the installer (e.g. installed by hand).
      if (!req.user) return sendJson(res, 401, { error: 'Sign in first' });
      return readJson(req, (body) => {
        const version = cleanText(body && body.packVersion, 40);
        if (!version) return sendJson(res, 400, { error: 'Which version?' });
        req.user.install = { packVersion: version, ok: true, time: Date.now(), manual: true, minecraft: '', problems: [], mods: [], machine: '' };
        saveUsers();
        log(req, `install (manual) ${req.user.name}: pack ${version}`);
        sendJson(res, 201, { ok: true });
      });
    }
    if (p === '/api/server-status' && req.method === 'GET') return sendJson(res, 200, mcStatus);
    if (p === '/api/releases/changelog' && req.method === 'GET') return sendJson(res, 200, { changelog: changelog() });
    if (p === '/api/users' && req.method === 'GET') {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can list accounts' });
      return sendJson(res, 200, { users: users.map(publicUser), current: (currentRelease() || {}).version || null });
    }
    if (p.startsWith('/api/users/')) {
      const target = users.find((u) => `/api/users/${u.id}` === p);
      if (!target) return sendJson(res, 404, { error: 'Account not found' });
      if (req.method === 'PATCH') return patchUser(req, res, target);
      if (req.method === 'DELETE') {
        if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can remove accounts' });
        if (req.user && req.user.id === target.id) return sendJson(res, 400, { error: 'You cannot remove yourself' });
        users = users.filter((u) => u !== target);
        saveUsers();
        log(req, `account removed  ${target.name}`);
        return sendJson(res, 200, { ok: true });
      }
    }
    if (p === '/api/deploys' && req.method === 'GET') return sendJson(res, 200, { deploys: deploys.slice(-20).reverse() });
    if (p === '/api/export' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can export' });
      return downloadZip(req, res, { full: DATA_DIR, name: 'lan-file-share-data', segs: ['export'] }, exportEntries()).catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Export failed' });
        else res.destroy();
      });
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(INDEX_FILE).pipe(res);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && p === '/model-viewer.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
      return req.method === 'HEAD' ? res.end() : fs.createReadStream(path.join(__dirname, 'public', 'model-viewer.js')).pipe(res);
    }
    if (req.method === 'GET' && p === '/api/files') return listFiles(req, res, url);
    if (req.method === 'PUT' && p === '/api/upload') return upload(req, res, url);
    if (req.method === 'POST' && p === '/api/folder') return reserveFolder(req, res, url);
    if (req.method === 'DELETE' && p.startsWith('/api/folder/')) return cancelFolder(req, res, p.slice('/api/folder/'.length));
    if (req.method === 'GET' && p === '/api/chat') return getChat(req, res, url);
    if (req.method === 'POST' && p === '/api/chat') return postChat(req, res);

    // Mods and POIs: everyone can add and edit, only the host PC can delete (same as files).
    if (req.method === 'GET' && p === '/api/title') return getTitle(req, res, url);
    if (req.method === 'GET' && p === '/api/mods') return sendJson(res, 200, { mods, canDelete: isAdmin(req) });
    if (req.method === 'POST' && p === '/api/mods') return postMod(req, res);
    if (p.startsWith('/api/mods/')) {
      const mod = mods.find((m) => `/api/mods/${m.id}` === p);
      if (!mod) return sendJson(res, 404, { error: 'Mod not found' });
      if (req.method === 'PATCH') return patchMod(req, res, mod);
      if (req.method === 'DELETE') {
        if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can remove mods' });
        mods = mods.filter((m) => m !== mod);
        saveMods();
        log(req, `mod removed      ${mod.name}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && p === '/api/releases') return listReleases(req, res);
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/api/releases/current/download' || /^\/api\/releases\/\d+\/download$/.test(p))) {
      const idPart = p.split('/')[3];
      const release = idPart === 'current' ? currentRelease() : releases.find((r) => String(r.id) === idPart);
      if (!release || release.status !== 'ready') return sendJson(res, 404, { error: 'Version not found' });
      return downloadRelease(req, res, release).catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'Could not zip that version' });
        else res.destroy();
      });
    }
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
      if (req.method === 'GET' && action === 'bbmodel' && extra) return modelBBModel(req, res, m, extra);
      if (req.method === 'PUT' && action === 'skins') return uploadSkin(req, res, m, url);
      if (req.method === 'PATCH' && !action) return patchModel(req, res, m);
      if (req.method === 'DELETE' && !action) {
        if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can delete models' });
        fs.rmSync(modelDir(m), { recursive: true, force: true });
        touched(modelDir(m), false);
        models = models.filter((x) => x !== m);
        saveModels();
        log(req, `model removed    ${m.name}`);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (req.method === 'GET' && p === '/api/pois') return sendJson(res, 200, { pois, types: POI_TYPES, canDelete: isAdmin(req) });
    if (req.method === 'POST' && p === '/api/pois') return postPoi(req, res);
    if (p.startsWith('/api/pois/')) {
      const poi = pois.find((x) => `/api/pois/${x.id}` === p);
      if (!poi) return sendJson(res, 404, { error: 'Place not found' });
      if (req.method === 'PATCH') return patchPoi(req, res, poi);
      if (req.method === 'DELETE') {
        if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can delete places' });
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
      if (!isAdmin(req)) return sendJson(res, 403, { error: 'Only an admin can delete files' });
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

// ---------- command line: export / import the data folder ----------
async function runCli() {
  if (CLI.cmd === 'export') {
    const out = path.resolve(CLI.file || `lan-file-share-${new Date().toISOString().slice(0, 10)}.zip`);
    const ws = fs.createWriteStream(out);
    // downloadZip writes to a response; a file stream with the few methods it uses works the same.
    const fakeRes = Object.assign(ws, { writeHead() {}, headersSent: false });
    await downloadZip({ method: 'GET', socket: {}, headers: {} }, fakeRes, { full: DATA_DIR, name: 'data', segs: ['export'] }, exportEntries());
    await new Promise((r) => ws.on('finish', r));
    console.log(`Exported ${DATA_DIR} to ${out} (${formatSize(fs.statSync(out).size)})`);
    return;
  }
  if (CLI.cmd === 'import') {
    if (!CLI.file || !fs.existsSync(CLI.file)) throw new Error('Usage: node server.js --import <backup.zip>');
    const fd = fs.openSync(CLI.file, 'r');
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(Math.min(size, 70000));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a zip file');
    let count = tail.readUInt16LE(eocd + 10);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    let cdSize = tail.readUInt32LE(eocd + 12);
    if (cdOffset === MAX32) { // zip64: the locator sits just before the end record
      const loc = eocd - 20;
      const z64 = Number(tail.readBigUInt64LE(loc + 8)) - (size - tail.length);
      const rec = Buffer.alloc(56);
      if (z64 >= 0 && z64 + 56 <= tail.length) tail.copy(rec, 0, z64, z64 + 56); else fs.readSync(fd, rec, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
      count = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOffset = Number(rec.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    // The zip may be an export (shared/ and the json files at the top) or a zip of the whole app folder, possibly
    // nested ("LAN Party/file-share/shared/..."). Find the folder that holds the data and import only the data.
    const allNames = [];
    for (let q = 0, i = 0; i < count; i++) {
      const nameLen = cd.readUInt16LE(q + 28);
      allNames.push(cd.toString('utf8', q + 46, q + 46 + nameLen).replace(/\\/g, '/'));
      q += 46 + nameLen + cd.readUInt16LE(q + 30) + cd.readUInt16LE(q + 32);
    }
    let prefix = '';
    for (const name of allNames) {
      const m = /^(.*?)(shared\/|chat\.jsonl$|releases\.json$|mods\.json$|models\.json$|pois\.json$)/.exec(name);
      if (m && (!prefix || m[1].length < prefix.length)) prefix = m[1];
    }
    console.log(prefix ? `Data found under "${prefix}" in the zip` : 'Data found at the top of the zip');
    const wanted = (name) => {
      if (!name.startsWith(prefix)) return null;
      const rel = name.slice(prefix.length);
      if (rel.startsWith('shared/') || DATA_FILES.includes(rel) || rel === 'secret.key') return rel;
      return null; // server.js, public/, start.bat, incoming/, .git etc. are not data
    };
    let p = 0;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let localOff = cd.readUInt32LE(p + 42);
      let name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
      for (let q = 0; q + 4 <= extra.length;) { // zip64 sizes/offset
        const id = extra.readUInt16LE(q), len = extra.readUInt16LE(q + 2);
        if (id === 1) {
          let r = q + 4;
          if (usize === MAX32) { usize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (csize === MAX32) { csize = Number(extra.readBigUInt64LE(r)); r += 8; }
          if (localOff === MAX32) { localOff = Number(extra.readBigUInt64LE(r)); }
        }
        q += 4 + len;
      }
      p += 46 + nameLen + extraLen + commentLen;
      if (name.includes('..') || name.startsWith('/')) continue;
      name = wanted(name);
      if (!name) continue;
      const target = path.join(DATA_DIR, name);
      if (name.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
      const head = Buffer.alloc(30);
      fs.readSync(fd, head, 0, 30, localOff);
      const start = localOff + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      await new Promise((resolve, reject) => {
        const src = csize ? fs.createReadStream(CLI.file, { start, end: start + csize - 1, highWaterMark: CHUNK }) : null;
        const dst = fs.createWriteStream(target);
        if (!src) return dst.end(resolve);
        const chain = method === 8 ? [src, zlib.createInflateRaw(), dst] : [src, dst];
        pipeline(...chain, (err) => (err ? reject(err) : resolve()));
      });
      n++;
    }
    fs.closeSync(fd);
    console.log(`Imported ${n} files into ${DATA_DIR}`);
    return;
  }
  throw new Error(`Unknown option --${CLI.cmd}. Use --export [file.zip] or --import <file.zip>`);
}

if (CLI) {
  runCli().then(() => process.exit(0), (err) => { console.error(err.message); process.exit(1); });
} else server.listen(PORT, BIND, () => {
  console.log(`\n  LAN File Share is running (${MODE} mode, accounts ${AUTH ? 'on' : 'off'}).\n`);
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
  if (AUTH) console.log(`  Accounts:            ${USERS_FILE} (${users.length} accounts${INVITE_CODE ? ', invite code set' : ', OPEN REGISTRATION, set INVITE_CODE'})`);
  if (MODE === 'hosted' && !ADMIN_TOKEN) console.log('  WARNING: ADMIN_TOKEN is not set, the deploy command cannot talk to this site.');
  if (MC_SERVER) { console.log(`  Minecraft server:    ${MC_SERVER} (pinged every 30 s for the online list)`); refreshMcStatus(); setInterval(refreshMcStatus, 30000); }
  console.log('  Close this window to stop the server.\n');
});
