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

// Broadcast announcements are sent from this special sender identity.
// It is NOT a real user: it has a row in `users` only so publicUser()
// can give it a name, and the message endpoints accept it as a peer.
const SYSTEM_SENDER = 'S_19 CHAT BOOK';

// Admin panel: who may use it, from the ADMIN_USERS env var — a
// comma-separated list of full international phone numbers
// (8801XXXXXXXXX) or Gmail addresses. If it is unset, nobody is admin
// and the Admin tab stays hidden for everyone. Set it in the Render
// Dashboard (Environment tab); the server only ever logs the count,
// never the identities themselves.
function normalizeAdminEntry(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s.toLowerCase();
  let d = s.replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) d = '880' + d.slice(1); // 01XXXXXXXXX -> 8801XXXXXXXXX
  return d;
}
const ADMIN_USERS = new Set(
  (process.env.ADMIN_USERS || '').split(',').map(normalizeAdminEntry).filter(Boolean)
);
function isAdmin(phone) {
  return Boolean(phone) && ADMIN_USERS.has(phone);
}

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
  // A blocked user is kicked out immediately, even with a live session:
  // this one check gates every protected endpoint, so a blocked user
  // cannot send messages, call, or use any other API. Unblocking makes
  // the same token work again — no re-login needed.
  const u = await db.get('SELECT blocked FROM users WHERE phone = ?', row.phone);
  if (u && u.blocked) return res.status(401).json({ ok: false, error: 'blocked' });
  req.phone = row.phone;
  req.token = token;
  next();
}

// Admin-only routes: runs after auth, so req.phone is set. 403 for
// everyone else — the client hides the Admin tab for non-admins, but the
// server is the real gate.
function adminAuth(req, res, next) {
  if (!isAdmin(req.phone)) return res.status(403).json({ ok: false, error: 'not_admin' });
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
  if (phone === SYSTEM_SENDER) return { phone, name: 'S_19 CHAT BOOK' };
  const u = await db.get('SELECT phone, name, avatar, about FROM users WHERE phone = ?', phone);
  return u ? { phone: u.phone, name: u.name, avatar: u.avatar || '', about: u.about || '' } : { phone, name: '', avatar: '', about: '' };
}

// A peer identity, except the broadcast sender is accepted as-is:
// normalizePeer() would strip it to '' because it is not a phone number
// or an email address.
function normalizePeerOrSystem(raw, dial) {
  const s = String(raw || '').trim();
  if (s === SYSTEM_SENDER) return SYSTEM_SENDER;
  return normalizePeer(s, dial);
}

// ---- per-chat settings (mute / disappearing / theme / block / clear) -----
// One row per (owner, peer) direction in chat_settings; each side keeps
// their own choices. A missing row = all defaults (not muted, no
// disappearing, default theme, not blocked, nothing cleared).
const DISAPPEAR_OPTIONS = [0, 86400, 604800, 7776000]; // off, 24h, 7d, 90d
const CHAT_THEMES = ['', 'green', 'blue', 'purple', 'pink', 'dark'];
async function getChatSettings(owner, peer) {
  const row = await db.get(
    'SELECT muted, disappearing, chat_theme, blocked, cleared_at FROM chat_settings WHERE owner_phone = ? AND peer_phone = ?',
    owner, peer);
  return {
    muted: row ? row.muted : 0,
    disappearing: row ? row.disappearing : 0,
    chatTheme: row ? (row.chat_theme || '') : '',
    blocked: row ? row.blocked : 0,
    clearedAt: row ? row.cleared_at : 0,
  };
}
// Has `receiver` muted this chat (no push, no sound) for `sender`?
async function isMutedFor(receiver, sender) {
  return (await getChatSettings(receiver, sender)).muted === 1;
}
// Per-user block between two people, from EITHER side's row:
// byMe = I blocked them, byPeer = they blocked me. This is SEPARATE from
// the admin-level block (users.blocked) — an admin block locks the whole
// account, a per-user block only stops these two from reaching each other.
async function blockState(me, peer) {
  const mine = await getChatSettings(me, peer);
  const theirs = await getChatSettings(peer, me);
  return { byMe: mine.blocked === 1, byPeer: theirs.blocked === 1 };
}
// When a message is sent it expires after the SHORTER of the two sides'
// disappearing settings (0 on a side = that side set nothing). 0 = never.
async function disappearingExpiresAt(sender, receiver, createdAt) {
  const s = (await getChatSettings(sender, receiver)).disappearing;
  const r = (await getChatSettings(receiver, sender)).disappearing;
  const secs = [s, r].filter((v) => v > 0);
  if (!secs.length) return 0;
  return createdAt + Math.min(...secs) * 1000;
}
// Push goes out only when the receiver has NOT muted this chat.
async function pushUnlessMuted(receiver, sender, payload) {
  if (await isMutedFor(receiver, sender)) return;
  push.sendPushToUser(db, receiver, payload).catch(() => {});
}

