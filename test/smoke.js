// S_19 CHAT BOOK — smoke test (run: npm test)
// Boots the real server on a scratch DB and exercises every flow with
// made-up test numbers only. Exits non-zero on any failure.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = '/tmp/s19-smoke-test.db';
// When DATABASE_URL is set, the same suite runs against Postgres (Neon)
// instead of the local SQLite file. The tables are dropped first so the
// fixed test numbers start clean on every run.
const PG_URL = process.env.DATABASE_URL || '';
if (!PG_URL) {
  try { fs.unlinkSync(DB); } catch {}
  try { fs.unlinkSync(DB + '-wal'); } catch {}
  try { fs.unlinkSync(DB + '-shm'); } catch {}
}

const BIJOY = '8801711000001'; // made-up test number
const FRIEND = '8801811000002'; // made-up test number
const GMAIL_USER = 'bijoy.test@gmail.com'; // made-up test Gmail address

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra ? JSON.stringify(extra).slice(0, 300) : ''); }
}
async function post(p, body, token) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}
async function get(p, token) {
  const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function login(phone, name) {
  const rc = await post('/api/request-code', { phone });
  check(`request-code ${phone} returns test code`, rc.status === 200 && rc.data.ok && typeof rc.data.testCode === 'string' && rc.data.testCode.length === 6, rc);
  // A wrong code must be rejected before the right one is used.
  const badVerify = await post('/api/verify-code', { phone, code: '000000' });
  check(`wrong code rejected for ${phone}`, badVerify.status === 400 && badVerify.data.error === 'wrong_code', badVerify);
  const vc = await post('/api/verify-code', { phone, code: rc.data.testCode });
  check(`verify-code ${phone}`, vc.status === 200 && vc.data.ok && vc.data.token, vc);
  const sn = await post('/api/set-name', { name }, vc.data.token);
  check(`set-name ${phone} -> ${name}`, sn.status === 200 && sn.data.name === name, sn);
  return vc.data.token;
}

async function loginEmail(email, name) {
  const rc = await post('/api/request-code', { email });
  check(`request-code ${email} returns test code`, rc.status === 200 && rc.data.ok && typeof rc.data.testCode === 'string' && rc.data.testCode.length === 6, rc);
  // A wrong code must be rejected before the right one is used.
  const badVerify = await post('/api/verify-code', { email, code: '000000' });
  check(`wrong code rejected for ${email}`, badVerify.status === 400 && badVerify.data.error === 'wrong_code', badVerify);
  const vc = await post('/api/verify-code', { email, code: rc.data.testCode });
  check(`verify-code ${email}`, vc.status === 200 && vc.data.ok && vc.data.token, vc);
  const sn = await post('/api/set-name', { name }, vc.data.token);
  check(`set-name ${email} -> ${name}`, sn.status === 200 && sn.data.name === name, sn);
  return vc.data.token;
}

async function main() {
  if (PG_URL) {
    console.log('== engine: Postgres (DATABASE_URL) ==');
    const { Client } = require('pg');
    const { cleanConnectionString } = require('../db');
    const client = new Client({
      connectionString: cleanConnectionString(PG_URL),
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await client.query('DROP TABLE IF EXISTS users, sessions, otp_codes, contacts, messages, statuses, channels, channel_follows, channel_posts, call_signals CASCADE');
    await client.end();
  } else {
    console.log('== engine: SQLite (local file) ==');
  }
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB },
    stdio: 'pipe',
  });
  server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));

  // Wait for the server to answer (Neon can take a few seconds to wake).
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log('== static files ==');
  const idx = await fetch(BASE + '/');
  check('GET / serves index.html', idx.status === 200 && (await idx.text()).includes('S_19 CHAT BOOK'));
  const cj = await fetch(BASE + '/countries.js');
  const cjText = await cj.text();
  check('countries.js has 248 entries, BD first', cj.status === 200 && cjText.includes('Bangladesh') && cjText.includes('"+880"'));
  const logo = await fetch(BASE + '/logo.webp');
  check('logo.webp serves', logo.status === 200 && (logo.headers.get('content-type') || '').includes('webp'));
  const idxText = await (await fetch(BASE + '/')).text();
  check('index offers Gmail login', idxText.includes('Gmail'));

  console.log('== auth ==');
  const tokA = await login(BIJOY, 'Bijoy Test');
  const tokB = await login(FRIEND, 'Friend Test');
  const me = await get('/api/me', tokA);
  check('GET /api/me returns name', me.status === 200 && me.data.name === 'Bijoy Test', me);
  const noAuth = await get('/api/me');
  check('no token -> 401', noAuth.status === 401);

  console.log('== gmail login ==');
  const badEmail = await post('/api/request-code', { email: 'not-an-email' });
  check('bad email rejected', badEmail.status === 400 && badEmail.data.error === 'bad_email', badEmail);
  const tokG = await loginEmail(GMAIL_USER, 'Gmail Bondhu');
  const meG = await get('/api/me', tokG);
  check('GET /api/me returns Gmail user', meG.status === 200 && meG.data.name === 'Gmail Bondhu' && meG.data.phone === GMAIL_USER, meG);

  console.log('== contacts + direct messages ==');
  const add = await post('/api/contacts', { phone: FRIEND }, tokA);
  check('add contact by number', add.status === 200 && add.data.contact.phone === FRIEND, add);
  const addSelf = await post('/api/contacts', { phone: BIJOY }, tokA);
  check('cannot add self', addSelf.status === 400, addSelf);
  const sent = await post('/api/messages', { to: FRIEND, body: 'Hello bondhu, test message' }, tokA);
  check('send direct message', sent.status === 200 && sent.data.message.body.includes('Hello'), sent);
  const inboxB = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('friend receives the message', inboxB.status === 200 && inboxB.data.messages.length === 1, inboxB);
  const inboxA = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  check('sender sees delivered double-tick', inboxA.status === 200 && inboxA.data.messages[0].delivered === 1, inboxA);
  const inc = await get('/api/messages?with=' + FRIEND + '&afterId=' + inboxA.data.messages[0].id, tokA);
  check('incremental fetch returns nothing new', inc.status === 200 && inc.data.messages.length === 0, inc);
  const read = await post('/api/messages/read', { with: BIJOY }, tokB);
  check('friend marks conversation read', read.status === 200 && read.data.ok, read);
  const ticksEmpty = await get('/api/messages?with=' + FRIEND + '&afterId=' + inboxA.data.messages[0].id, tokA);
  check('ticks arrive even when no new messages (delivered + read)',
    ticksEmpty.status === 200 && ticksEmpty.data.messages.length === 0 && Array.isArray(ticksEmpty.data.ticks)
    && ticksEmpty.data.ticks.length === 1 && ticksEmpty.data.ticks[0].delivered === 1 && ticksEmpty.data.ticks[0].read === 1, ticksEmpty);
  const sent2 = await post('/api/messages', { to: FRIEND, body: 'Second test message' }, tokA);
  check('send second message', sent2.status === 200, sent2);
  const convsB = await get('/api/conversations', tokB);
  check('friend inbox lists conversation', convsB.status === 200 && convsB.data.conversations.length >= 1, convsB);
  const ticks2 = await get('/api/messages?with=' + FRIEND + '&afterId=' + sent2.data.message.id, tokA);
  check('inbox poll alone marks message delivered',
    ticks2.status === 200 && ticks2.data.ticks.some((t) => t.id === sent2.data.message.id && t.delivered === 1 && t.read === 0), ticks2);
  const convs = await get('/api/conversations', tokA);
  check('inbox lists the conversation', convs.status === 200 && convs.data.conversations.length === 1 && convs.data.conversations[0].lastMessage.includes('Second test message'), convs);

  console.log('== gmail + phone cross chat ==');
  const addByEmail = await post('/api/contacts', { email: GMAIL_USER }, tokA);
  check('add contact by Gmail address', addByEmail.status === 200 && addByEmail.data.contact.phone === GMAIL_USER, addByEmail);
  const addSelfEmail = await post('/api/contacts', { email: GMAIL_USER }, tokG);
  check('cannot add self by Gmail', addSelfEmail.status === 400, addSelfEmail);
  const sentToGmail = await post('/api/messages', { to: GMAIL_USER, body: 'Gmail bondhu, kemon acho?' }, tokA);
  check('phone user sends to Gmail user', sentToGmail.status === 200 && sentToGmail.data.message.body.includes('Gmail bondhu'), sentToGmail);
  const inboxG = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokG);
  check('Gmail user receives phone user message', inboxG.status === 200 && inboxG.data.messages.length === 1, inboxG);
  const replyFromGmail = await post('/api/messages', { to: BIJOY, body: 'Ami valo achi!' }, tokG);
  check('Gmail user replies to phone user', replyFromGmail.status === 200, replyFromGmail);
  const inboxA2 = await get('/api/messages?with=' + GMAIL_USER + '&afterId=0', tokA);
  check('phone user receives Gmail user reply', inboxA2.status === 200 && inboxA2.data.messages.length === 2, inboxA2);
  const convsA2 = await get('/api/conversations', tokA);
  check('inbox lists both conversations', convsA2.status === 200 && convsA2.data.conversations.length === 2, convsA2);

  console.log('== statuses ==');
  const st = await post('/api/statuses', { text: 'Ami valo achi — test status' }, tokA);
  check('post status', st.status === 200 && st.data.status.id, st);
  const stB = await get('/api/statuses', tokB);
  check('friend (contact) sees status', stB.status === 200 && stB.data.statuses.some((s) => s.text.includes('Ami valo')), stB);
  const delOther = await fetch(BASE + '/api/statuses/' + st.data.status.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokB } });
  check('non-owner cannot delete status', delOther.status === 403);
  const delOwn = await fetch(BASE + '/api/statuses/' + st.data.status.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokA } });
  check('owner deletes own status', delOwn.status === 200);

  console.log('== channels ==');
  const ch = await post('/api/channels', { name: 'Test Channel S19', description: 'porikkhar channel' }, tokA);
  check('create channel', ch.status === 200 && ch.data.channel.id, ch);
  const dup = await post('/api/channels', { name: 'test channel s19', description: 'duplicate' }, tokB);
  check('duplicate channel name rejected', dup.status === 409 && dup.data.error === 'name_taken', dup);
  const search = await get('/api/channels?q=porikkhar', tokB);
  check('channel found by search (stranger, never added)', search.status === 200 && search.data.channels.some((c) => c.name === 'Test Channel S19'), search);
  const follow = await post('/api/channels/' + ch.data.channel.id + '/follow', {}, tokB);
  check('friend follows channel', follow.status === 200, follow);
  const badPost = await post('/api/channels/' + ch.data.channel.id + '/posts', { text: 'ami post korbo' }, tokB);
  check('non-owner cannot post', badPost.status === 403 && badPost.data.error === 'not_owner', badPost);
  const goodPost = await post('/api/channels/' + ch.data.channel.id + '/posts', { text: 'Prothom update!' }, tokA);
  check('owner posts', goodPost.status === 200, goodPost);
  const chList = await get('/api/channels?q=', tokB);
  const mine = chList.data.channels.find((c) => c.id === ch.data.channel.id);
  check('follower sees unread badge = 1', mine && mine.unread === 1 && mine.lastPost === 'Prothom update!', mine);
  const posts = await get('/api/channels/' + ch.data.channel.id + '/posts', tokB);
  check('follower reads posts', posts.status === 200 && posts.data.posts.length === 1, posts);
  await post('/api/channels/' + ch.data.channel.id + '/read', {}, tokB);
  const chList2 = await get('/api/channels?q=', tokB);
  const mine2 = chList2.data.channels.find((c) => c.id === ch.data.channel.id);
  check('unread badge clears on open', mine2 && mine2.unread === 0, mine2);

  console.log('== call signalling ==');
  const sig = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'fake-offer', type: 'offer' } }, tokA);
  check('send call offer signal', sig.status === 200, sig);
  const sigs = await get('/api/calls/signals', tokB);
  check('callee receives offer signal', sigs.status === 200 && sigs.data.signals.length === 1 && sigs.data.signals[0].kind === 'offer', sigs);
  const sigs2 = await get('/api/calls/signals', tokB);
  check('signals are consumed after fetch', sigs2.status === 200 && sigs2.data.signals.length === 0, sigs2);

  console.log('== usage ==');
  const usage = await get('/api/usage', tokA);
  check('usage endpoint counts today', usage.status === 200 && usage.data.messagesSent === 3 && usage.data.bytesSent > 0, usage);

  console.log('== logout ==');
  const lo = await post('/api/logout', {}, tokA);
  check('logout works', lo.status === 200, lo);
  const meAfter = await get('/api/me', tokA);
  check('token invalid after logout', meAfter.status === 401);

  server.kill();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE ERROR', e); process.exit(2); });
