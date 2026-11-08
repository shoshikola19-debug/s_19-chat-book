// S_19 CHAT BOOK — single-file server (Node.js + Express)
// ---------------------------------------------------------------------------
// One service: serves the static frontend from ./public and a small JSON API
// (users, contacts, 1-to-1 messages, statuses, channels, call signalling).
// Database: Postgres (Neon) when DATABASE_URL is set, otherwise a local
// SQLite file (DB_PATH env, default ./s19.db). The Render free tier has an
// ephemeral disk, so on Render the data lives in Neon and survives
// restarts; locally the SQLite file is used instead. See db.js.
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
const express = require('express');
const { createDb } = require('./db');
const { sendOtp, isConfigured } = require('./sms');
const emailSender = require('./email');
const push = require('./push');

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 's19.db');
const CODE_TTL_MS = 10 * 60 * 1000; // a code works for 10 minutes
const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // a status lives 24 hours

// Set in start() before the server listens, so no request can arrive
// before the database is ready.
let db;

// Express 4 does not catch errors from async handlers, so wrap them:
// a rejection goes to the error middleware instead of hanging the request.
const ah = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

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

async function auth(req, res, next) {
  const h = req.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return res.status(401).json({ ok: false, error: 'no_token' });
  const row = await db.get('SELECT phone FROM sessions WHERE token = ?', token);
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

async function publicUser(phone) {
  const u = await db.get('SELECT phone, name FROM users WHERE phone = ?', phone);
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
app.post('/api/request-code', ah(async (req, res) => {
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
  await db.run(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts)
     VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash,
       expires_at = excluded.expires_at, attempts = 0`,
    phone, hashCode(code), now() + CODE_TTL_MS);

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
}));

// Step 2: verify the code. Returns a session token + whether this is a
// brand-new number (then the client asks for the name — step 3).
app.post('/api/verify-code', ah(async (req, res) => {
  const body = req.body || {};
  const isEmail = body.email !== undefined && body.email !== null && String(body.email).trim() !== '';
  const phone = isEmail ? normalizeEmail(body.email) : normalizePhone(body.phone, body.dial);
  const code = String((body && body.code) || '').replace(/\D/g, '');
  if (!phone || code.length !== 6 || (isEmail && !isEmailAddr(phone))) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  const row = await db.get('SELECT * FROM otp_codes WHERE phone = ?', phone);
  if (!row) return res.status(400).json({ ok: false, error: 'no_code' });
  if (row.expires_at < now()) {
    return res.status(400).json({ ok: false, error: 'code_expired' });
  }
  if (row.attempts >= 5) {
    return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  }
  if (row.code_hash !== hashCode(code)) {
    await db.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
    return res.status(400).json({ ok: false, error: 'wrong_code' });
  }
  await db.run('DELETE FROM otp_codes WHERE phone = ?', phone);
  const exists = await db.get('SELECT phone, name FROM users WHERE phone = ?', phone);
  const token = newToken();
  await db.run('INSERT INTO sessions (token, phone, created_at) VALUES (?, ?, ?)', token, phone, now());
  return res.json({
    ok: true,
    token,
    phone,
    isNewUser: !exists,
    name: exists ? exists.name : '',
  });
}));

// Step 3: set / change the display name.
app.post('/api/set-name', ah(auth), ah(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  if (!name) return res.status(400).json({ ok: false, error: 'bad_name' });
  await db.run(
    `INSERT INTO users (phone, name, created_at) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET name = excluded.name`,
    req.phone, name, now());
  return res.json({ ok: true, phone: req.phone, name });
}));

app.get('/api/me', ah(auth), ah(async (req, res) => {
  return res.json({ ok: true, ...(await publicUser(req.phone)) });
}));

app.post('/api/logout', ah(auth), ah(async (req, res) => {
  await db.run('DELETE FROM sessions WHERE token = ?', req.token);
  return res.json({ ok: true });
}));

// ---- contacts + 1-to-1 chats ------------------------------------------------

// Add a friend by number OR by Gmail address. The friend does NOT need
// to have added you back — either side can start the chat.
app.post('/api/contacts', ah(auth), ah(async (req, res) => {
  const raw = req.body && (req.body.email || req.body.phone);
  const phone = normalizePeer(raw, req.body && req.body.dial);
  if (!validIdentity(phone)) {
    return res.status(400).json({ ok: false, error: String(raw || '').includes('@') ? 'bad_email' : 'bad_phone' });
  }
  if (phone === req.phone) {
    return res.status(400).json({ ok: false, error: 'self_contact' });
  }
  await db.run(
    'INSERT INTO contacts (owner_phone, contact_phone, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    req.phone, phone, now());
  return res.json({ ok: true, contact: await publicUser(phone) });
}));

app.get('/api/contacts', ah(auth), ah(async (req, res) => {
  const rows = await db.all(
    'SELECT contact_phone FROM contacts WHERE owner_phone = ? ORDER BY created_at',
    req.phone);
  const contacts = [];
  for (const r of rows) contacts.push(await publicUser(r.contact_phone));
  return res.json({ ok: true, contacts });
}));

// Inbox: one row per 1-to-1 conversation (contacts + anyone who messaged
// me), newest first, with the last message and unread count.
app.get('/api/conversations', ah(auth), ah(async (req, res) => {
  // A message counts as delivered as soon as the other person's app is
  // open (it polls the inbox), even before they open the chat.
  await db.run('UPDATE messages SET delivered = TRUE WHERE receiver = ? AND delivered = FALSE', req.phone);
  const peers = new Map();
  for (const r of await db.all('SELECT contact_phone AS peer FROM contacts WHERE owner_phone = ?', req.phone)) peers.set(r.peer, true);
  for (const r of await db.all('SELECT DISTINCT sender AS peer FROM messages WHERE receiver = ?', req.phone)) peers.set(r.peer, true);
  for (const r of await db.all('SELECT DISTINCT receiver AS peer FROM messages WHERE sender = ?', req.phone)) peers.set(r.peer, true);

  const out = [];
  for (const peer of peers.keys()) {
    const last = await db.get(
      `SELECT id, sender, receiver, body, created_at, delivered, read FROM messages
       WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
       ORDER BY id DESC LIMIT 1`,
      req.phone, peer, peer, req.phone);
    const unread = (await db.get(
      'SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND receiver = ? AND read = FALSE',
      peer, req.phone)).n;
    out.push({
      ...(await publicUser(peer)),
      lastMessage: last ? last.body : '',
      lastAt: last ? last.created_at : 0,
      lastId: last ? last.id : 0,
      unread,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return res.json({ ok: true, conversations: out });
}));

// Incremental message fetch: only messages with id > afterId are returned,
// so a weak connection never re-downloads the whole history.
app.get('/api/messages', ah(auth), ah(async (req, res) => {
  const withPhone = normalizePeer(req.query.with || '');
  const afterId = Number(req.query.afterId || 0);
  if (!withPhone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  const rows = await db.all(
    `SELECT id, sender, receiver, body, created_at, delivered, read FROM messages
     WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
       AND id > ? ORDER BY id ASC LIMIT 200`,
    req.phone, withPhone, withPhone, req.phone, afterId);
  // Messages from the peer that I just received count as delivered now.
  await db.run(
    'UPDATE messages SET delivered = TRUE WHERE sender = ? AND receiver = ? AND delivered = FALSE',
    withPhone, req.phone);
  // Tick state for MY messages in this conversation — returned on every
  // fetch, even when there are no new messages, so the sender's ticks
  // update from ✓ to ✓✓ to seen without re-downloading the history.
  const ticks = await db.all(
    `SELECT id, delivered, read FROM messages
     WHERE sender = ? AND receiver = ? ORDER BY id DESC LIMIT 100`,
    req.phone, withPhone);
  return res.json({ ok: true, messages: rows, ticks });
}));

app.post('/api/messages', ah(auth), ah(async (req, res) => {
  const to = normalizePeer(req.body && (req.body.to || req.body.email), req.body && req.body.dial);
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  if (!validIdentity(to) || !body) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  if (to === req.phone) return res.status(400).json({ ok: false, error: 'self_message' });
  const inserted = await db.get(
    'INSERT INTO messages (sender, receiver, body, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    req.phone, to, body, now());
  const row = await db.get('SELECT * FROM messages WHERE id = ?', inserted.id);
  // Notify the receiver even if their app is closed (Web Push). The
  // notification never carries the message text — only the sender's name.
  // Fire-and-forget: a push failure must never fail or delay this reply.
  const sender = await publicUser(req.phone);
  push.sendPushToUser(db, to, {
    title: sender.name || req.phone,
    body: 'নতুন মেসেজ',
    tag: 'msg-' + req.phone,
    type: 'message',
    peer: req.phone,
  }).catch(() => {});
  return res.json({ ok: true, message: row });
}));

// Mark a conversation as read (clears my unread count for that peer).
app.post('/api/messages/read', ah(auth), ah(async (req, res) => {
  const withPhone = normalizePeer(req.body && req.body.with);
  if (!withPhone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  await db.run(
    'UPDATE messages SET read = TRUE, delivered = TRUE WHERE sender = ? AND receiver = ?',
    withPhone, req.phone);
  return res.json({ ok: true });
}));

// Today's message traffic for the data meter (Tools tab).
app.get('/api/usage', ah(auth), ah(async (req, res) => {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const t0 = dayStart.getTime();
  const sent = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM messages
     WHERE sender = ? AND created_at >= ?`,
    req.phone, t0);
  const received = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(body)), 0) AS b FROM messages
     WHERE receiver = ? AND created_at >= ?`,
    req.phone, t0);
  return res.json({
    ok: true,
    day: dayStart.toISOString().slice(0, 10),
    messagesSent: sent.n,
    messagesReceived: received.n,
    bytesSent: sent.b,
    bytesReceived: received.b,
  });
}));

// ---- statuses (24 hours) ----------------------------------------------------

// Post a text status. It is visible to my contacts (and to me) for 24
// hours, then it disappears (expired rows are ignored and cleaned up).
app.post('/api/statuses', ah(auth), ah(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ ok: false, error: 'bad_text' });
  const t = now();
  const inserted = await db.get(
    'INSERT INTO statuses (phone, text, created_at, expires_at) VALUES (?, ?, ?, ?) RETURNING id',
    req.phone, text, t, t + STATUS_TTL_MS);
  return res.json({ ok: true, status: { id: inserted.id, phone: req.phone, text, created_at: t } });
}));

// My status + my contacts' statuses (newest first). `mine: true` marks my own.
app.get('/api/statuses', ah(auth), ah(async (req, res) => {
  const t = now();
  const peers = (await db.all('SELECT contact_phone FROM contacts WHERE owner_phone = ?', req.phone))
    .map((r) => r.contact_phone);
  // People who added me can also see my status, and vice versa.
  const reverse = (await db.all('SELECT owner_phone FROM contacts WHERE contact_phone = ?', req.phone))
    .map((r) => r.owner_phone);
  const visible = [...new Set([req.phone, ...peers, ...reverse])];
  const placeholders = visible.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id, phone, text, created_at, expires_at FROM statuses
     WHERE phone IN (${placeholders}) AND expires_at > ? ORDER BY created_at DESC LIMIT 100`,
    ...visible, t);
  const statuses = [];
  for (const r of rows) {
    statuses.push({ ...r, mine: r.phone === req.phone, name: (await publicUser(r.phone)).name });
  }
  return res.json({ ok: true, statuses });
}));

