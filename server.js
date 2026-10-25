// LearnerAI server — zero dependencies. Serves /public and a tiny JSON-file auth + progress API.
// Usage: node server.js   (PORT env var optional, default 3000)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// On hosts with a persistent disk (e.g. Render), point DATA_DIR at the mounted disk path.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_DAYS = 30;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// ---------- JSON file store ----------
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
const db = {
  users: loadJson(USERS_FILE, { users: {} }),
  sessions: loadJson(SESSIONS_FILE, { sessions: {} }),
  saveUsers() { saveJson(USERS_FILE, this.users); },
  saveSessions() { saveJson(SESSIONS_FILE, this.sessions); },
};

// ---------- helpers ----------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function currentUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = db.sessions.sessions[sid];
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_DAYS * 86400e3) {
    delete db.sessions.sessions[sid];
    db.saveSessions();
    return null;
  }
  const user = db.users.users[s.username];
  return user ? { username: s.username, user, sid } : null;
}
function sessionCookie(req, sid, maxAge = SESSION_DAYS * 86400) {
  // Behind an HTTPS proxy (Render, Railway, etc.) mark the cookie Secure.
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
function sanitizeDone(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const id of list) {
    if (typeof id === 'string' && id.length <= 400) out.push(id);
    if (out.length > 50000) break;
  }
  return Array.from(new Set(out));
}
function newSession(usernameKey) {
  const sid = crypto.randomBytes(32).toString('hex');
  db.sessions.sessions[sid] = { username: usernameKey, createdAt: Date.now() };
  db.saveSessions();
  return sid;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/health') return send(res, 200, { ok: true });
  try {
    if (route === 'POST /api/signup') {
      const { username = '', password = '' } = await readBody(req);
      const name = String(username).trim();
      if (!USERNAME_RE.test(name)) return send(res, 400, { error: 'Username: 3-24 letters, numbers, _ . or -' });
      if (typeof password !== 'string' || password.length < 6) return send(res, 400, { error: 'Password must be at least 6 characters' });
      const key = name.toLowerCase();
      if (db.users.users[key]) return send(res, 409, { error: 'That username is taken' });
      const { salt, hash } = hashPassword(password);
      db.users.users[key] = { username: name, salt, hash, createdAt: new Date().toISOString(), progress: { done: [], updatedAt: null } };
      db.saveUsers();
      const sid = newSession(key);
      return send(res, 201, { username: name, done: [] }, { 'Set-Cookie': sessionCookie(req, sid) });
    }
    if (route === 'POST /api/login') {
      const { username = '', password = '' } = await readBody(req);
      const key = String(username).trim().toLowerCase();
      const user = db.users.users[key];
      if (!user || typeof password !== 'string' || !verifyPassword(password, user.salt, user.hash)) {
        return send(res, 401, { error: 'Wrong username or password' });
      }
      const sid = newSession(key);
      return send(res, 200, { username: user.username, done: user.progress.done }, { 'Set-Cookie': sessionCookie(req, sid) });
    }
    if (route === 'POST /api/logout') {
      const me = currentUser(req);
      if (me) { delete db.sessions.sessions[me.sid]; db.saveSessions(); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    if (route === 'GET /api/me') {
      const me = currentUser(req);
      if (!me) return send(res, 401, { error: 'Not signed in' });
      return send(res, 200, { username: me.user.username, done: me.user.progress.done, updatedAt: me.user.progress.updatedAt });
    }
    if (route === 'PUT /api/progress') {
      const me = currentUser(req);
      if (!me) return send(res, 401, { error: 'Not signed in' });
      const body = await readBody(req);
      const done = sanitizeDone(body.done);
      if (!done) return send(res, 400, { error: 'Expected { done: string[] }' });
      me.user.progress = { done, updatedAt: new Date().toISOString() };
      db.saveUsers();
      return send(res, 200, { ok: true, count: done.length, updatedAt: me.user.progress.updatedAt });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    return send(res, 400, { error: err.message || 'Bad request' });
  }
}

// ---------- static ----------
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, url);
}).listen(PORT, () => {
  console.log(`LearnerAI running at http://localhost:${PORT}`);
});
