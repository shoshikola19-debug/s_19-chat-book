// S_19 CHAT BOOK — database adapter
// ---------------------------------------------------------------------------
// Two engines behind one small async API (get / all / run / exec):
//
// - Postgres, when DATABASE_URL is set (Neon free tier on Render). The
//   connection string comes from the environment only — never from code.
//   Neon's pooler (PgBouncer) rejects `channel_binding=require`, and
//   pg-connection-string v3 parses `sslmode` into an ssl config that
//   overrides the explicit one, so both parameters are stripped from the
//   URL automatically (TLS is still on, via the explicit ssl option).
// - SQLite (local file), when DATABASE_URL is unset — exactly the
//   behaviour the app always had, so local `npm test` still works.
//
// Callers keep writing `?` placeholders: the Postgres path converts them
// to $1, $2, ... automatically. Both engines return identical shapes:
// ids and counts are JS numbers, and delivered/read/consumed flags are
// 0/1 (pg returns booleans for BOOLEAN columns and strings for int8, so
// those are normalised here with pg type parsers).

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0
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
  read INTEGER NOT NULL DEFAULT 0,
  -- Disappearing messages: ms timestamp when this message expires
  -- (0 = never). Expired rows are hidden from every read and deleted
  -- by the hourly cleanup.
  expires_at INTEGER NOT NULL DEFAULT 0,
  -- Media (photo / video / voice note / file): sent at 100% original
  -- quality, never compressed. The body holds the inbox preview label
  -- ("📷 ছবি", "🎥 ভিডিও", "🎤 ভয়েস", "📄 নাম") and these columns
  -- hold the media itself (base64 in media_data, never on disk —
  -- Render's disk is ephemeral). Caps are enforced in server.js:
  -- photo 10 MB, video 50 MB, voice 10 MB, file 5 MB.
  media_kind TEXT,
  media_name TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT '',
  media_size INTEGER NOT NULL DEFAULT 0,
  media_data TEXT,
  -- Voice-note length in seconds (0 for other kinds).
  media_duration INTEGER NOT NULL DEFAULT 0,
  -- Client idempotency key for media uploads: the sender's tempId.
  -- A retry of an upload whose response was lost (flaky network)
  -- re-sends the same key, and the server returns the row that
  -- already exists instead of inserting a second copy.
  client_key TEXT
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
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_phone TEXT NOT NULL,
  keys TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_phone);
-- Admin panel settings (key/value, e.g. key 'banner' = welcome-screen
-- announcement text; empty/missing = hidden). One small table on purpose:
-- the admin panel has exactly one setting, the banner.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
-- Per-chat settings, one row per (owner, peer) direction — each side
-- keeps their own mute / disappearing / theme / block choice:
--   muted         1 = no push notification and no sound for this chat
--   disappearing  seconds until messages in this chat expire
--                 (0 = off, 86400 = 24h, 604800 = 7d, 7776000 = 90d)
--   chat_theme    per-chat background theme ('' = default)
--   blocked       1 = I blocked this peer (they cannot message/call me,
--                 and I cannot message/call them either)
--   cleared_at    ms timestamp: messages at or before this are hidden
--                 for me only (Clear chat) — the other side keeps them.
CREATE TABLE IF NOT EXISTS chat_settings (
  owner_phone TEXT NOT NULL,
  peer_phone TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  disappearing INTEGER NOT NULL DEFAULT 0,
  chat_theme TEXT NOT NULL DEFAULT '',
  blocked INTEGER NOT NULL DEFAULT 0,
  cleared_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_phone, peer_phone)
);
`;

// Postgres equivalent of the schema above. Differences from SQLite:
// - SERIAL instead of INTEGER PRIMARY KEY AUTOINCREMENT
// - BIGINT for created_at/expires_at/last_read_at (Date.now() ms values
//   do not fit in a 32-bit integer)
// - BOOLEAN instead of INTEGER 0/1 for delivered/read/consumed
// - No COLLATE NOCASE: case-insensitive channel names are enforced by a
//   unique index on LOWER(name) instead
// - No PRAGMA lines (SQLite only)
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  phone TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  created_at BIGINT NOT NULL,
  blocked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS contacts (
  owner_phone TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (owner_phone, contact_phone)
);
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  delivered BOOLEAN NOT NULL DEFAULT FALSE,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at BIGINT NOT NULL DEFAULT 0,
  media_kind TEXT,
  media_name TEXT NOT NULL DEFAULT '',
  media_type TEXT NOT NULL DEFAULT '',
  media_size BIGINT NOT NULL DEFAULT 0,
  media_data TEXT,
  media_duration BIGINT NOT NULL DEFAULT 0,
  client_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender, receiver, id);
CREATE TABLE IF NOT EXISTS statuses (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_statuses_phone ON statuses (phone, expires_at);
CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_phone TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_name_lower ON channels (LOWER(name));
CREATE TABLE IF NOT EXISTS channel_follows (
  channel_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  last_read_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, phone)
);
CREATE TABLE IF NOT EXISTS channel_posts (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_posts ON channel_posts (channel_id, id);
CREATE TABLE IF NOT EXISTS call_signals (
  id SERIAL PRIMARY KEY,
  from_phone TEXT NOT NULL,
  to_phone TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  consumed BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_call_signals_to ON call_signals (to_phone, consumed);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_phone TEXT NOT NULL,
  keys TEXT NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions (user_phone);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chat_settings (
  owner_phone TEXT NOT NULL,
  peer_phone TEXT NOT NULL,
  muted BOOLEAN NOT NULL DEFAULT FALSE,
  disappearing BIGINT NOT NULL DEFAULT 0,
  chat_theme TEXT NOT NULL DEFAULT '',
  blocked BOOLEAN NOT NULL DEFAULT FALSE,
  cleared_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_phone, peer_phone)
);
`;