app.delete('/api/statuses/:id', ah(auth), ah(async (req, res) => {
  const row = await db.get('SELECT * FROM statuses WHERE id = ?', Number(req.params.id));
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.phone !== req.phone) return res.status(403).json({ ok: false, error: 'not_owner' });
  await db.run('DELETE FROM statuses WHERE id = ?', row.id);
  return res.json({ ok: true });
}));

// ---- channels ---------------------------------------------------------------
// Anyone can create a channel. Every channel can be found by searching its
// name or description — nothing is pre-added. Only the owner can post;
// everyone else follows and reads. The unread badge counts posts newer
// than the follower's last-read time and clears when the channel is opened.

app.post('/api/channels', ah(auth), ah(async (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  const description = String((req.body && req.body.description) || '').trim().slice(0, 300);
  if (!name) return res.status(400).json({ ok: false, error: 'bad_name' });
  const t = now();
  try {
    const inserted = await db.get(
      'INSERT INTO channels (name, description, owner_phone, created_at) VALUES (?, ?, ?, ?) RETURNING id',
      name, description, req.phone, t);
    // The creator automatically follows their own channel.
    await db.run(
      'INSERT INTO channel_follows (channel_id, phone, last_read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      inserted.id, req.phone, t);
    return res.json({
      ok: true,
      channel: { id: inserted.id, name, description, owner_phone: req.phone, created_at: t },
    });
  } catch (e) {
    const msg = String((e && e.message) || '');
    // SQLite: "UNIQUE constraint failed"; Postgres: error 23505
    // ("duplicate key value violates unique constraint").
    if ((e && e.code === '23505') || msg.includes('UNIQUE') || /duplicate key/i.test(msg)) {
      return res.status(409).json({ ok: false, error: 'name_taken' });
    }
    throw e;
  }
}));

// Search all channels by name/description. Empty query = list all (newest first).
// LOWER() on both sides keeps the search case-insensitive on both engines
// (SQLite LIKE is case-insensitive, Postgres LIKE is not).
app.get('/api/channels', ah(auth), ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = q
    ? await db.all(
        `SELECT * FROM channels WHERE LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) ORDER BY created_at DESC LIMIT 100`,
        like, like)
    : await db.all('SELECT * FROM channels ORDER BY created_at DESC LIMIT 100');
  const out = [];
  for (const c of rows) {
    const followers = (await db.get('SELECT COUNT(*) AS n FROM channel_follows WHERE channel_id = ?', c.id)).n;
    const follow = await db.get(
      'SELECT last_read_at FROM channel_follows WHERE channel_id = ? AND phone = ?',
      c.id, req.phone);
    const lastPost = await db.get(
      'SELECT text, created_at FROM channel_posts WHERE channel_id = ? ORDER BY id DESC LIMIT 1',
      c.id);
    const unread = follow
      ? (await db.get('SELECT COUNT(*) AS n FROM channel_posts WHERE channel_id = ? AND created_at > ?', c.id, follow.last_read_at)).n
      : 0;
    out.push({
      ...c,
      mine: c.owner_phone === req.phone,
      followed: Boolean(follow),
      followers,
      lastPost: lastPost ? lastPost.text : '',
      lastPostAt: lastPost ? lastPost.created_at : 0,
      unread,
    });
  }
  return res.json({ ok: true, channels: out });
}));

