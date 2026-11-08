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

// Direct SQL against the scratch DB (both engines), for test setup the
// API cannot do — e.g. backdating a message's expiry so the test does
// not have to wait 24 hours. The server keeps running on the same DB.
async function execSql(sql, ...params) {
  if (PG_URL) {
    const { Client } = require('pg');
    const { cleanConnectionString } = require('../db');
    const client = new Client({ connectionString: cleanConnectionString(PG_URL), ssl: { rejectUnauthorized: false } });
    await client.connect();
    let i = 0;
    await client.query(sql.replace(/\?/g, () => '$' + ++i), params);
    await client.end();
  } else {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    db.prepare(sql).run(...params);
    db.close();
  }
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
    await client.query('DROP TABLE IF EXISTS users, sessions, otp_codes, contacts, messages, statuses, channels, channel_follows, channel_posts, call_signals, push_subscriptions, settings CASCADE');
    await client.end();
  } else {
    console.log('== engine: SQLite (local file) ==');
  }
  const server = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    // BIJOY is the admin for this run (ADMIN_USERS), so the admin panel
    // can be tested end to end; everyone else must get 403.
    env: { ...process.env, PORT: String(PORT), DB_PATH: DB, ADMIN_USERS: BIJOY },
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
  const manifest = await fetch(BASE + '/manifest.json');
  const manifestData = await manifest.json().catch(() => null);
  check('manifest serves for Add to Home screen',
    manifest.status === 200 && (manifest.headers.get('content-type') || '').includes('manifest')
    && manifestData && manifestData.name === 'S_19 CHAT BOOK' && manifestData.display === 'standalone', manifestData);
  const icon192 = await fetch(BASE + '/icon-192.png');
  check('app icon 192 serves', icon192.status === 200 && (icon192.headers.get('content-type') || '').includes('png'));
  const swJs = await fetch(BASE + '/sw.js');
  const swText = await swJs.text();
  check('service worker has a fetch handler (installable)',
    swJs.status === 200 && swText.includes("addEventListener('fetch'"));
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

  console.log('== video call signalling ==');
  // A video offer carries video:true through the same signal path, so
  // the callee's incoming screen knows it is a VIDEO call and opens
  // the video UI on answer. An audio offer carries no video flag.
  // (Real two-phone video cannot be tested headlessly — the API flow
  // and the UI presence below are what this suite can pin down.)
  const vidSig = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'fake-video-offer', type: 'offer', video: true } }, tokA);
  check('send video call offer signal', vidSig.status === 200, vidSig);
  const vidSigs = await get('/api/calls/signals', tokB);
  check('callee receives the video offer with the video flag',
    vidSigs.status === 200 && vidSigs.data.signals.length === 1 && vidSigs.data.signals[0].kind === 'offer' && vidSigs.data.signals[0].payload.video === true, vidSigs);
  const audSig = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'fake-audio-offer', type: 'offer' } }, tokA);
  check('send audio call offer signal', audSig.status === 200, audSig);
  const audSigs = await get('/api/calls/signals', tokB);
  check('audio offer carries no video flag',
    audSigs.status === 200 && audSigs.data.signals.length === 1 && audSigs.data.signals[0].payload.video !== true, audSigs);
  // Static checks: the video UI exists (button, remote + local video,
  // camera toggle/switch) and the ringtone is the melodic WebAudio
  // tune at two volumes — soft ringback for the caller, full ringtone
  // for the callee — with the old dual-sine beep gone.
  const idxHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('video call button in the chat header', idxHtml.includes('id="btn-video-call-peer"'));
  check('remote + local video elements in the call overlay',
    idxHtml.includes('id="remote-video"') && idxHtml.includes('id="local-video"') && idxHtml.includes('id="call-video-wrap"'));
  check('camera toggle + switch buttons in the call overlay',
    idxHtml.includes('id="btn-cam-toggle"') && idxHtml.includes('id="btn-cam-switch"'));
  check('video call counted separately in the data meter', idxHtml.includes('id="meter-vcall"'));
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  check('video overlay styles present', css.includes('.call-video-wrap') && css.includes('#local-video'));
  const appJs2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('melodic ringtone (original tune, two volumes)',
    appJs2.includes('RING_MELODY') && appJs2.includes("startRinging('soft')") && appJs2.includes("startRinging('full')"));
  check('old dual-sine beep is gone', !appJs2.includes('1209') && !appJs2.includes("frequency.value = 941"));
  check('video call flow in the client (720p, flag, prioritised audio)',
    appJs2.includes('callIsVideo') && appJs2.includes('video: Boolean(isVideo)') && appJs2.includes('video: isVideo') && appJs2.includes('ideal: 1280')
    && appJs2.includes('degradationPreference') && appJs2.includes('maxBitrate: 1500000')
    && appJs2.includes("priority: 'high'") && appJs2.includes('facingMode'));

  console.log('== usage ==');
  const usage = await get('/api/usage', tokA);
  check('usage endpoint counts today', usage.status === 200 && usage.data.messagesSent === 3 && usage.data.bytesSent > 0, usage);

  console.log('== web push ==');
  // No VAPID keys are set for this run, so push is disabled: the public
  // key endpoint answers null and everything else works exactly as
  // before (polling). Subscriptions can still be saved/deleted.
  const vapid = await get('/api/push/vapid-public-key');
  check('vapid public key endpoint (push disabled -> null)', vapid.status === 200 && vapid.data.ok && vapid.data.publicKey === null, vapid);
  const FAKE_SUB = { endpoint: 'https://localhost:1/fake-push', keys: { p256dh: 'test-p256dh', auth: 'test-auth' } };
  const subNoAuth = await post('/api/push/subscribe', { subscription: FAKE_SUB });
  check('subscribe without auth -> 401', subNoAuth.status === 401);
  const subBad = await post('/api/push/subscribe', { subscription: { endpoint: '' } }, tokA);
  check('subscribe with bad subscription -> 400', subBad.status === 400 && subBad.data.error === 'bad_subscription', subBad);
  const sub1 = await post('/api/push/subscribe', { subscription: FAKE_SUB }, tokA);
  check('subscribe with auth saves subscription', sub1.status === 200 && sub1.data.ok, sub1);
  const sub2 = await post('/api/push/subscribe', { subscription: FAKE_SUB }, tokA);
  check('re-subscribe (upsert) is idempotent', sub2.status === 200 && sub2.data.ok, sub2);
  const delNoAuth = await fetch(BASE + '/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: FAKE_SUB.endpoint }) });
  check('unsubscribe without auth -> 401', delNoAuth.status === 401);
  const del1 = await fetch(BASE + '/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokA }, body: JSON.stringify({ endpoint: FAKE_SUB.endpoint }) });
  check('unsubscribe with auth deletes subscription', del1.status === 200);
  const del2 = await fetch(BASE + '/api/push/subscribe', { method: 'DELETE', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokA }, body: JSON.stringify({ endpoint: FAKE_SUB.endpoint }) });
  check('unsubscribe again is idempotent', del2.status === 200);
  // Neither recipient has a subscription now: a message and a call offer
  // must still succeed (push is skipped, never blocks the response).
  const msgNoSub = await post('/api/messages', { to: FRIEND, body: 'Push chara message' }, tokA);
  check('message to user with no push subscription still sends', msgNoSub.status === 200 && msgNoSub.data.ok, msgNoSub);
  const sigNoSub = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'fake-offer-2', type: 'offer' } }, tokA);
  check('call offer to user with no push subscription still sends', sigNoSub.status === 200 && sigNoSub.data.ok, sigNoSub);
  const sigsNoSub = await get('/api/calls/signals', tokB);
  check('callee still receives the offer via polling', sigsNoSub.status === 200 && sigsNoSub.data.signals.length === 1, sigsNoSub);

  console.log('== admin panel ==');
  const CHARLIE = '8801911000003'; // made-up test number, for block tests
  const tokC = await login(CHARLIE, 'Charlie Test');

  // The /api/me flag is what shows the Admin tab in the client.
  const meAdmin = await get('/api/me', tokA);
  check('admin sees isAdmin=true on /api/me', meAdmin.status === 200 && meAdmin.data.isAdmin === true, meAdmin);
  const meNonAdmin = await get('/api/me', tokB);
  check('non-admin sees isAdmin=false on /api/me', meNonAdmin.status === 200 && meNonAdmin.data.isAdmin === false, meNonAdmin);

  // Non-admins get 403 on every admin route.
  const statsNo = await get('/api/admin/stats', tokB);
  check('non-admin stats -> 403', statsNo.status === 403 && statsNo.data.error === 'not_admin', statsNo);
  const usersNo = await get('/api/admin/users', tokB);
  check('non-admin users list -> 403', usersNo.status === 403, usersNo);
  const bcNo = await post('/api/admin/broadcast', { text: 'ami admin na' }, tokB);
  check('non-admin broadcast -> 403', bcNo.status === 403, bcNo);
  const setNo = await get('/api/admin/settings', tokB);
  check('non-admin settings read -> 403', setNo.status === 403, setNo);
  const setPostNo = await post('/api/admin/settings', { banner: 'x' }, tokB);
  check('non-admin settings write -> 403', setPostNo.status === 403, setPostNo);
  const statsAnon = await get('/api/admin/stats');
  check('anonymous stats -> 401', statsAnon.status === 401, statsAnon);

  // Admin stats: 4 users, 5 messages so far, 4 call offers so far
  // (1 audio offer + 1 no-sub offer from the earlier sections, and
  // the video + audio offers from the video-call section).
  const stats = await get('/api/admin/stats', tokA);
  check('admin stats totals', stats.status === 200 && stats.data.users === 4 && stats.data.messages === 5 && stats.data.calls === 4, stats);
  const usersList = await get('/api/admin/users', tokA);
  const charlieRow = (usersList.data.users || []).find((u) => u.phone === CHARLIE);
  check('admin users list has Charlie, not blocked', usersList.status === 200 && usersList.data.users.length === 4 && charlieRow && charlieRow.blocked === 0, usersList);

  // Block Charlie: login is refused at both code steps, and the live
  // session token stops working at once (message + call + me -> 401).
  const block = await post('/api/admin/users/block', { phone: CHARLIE, blocked: true }, tokA);
  check('admin blocks Charlie', block.status === 200 && block.data.blocked === true, block);
  const blockNoUser = await post('/api/admin/users/block', { phone: '8801999999999', blocked: true }, tokA);
  check('blocking an unknown user -> 404', blockNoUser.status === 404, blockNoUser);
  const blockAdmin = await post('/api/admin/users/block', { phone: BIJOY, blocked: true }, tokA);
  check('admin cannot block themself', blockAdmin.status === 403 && blockAdmin.data.error === 'cannot_block_admin', blockAdmin);
  const rcBlocked = await post('/api/request-code', { phone: CHARLIE });
  check('blocked user gets no code', rcBlocked.status === 403 && rcBlocked.data.error === 'blocked', rcBlocked);
  const vcBlocked = await post('/api/verify-code', { phone: CHARLIE, code: '123456' });
  check('blocked user verify-code -> 403', vcBlocked.status === 403 && vcBlocked.data.error === 'blocked', vcBlocked);
  const meBlocked = await get('/api/me', tokC);
  check('blocked user live session -> 401', meBlocked.status === 401, meBlocked);
  const msgBlocked = await post('/api/messages', { to: FRIEND, body: 'ami blocked' }, tokC);
  check('blocked user cannot send messages', msgBlocked.status === 401, msgBlocked);
  const sigBlocked = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'x', type: 'offer' } }, tokC);
  check('blocked user cannot call', sigBlocked.status === 401, sigBlocked);

  // Unblock: the same session token works again, no re-login needed.
  const unblock = await post('/api/admin/users/block', { phone: CHARLIE, blocked: false }, tokA);
  check('admin unblocks Charlie', unblock.status === 200 && unblock.data.blocked === false, unblock);
  const meUnblocked = await get('/api/me', tokC);
  check('unblocked user session works again', meUnblocked.status === 200 && meUnblocked.data.name === 'Charlie Test', meUnblocked);

  // Broadcast: one message from "S_19 CHAT BOOK" into every inbox.
  const bc = await post('/api/admin/broadcast', { text: 'ঘোষণা: কাল অ্যাপের নতুন সংস্করণ আসবে!' }, tokA);
  check('admin broadcast reaches all 4 users', bc.status === 200 && bc.data.recipients === 4, bc);
  const bcEmpty = await post('/api/admin/broadcast', { text: '   ' }, tokA);
  check('empty broadcast rejected', bcEmpty.status === 400, bcEmpty);
  const statsAfterBc = await get('/api/admin/stats', tokA);
  check('stats messages grew by 4 after broadcast', statsAfterBc.status === 200 && statsAfterBc.data.messages === 9, statsAfterBc);
  const convsBc = await get('/api/conversations', tokB);
  const bcConv = (convsBc.data.conversations || []).find((c) => c.phone === 'S_19 CHAT BOOK');
  check('friend inbox shows the announcement conversation', convsBc.status === 200 && bcConv && bcConv.lastMessage.includes('নতুন সংস্করণ'), convsBc);
  const bcMsgs = await get('/api/messages?with=' + encodeURIComponent('S_19 CHAT BOOK') + '&afterId=0', tokB);
  check('friend reads the announcement message', bcMsgs.status === 200 && bcMsgs.data.messages.length === 1 && bcMsgs.data.messages[0].sender === 'S_19 CHAT BOOK' && bcMsgs.data.messages[0].body.includes('নতুন সংস্করণ'), bcMsgs);

  // Settings: the welcome-screen banner, public to read, admin to write.
  const setGet0 = await get('/api/admin/settings', tokA);
  check('banner starts empty', setGet0.status === 200 && setGet0.data.banner === '', setGet0);
  const bannerPub0 = await get('/api/banner');
  check('public banner endpoint starts empty', bannerPub0.status === 200 && bannerPub0.data.banner === '', bannerPub0);
  const setSave = await post('/api/admin/settings', { banner: 'স্বাগতম! আজ রাত ৯টায় নতুন ভিডিও।' }, tokA);
  check('admin saves banner', setSave.status === 200 && setSave.data.banner.includes('স্বাগতম'), setSave);
  const bannerPub = await get('/api/banner');
  check('public banner shows the saved text', bannerPub.status === 200 && bannerPub.data.banner.includes('স্বাগতম'), bannerPub);
  const setClear = await post('/api/admin/settings', { banner: '' }, tokA);
  check('admin clears banner', setClear.status === 200 && setClear.data.banner === '', setClear);
  const bannerPub2 = await get('/api/banner');
  check('public banner empty again after clear', bannerPub2.status === 200 && bannerPub2.data.banner === '', bannerPub2);

  // Channels: admin can delete any channel; non-admins get 403 even
  // for a channel they own (the admin delete route is admin-only).
  const chDel = await post('/api/channels', { name: 'Admin Delete Test', description: 'muchhe felar channel' }, tokB);
  check('friend creates a channel for admin-delete test', chDel.status === 200 && chDel.data.channel.id, chDel);
  const delNoAdmin = await fetch(BASE + '/api/admin/channels/' + chDel.data.channel.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokB } });
  check('non-admin cannot delete via admin route', delNoAdmin.status === 403);
  const delAdmin = await fetch(BASE + '/api/admin/channels/' + chDel.data.channel.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokA } });
  check('admin deletes any channel', delAdmin.status === 200);
  const chListAfter = await get('/api/channels?q=', tokB);
  check('deleted channel is gone', chListAfter.status === 200 && !chListAfter.data.channels.some((c) => c.name === 'Admin Delete Test'), chListAfter);
  const delMissing = await fetch(BASE + '/api/admin/channels/999999', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokA } });
  check('admin delete of missing channel -> 404', delMissing.status === 404);

  console.log('== chat settings: theme / mute / disappearing / clear / block ==');
  const set0 = await get('/api/chat-settings?with=' + FRIEND, tokA);
  check('chat settings default (not muted, no disappearing, default theme, not blocked)',
    set0.status === 200 && set0.data.muted === 0 && set0.data.disappearing === 0 && set0.data.chatTheme === '' && set0.data.blockedByMe === 0 && set0.data.blockedByPeer === 0, set0);
  const setTheme = await post('/api/chat-settings', { with: FRIEND, chatTheme: 'blue' }, tokA);
  check('set per-chat theme blue', setTheme.status === 200 && setTheme.data.chatTheme === 'blue', setTheme);
  const setThemeBad = await post('/api/chat-settings', { with: FRIEND, chatTheme: 'rainbow' }, tokA);
  check('bad chat theme rejected', setThemeBad.status === 400 && setThemeBad.data.error === 'bad_theme', setThemeBad);
  const setThemeBack = await post('/api/chat-settings', { with: FRIEND, chatTheme: '' }, tokA);
  check('reset per-chat theme to default', setThemeBack.status === 200 && setThemeBack.data.chatTheme === '', setThemeBack);
  const setDispBad = await post('/api/chat-settings', { with: FRIEND, disappearing: 12345 }, tokA);
  check('bad disappearing value rejected', setDispBad.status === 400 && setDispBad.data.error === 'bad_disappearing', setDispBad);
  // Mute: the friend mutes Bijoy. Messages still deliver (only the push
  // is skipped) and the inbox row carries the muted flag.
  const setMute = await post('/api/chat-settings', { with: BIJOY, muted: true }, tokB);
  check('friend mutes Bijoy chat', setMute.status === 200 && setMute.data.muted === 1, setMute);
  const mutedMsg = await post('/api/messages', { to: FRIEND, body: 'Muted chat message still delivers' }, tokA);
  check('message to a muted chat still delivers', mutedMsg.status === 200 && mutedMsg.data.ok, mutedMsg);
  const mutedInbox = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('muted friend receives the message', mutedInbox.status === 200 && mutedInbox.data.messages.some((m) => m.body.includes('Muted chat message')), mutedInbox);
  const convsMuted = await get('/api/conversations', tokB);
  const mutedConv = (convsMuted.data.conversations || []).find((c) => c.phone === BIJOY);
  check('inbox row carries muted flag', convsMuted.status === 200 && mutedConv && mutedConv.muted === 1, mutedConv);
  const setUnmute = await post('/api/chat-settings', { with: BIJOY, muted: false }, tokB);
  check('friend unmutes Bijoy chat', setUnmute.status === 200 && setUnmute.data.muted === 0, setUnmute);
  // Disappearing: Bijoy sets 24h; the message gets expires_at; backdate
  // it in the DB and it hides from fetch and from the inbox preview.
  const setDisp = await post('/api/chat-settings', { with: FRIEND, disappearing: 86400 }, tokA);
  check('set disappearing 24h', setDisp.status === 200 && setDisp.data.disappearing === 86400, setDisp);
  const dispMsg = await post('/api/messages', { to: FRIEND, body: 'This message will disappear' }, tokA);
  check('message in disappearing chat gets expires_at',
    dispMsg.status === 200 && dispMsg.data.message.expires_at > dispMsg.data.message.created_at
    && dispMsg.data.message.expires_at - dispMsg.data.message.created_at === 86400 * 1000, dispMsg);
  const dispId = dispMsg.data.message.id;
  await execSql('UPDATE messages SET expires_at = ? WHERE id = ?', Date.now() - 1000, dispId);
  const dispGone = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('expired message hidden from fetch', dispGone.status === 200 && !dispGone.data.messages.some((m) => m.id === dispId), dispGone);
  const convsDisp = await get('/api/conversations', tokB);
  const dispConv = (convsDisp.data.conversations || []).find((c) => c.phone === BIJOY);
  check('expired message not the inbox preview', convsDisp.status === 200 && dispConv && !dispConv.lastMessage.includes('will disappear'), dispConv);
  const setDispOff = await post('/api/chat-settings', { with: FRIEND, disappearing: 0 }, tokA);
  check('disappearing off again', setDispOff.status === 200 && setDispOff.data.disappearing === 0, setDispOff);
  // Clear chat: Bijoy clears; his view empties, the friend keeps history,
  // and a message sent after the clear shows up again.
  const clearMsg = await post('/api/messages', { to: FRIEND, body: 'Message before clear' }, tokA);
  check('message before clear sends', clearMsg.status === 200, clearMsg);
  const clear = await post('/api/chat-settings/clear', { with: FRIEND }, tokA);
  check('clear chat', clear.status === 200 && clear.data.ok, clear);
  const clearedView = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  check('cleared chat is empty for me', clearedView.status === 200 && clearedView.data.messages.length === 0, clearedView);
  const friendKeeps = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('friend still sees the history after my clear', friendKeeps.status === 200 && friendKeeps.data.messages.some((m) => m.body.includes('Message before clear')), friendKeeps);
  const afterClear = await post('/api/messages', { to: FRIEND, body: 'Message after clear' }, tokA);
  check('message after clear sends', afterClear.status === 200, afterClear);
  const clearedView2 = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  check('only the new message shows after clear', clearedView2.status === 200 && clearedView2.data.messages.length === 1 && clearedView2.data.messages[0].body.includes('Message after clear'), clearedView2);
  // Per-user block: Bijoy blocks the friend; messages and calls stop in
  // BOTH directions; unblock restores. The admin block is untouched —
  // the friend's session keeps working (GET /api/me still 200).
  const blockU = await post('/api/chat-settings', { with: FRIEND, blocked: true }, tokA);
  check('Bijoy blocks friend (per-user)', blockU.status === 200 && blockU.data.blockedByMe === 1, blockU);
  const blockedMsg = await post('/api/messages', { to: BIJOY, body: 'blocked bondhu message' }, tokB);
  check('blocked friend cannot message me', blockedMsg.status === 403 && blockedMsg.data.error === 'blocked_by_peer', blockedMsg);
  const blockedMsgMe = await post('/api/messages', { to: FRIEND, body: 'ami block korechi' }, tokA);
  check('I cannot message someone I blocked', blockedMsgMe.status === 403 && blockedMsgMe.data.error === 'you_blocked', blockedMsgMe);
  const blockedCall = await post('/api/calls/signal', { to: BIJOY, kind: 'offer', payload: { sdp: 'x', type: 'offer' } }, tokB);
  check('blocked friend cannot call me', blockedCall.status === 403 && blockedCall.data.error === 'blocked_by_peer', blockedCall);
  const meFriend = await get('/api/me', tokB);
  check('per-user block does not admin-block (session still works)', meFriend.status === 200, meFriend);
  const unblockU = await post('/api/chat-settings', { with: FRIEND, blocked: false }, tokA);
  check('Bijoy unblocks friend', unblockU.status === 200 && unblockU.data.blockedByMe === 0, unblockU);
  const afterUnblock = await post('/api/messages', { to: BIJOY, body: 'Unblocked, kotha bolo' }, tokB);
  check('message works again after unblock', afterUnblock.status === 200, afterUnblock);

  console.log('== media messages ==');
  // Small fixtures: a 1x1 PNG, a few fake video/voice bytes, a text file.
  const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const FAKE_VIDEO = Buffer.from('000000186674797069736f6d0000000000000000', 'hex').toString('base64');
  const FAKE_VOICE = Buffer.from('1a45dfa3', 'hex').toString('base64');
  const FILE_TEXT = Buffer.from('Hello, this is a test document for S_19 CHAT BOOK.', 'utf8').toString('base64');
  async function sendMedia(to, kind, fileName, mimeType, data, token, duration, clientKey) {
    return post('/api/messages/media', { to, mediaKind: kind, fileName, mimeType, size: Buffer.from(data, 'base64').length, data, duration, clientKey }, token);
  }
  const img = await sendMedia(FRIEND, 'image', 'test-photo.png', 'image/png', PNG_1X1, tokA);
  check('send photo (original bytes, no compression)', img.status === 200 && img.data.message.media_kind === 'image' && img.data.message.body === '📷 Photo', img);
  const imgId = img.data.message.id;
  const imgFetch = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  const imgMsg = (imgFetch.data.messages || []).find((m) => m.id === imgId);
  check('receiver fetch lists the photo with metadata, no bytes inline',
    imgFetch.status === 200 && imgMsg && imgMsg.media_kind === 'image' && imgMsg.has_media === 1 && !('media_data' in imgMsg), imgMsg);
  const imgData = await get('/api/media/' + imgId, tokB);
  check('receiver downloads the photo bytes unchanged',
    imgData.status === 200 && imgData.data.data === PNG_1X1 && imgData.data.mimeType === 'image/png', imgData);
  const imgDataSender = await get('/api/media/' + imgId, tokA);
  check('sender can download their own photo', imgDataSender.status === 200 && imgDataSender.data.data === PNG_1X1, imgDataSender);
  // Contact profile: /api/chat-media returns the peer info plus every
  // media item shared in this chat (metadata only, no bytes inline).
  const chatMedia = await get('/api/chat-media?with=' + FRIEND, tokA);
  check('chat-media returns peer info and the shared photo',
    chatMedia.status === 200 && chatMedia.data.peer && chatMedia.data.peer.phone === FRIEND
    && (chatMedia.data.media || []).some((m) => m.id === imgId && m.media_kind === 'image' && !('media_data' in m)), chatMedia);
  const chatMediaBad = await get('/api/chat-media', tokA);
  check('chat-media needs a peer', chatMediaBad.status === 400, chatMediaBad);
  const chatMediaAnon = await get('/api/chat-media?with=' + FRIEND);
  check('chat-media needs a session', chatMediaAnon.status === 401, chatMediaAnon);

  console.log('== my profile (Settings) ==');
  // Avatar + About: set them, read them back from /api/me, and confirm a
  // friend sees them in the inbox list. The avatar is a small data URL.
  const AVATAR_TINY = 'data:image/png;base64,' + PNG_1X1;
  const profAbout = await post('/api/profile', { about: 'Current mood: building my own app!' }, tokA);
  check('set About', profAbout.status === 200 && profAbout.data.about === 'Current mood: building my own app!', profAbout);
  const profAvatar = await post('/api/profile', { avatar: AVATAR_TINY }, tokA);
  check('set avatar', profAvatar.status === 200 && profAvatar.data.avatar === AVATAR_TINY, profAvatar);
  const meProf = await get('/api/me', tokA);
  check('my profile reads back avatar + about',
    meProf.status === 200 && meProf.data.avatar === AVATAR_TINY && meProf.data.about === 'Current mood: building my own app!', meProf);
  const convsAvatar = await get('/api/conversations', tokB);
  const avConv = (convsAvatar.data.conversations || []).find((c) => c.phone === BIJOY);
  check('friend sees my avatar and About in the inbox',
    convsAvatar.status === 200 && avConv && avConv.avatar === AVATAR_TINY && avConv.about === 'Current mood: building my own app!', avConv);
  const profName = await post('/api/profile', { name: 'Bijoy Test' }, tokA);
  check('rename via profile', profName.status === 200 && profName.data.name === 'Bijoy Test', profName);
  const profBadAvatar = await post('/api/profile', { avatar: 'not-an-image' }, tokA);
  check('non-image avatar rejected', profBadAvatar.status === 400 && profBadAvatar.data.error === 'bad_avatar', profBadAvatar);
  const profBigAvatar = await post('/api/profile', { avatar: 'data:image/png;base64,' + 'A'.repeat(160000) }, tokA);
  check('oversize avatar rejected', profBigAvatar.status === 413 && profBigAvatar.data.error === 'avatar_too_big', profBigAvatar);
  const profEmptyName = await post('/api/profile', { name: '   ' }, tokA);
  check('empty name rejected', profEmptyName.status === 400 && profEmptyName.data.error === 'bad_name', profEmptyName);
  const profLongAbout = await post('/api/profile', { about: 'x'.repeat(200) }, tokA);
  check('About over 140 chars is capped, not rejected',
    profLongAbout.status === 200 && profLongAbout.data.about.length === 140, profLongAbout);
  const profAnon = await post('/api/profile', { about: 'hi' });
  check('profile needs a session', profAnon.status === 401, profAnon);
  const profEmpty = await post('/api/profile', {}, tokA);
  check('profile with nothing to change rejected', profEmpty.status === 400, profEmpty);
  const profClearAvatar = await post('/api/profile', { avatar: '' }, tokA);
  check('avatar can be removed', profClearAvatar.status === 200 && profClearAvatar.data.avatar === '', profClearAvatar);
  const imgDataStranger = await get('/api/media/' + imgId, tokG);
  check('a stranger cannot download the photo', imgDataStranger.status === 403, imgDataStranger);
  const vid = await sendMedia(FRIEND, 'video', 'test-video.mp4', 'video/mp4', FAKE_VIDEO, tokA);
  check('send video', vid.status === 200 && vid.data.message.media_kind === 'video' && vid.data.message.body === '🎥 Video', vid);
  const vidData = await get('/api/media/' + vid.data.message.id, tokB);
  check('receiver downloads the video bytes unchanged', vidData.status === 200 && vidData.data.data === FAKE_VIDEO, vidData);
  const voice = await sendMedia(FRIEND, 'voice', 'voice-1.webm', 'audio/webm', FAKE_VOICE, tokA, 7);
  check('send voice note with duration', voice.status === 200 && voice.data.message.media_kind === 'voice' && voice.data.message.media_duration === 7 && voice.data.message.body === '🎤 Voice', voice);
  const file = await sendMedia(FRIEND, 'file', 'notes.txt', 'text/plain', FILE_TEXT, tokA);
  check('send file', file.status === 200 && file.data.message.media_kind === 'file' && file.data.message.body === '📄 notes.txt', file);
  const fileData = await get('/api/media/' + file.data.message.id, tokB);
  check('receiver downloads the file bytes unchanged', fileData.status === 200 && fileData.data.data === FILE_TEXT, fileData);
  const convsMedia = await get('/api/conversations', tokB);
  const mediaConv = (convsMedia.data.conversations || []).find((c) => c.phone === BIJOY);
  check('inbox preview shows the last media label', convsMedia.status === 200 && mediaConv && mediaConv.lastMessage === '📄 notes.txt', mediaConv);
  const mediaTicks = await get('/api/messages?with=' + FRIEND + '&afterId=' + file.data.message.id, tokA);
  check('media message ticks arrive on empty fetch',
    mediaTicks.status === 200 && mediaTicks.data.ticks.some((t) => t.id === imgId && t.delivered === 1), mediaTicks);
  const storage = await get('/api/storage', tokA);
  check('storage endpoint counts my media', storage.status === 200 && storage.data.mediaCount >= 4 && storage.data.mediaBytes > 0 && storage.data.limitBytes === 1073741824, storage);
  // Size caps: real oversized bytes are rejected (photo 10 MB, file
  // 5 MB); the video cap is exercised through the declared size — the
  // same code path checks both the declared and the decoded size.
  const BIG_PHOTO = Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64');
  const bigPhoto = await sendMedia(FRIEND, 'image', 'big.png', 'image/png', BIG_PHOTO, tokA);
  check('photo over 10 MB rejected', bigPhoto.status === 413 && bigPhoto.data.error === 'file_too_big', { status: bigPhoto.status, error: bigPhoto.data && bigPhoto.data.error });
  const BIG_FILE = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  const bigFile = await sendMedia(FRIEND, 'file', 'big.txt', 'text/plain', BIG_FILE, tokA);
  check('file over 5 MB rejected', bigFile.status === 413 && bigFile.data.error === 'file_too_big', { status: bigFile.status, error: bigFile.data && bigFile.data.error });
  const bigVideoDeclared = await post('/api/messages/media', { to: FRIEND, mediaKind: 'video', fileName: 'big.mp4', mimeType: 'video/mp4', size: 60 * 1024 * 1024, data: FAKE_VIDEO }, tokA);
  check('video over 50 MB declared size rejected', bigVideoDeclared.status === 413 && bigVideoDeclared.data.error === 'file_too_big', { status: bigVideoDeclared.status, error: bigVideoDeclared.data && bigVideoDeclared.data.error });

  console.log('== media regression: duplicate photo + voice note ==');
  // BUG 1 (live report 2026-11-08): sending ONE photo showed TWO.
  // Root causes: (a) the 3s poll can render a message while its
  // upload is still in flight, and the upload's success handler
  // appended it again — appendMessage had no dedupe; (b) a retry of
  // an upload whose response was lost inserted a SECOND row.
  // The client now sends its tempId as clientKey, and the server
  // returns the existing row for a repeated key.
  const dupImg = await sendMedia(FRIEND, 'image', 'dup-photo.png', 'image/png', PNG_1X1, tokA, 0, 'regression-dup-photo-1');
  check('photo with idempotency key sends', dupImg.status === 200 && dupImg.data.message.id, dupImg);
  const dupImgId = dupImg.data.message.id;
  const convBefore = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  const countBefore = (convBefore.data.messages || []).filter((m) => m.id === dupImgId).length;
  check('receiver fetch has exactly one copy of the photo', countBefore === 1, { countBefore });
  const dupImgRetry = await sendMedia(FRIEND, 'image', 'dup-photo.png', 'image/png', PNG_1X1, tokA, 0, 'regression-dup-photo-1');
  check('retry of the same upload returns the SAME message id',
    dupImgRetry.status === 200 && dupImgRetry.data.message.id === dupImgId && dupImgRetry.data.duplicate === true, dupImgRetry);
  const convAfter = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('receiver fetch still has exactly one copy after the retry',
    (convAfter.data.messages || []).filter((m) => m.id === dupImgId).length === 1
    && convAfter.data.messages.length === convBefore.data.messages.length, { before: convBefore.data.messages.length, after: convAfter.data.messages.length });
  // The same double-send hole covered video and file too: same key,
  // same row, no second copy.
  const dupVid = await sendMedia(FRIEND, 'video', 'dup-video.mp4', 'video/mp4', FAKE_VIDEO, tokA, 0, 'regression-dup-video-1');
  const dupVidRetry = await sendMedia(FRIEND, 'video', 'dup-video.mp4', 'video/mp4', FAKE_VIDEO, tokA, 0, 'regression-dup-video-1');
  check('video retry returns the same message id, no second copy',
    dupVid.status === 200 && dupVidRetry.status === 200 && dupVidRetry.data.message.id === dupVid.data.message.id, { first: dupVid.data.message && dupVid.data.message.id, retry: dupVidRetry.data.message && dupVidRetry.data.message.id });
  const dupFile = await sendMedia(FRIEND, 'file', 'dup-notes.txt', 'text/plain', FILE_TEXT, tokA, 0, 'regression-dup-file-1');
  const dupFileRetry = await sendMedia(FRIEND, 'file', 'dup-notes.txt', 'text/plain', FILE_TEXT, tokA, 0, 'regression-dup-file-1');
  check('file retry returns the same message id, no second copy',
    dupFile.status === 200 && dupFileRetry.status === 200 && dupFileRetry.data.message.id === dupFile.data.message.id, { first: dupFile.data.message && dupFile.data.message.id, retry: dupFileRetry.data.message && dupFileRetry.data.message.id });
  // BUG 2 (live report 2026-11-08): a voice note never arrived.
  // Root cause was client-side: stopVoiceRec() cleared the global
  // mediaRecorder right after stop(), and the async onstop handler
  // then read mediaRecorder.mimeType (null) and died before sending.
  // The server path is pinned here with the exact MIME Android
  // Chrome produces (audio/webm;codecs=opus): the receiver must get
  // the note, and GET /api/media/:id must serve the exact bytes
  // with an audio content-type.
  const voiceOpus = await sendMedia(FRIEND, 'voice', 'voice-opus.webm', 'audio/webm;codecs=opus', FAKE_VOICE, tokA, 9, 'regression-voice-opus-1');
  check('voice note with Android Chrome MIME sends', voiceOpus.status === 200 && voiceOpus.data.message.media_kind === 'voice' && voiceOpus.data.message.media_duration === 9, voiceOpus);
  const voiceOpusFetch = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  const voiceOpusMsg = (voiceOpusFetch.data.messages || []).find((m) => m.id === voiceOpus.data.message.id);
  check('receiver fetch returns the voice note with duration',
    voiceOpusFetch.status === 200 && voiceOpusMsg && voiceOpusMsg.media_kind === 'voice' && voiceOpusMsg.media_duration === 9, voiceOpusMsg);
  const voiceOpusData = await get('/api/media/' + voiceOpus.data.message.id, tokB);
  check('voice bytes served unchanged with an audio content-type',
    voiceOpusData.status === 200 && voiceOpusData.data.data === FAKE_VOICE && typeof voiceOpusData.data.mimeType === 'string' && voiceOpusData.data.mimeType.indexOf('audio/') === 0, voiceOpusData);
  // Static guards for the two client-side fixes (same style as the
  // other static checks in this suite): the render dedupe in
  // appendMessage, and the captured MIME type in the voice recorder
  // — the buggy pattern must be gone.
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  check('appendMessage dedupes by message id (no double bubble)',
    appJs.includes('querySelector(\'.msg[data-id="\' + m.id + \'"]\')'));
  check('voice recorder captures its MIME type before stop()',
    appJs.includes('const recMimeType = mediaRecorder.mimeType') && appJs.includes('type: recMimeType'));
  check('voice onstop no longer reads the cleared global recorder',
    !appJs.includes('type: mediaRecorder.mimeType'));

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
