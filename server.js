// S_19 CHAT BOOK — single-file server (Node.js + Express + SQLite)
// ---------------------------------------------------------------------------
// One service: serves the static frontend from ./public and a small JSON API
// (users, contacts, 1-to-1 messages, statuses, channels, call signalling).
// Database: SQLite file (DB_PATH env, default ./s19.db). No other services.
//
// Login: 3 steps — phone number (+ country dial code) OR a Gmail address
// -> 6-digit code -> name. The session token is stored in the browser
// (localStorage), so the user stays logged in on that device; a code is
// only asked again on a new device or after an explicit logout. Codes are
// stored hashed (SHA-256).
//
// Identity: a user is identified by EITHER their full international phone
// digits OR their Gmail address (lowercased). The database columns are
// still called "phone" but they hold whichever identity the user logged
// in with; contacts, messages, statuses, channels and calls all work the
// same for phone users and Gmail users. Email codes are free; SMS codes
// cost money per message (paid by the sender, not the receiver).
//
// SMS: if SMS_* env vars are set, a phone code is sent by real SMS (see
// sms.js) and is NOT returned to the client. Email: if EMAIL_* env vars
// are set, a Gmail code is sent by real email (see email.js). If neither
// is set (test mode), the code is returned in the response and shown on
// screen — exactly like the current test version of the app.

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const { sendOtp, isConfigured } = require('./sms');
const emailSender = require('./email');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 's19.db');
const CODE_TTL_MS = 10 * 60 * 1000; // a code works for 10 minutes
const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // a status lives 24 hours

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  owner_phone TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_phone, contact_phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender, receiver, id);
CREATE TABLE IF NOT EXISTS statuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statuses_phone ON statuses (phone, expires_at);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  owner_phone TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_follows (
  channel_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, phone)
);
CREATE TABLE IF NOT EXISTS channel_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_posts ON channel_posts (channel_id, id);
CREATE TABLE IF NOT EXISTS call_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_call_signals_to ON call_signals (to_phone, consumed);
`);

// ---- helpers ---------------------------------------------------------------

const now = () => Date.now();

// Normalise a phone number to digits only, with country code.
// Accepts "+8801...", "8801...", "01..." (leading 0 trunk is dropped, the
// way numbers are typed in Bangladesh) and plain digit strings.
function normalizePhone(raw, dial) {
  if (raw === undefined || raw === null) return '';
  let d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  if (dial) {
    const dc = String(dial).replace(/\D/g, '');
    if (dc && d.startsWith('0')) d = d.slice(1); // drop trunk 0
    if (dc && !d.startsWith(dc)) d = dc + d;
  }
  return d;
}

function isEmailAddr(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

// A peer/contact identity is either a phone number (digits) or a Gmail
// address. normalizePeer() accepts either form and returns the canonical
// identity string (digits, or the lowercased email), or '' when invalid.
function normalizePeer(raw, dial) {
  if (raw === undefined || raw === null) return '';
  const s = String(raw).trim();
  if (s.includes('@')) return isEmailAddr(s) ? normalizeEmail(s) : '';
  return normalizePhone(s, dial);
}

function validIdentity(id) {
  if (!id) return false;
  if (id.includes('@')) return isEmailAddr(id);
  return id.length >= 8 && id.length <= 15;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

function auth(req, res, next) {
  const h = req.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, error: 'no_token' });
  const row = db.prepare('SELECT phone FROM sessions WHERE token = ?').get(token);
  if (!row) return res.status(401).json({ ok: false, error: 'bad_token' });
  req.phone = row.phone;
  req.token = token;
  next();
}

// Tiny in-memory rate limit for code requests: max 5 codes per phone per
// hour, and at least 60 seconds between two codes. This protects the SMS
// budget (every SMS costs money) from being drained by repeated requests.
const codeRequests = new Map();
function codeRateLimited(phone) {
  const t = now();
  const arr = (codeRequests.get(phone) || []).filter((x) => t - x < 60 * 60 * 1000);
  if (arr.length >= 5) return true;
  if (arr.length > 0 && t - arr[arr.length - 1] < 60 * 1000) return true;
  arr.push(t);
  codeRequests.set(phone, arr);
  return false;
}

function publicUser(phone) {
  const u = db.prepare('SELECT phone, name FROM users WHERE phone = ?').get(phone);
  return u ? { phone: u.phone, name: u.name } : { phone, name: '' };
}

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use((req, _res, next) => {
  if (req.path.startsWith('/api/')) console.log(new Date().toISOString(), req.method, req.path);
  next();
});

// ---- auth: 3-step login ----------------------------------------------------

// Step 1: ask for a 6-digit code for a phone number OR a Gmail address.
// Body: { phone, dial } — dial like "+880" (optional; phone may already
// include the country code) — or { email }. In TEST mode (no SMS/email
// configured) the reply includes testCode so the screen can show it. In
// SMS/email mode the code is sent for real and the reply only says
// { ok, sms: true } or { ok, email: true }.
app.post('/api/request-code', async (req, res) => {
  const body = req.body || {};
  // Identity: a Gmail address (email field) OR a phone number (phone + dial).
  const isEmail = body.email !== undefined && body.email !== null && String(body.email).trim() !== '';
  const phone = isEmail ? normalizeEmail(body.email) : normalizePhone(body.phone, body.dial);
  if (isEmail) {
    if (!isEmailAddr(phone)) {
      return res.status(400).json({ ok: false, error: 'bad_email' });
    }
  } else if (!phone || phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ ok: false, error: 'bad_phone' });
  }
  if (codeRateLimited(phone)) {
    return res.status(429).json({ ok: false, error: 'too_many_codes' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0`,
  ).run(phone, hashCode(code), now() + CODE_TTL_MS);

  if (isEmail) {
    if (emailSender.isConfigured()) {
      const r = await emailSender.sendOtp(phone, code);
      if (r.sent) return res.json({ ok: true, email: true });
      // Email failed — fall back to test code so login is not blocked.
      console.error('[auth] email failed, falling back to test code:', r.reason);
      return res.json({ ok: true, email: false, emailError: r.reason, testCode: code });
    }
    return res.json({ ok: true, email: false, testCode: code });
  }
  if (isConfigured()) {
    const r = await sendOtp(phone, code);
    if (r.sent) return res.json({ ok: true, sms: true });
    // SMS failed — fall back to test code so login is not blocked, and say so.
    console.error('[auth] SMS failed, falling back to test code:', r.reason);
    return res.json({ ok: true, sms: false, smsError: r.reason, testCode: code });
  }
  return res.json({ ok: true, sms: false, testCode: code });
});