app.post('/api/channels/:id/follow', ah(auth), ah(async (req, res) => {
  const id = Number(req.params.id);
  const ch = await db.get('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  await db.run(
    'INSERT INTO channel_follows (channel_id, phone, last_read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
    id, req.phone, now());
  return res.json({ ok: true });
}));

// Opening a channel marks it read (clears the unread badge).
app.post('/api/channels/:id/read', ah(auth), ah(async (req, res) => {
  const id = Number(req.params.id);
  await db.run('UPDATE channel_follows SET last_read_at = ? WHERE channel_id = ? AND phone = ?', now(), id, req.phone);
  return res.json({ ok: true });
}));

app.get('/api/channels/:id/posts', ah(auth), ah(async (req, res) => {
  const id = Number(req.params.id);
  const afterId = Number(req.query.afterId || 0);
  const ch = await db.get('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  const rows = await db.all(
    `SELECT id, channel_id, phone, text, created_at FROM channel_posts
     WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
    id, afterId);
  return res.json({ ok: true, channel: ch, posts: rows });
}));

app.post('/api/channels/:id/posts', ah(auth), ah(async (req, res) => {
  const id = Number(req.params.id);
  const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
  if (!text) return res.status(400).json({ ok: false, error: 'bad_text' });
  const ch = await db.get('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  if (ch.owner_phone !== req.phone) {
    return res.status(403).json({ ok: false, error: 'not_owner' });
  }
  const inserted = await db.get(
    'INSERT INTO channel_posts (channel_id, phone, text, created_at) VALUES (?, ?, ?, ?) RETURNING id',
    id, req.phone, text, now());
  return res.json({
    ok: true,
    post: { id: inserted.id, channel_id: id, phone: req.phone, text, created_at: now() },
  });
}));

// ---- voice-call signalling (WebRTC) -----------------------------------------
// The server only passes signalling messages between the two phones; the
// voice itself goes peer-to-peer over WebRTC (STUN). Polling keeps it
// working on weak networks where a websocket would drop.

app.post('/api/calls/signal', ah(auth), ah(async (req, res) => {
  const to = normalizePeer(req.body && req.body.to, req.body && req.body.dial);
  const kind = String((req.body && req.body.kind) || '');
  const payload = req.body && req.body.payload ? req.body.payload : {};
  if (!to || !['offer', 'answer', 'ice', 'end'].includes(kind)) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  await db.run(
    'INSERT INTO call_signals (from_phone, to_phone, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    req.phone, to, kind, JSON.stringify(payload), now());
  // A call offer also pushes the callee's phone, so the call arrives even
  // when their app is closed. Fire-and-forget, like messages.
  if (kind === 'offer') {
    const caller = await publicUser(req.phone);
    push.sendPushToUser(db, to, {
      title: caller.name || req.phone,
      body: 'কল আসছে…',
      tag: 'call-' + req.phone,
      type: 'call',
      peer: req.phone,
      requireInteraction: true,
    }).catch(() => {});
  }
  return res.json({ ok: true });
}));

// Fetch my pending signals and mark them consumed.
app.get('/api/calls/signals', ah(auth), ah(async (req, res) => {
  const rows = await db.all(
    `SELECT id, from_phone, kind, payload, created_at FROM call_signals
     WHERE to_phone = ? AND consumed = FALSE ORDER BY id ASC LIMIT 50`,
    req.phone);
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await db.run(`UPDATE call_signals SET consumed = TRUE WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  }
  return res.json({
    ok: true,
    signals: rows.map((r) => ({ ...r, from: r.from_phone, payload: JSON.parse(r.payload || '{}') })),
  });
}));