const app = express();
// The media upload carries a base64 file (a 50 MB video is ~67 MB of
// base64), far over the 200 KB cap — so that one route gets its own
// 70 MB parser, and the small parser below skips that path.
const jsonSmall = express.json({ limit: '200kb' });
const jsonMedia = express.json({ limit: '70mb' });
app.use((req, res, next) => {
  if (req.path === '/api/messages/media') return next();
  jsonSmall(req, res, next);
});
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
  // Blocked users get no code at all (and no SMS/email is spent on them).
  // Checked before the rate limit, so a blocked user always gets 'blocked'.
  const existingUser = await db.get('SELECT blocked FROM users WHERE phone = ?', phone);
  if (existingUser && existingUser.blocked) {
    return res.status(403).json({ ok: false, error: 'blocked' });
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
  // Checked before the code itself, so a blocked user always gets
  // 'blocked' even with a wrong or missing code.
  const blockedUser = await db.get('SELECT blocked FROM users WHERE phone = ?', phone);
  if (blockedUser && blockedUser.blocked) {
    return res.status(403).json({ ok: false, error: 'blocked' });
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

// ---- my profile: name, about ("Current mood") and photo ------------------
// Edited from the Settings screen. The photo is a small square avatar —
// the client downscales it to 256px before upload, so it stays tiny in
// the database. (A profile photo is NOT a sent chat photo, so the
// 100%-original-quality rule does not apply here.) Avatar and about ride
// along in publicUser(), so contacts see them in the inbox, chat header
// and contact profile. About is capped at 140 characters, like WhatsApp.
const AVATAR_MAX_LEN = 150000; // ~112 KB decoded — far above a 256px JPEG, and below the 200 KB global JSON body limit so this check can actually fire
app.post('/api/profile', ah(auth), ah(async (req, res) => {
  const body = req.body || {};
  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) return res.status(400).json({ ok: false, error: 'bad_name' });
    updates.name = name;
  }
  if (body.about !== undefined) {
    updates.about = String(body.about).trim().slice(0, 140);
  }
  if (body.avatar !== undefined) {
    const avatar = String(body.avatar);
    if (avatar !== '' && !avatar.startsWith('data:image/')) {
      return res.status(400).json({ ok: false, error: 'bad_avatar' });
    }
    if (avatar.length > AVATAR_MAX_LEN) {
      return res.status(413).json({ ok: false, error: 'avatar_too_big' });
    }
    updates.avatar = avatar;
  }
  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  const sets = Object.keys(updates).map((k) => k + ' = ?').join(', ');
  await db.run(`UPDATE users SET ${sets} WHERE phone = ?`, ...Object.values(updates), req.phone);
  return res.json({ ok: true, ...(await publicUser(req.phone)) });
}));