// Neon's pooler (PgBouncer) does not support channel binding, so that
// parameter is dropped. `sslmode` is dropped too: pg-connection-string
// v3 parses sslmode=require as verify-full, and the parsed value
// overrides the explicit ssl option below — which would reject
// self-signed certificates. TLS is still used: the ssl option is set
// explicitly on the pool.
function cleanConnectionString(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.searchParams.delete('channel_binding');
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url
      .replace(/([?&])(channel_binding|sslmode)=[^&]*&/g, '$1')
      .replace(/([?&])(channel_binding|sslmode)=[^&]*$/, '');
  }
}

// Convert `?` placeholders to $1, $2, ... for Postgres. (Our SQL never
// contains a literal `?` inside a string, so a plain scan is safe.)
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

async function createDb({ dbPath }) {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const { Pool, types } = require('pg');
    // Normalise pg's return types so both engines return identical
    // shapes: int8 (COUNT, SUM, BIGINT ids/timestamps) as numbers, and
    // booleans as 0/1 like SQLite's INTEGER flags.
    types.setTypeParser(20, (v) => parseInt(v, 10)); // int8 -> number
    // Postgres sends booleans as 't'/'f' on the wire (not 'true'/'false').
    types.setTypeParser(16, (v) => (v === 't' || v === 'true' || v === 'TRUE' ? 1 : 0)); // bool -> 0/1
    const pool = new Pool({
      connectionString: cleanConnectionString(databaseUrl),
      ssl: { rejectUnauthorized: false }, // Neon requires sslmode=require
      max: 5,
    });
    await pool.query(PG_SCHEMA);
    // Migration for databases created before the admin panel: the users
    // table needs the blocked flag. IF NOT EXISTS keeps this safe to run
    // on every boot (fresh DBs already have the column from the schema).
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked BOOLEAN NOT NULL DEFAULT FALSE');
    // Migration for databases created before chat settings / media /
    // disappearing messages: new messages columns. Same pattern — safe
    // on every boot, fresh DBs already have them from the schema.
    await pool.query(`ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS expires_at BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS media_kind TEXT,
      ADD COLUMN IF NOT EXISTS media_name TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS media_size BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS media_data TEXT,
      ADD COLUMN IF NOT EXISTS media_duration BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS client_key TEXT`);
    // Idempotency key for media-upload retries (see db.js schema note).
    // NOTE: this index must ONLY be created here, AFTER the ALTER above
    // — never inside PG_SCHEMA. On an existing database the schema's
    // CREATE TABLE is a no-op (table already exists without client_key),
    // so an index on client_key inside PG_SCHEMA crashes the boot with
    // `column "client_key" does not exist` (seen live 2026-11-08).
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_key ON messages (sender, client_key)');
    return {
      engine: 'postgres',
      label: 'Neon Postgres',
      exec: async (sql) => {
        await pool.query(sql);
      },
      get: async (sql, ...params) => {
        const r = await pool.query(toPgParams(sql), params);
        return r.rows[0];
      },
      all: async (sql, ...params) => {
        const r = await pool.query(toPgParams(sql), params);
        return r.rows;
      },
      run: async (sql, ...params) => {
        const r = await pool.query(toPgParams(sql), params);
        return { changes: r.rowCount, lastInsertRowid: undefined, rows: r.rows };
      },
      close: async () => pool.end(),
    };
  }

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SQLITE_SCHEMA);
  // Migration for databases created before the admin panel: SQLite has
  // no ADD COLUMN IF NOT EXISTS, so check the table first.
  const userCols = db.prepare('PRAGMA table_info(users)').all();
  if (!userCols.some((c) => c.name === 'blocked')) {
    db.exec('ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0');
  }
  // Migration for databases created before chat settings / media /
  // disappearing messages: new messages columns, same check-first way.
  const msgCols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  const msgAdds = [
    ['expires_at', 'INTEGER NOT NULL DEFAULT 0'],
    ['media_kind', 'TEXT'],
    ['media_name', "TEXT NOT NULL DEFAULT ''"],
    ['media_type', "TEXT NOT NULL DEFAULT ''"],
    ['media_size', 'INTEGER NOT NULL DEFAULT 0'],
    ['media_data', 'TEXT'],
    ['media_duration', 'INTEGER NOT NULL DEFAULT 0'],
    ['client_key', 'TEXT'],
  ];
  for (const [col, def] of msgAdds) {
    if (!msgCols.includes(col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} ${def}`);
  }
  // Idempotency key for media-upload retries (see schema note above).
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_key ON messages (sender, client_key)');
  return {
    engine: 'sqlite',
    label: 'SQLite (local file)',
    exec: async (sql) => {
      db.exec(sql);
    },
    get: async (sql, ...params) => db.prepare(sql).get(...params),
    all: async (sql, ...params) => db.prepare(sql).all(...params),
    run: async (sql, ...params) => {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowid: info.lastInsertRowid, rows: [] };
    },
    close: async () => db.close(),
  };
}

module.exports = { createDb, cleanConnectionString, stripChannelBinding: cleanConnectionString };