// ---- web push notifications -------------------------------------------------
// The public VAPID key is public by design — the frontend fetches it to
// subscribe. When push is not configured (no keys), publicKey is null and
// the frontend simply skips subscribing; the app keeps polling as before.
app.get('/api/push/vapid-public-key', ah(async (_req, res) => {
  return res.json({ ok: true, publicKey: push.getPublicKey() });
}));

// Save (or refresh) this device's push subscription. Upsert by endpoint,
// so re-subscribing on every login is safe and idempotent.
app.post('/api/push/subscribe', ah(auth), ah(async (req, res) => {
  const sub = req.body && req.body.subscription;
  const endpoint = sub && typeof sub.endpoint === 'string' ? sub.endpoint : '';
  const keys = sub && sub.keys && typeof sub.keys === 'object' ? sub.keys : null;
  if (!endpoint || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return res.status(400).json({ ok: false, error: 'bad_subscription' });
  }
  await db.run(
    `INSERT INTO push_subscriptions (endpoint, user_phone, keys, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_phone = excluded.user_phone,
       keys = excluded.keys, created_at = excluded.created_at`,
    endpoint, req.phone, JSON.stringify({ p256dh: keys.p256dh, auth: keys.auth }), now());
  return res.json({ ok: true });
}));

// Remove this device's push subscription (e.g. on logout from this device).
app.delete('/api/push/subscribe', ah(auth), ah(async (req, res) => {
  const endpoint = req.body && typeof req.body.endpoint === 'string' ? req.body.endpoint : '';
  if (!endpoint) return res.status(400).json({ ok: false, error: 'bad_endpoint' });
  await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_phone = ?', endpoint, req.phone);
  return res.json({ ok: true });
}));