// Step 2: verify the code. Returns a session token + whether this is a
// brand-new number (then the client asks for the name — step 3).
app.post('/api/verify-code', (req, res) => {
  const body = req.body || {};
  const isEmail = body.email !== undefined && body.email !== null && String(body.email).trim() !== '';
  const phone = isEmail ? normalizeEmail(body.email) : normalizePhone(body.phone, body.dial);
  const code = String((body && body.code) || '').replace(/\D/g, '');
  if (!phone || code.length !== 6 || (isEmail && !isEmailAddr(phone))) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(phone);
  if (!row) return res.status(400).json({ ok: false, error: 'no_code' });
  if (row.expires_at < now()) {
    return res.status(400).json({ ok: false, error: 'code_expired' });
  }
  if (row.attempts >= 5) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }
  if (row.code_hash !== hashCode(code)) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return res.status(400).json({ ok: false, error: 'wrong_code' });
  }
  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);
  const exists = db.prepare('SELECT phone, name FROM users WHERE phone = ?').get(phone);
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, phone, created_at) VALUES (?, ?, ?)').run(token, phone, now());
  return res.json({
    ok: true,
    token,
    phone,
    isNewUser: !exists,
    name: exists ? exists.name : '',
  });
});

// Step 3: set / change the display name.
app.post('/api/set-name', auth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ ok: false, error: 'bad_name' });
  db.prepare(
    `INSERT INTO users (phone, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET name = excluded.name`,
  ).run(req.phone, name, now());
  return res.json({ ok: true, phone: req.phone, name });
});

app.get('/api/me', auth, (req, res) => {
  return res.json({ ok: true, ...publicUser(req.phone) });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  return res.json({ ok: true });
});

// ---- contacts + 1-to-1 chats ------------------------------------------------

