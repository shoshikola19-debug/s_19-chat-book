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

  // Admin stats: 4 users, 5 messages so far, 2 call offers so far.
  const stats = await get('/api/admin/stats', tokA);
  check('admin stats totals', stats.status === 200 && stats.data.users === 4 && stats.data.messages === 5 && stats.data.calls === 2, stats);
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
