/*
 * ChatApp Server — backend propio para ChatApp (sin Firebase).
 * - API REST: registro, login, búsqueda de usuarios, chats, historial.
 * - WebSocket: mensajes en tiempo real, presencia, "escribiendo", leídos.
 * - SQLite (node:sqlite, sin dependencias nativas) + ws (única dependencia).
 *
 * Variables de entorno:
 *   PORT      puerto HTTP (defecto 3000)
 *   DATA_DIR  carpeta del SQLite (defecto ./data)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TOKEN_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'chatapp.sqlite'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_lower TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats(
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg_chat ON messages(chat_id, id);
CREATE TABLE IF NOT EXISTS chat_state(
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  seen_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_id, user_id)
);
`);

/* ---------- utilidades ---------- */
const now = () => Date.now();
const uid = () => crypto.randomBytes(8).toString('hex');
const token = () => crypto.randomBytes(32).toString('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const chatIdFor = (a, b) => [a, b].sort().join('_');

function publicUser(u) {
  return u ? { id: u.id, name: u.name, email: u.email, lastSeen: u.last_seen } : null;
}

/* rate limit simple en memoria para auth */
const rl = new Map();
function rateLimited(ip, max = 20, windowMs = 10 * 60 * 1000) {
  const t = now();
  let e = rl.get(ip);
  if (!e || e.reset < t) { e = { count: 0, reset: t + windowMs }; rl.set(ip, e); }
  e.count++;
  return e.count > max;
}

/* ---------- HTTP helpers ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { resolve(null); }
    });
    req.on('error', reject);
  });
}
function getSession(tokenStr) {
  if (!tokenStr) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(tokenStr);
  if (!s || s.expires_at < now()) return null;
  return s;
}
function authUser(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const s = getSession(m && m[1]);
  if (!s) return null;
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  return u || null;
}
function isParticipant(chatId, userId) {
  const c = db.prepare('SELECT user_a, user_b FROM chats WHERE id = ?').get(chatId);
  return c && (c.user_a === userId || c.user_b === userId) ? c : null;
}
const peerOf = (c, me) => (c.user_a === me ? c.user_b : c.user_a);

/* ---------- WebSocket ---------- */
const conns = new Map(); // userId -> Set<ws>
function sendTo(userId, obj) {
  const set = conns.get(userId);
  if (!set) return;
  const data = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}
function chatPeers(userId) {
  // usuarios con los que comparte al menos un chat
  const rows = db.prepare(
    `SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END AS peer
     FROM chats WHERE user_a = ? OR user_b = ?`
  ).all(userId, userId, userId);
  return [...new Set(rows.map((r) => r.peer))];
}

/* ---------- rutas API ---------- */
async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress || 'unknown';

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  // ---- registro ----
  if (req.method === 'POST' && url.pathname === '/api/register') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Datos inválidos.' });
    const name = String(body.name || '').trim();
    const email = String(body.email || '').trim();
    const password = String(body.password || '');
    if (name.length < 2 || name.length > 40) return sendJson(res, 400, { error: 'Escribe tu nombre (2 a 40 letras).' });
    if (!EMAIL_RE.test(email)) return sendJson(res, 400, { error: 'Ese correo no parece válido.' });
    if (password.length < 6) return sendJson(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
    if (db.prepare('SELECT id FROM users WHERE email_lower = ?').get(email.toLowerCase())) {
      return sendJson(res, 409, { error: 'Ese correo ya está registrado. Prueba a iniciar sesión.' });
    }
    const id = uid();
    db.prepare(
      'INSERT INTO users(id,name,email,email_lower,name_lower,password_hash,created_at,last_seen) VALUES(?,?,?,?,?,?,?,?)'
    ).run(id, name, email, email.toLowerCase(), name.toLowerCase(), hashPassword(password), now(), now());
    const tok = token();
    db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
      .run(tok, id, now(), now() + TOKEN_DAYS * 86400000);
    return sendJson(res, 201, { token: tok, user: { id, name, email } });
  }

  // ---- login ----
  if (req.method === 'POST' && url.pathname === '/api/login') {
    if (rateLimited(ip)) return sendJson(res, 429, { error: 'Demasiados intentos. Espera unos minutos.' });
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'Datos inválidos.' });
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const u = db.prepare('SELECT * FROM users WHERE email_lower = ?').get(email);
    if (!u || !verifyPassword(password, u.password_hash)) {
      return sendJson(res, 401, { error: 'Correo o contraseña incorrectos.' });
    }
    const tok = token();
    db.prepare('INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)')
      .run(tok, u.id, now(), now() + TOKEN_DAYS * 86400000);
    db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now(), u.id);
    return sendJson(res, 200, { token: tok, user: { id: u.id, name: u.name, email: u.email } });
  }

  // ---- resto requiere auth ----
  const me = authUser(req);
  if (!me) return sendJson(res, 401, { error: 'No autenticado.' });

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer\s+(.+)$/i);
    if (m) db.prepare('DELETE FROM sessions WHERE token = ?').run(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/me') {
    return sendJson(res, 200, { user: { id: me.id, name: me.name, email: me.email } });
  }

  // ---- buscar usuarios ----
  if (req.method === 'GET' && url.pathname === '/api/users/search') {
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    if (q.length < 2) return sendJson(res, 200, { users: [] });
    const rows = db.prepare(
      `SELECT id,name,email,last_seen FROM users
       WHERE id != ? AND (email_lower LIKE ? ESCAPE '\\' OR name_lower LIKE ? ESCAPE '\\')
       LIMIT 10`
    ).all(me.id, q.replace(/[\\%_]/g, (c) => '\\' + c) + '%', q.replace(/[\\%_]/g, (c) => '\\' + c) + '%');
    return sendJson(res, 200, { users: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, lastSeen: r.last_seen })) });
  }

  // ---- lista de chats ----
  if (req.method === 'GET' && url.pathname === '/api/chats') {
    const chats = db.prepare(
      'SELECT * FROM chats WHERE user_a = ? OR user_b = ? ORDER BY updated_at DESC'
    ).all(me.id, me.id);
    const out = chats.map((c) => {
      const peerId = peerOf(c, me.id);
      const p = db.prepare('SELECT id,name,email,last_seen FROM users WHERE id = ?').get(peerId);
      const last = db.prepare('SELECT id,sender_id,text,created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1').get(c.id);
      const st = db.prepare('SELECT unread,seen_at FROM chat_state WHERE chat_id = ? AND user_id = ?').get(c.id, me.id);
      const peerSeen = db.prepare('SELECT seen_at FROM chat_state WHERE chat_id = ? AND user_id = ?').get(c.id, peerId);
      return {
        id: c.id,
        peer: p ? { id: p.id, name: p.name, email: p.email, lastSeen: p.last_seen } : { id: peerId, name: 'Usuario', email: '' },
        lastMessage: last ? { id: last.id, senderId: last.sender_id, text: last.text, createdAt: last.created_at } : null,
        updatedAt: c.updated_at,
        unread: st ? st.unread : 0,
        peerSeenAt: peerSeen ? peerSeen.seen_at : 0,
      };
    });
    return sendJson(res, 200, { chats: out });
  }

  // ---- crear/obtener chat ----
  if (req.method === 'POST' && url.pathname === '/api/chats') {
    const body = await readBody(req);
    const peerId = body && String(body.peerId || '');
    if (!peerId || peerId === me.id) return sendJson(res, 400, { error: 'Contacto inválido.' });
    const peer = db.prepare('SELECT id FROM users WHERE id = ?').get(peerId);
    if (!peer) return sendJson(res, 404, { error: 'Ese usuario no existe.' });
    const id = chatIdFor(me.id, peerId);
    const t = now();
    db.prepare('INSERT OR IGNORE INTO chats(id,user_a,user_b,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(id, ...[me.id, peerId].sort(), t, t);
    db.prepare('INSERT OR IGNORE INTO chat_state(chat_id,user_id) VALUES(?,?)').run(id, me.id);
    db.prepare('INSERT OR IGNORE INTO chat_state(chat_id,user_id) VALUES(?,?)').run(id, peerId);
    sendTo(peerId, { t: 'chats' });
    return sendJson(res, 200, { id });
  }

  // ---- historial de mensajes ----
  const mHist = url.pathname.match(/^\/api\/chats\/([^/]+)\/messages$/);
  if (req.method === 'GET' && mHist) {
    const chatId = decodeURIComponent(mHist[1]);
    if (!isParticipant(chatId, me.id)) return sendJson(res, 403, { error: 'Sin acceso a este chat.' });
    const before = parseInt(url.searchParams.get('before') || '0', 10) || 0;
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 100);
    const rows = before > 0
      ? db.prepare('SELECT id,sender_id,text,created_at FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(chatId, before, limit)
      : db.prepare('SELECT id,sender_id,text,created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
    const msgs = rows.reverse().map((r) => ({ id: r.id, senderId: r.sender_id, text: r.text, createdAt: r.created_at }));
    return sendJson(res, 200, { messages: msgs });
  }

  return sendJson(res, 404, { error: 'No encontrado.' });
}

/* ---------- servidor HTTP ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (url.pathname === '/ws') { res.writeHead(400); res.end(); return; }
    // estáticos
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) {
        // SPA: cualquier ruta desconocida sirve index.html
        if (req.method === 'GET' && !path.extname(p)) {
          fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
            if (e2) { res.writeHead(404); res.end(); return; }
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(d2);
          });
          return;
        }
        res.writeHead(404); res.end('No encontrado');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(data);
    });
  } catch (e) {
    try { sendJson(res, 500, { error: 'Error interno.' }); } catch { /* noop */ }
  }
});

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const s = getSession(url.searchParams.get('token'));
  if (!s) { ws.close(4401, 'no auth'); return; }
  const userId = s.user_id;
  ws.userId = userId;
  ws.openChat = null;
  if (!conns.get(userId)) conns.set(userId, new Set());
  conns.get(userId).add(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const t = now();

    if (msg.t === 'beat') {
      db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(t, userId);
      for (const peer of chatPeers(userId)) {
        sendTo(peer, { t: 'presence', userId, online: true, lastSeen: t });
      }
      return;
    }
    if (msg.t === 'open') {
      if (typeof msg.chatId === 'string' && isParticipant(msg.chatId, userId)) ws.openChat = msg.chatId;
      return;
    }
    if (msg.t === 'close') { ws.openChat = null; return; }

    if (msg.t === 'typing') {
      const chat = typeof msg.chatId === 'string' && isParticipant(msg.chatId, userId);
      if (!chat) return;
      sendTo(peerOf(chat, userId), { t: 'typing', chatId: msg.chatId, userId, on: !!msg.on });
      return;
    }
    if (msg.t === 'read') {
      const chatId = msg.chatId;
      const chat = typeof chatId === 'string' && isParticipant(chatId, userId);
      if (!chat) return;
      db.prepare('UPDATE chat_state SET unread = 0, seen_at = ? WHERE chat_id = ? AND user_id = ?')
        .run(t, chatId, userId);
      sendTo(peerOf(chat, userId), { t: 'read', chatId, userId, seenAt: t });
      return;
    }
    if (msg.t === 'send') {
      const chatId = msg.chatId;
      const text = String(msg.text || '').trim().slice(0, 2000);
      const chat = typeof chatId === 'string' && isParticipant(chatId, userId);
      if (!chat || !text) return;
      const peerId = peerOf(chat, userId);
      const info = db.prepare('INSERT INTO messages(chat_id,sender_id,text,created_at) VALUES(?,?,?,?)')
        .run(chatId, userId, text, t);
      db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(t, chatId);
      // no leído para el otro, salvo que tenga el chat abierto
      let peerViewing = false;
      const pset = conns.get(peerId);
      if (pset) for (const c of pset) if (c.openChat === chatId) { peerViewing = true; break; }
      if (!peerViewing) {
        db.prepare('UPDATE chat_state SET unread = unread + 1 WHERE chat_id = ? AND user_id = ?')
          .run(chatId, peerId);
      }
      const m = { id: Number(info.lastInsertRowid), senderId: userId, text, createdAt: t };
      const payload = { t: 'msg', chatId, m };
      sendTo(userId, { ...payload, cid: msg.cid });
      sendTo(peerId, payload);
      sendTo(userId, { t: 'chats' });
      sendTo(peerId, { t: 'chats' });
      return;
    }
  });

  ws.on('close', () => {
    const set = conns.get(userId);
    if (set) { set.delete(ws); if (!set.size) conns.delete(userId); }
  });
});

server.listen(PORT, () => {
  console.log(`ChatApp Server escuchando en http://localhost:${PORT}`);
  console.log(`Datos en: ${DATA_DIR}`);
});