// Add a friend by number OR by Gmail address. The friend does NOT need
// to have added you back — either side can start the chat.
app.post('/api/contacts', auth, (req, res) => {
  const raw = req.body && (req.body.email || req.body.phone);
  const phone = normalizePeer(raw, req.body && req.body.dial);
  if (!validIdentity(phone)) {
    return res.status(400).json({ ok: false, error: String(raw || '').includes('@') ? 'bad_email' : 'bad_phone' });
  }
  if (phone === req.phone) {
    return res.status(400).json({ ok: false, error: 'self_contact' });
  }
  db.prepare(
    'INSERT OR IGNORE INTO contacts (owner_phone, contact_phone, created_at) VALUES (?, ?, ?)',
  ).run(req.phone, phone, now());
  return res.json({ ok: true, contact: publicUser(phone) });
});

app.get('/api/contacts', auth, (req, res) => {
  const rows = db
    .prepare('SELECT contact_phone FROM contacts WHERE owner_phone = ? ORDER BY created_at')
    .all(req.phone);
  return res.json({ ok: true, contacts: rows.map((r) => publicUser(r.contact_phone)) });
});

// Inbox: one row per 1-to-1 conversation (contacts + anyone who messaged
// me), newest first, with the last message and unread count.
app.get('/api/conversations', auth, (req, res) => {
  const peers = new Map();
  for (const r of db
    .prepare('SELECT contact_phone AS peer FROM contacts WHERE owner_phone = ?')
    .all(req.phone)) peers.set(r.peer, true);
  for (const r of db
    .prepare('SELECT DISTINCT sender AS peer FROM messages WHERE receiver = ?')
    .all(req.phone)) peers.set(r.peer, true);
  for (const r of db
    .prepare('SELECT DISTINCT receiver AS peer FROM messages WHERE sender = ?')
    .all(req.phone)) peers.set(r.peer, true);

  const out = [];
  for (const peer of peers.keys()) {
    const last = db
      .prepare(
        `SELECT id, sender, receiver, body, created_at, delivered, read FROM messages
         WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
         ORDER BY id DESC LIMIT 1`,
      )
      .get(req.phone, peer, peer, req.phone);
    const unread = db
      .prepare('SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND receiver = ? AND read = 0')
      .get(peer, req.phone).n;
    out.push({
      ...publicUser(peer),
      lastMessage: last ? last.body : '',
      lastAt: last ? last.created_at : 0,
      lastId: last ? last.id : 0,
      unread,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return res.json({ ok: true, conversations: out });
});

// Incremental message fetch: only messages with id > afterId are returned,
// so a weak connection never re-downloads the whole history.
app.get('/api/messages', auth, (req, res) => {
  const withPhone = normalizePeer(req.query.with || '');
  const afterId = Number(req.query.afterId || 0);
  if (!withPhone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  const rows = db
    .prepare(
      `SELECT id, sender, receiver, body, created_at, delivered, read FROM messages
       WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
         AND id > ? ORDER BY id ASC LIMIT 200`,
    )
    .all(req.phone, withPhone, withPhone, req.phone, afterId);
  // Messages from the peer that I just received count as delivered now.
  db.prepare(
    'UPDATE messages SET delivered = 1 WHERE sender = ? AND receiver = ? AND delivered = 0',
  ).run(withPhone, req.phone);
  return res.json({ ok: true, messages: rows });
});

app.post('/api/messages', auth, (req, res) => {
  const to = normalizePeer(req.body && (req.body.to || req.body.email), req.body && req.body.dial);
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  if (!validIdentity(to) || !body) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  if (to === req.phone) return res.status(400).json({ ok: false, error: 'self_message' });
  const info = db
    .prepare('INSERT INTO messages (sender, receiver, body, created_at) VALUES (?, ?, ?, ?)')
    .run(req.phone, to, body, now());
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid));
  return res.json({ ok: true, message: row });
});

// Mark a conversation as read (clears my unread count for that peer).
app.post('/api/messages/read', auth, (req, res) => {
  const withPhone = normalizePeer(req.body && req.body.with);
  if (!withPhone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  db.prepare('UPDATE messages SET read = 1, delivered = 1 WHERE sender = ? AND receiver = ?').run(
    withPhone,
    req.phone,
  );
  return res.json({ ok: true });
});

// Today's message traffic for the data meter (Tools tab).
app.get('/api/usage', auth, (req, res) => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const t0 = dayStart.getTime();
  const sent = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM messages
       WHERE sender = ? AND created_at >= ?`,
    )
    .get(req.phone, t0);
  const received = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM messages
       WHERE receiver = ? AND created_at >= ?`,
    )
    .get(req.phone, t0);
  return res.json({
    ok: true,
    day: dayStart.toISOString().slice(0, 10),
    messagesSent: sent.n,
    messagesReceived: received.n,
    bytesSent: sent.b,
    bytesReceived: received.b,
  });
});

// ---- statuses (24 hours) ----------------------------------------------------

// Post a text status. It is visible to my contacts (and to me) for 24
// hours, then it disappears (expired rows are ignored and cleaned up).
app.post('/api/statuses', auth, (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: 'bad_text' });
  const t = now();
  const info = db
    .prepare('INSERT INTO statuses (phone, text, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(req.phone, text, t, t + STATUS_TTL_MS);
  return res.json({ ok: true, status: { id: Number(info.lastInsertRowid), phone: req.phone, text, created_at: t } });
});