app.get('/api/me', ah(auth), ah(async (req, res) => {
  // isAdmin tells the client whether to show the Admin tab. The server
  // still enforces admin on every /api/admin/* route — the tab is only UI.
  return res.json({ ok: true, ...(await publicUser(req.phone)), isAdmin: isAdmin(req.phone) });
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
  const t = now();
  for (const peer of peers.keys()) {
    // My Clear-chat marker hides my copy of old messages, and expired
    // (disappearing) messages never show as the last message or unread.
    const mine = await getChatSettings(req.phone, peer);
    const last = await db.get(
      `SELECT id, sender, receiver, body, created_at, delivered, read FROM messages
       WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
       AND (expires_at = 0 OR expires_at > ?) AND created_at > ?
       ORDER BY id DESC LIMIT 1`,
      req.phone, peer, peer, req.phone, t, mine.clearedAt);
    const unread = (await db.get(
      `SELECT COUNT(*) AS n FROM messages WHERE sender = ? AND receiver = ? AND read = FALSE
       AND (expires_at = 0 OR expires_at > ?) AND created_at > ?`,
      peer, req.phone, t, mine.clearedAt)).n;
    out.push({
      ...(await publicUser(peer)),
      lastMessage: last ? last.body : '',
      lastAt: last ? last.created_at : 0,
      lastId: last ? last.id : 0,
      unread,
      muted: mine.muted ? 1 : 0,
    });
  }
  out.sort((a, b) => b.lastAt - a.lastAt);
  return res.json({ ok: true, conversations: out });
}));