// ---- static frontend + start -------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Errors from async handlers end up here as JSON, not an HTML error page.
app.use((err, _req, res, _next) => {
  console.error('[api error]', err && err.message);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'server_error' });
});

// Clean up expired statuses and consumed signals every hour.
setInterval(async () => {
  try {
    await db.run('DELETE FROM statuses WHERE expires_at <= ?', now());
    await db.run('DELETE FROM call_signals WHERE consumed = TRUE AND created_at < ?', now() - 60 * 60 * 1000);
  } catch (e) {
    console.error('[cleanup]', e && e.message);
  }
}, 60 * 60 * 1000);

async function start() {
  db = await createDb({ dbPath: DB_PATH });
  const pushOn = push.initPush();
  app.listen(PORT, () => {
    console.log(`S_19 CHAT BOOK running on http://localhost:${PORT}`);
    console.log(`SMS mode: ${isConfigured() ? 'REAL SMS (' + process.env.SMS_PROVIDER + ')' : 'TEST CODE on screen'}`);
    console.log(`Email mode: ${emailSender.isConfigured() ? 'REAL EMAIL (' + process.env.EMAIL_PROVIDER + ')' : 'TEST CODE on screen'}`);
    console.log(`DB: ${db.label}`);
    console.log(`Push notifications: ${pushOn ? 'ENABLED (VAPID)' : 'disabled (no VAPID keys set)'}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server:', e && e.message);
  process.exit(1);
});