// My status + my contacts' statuses (newest first). `mine: true` marks my own.
app.get('/api/statuses', auth, (req, res) => {
  const t = now();
  const peers = db
    .prepare('SELECT contact_phone FROM contacts WHERE owner_phone = ?')
    .all(req.phone)
    .map((r) => r.contact_phone);
  // People who added me can also see my status, and vice versa.
  const reverse = db
    .prepare('SELECT owner_phone FROM contacts WHERE contact_phone = ?')
    .all(req.phone)
    .map((r) => r.owner_phone);
  const visible = [...new Set([req.phone, ...peers, ...reverse])];
  const placeholders = visible.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT id, phone, text, created_at, expires_at FROM statuses
       WHERE phone IN (${placeholders}) AND expires_at > ? ORDER BY created_at DESC LIMIT 100`,
    )
    .all(...visible, t);
  return res.json({
    ok: true,
    statuses: rows.map((r) => ({ ...r, mine: r.phone === req.phone, name: publicUser(r.phone).name })),
  });
});

app.delete('/api/statuses/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM statuses WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.phone !== req.phone) return res.status(403).json({ ok: false, error: 'not_owner' });
  db.prepare('DELETE FROM statuses WHERE id = ?').run(row.id);
  return res.json({ ok: true });
});

// ---- channels ---------------------------------------------------------------
// Anyone can create a channel. Every channel can be found by searching its
// name or description — nothing is pre-added. Only the owner can post;
// everyone else follows and reads. The unread badge counts posts newer
// than the follower's last-read time and clears when the channel is opened.

app.post('/api/channels', auth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  const description = String((req.body && req.body.description) || '').trim().slice(0, 300);
  if (!name) return res.status(400).json({ ok: false, error: 'bad_name' });
  const t = now();
  try {
    const info = db
      .prepare('INSERT INTO channels (name, description, owner_phone, created_at) VALUES (?, ?, ?, ?)')
      .run(name, description, req.phone, t);
    // The creator automatically follows their own channel.
    db.prepare('INSERT OR IGNORE INTO channel_follows (channel_id, phone, last_read_at) VALUES (?, ?, ?)').run(
      Number(info.lastInsertRowid),
      req.phone,
      t,
    );
    return res.json({
      ok: true,
      channel: { id: Number(info.lastInsertRowid), name, description, owner_phone: req.phone, created_at: t },
    });
  } catch (e) {
    if (String(e && e.message).includes('UNIQUE')) {
      return res.status(409).json({ ok: false, error: 'name_taken' });
    }
    throw e;
  }
});

// Search all channels by name/description. Empty query = list all (newest first).
app.get('/api/channels', auth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = q
    ? db
        .prepare(
          `SELECT * FROM channels WHERE name LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT 100`,
        )
        .all(like, like)
    : db.prepare('SELECT * FROM channels ORDER BY created_at DESC LIMIT 100').all();
  const out = rows.map((c) => {
    const followers = db.prepare('SELECT COUNT(*) AS n FROM channel_follows WHERE channel_id = ?').get(c.id).n;
    const follow = db
      .prepare('SELECT last_read_at FROM channel_follows WHERE channel_id = ? AND phone = ?')
      .get(c.id, req.phone);
    const lastPost = db
      .prepare('SELECT text, created_at FROM channel_posts WHERE channel_id = ? ORDER BY id DESC LIMIT 1')
      .get(c.id);
    const unread = follow
      ? db
          .prepare('SELECT COUNT(*) AS n FROM channel_posts WHERE channel_id = ? AND created_at > ?')
          .get(c.id, follow.last_read_at).n
      : 0;
    return {
      ...c,
      mine: c.owner_phone === req.phone,
      followed: Boolean(follow),
      followers,
      lastPost: lastPost ? lastPost.text : '',
      lastPostAt: lastPost ? lastPost.created_at : 0,
      unread,
    };
  });
  return res.json({ ok: true, channels: out });
});

app.post('/api/channels/:id/follow', auth, (req, res) => {
  const id = Number(req.params.id);
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  db.prepare(
    'INSERT OR IGNORE INTO channel_follows (channel_id, phone, last_read_at) VALUES (?, ?, ?)',
  ).run(id, req.phone, now());
  return res.json({ ok: true });
});

// Opening a channel marks it read (clears the unread badge).
app.post('/api/channels/:id/read', auth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('UPDATE channel_follows SET last_read_at = ? WHERE channel_id = ? AND phone = ?').run(
    now(),
    id,
    req.phone,
  );
  return res.json({ ok: true });
});

app.get('/api/channels/:id/posts', auth, (req, res) => {
  const id = Number(req.params.id);
  const afterId = Number(req.query.afterId || 0);
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  const rows = db
    .prepare(
      `SELECT id, channel_id, phone, text, created_at FROM channel_posts
       WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
    )
    .all(id, afterId);
  return res.json({ ok: true, channel: ch, posts: rows });
});