// Incremental message fetch: only messages with id > afterId are returned,
// so a weak connection never re-downloads the whole history.
app.get('/api/messages', ah(auth), ah(async (req, res) => {
  const withPhone = normalizePeerOrSystem(req.query.with || '');
  const afterId = Number(req.query.afterId || 0);
  if (!withPhone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  const t = now();
  const mine = await getChatSettings(req.phone, withPhone);
  // Hidden for me: messages that expired, and anything at/before my
  // Clear-chat marker. (The other side's view is untouched.) The media
  // bytes themselves are NOT in this reply — the client fetches them
  // on demand from GET /api/media/:id, so a poll stays light even when
  // the chat holds big original-quality photos and videos.
  const rows = await db.all(
    `SELECT id, sender, receiver, body, created_at, delivered, read,
       media_kind, media_name, media_type, media_size, media_duration,
       (media_data IS NOT NULL) AS has_media, expires_at FROM messages
     WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
       AND id > ? AND (expires_at = 0 OR expires_at > ?) AND created_at > ?
     ORDER BY id ASC LIMIT 200`,
    req.phone, withPhone, withPhone, req.phone, afterId, t, mine.clearedAt);
  // Messages from the peer that I just received count as delivered now.
  await db.run(
    'UPDATE messages SET delivered = TRUE WHERE sender = ? AND receiver = ? AND delivered = FALSE',
    withPhone, req.phone);
  // Tick state for MY messages in this conversation — returned on every
  // fetch, even when there are no new messages, so the sender's ticks
  // update from ✓ to ✓✓ to seen without re-downloading the history.
  const ticks = await db.all(
    `SELECT id, delivered, read FROM messages
     WHERE sender = ? AND receiver = ? AND (expires_at = 0 OR expires_at > ?) AND created_at > ?
     ORDER BY id DESC LIMIT 100`,
    req.phone, withPhone, t, mine.clearedAt);
  return res.json({ ok: true, messages: rows, ticks });
}));

app.post('/api/messages', ah(auth), ah(async (req, res) => {
  const to = normalizePeerOrSystem(req.body && (req.body.to || req.body.email), req.body && req.body.dial);
  const body = String((req.body && req.body.body) || '').trim().slice(0, 4000);
  if (!validIdentity(to) || !body) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  if (to === req.phone) return res.status(400).json({ ok: false, error: 'self_message' });
  // Per-user block: either side blocking the other stops new messages.
  const block = await blockState(req.phone, to);
  if (block.byMe) return res.status(403).json({ ok: false, error: 'you_blocked' });
  if (block.byPeer) return res.status(403).json({ ok: false, error: 'blocked_by_peer' });
  const t = now();
  const expiresAt = await disappearingExpiresAt(req.phone, to, t);
  const inserted = await db.get(
    'INSERT INTO messages (sender, receiver, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
    req.phone, to, body, t, expiresAt);
  const row = await db.get('SELECT * FROM messages WHERE id = ?', inserted.id);
  // Notify the receiver even if their app is closed (Web Push). The
  // notification never carries the message text — only the sender's name.
  // Fire-and-forget: a push failure must never fail or delay this reply.
  // Muted chats get no push at all.
  const sender = await publicUser(req.phone);
  await pushUnlessMuted(to, req.phone, {
    title: sender.name || req.phone,
    body: 'New message',
    tag: 'msg-' + req.phone,
    type: 'message',
    peer: req.phone,
  });
  return res.json({ ok: true, message: row });
}));

// Mark a conversation as read (clears my unread count for that peer).
app.post('/api/messages/read', ah(auth), ah(async (req, res) => {
  const withPhone = normalizePeerOrSystem(req.body && req.body.with);
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

// ---- per-chat settings: theme / mute / disappearing / block / clear -----
// WhatsApp-style per-chat menu (⋮ in the chat header). Each side keeps
// their own row, so muting a chat never mutes it for the other person.

app.get('/api/chat-settings', ah(auth), ah(async (req, res) => {
  const peer = normalizePeerOrSystem(req.query.with || '');
  if (!peer || peer === req.phone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  const mine = await getChatSettings(req.phone, peer);
  const theirs = await getChatSettings(peer, req.phone);
  return res.json({
    ok: true,
    peer,
    muted: mine.muted,
    disappearing: mine.disappearing,
    chatTheme: mine.chatTheme,
    blockedByMe: mine.blocked,
    blockedByPeer: theirs.blocked,
    clearedAt: mine.clearedAt,
  });
}));

app.post('/api/chat-settings', ah(auth), ah(async (req, res) => {
  const peer = normalizePeerOrSystem(req.body && req.body.with);
  if (!peer || peer === req.phone || peer === SYSTEM_SENDER) {
    return res.status(400).json({ ok: false, error: 'bad_peer' });
  }
  const body = req.body || {};
  // Only the fields actually sent are changed; the rest stay as they are.
  // Booleans go in as JS true/false: pg stores them as BOOLEAN, and
  // node:sqlite binds them as 1/0 — the same value either way.
  const patch = {};
  if (body.muted !== undefined) patch.muted = body.muted ? true : false;
  if (body.disappearing !== undefined) {
    const d = Number(body.disappearing);
    if (!DISAPPEAR_OPTIONS.includes(d)) return res.status(400).json({ ok: false, error: 'bad_disappearing' });
    patch.disappearing = d;
  }
  if (body.chatTheme !== undefined) {
    const th = String(body.chatTheme || '');
    if (!CHAT_THEMES.includes(th)) return res.status(400).json({ ok: false, error: 'bad_theme' });
    patch.chatTheme = th;
  }
  if (body.blocked !== undefined) patch.blocked = body.blocked ? true : false;
  if (!Object.keys(patch).length) return res.status(400).json({ ok: false, error: 'bad_input' });
  const colName = { muted: 'muted', disappearing: 'disappearing', chatTheme: 'chat_theme', blocked: 'blocked' };
  const keys = Object.keys(patch);
  const cols = ['owner_phone', 'peer_phone', ...keys.map((k) => colName[k])];
  const vals = [req.phone, peer, ...keys.map((k) => patch[k])];
  await db.run(
    `INSERT INTO chat_settings (${cols.join(', ')}) VALUES (${vals.map(() => '?').join(', ')})
     ON CONFLICT(owner_phone, peer_phone) DO UPDATE SET ${keys.map((k) => `${colName[k]} = excluded.${colName[k]}`).join(', ')}`,
    ...vals);
  const mine = await getChatSettings(req.phone, peer);
  const theirs = await getChatSettings(peer, req.phone);
  return res.json({
    ok: true,
    peer,
    muted: mine.muted,
    disappearing: mine.disappearing,
    chatTheme: mine.chatTheme,
    blockedByMe: mine.blocked,
    blockedByPeer: theirs.blocked,
    clearedAt: mine.clearedAt,
  });
}));

// Clear chat: hides this conversation's history for ME only (a marker,
// not a delete — the other side keeps their copy, and new messages after
// this still appear). Media is hidden with the messages.
app.post('/api/chat-settings/clear', ah(auth), ah(async (req, res) => {
  const peer = normalizePeerOrSystem(req.body && req.body.with);
  if (!peer || peer === req.phone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  await db.run(
    `INSERT INTO chat_settings (owner_phone, peer_phone, cleared_at) VALUES (?, ?, ?)
     ON CONFLICT(owner_phone, peer_phone) DO UPDATE SET cleared_at = excluded.cleared_at`,
    req.phone, peer, now());
  return res.json({ ok: true });
}));

// ---- contact profile: peer info + all shared media in this chat -----------
// Powers the profile page (tap the name in a chat): the peer's name and
// join date plus every photo / video / voice note / file shared in this
// chat, newest first. Only metadata here — the bytes still come on
// demand from GET /api/media/:id. Messages hidden by Clear chat
// (cleared_at) or by disappearing-message expiry are excluded.
app.get('/api/chat-media', ah(auth), ah(async (req, res) => {
  const withPhone = normalizePeerOrSystem(req.query.with || '');
  if (!withPhone) return res.status(400).json({ ok: false, error: 'bad_peer' });
  const t = now();
  const mine = await getChatSettings(req.phone, withPhone);
  const peer = await db.get('SELECT phone, name, avatar, about, created_at FROM users WHERE phone = ?', withPhone);
  const rows = await db.all(
    `SELECT id, sender, media_kind, media_name, media_type, media_size, media_duration, created_at FROM messages
     WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
       AND media_kind IS NOT NULL AND (expires_at = 0 OR expires_at > ?) AND created_at > ?
     ORDER BY id DESC LIMIT 200`,
    req.phone, withPhone, withPhone, req.phone, t, mine.clearedAt);
  return res.json({ ok: true, peer: peer || { phone: withPhone, name: '', avatar: '', about: '', created_at: 0 }, media: rows });
}));

// ---- media messages: photo / video / voice note / file ---------------------
// Sent at 100% ORIGINAL quality — never resized, never re-encoded, never
// compressed (Bijoy's rule: quality stays exactly as picked, however much
// MB it takes). The caps exist only to protect the 1 GB free Neon
// storage: photo 10 MB, video 50 MB, voice note 10 MB, file 5 MB.
// Anything over its cap is rejected with file_too_big — never squeezed
// to fit. Media is stored as base64 in the messages row itself (never
// on Render's disk — it is ephemeral). The bytes are NOT in the
// incremental message fetch; the client pulls them on demand from
// GET /api/media/:id, so polling stays light.
const MEDIA_CAPS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, voice: 10 * 1024 * 1024, file: 5 * 1024 * 1024 };
const MEDIA_LABELS = { image: '📷 Photo', video: '🎥 Video', voice: '🎤 Voice', file: '📄 File' };

app.post('/api/messages/media', jsonMedia, ah(auth), ah(async (req, res) => {
  const body = req.body || {};
  const to = normalizePeerOrSystem(body.to || body.email, body.dial);
  const kind = String(body.mediaKind || '');
  const data = typeof body.data === 'string' ? body.data : '';
  const fileName = String(body.fileName || '').trim().slice(0, 200);
  const mimeType = String(body.mimeType || '').trim().slice(0, 100);
  if (!validIdentity(to) || !MEDIA_CAPS[kind] || !data) {
    return res.status(400).json({ ok: false, error: 'bad_input' });
  }
  if (to === req.phone) return res.status(400).json({ ok: false, error: 'self_message' });
  // The real size is the decoded bytes, not what the client claims — a
  // lying size field cannot sneak a bigger file past the cap.
  const buf = Buffer.from(data, 'base64');
  const declared = Number(body.size || 0);
  if (!buf.length) return res.status(400).json({ ok: false, error: 'bad_data' });
  if (declared > MEDIA_CAPS[kind] || buf.length > MEDIA_CAPS[kind]) {
    return res.status(413).json({ ok: false, error: 'file_too_big', cap: MEDIA_CAPS[kind] });
  }
  const block = await blockState(req.phone, to);
  if (block.byMe) return res.status(403).json({ ok: false, error: 'you_blocked' });
  if (block.byPeer) return res.status(403).json({ ok: false, error: 'blocked_by_peer' });
  const t = now();
  const expiresAt = await disappearingExpiresAt(req.phone, to, t);
  const duration = Math.max(0, Math.floor(Number(body.duration || 0)));
  const label = kind === 'file' && fileName ? '📄 ' + fileName : MEDIA_LABELS[kind];
  const fetchRow = (id) => db.get(
    `SELECT id, sender, receiver, body, created_at, delivered, read,
       media_kind, media_name, media_type, media_size, media_duration, expires_at
     FROM messages WHERE id = ?`,
    id);
  // Idempotency: the client sends its tempId as clientKey. A retry of
  // an upload whose response was lost (flaky network) re-sends the
  // same key — return the row that already exists instead of
  // inserting a second copy (the receiver used to get the same photo
  // twice). No second push: the first insert already sent one.
  const clientKey = String(body.clientKey || '').trim().slice(0, 100);
  if (clientKey) {
    const existing = await db.get('SELECT id FROM messages WHERE sender = ? AND client_key = ?', req.phone, clientKey);
    if (existing) return res.json({ ok: true, message: await fetchRow(existing.id), duplicate: true });
  }
  let inserted;
  try {
    inserted = await db.get(
      `INSERT INTO messages (sender, receiver, body, created_at, expires_at,
         media_kind, media_name, media_type, media_size, media_data, media_duration, client_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      req.phone, to, label, t, expiresAt, kind, fileName, mimeType, buf.length, data, duration, clientKey || null);
  } catch (e) {
    // Two identical uploads raced each other and the unique index let
    // only one through — return that row instead of failing.
    if (clientKey) {
      const existing = await db.get('SELECT id FROM messages WHERE sender = ? AND client_key = ?', req.phone, clientKey);
      if (existing) return res.json({ ok: true, message: await fetchRow(existing.id), duplicate: true });
    }
    throw e;
  }
  // The reply leaves the bytes out — the sender already has them, and
  // the receiver pulls them on demand from GET /api/media/:id.
  const row = await fetchRow(inserted.id);
  const sender = await publicUser(req.phone);
  await pushUnlessMuted(to, req.phone, {
    title: sender.name || req.phone,
    body: label,
    tag: 'msg-' + req.phone,
    type: 'message',
    peer: req.phone,
  });
  return res.json({ ok: true, message: row });
}));

// Fetch one message's media bytes (on demand, when the chat renders it).
// Only the sender or the receiver may fetch it.
app.get('/api/media/:id', ah(auth), ah(async (req, res) => {
  const id = Number(req.params.id);
  const row = await db.get(
    'SELECT id, sender, receiver, media_kind, media_name, media_type, media_size, media_data, media_duration, expires_at FROM messages WHERE id = ?',
    id);
  if (!row || !row.media_data) return res.status(404).json({ ok: false, error: 'not_found' });
  if (row.sender !== req.phone && row.receiver !== req.phone) {
    return res.status(403).json({ ok: false, error: 'not_allowed' });
  }
  if (row.expires_at && row.expires_at <= now()) return res.status(404).json({ ok: false, error: 'expired' });
  return res.json({
    ok: true,
    id: row.id,
    mediaKind: row.media_kind,
    fileName: row.media_name,
    mimeType: row.media_type,
    size: row.media_size,
    duration: row.media_duration,
    data: row.media_data,
  });
}));

// How much of the 1 GB free storage this user's media uses (sent +
// received). LENGTH(media_data) counts base64 characters — an estimate,
// labelled as such in the app. Nothing is ever auto-deleted to save space.
app.get('/api/storage', ah(auth), ah(async (req, res) => {
  const r = await db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(media_data)), 0) AS b FROM messages
     WHERE media_data IS NOT NULL AND (sender = ? OR receiver = ?)`,
    req.phone, req.phone);
  return res.json({ ok: true, mediaCount: r.n, mediaBytes: r.b, limitBytes: 1073741824 });
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
    statuses.push({ ...r, mine: r.phone === req.phone, ...(await publicUser(r.phone)) });
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
  // Per-user block: a blocked contact cannot start a call with me, and
  // I cannot call someone I blocked. (Only the offer is gated — an
  // in-progress call's answer/ice/end signals must still flow.)
  if (kind === 'offer') {
    const block = await blockState(req.phone, to);
    if (block.byMe) return res.status(403).json({ ok: false, error: 'you_blocked' });
    if (block.byPeer) return res.status(403).json({ ok: false, error: 'blocked_by_peer' });
  }
  await db.run(
    'INSERT INTO call_signals (from_phone, to_phone, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    req.phone, to, kind, JSON.stringify(payload), now());
  // A call offer also pushes the callee's phone, so the call arrives even
  // when their app is closed. Fire-and-forget, like messages — and a
  // muted chat gets no push at all.
  if (kind === 'offer') {
    const caller = await publicUser(req.phone);
    await pushUnlessMuted(to, req.phone, {
      title: caller.name || req.phone,
      body: 'Incoming call…',
      tag: 'call-' + req.phone,
      type: 'call',
      peer: req.phone,
      requireInteraction: true,
    });
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

// ---- admin panel ------------------------------------------------------------
// Admins are named by the ADMIN_USERS env var (see top of this file).
// Every route here requires auth + adminAuth — a non-admin gets 403,
// even if they guess the URL. The client hides the Admin tab for
// non-admins, but this server check is the real gate.

// Stats: totals for the panel's top cards. Calls = call attempts
// (one 'offer' signal per call attempt).
app.get('/api/admin/stats', ah(auth), adminAuth, ah(async (req, res) => {
  const users = (await db.get('SELECT COUNT(*) AS n FROM users')).n;
  const messages = (await db.get('SELECT COUNT(*) AS n FROM messages')).n;
  const calls = (await db.get("SELECT COUNT(*) AS n FROM call_signals WHERE kind = 'offer'")).n;
  return res.json({ ok: true, users, messages, calls });
}));

// All users, newest first, with their blocked flag.
app.get('/api/admin/users', ah(auth), adminAuth, ah(async (req, res) => {
  const rows = await db.all('SELECT phone, name, created_at, blocked FROM users ORDER BY created_at DESC LIMIT 500');
  return res.json({ ok: true, users: rows.map((r) => ({ ...r, blocked: r.blocked ? 1 : 0 })) });
}));

// Block or unblock a user. Blocking takes effect at once: the auth
// middleware rejects the user's live session on the next request, so they
// cannot log in, send messages, or call. Unblocking makes the same
// session work again — no re-login needed. An admin cannot block another
// admin (or themself) by accident.
app.post('/api/admin/users/block', ah(auth), adminAuth, ah(async (req, res) => {
  const phone = normalizePeer(req.body && req.body.phone);
  const blocked = req.body && req.body.blocked === true;
  if (!validIdentity(phone)) return res.status(400).json({ ok: false, error: 'bad_phone' });
  const user = await db.get('SELECT phone FROM users WHERE phone = ?', phone);
  if (!user) return res.status(404).json({ ok: false, error: 'not_found' });
  if (blocked && isAdmin(phone)) return res.status(403).json({ ok: false, error: 'cannot_block_admin' });
  // TRUE/FALSE as SQL literals: native boolean on Postgres, 1/0 on SQLite.
  await db.run(`UPDATE users SET blocked = ${blocked ? 'TRUE' : 'FALSE'} WHERE phone = ?`, phone);
  return res.json({ ok: true, phone, blocked });
}));

// All channels, with follower counts, for the panel's channel list.
app.get('/api/admin/channels', ah(auth), adminAuth, ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM channels ORDER BY created_at DESC LIMIT 200');
  const out = [];
  for (const c of rows) {
    const followers = (await db.get('SELECT COUNT(*) AS n FROM channel_follows WHERE channel_id = ?', c.id)).n;
    out.push({ ...c, followers });
  }
  return res.json({ ok: true, channels: out });
}));

// Delete any channel (admin only — the normal owner-only rule stays for
// regular users). Posts and follows go with it.
app.delete('/api/admin/channels/:id', ah(auth), adminAuth, ah(async (req, res) => {
  const id = Number(req.params.id);
  const ch = await db.get('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) return res.status(404).json({ ok: false, error: 'not_found' });
  await db.run('DELETE FROM channel_posts WHERE channel_id = ?', id);
  await db.run('DELETE FROM channel_follows WHERE channel_id = ?', id);
  await db.run('DELETE FROM channels WHERE id = ?', id);
  return res.json({ ok: true });
}));

// Broadcast an announcement to ALL users. It is stored as a normal
// 1-to-1 message from "S_19 CHAT BOOK" into every user's inbox — the
// same delivery path as a regular message (it appears in each user's
// chat list, and a push notification goes out like any other message),
// not a second channel system. Blocked users are skipped: they cannot
// log in to read it anyway.
app.post('/api/admin/broadcast', ah(auth), adminAuth, ah(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim().slice(0, 4000);
  if (!text) return res.status(400).json({ ok: false, error: 'bad_text' });
  const t = now();
  const r = await db.run(
    `INSERT INTO messages (sender, receiver, body, created_at)
     SELECT ?, phone, ?, ? FROM users WHERE phone != ? AND blocked = FALSE`,
    SYSTEM_SENDER, text, t, SYSTEM_SENDER);
  const recipients = r.changes || 0;
  // Notify everyone, even with the app closed — fire-and-forget, like a
  // normal message; a push failure never blocks the reply.
  const users = await db.all('SELECT phone FROM users WHERE phone != ? AND blocked = FALSE', SYSTEM_SENDER);
  for (const u of users) {
    push.sendPushToUser(db, u.phone, {
      title: 'S_19 CHAT BOOK',
      body: 'New announcement',
      tag: 'announce',
      type: 'announcement',
      peer: SYSTEM_SENDER,
    }).catch(() => {});
  }
  return res.json({ ok: true, recipients });
}));

// The panel's one setting: the welcome-screen banner text. Empty = hidden.
app.get('/api/admin/settings', ah(auth), adminAuth, ah(async (req, res) => {
  const row = await db.get("SELECT value FROM settings WHERE key = 'banner'");
  return res.json({ ok: true, banner: row ? row.value : '' });
}));
app.post('/api/admin/settings', ah(auth), adminAuth, ah(async (req, res) => {
  const banner = String((req.body && req.body.banner) || '').trim().slice(0, 300);
  await db.run(
    `INSERT INTO settings (key, value) VALUES ('banner', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    banner);
  return res.json({ ok: true, banner });
}));

// Public (no login needed): the welcome screen fetches this before login
// to show the admin's banner, if one is set.
app.get('/api/banner', ah(async (req, res) => {
  const row = await db.get("SELECT value FROM settings WHERE key = 'banner'");
  return res.json({ ok: true, banner: row ? row.value : '' });
}));

// ---- static frontend + start -------------------------------------------------

// The web app manifest, served with its proper content type so Chrome
// offers "Add to Home screen" / Install — the installed app opens
// fullscreen with no browser address bar on top.
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Errors from async handlers end up here as JSON, not an HTML error page.
// A body that is too big (media over the 70 MB parser cap) is reported
// as file_too_big, not a generic server error.
app.use((err, _req, res, _next) => {
  console.error('[api error]', err && err.message);
  if (res.headersSent) return;
  if (err && (err.status === 413 || err.type === 'entity.too.large')) {
    return res.status(413).json({ ok: false, error: 'file_too_big' });
  }
  res.status(500).json({ ok: false, error: 'server_error' });
});

// Clean up expired statuses and consumed signals every hour.
setInterval(async () => {
  try {
    await db.run('DELETE FROM statuses WHERE expires_at <= ?', now());
    await db.run('DELETE FROM call_signals WHERE consumed = TRUE AND created_at < ?', now() - 60 * 60 * 1000);
    // Disappearing messages: expired rows — and their media with them —
    // are deleted for everyone, not just hidden.
    await db.run('DELETE FROM messages WHERE expires_at > 0 AND expires_at <= ?', now());
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
    console.log(`Admin panel: ${ADMIN_USERS.size ? ADMIN_USERS.size + ' admin(s) configured' : 'no admins (ADMIN_USERS not set)'}`);
  });
}

start().catch((e) => {
  console.error('Failed to start server:', e && e.message);
  process.exit(1);
});