app.post('/api/channels/:id/posts', auth, (req, res) => {
  const id = Number(req.params.id);
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: 'bad_text' });
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ch.owner_phone !== req.phone) {
    return res.status(403).json({ ok: false, error: 'not_owner' });
  }
  const info = db
    .prepare('INSERT INTO channel_posts (channel_id, phone, text, created_at) VALUES (?, ?, ?, ?)')
    .run(id, req.phone, text, now());
  return res.json({
    ok: true,
    post: { id: Number(info.lastInsertRowid), channel_id: id, phone: req.phone, text, created_at: now() },
  });
});

// ---- voice-call signalling (WebRTC) -----------------------------------------
// The server only passes signalling messages between the two phones; the
// voice itself goes peer-to-peer over WebRTC (STUN). Polling keeps it
// working on weak networks where a websocket would drop.

app.post('/api/calls/signal', auth, (req, res) => {
  const to = normalizePeer(req.body && req.body.to, req.body && req.body.dial);
  const kind = String((req.body && req.body.kind) || '');
  const payload = req.body && req.body.payload ? req.body.payload : {};
  if (!to || !['offer', 'answer', 'ice', 'end'].includes(kind)) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  db.prepare(
    'INSERT INTO call_signals (from_phone, to_phone, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(req.phone, to, kind, JSON.stringify(payload), now());
  return res.json({ ok: true });
});

// Fetch my pending signals and mark them consumed.
app.get('/api/calls/signals', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT id, from_phone, kind, payload, created_at FROM call_signals
       WHERE to_phone = ? AND consumed = 0 ORDER BY id ASC LIMIT 50`,
    )
    .all(req.phone);
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    db.prepare(`UPDATE call_signals SET consumed = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
  return res.json({
    ok: true,
    signals: rows.map((r) => ({ ...r, from: r.from_phone, payload: JSON.parse(r.payload || '{}') })),
  });
});

// ---- static frontend + start -------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Clean up expired statuses and consumed signals every hour.
setInterval(() => {
  try {
    db.prepare('DELETE FROM statuses WHERE expires_at <= ?').run(now());
    db.prepare('DELETE FROM call_signals WHERE consumed = 1 AND created_at < ?').run(now() - 60 * 60 * 1000);
  } catch (e) {
    console.error('[cleanup]', e && e.message);
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`S_19 CHAT BOOK running on http://localhost:${PORT}`);
  console.log(`SMS mode: ${isConfigured() ? 'REAL SMS (' + process.env.SMS_PROVIDER + ')' : 'TEST CODE on screen'}`);
  console.log(`Email mode: ${emailSender.isConfigured() ? 'REAL EMAIL (' + process.env.EMAIL_PROVIDER + ')' : 'TEST CODE on screen'}`);
  console.log(`DB: ${DB_PATH}`);
});
