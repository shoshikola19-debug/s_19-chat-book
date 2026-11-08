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
    await client.query('DROP TABLE IF EXISTS users, sessions, otp_codes, contacts, messages, statuses, channels, channel_follows, channel_posts, call_signals, push_subscriptions, settings, chat_settings, groups, group_members, reports CASCADE');
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
  for (const wp of ['media-generation-nature-palm-0-d7019b95-33b0-4080-a168-11452696861b.jpg', 'media-generation-nature-desert-0-b72be574-928d-4c61-89d6-f58db9cb588d.jpg', 'media-generation-nature-mountain-0-1a82b33a-a647-4613-b63b-14fbe7b99b41.jpg', 'media-generation-ai-dream-0-6ab45dc5-0529-4c8b-8b2d-8e21d10edefa.jpg']) {
    const r = await fetch(BASE + '/wallpapers/' + wp);
    check('bundled wallpaper serves: ' + wp.slice(18, 32), r.status === 200 && (r.headers.get('content-type') || '').includes('image'));
  }
  const swJs = await fetch(BASE + '/sw.js');
  const swText = await swJs.text();
  check('service worker has a fetch handler (installable)',
    swJs.status === 200 && swText.includes("addEventListener('fetch'"));
  const idxText = await (await fetch(BASE + '/')).text();
  check('index offers Gmail login', idxText.includes('Gmail'));
  check('theme-color uses the light/dark media pair (no green strip before JS runs)',
    idxText.includes('media="(prefers-color-scheme: light)" content="#FFFFFF"')
    && idxText.includes('media="(prefers-color-scheme: dark)" content="#0B141A"')
    && !idxText.includes('<meta name="theme-color" content="#075E54">'));
  check('contact-info screen has the WhatsApp rows',
    idxText.includes('Manage storage') && idxText.includes('Media visibility') && idxText.includes('Chat lock')
    && idxText.includes('No groups in common') && idxText.includes('Create group with') && idxText.includes('Add to groups'));
  check('contact-info screen never claims end-to-end encryption or advanced privacy',
    !idxText.includes('are end-to-end encrypted') && idxText.includes('NOT end-to-end encrypted')
    && !idxText.includes('Advanced chat privacy') && !idxText.includes('Encryption'));
  const menuOrder = ['menu-new-group', 'menu-view-contact', 'menu-search', 'menu-media', 'menu-mute', 'menu-disappearing', 'menu-chat-theme', 'menu-more'];
  let menuIdx = -1, menuInOrder = true;
  for (const id of menuOrder) {
    const i = idxText.indexOf('id="' + id + '"');
    if (i < 0 || i < menuIdx) menuInOrder = false;
    menuIdx = i;
  }
  check('chat menu items in WhatsApp order', menuInOrder);
  check('chat menu More submenu has Report / Export / Shortcut / Favorites',
    idxText.includes('menu-report') && idxText.includes('menu-block') && idxText.includes('menu-export')
    && idxText.includes('menu-shortcut') && idxText.includes('menu-favorite'));
  check('favorites chip and PIN / locked-chats / visibility dialogs exist',
    idxText.includes('favorites-chip') && idxText.includes('pin-dialog') && idxText.includes('locked-chats-dialog')
    && idxText.includes('media-visibility-dialog') && idxText.includes('report-dialog') && idxText.includes('admin-reports'));
  check('chat theme + wallpaper + preview overlays exist (WhatsApp-style theme flow)',
    idxText.includes('id="theme-overlay"') && idxText.includes('id="wallpaper-overlay"') && idxText.includes('id="wallpaper-preview"')
    && idxText.includes('id="theme-tab-bubble"') && idxText.includes('id="theme-tab-wallpaper"') && idxText.includes('id="theme-tab-ai"')
    && idxText.includes('id="wp-tab-gallery"') && idxText.includes('id="wp-tab-color"') && idxText.includes('id="wp-tab-ai"')
    && idxText.includes('id="preview-dim"') && idxText.includes('id="btn-preview-done"')
    && idxText.includes('id="btn-preview-zoom-in"') && idxText.includes('id="btn-preview-zoom-out"')
    && idxText.includes('Only you can see this theme.'));
  check('old colour-picker theme dialog is gone',
    !idxText.includes('chat-theme-dialog') && !idxText.includes('chat-theme-preview') && !idxText.includes('btn-chat-theme-apply'));
  check('pinch-zoom is disabled at the viewport (app-wide, except the preview cropper)',
    idxText.includes('maximum-scale=1') && idxText.includes('user-scalable=no'));

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
    appJs2.includes('RING_MELODIES') && appJs2.includes('classic') && appJs2.includes('659.25')
    && appJs2.includes("startRinging('soft')") && appJs2.includes("startRinging('full')"));
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

  console.log('== reports ==');
  const repAnon = await post('/api/report', { peer: FRIEND, reason: 'spam' });
  check('report needs a session', repAnon.status === 401, repAnon);
  const repSelf = await post('/api/report', { peer: BIJOY, reason: 'self' }, tokA);
  check('cannot report yourself', repSelf.status === 400 && repSelf.data.error === 'bad_peer', repSelf);
  const rep = await post('/api/report', { peer: FRIEND, reason: 'Spamming the group' }, tokA);
  check('report a peer', rep.status === 200 && rep.data.ok && typeof rep.data.id === 'number', rep);
  const repEmpty = await post('/api/report', { peer: FRIEND, reason: '' }, tokA);
  check('report with an empty reason works', repEmpty.status === 200 && repEmpty.data.ok, repEmpty);
  const repNo = await get('/api/admin/reports', tokB);
  check('non-admin reports list -> 403', repNo.status === 403, repNo);
  const repList = await get('/api/admin/reports', tokA);
  check('admin sees the reports with names',
    repList.status === 200 && repList.data.reports.some((r) => r.reported === FRIEND && r.reporter === BIJOY && r.reason === 'Spamming the group' && r.reportedName === 'Friend Test'), repList);

  console.log('== chat settings: theme / mute / disappearing / clear / block ==');
  const set0 = await get('/api/chat-settings?with=' + FRIEND, tokA);
  check('chat settings default (not muted, no disappearing, default theme, not blocked)',
    set0.status === 200 && set0.data.muted === 0 && set0.data.disappearing === 0 && set0.data.chatTheme === '' && set0.data.blockedByMe === 0 && set0.data.blockedByPeer === 0 && set0.data.mediaVisibility === null && set0.data.favorite === 0, set0);
  const setTheme = await post('/api/chat-settings', { with: FRIEND, chatTheme: 'blue' }, tokA);
  check('set per-chat theme blue', setTheme.status === 200 && setTheme.data.chatTheme === 'blue', setTheme);
  const setThemeBad = await post('/api/chat-settings', { with: FRIEND, chatTheme: 'rainbow' }, tokA);
  check('bad chat theme rejected', setThemeBad.status === 400 && setThemeBad.data.error === 'bad_theme', setThemeBad);
  const setThemeBack = await post('/api/chat-settings', { with: FRIEND, chatTheme: '' }, tokA);
  check('reset per-chat theme to default', setThemeBack.status === 200 && setThemeBack.data.chatTheme === '', setThemeBack);
  // Outgoing-bubble colour: stored per chat on the server, '' = default.
  const set0b = await get('/api/chat-settings?with=' + FRIEND, tokA);
  check('bubble colour defaults to empty', set0b.status === 200 && set0b.data.bubbleColor === '', set0b);
  const setBubble = await post('/api/chat-settings', { with: FRIEND, bubbleColor: '#34B7F1' }, tokA);
  check('set per-chat bubble colour', setBubble.status === 200 && setBubble.data.bubbleColor === '#34B7F1', setBubble);
  const setBubbleBad = await post('/api/chat-settings', { with: FRIEND, bubbleColor: 'not-a-colour' }, tokA);
  check('bad bubble colour rejected', setBubbleBad.status === 400 && setBubbleBad.data.error === 'bad_bubble_color', setBubbleBad);
  const setBubbleBack = await post('/api/chat-settings', { with: FRIEND, bubbleColor: '' }, tokA);
  check('reset bubble colour to default', setBubbleBack.status === 200 && setBubbleBack.data.bubbleColor === '', setBubbleBack);
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
  // Media visibility (per-chat auto-save override) + Favorites: tri-state
  // null = follow the global toggle, 1 = always save, 0 = never.
  const setVis0 = await post('/api/chat-settings', { with: FRIEND, mediaVisibility: 0 }, tokA);
  check('media visibility off for this chat', setVis0.status === 200 && setVis0.data.mediaVisibility === 0, setVis0);
  const setVis1 = await post('/api/chat-settings', { with: FRIEND, mediaVisibility: 1 }, tokA);
  check('media visibility on for this chat', setVis1.status === 200 && setVis1.data.mediaVisibility === 1, setVis1);
  const setVisBad = await post('/api/chat-settings', { with: FRIEND, mediaVisibility: 5 }, tokA);
  check('bad media visibility rejected', setVisBad.status === 400 && setVisBad.data.error === 'bad_visibility', setVisBad);
  const setVisDef = await post('/api/chat-settings', { with: FRIEND, mediaVisibility: null }, tokA);
  check('media visibility back to default (null)', setVisDef.status === 200 && setVisDef.data.mediaVisibility === null, setVisDef);
  const setFav = await post('/api/chat-settings', { with: FRIEND, favorite: true }, tokA);
  check('favorite a chat', setFav.status === 200 && setFav.data.favorite === 1, setFav);
  const convsFav = await get('/api/conversations', tokA);
  const favConv = (convsFav.data.conversations || []).find((c) => c.phone === FRIEND);
  check('inbox row carries favorite flag', convsFav.status === 200 && favConv && favConv.favorite === 1, favConv);
  const setUnfav = await post('/api/chat-settings', { with: FRIEND, favorite: false }, tokA);
  check('unfavorite a chat', setUnfav.status === 200 && setUnfav.data.favorite === 0, setUnfav);
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
  check('client has export, deep link, chat lock and per-chat visibility logic',
    appJs.includes('function exportChat') && appJs.includes('handleDeepLink')
    && appJs.includes('mediaVisibility') && appJs.includes('getLockedChats')
    && appJs.includes('showPinDialog') && appJs.includes('renderProfileGroups'));
  // Static guards for the inbox first-load states: a slow or failed
  // conversations fetch must show loading / tap-to-retry, never a
  // silent empty inbox — and the empty note only renders after a
  // successful load (guarded by inboxLoaded in renderInbox).
  check('inbox shows loading, not a silent empty list, while the first load is in flight',
    appJs.includes('Loading chats…') && appJs.includes('inboxLoaded') && appJs.includes('inboxLoadFailed'));
  check('inbox load failure shows tap-to-retry and auto-retries',
    appJs.includes('inbox-error') && appJs.includes('Tap to retry.') && appJs.includes('INBOX_MAX_RETRIES') && appJs.includes('retryInboxLoad'));
  check('inbox fetch has a timeout so a hung request can fail and retry',
    appJs.includes('INBOX_FETCH_TIMEOUT_MS') && appJs.includes('timeoutMs'));
  check('inbox renders instantly from a saved cache before any network call',
    appJs.includes('s19_inbox_cache') && appJs.includes('restoreInboxCache') && appJs.includes('inboxCached') && appJs.includes('saveInboxCache'));
  check('failed background refresh keeps the cached list and shows only a hint',
    appJs.includes("Couldn't refresh") && appJs.includes('inboxRefreshFailed') && appJs.includes('inbox-refresh-hint'));
  const styleCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  check('dark mode inbox title is white, light mode stays green',
    styleCss.includes(':root[data-theme="dark"] .app-header .app-title { color: #FFFFFF; }')
    && styleCss.includes('.app-header .app-title { flex: 1; color: #25D366;'));
  // Static guards for the WhatsApp-style default avatar and the
  // profile photo guard: no-photo contacts get a brown person icon
  // (never an initial letter), and the guarded viewer exists with
  // its protections — but nothing claims screenshots are impossible
  // or that messages are end-to-end encrypted (they are not).
  const idxHtml2 = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('contacts with no photo show a brown person icon, not a letter',
    appJs.includes('avatar-default') && !appJs.includes('avatarLetter')
    && styleCss.includes('.avatar-default') && styleCss.includes('#6B5B4C')
    && styleCss.includes('#D8CFC4'));
  check('profile photo guard toggle exists, default on, per-device',
    appJs.includes('s19_photo_guard') && appJs.includes('function photoGuardOn')
    && appJs.includes('settings-photoguard-row') && idxHtml2.includes('Profile photo guard'));
  check('photo viewer opens on avatar tap and hides on focus loss when guarded',
    appJs.includes('function openPhotoViewer') && appJs.includes('photo-viewer')
    && appJs.includes('visibilitychange') && appJs.includes('photo-hidden')
    && appJs.includes('contextmenu') && appJs.includes('stopPropagation'));
  check('guarded viewer shows Guarded label, unguarded shows a save button',
    appJs.includes('photo-viewer-guarded') && appJs.includes('photo-viewer-download')
    && idxHtml2.includes('🔒 Guarded') && idxHtml2.includes('Save photo'));
  check('no end-to-end encryption claim anywhere in the client (only the honest "NOT" note in Help)',
    !appJs.includes('end-to-end encrypted') && !idxHtml2.includes('are end-to-end encrypted')
    && idxHtml2.includes('NOT end-to-end encrypted')
    && !idxHtml2.includes('Encryption'));
  // Static guards for the audit sweep + Settings rebuild: every fixed
  // control has a real handler, and the new Settings screens exist.
  check('inbox camera opens the device camera, then a send-to chooser (not a dead toast)',
    idxHtml2.includes('id="file-camera"') && idxHtml2.includes('capture="environment"')
    && idxHtml2.includes('send-photo-dialog') && idxHtml2.includes('Send photo to')
    && appJs.includes('pendingCameraFile') && appJs.includes('file-camera'));
  check('in-chat search jumps between matches with a highlighted current match',
    idxHtml2.includes('btn-search-prev') && idxHtml2.includes('btn-search-next')
    && appJs.includes('stepSearchMatch') && appJs.includes('highlightSearchMatch')
    && appJs.includes('search-hit') && styleCss.includes('.msg.search-hit'));
  check('call history rows call the person back',
    appJs.includes('startCall(item.peer'));
  check('Manage storage shows a real breakdown instead of the media grid',
    idxHtml2.includes('manage-storage-dialog') && idxHtml2.includes('storage-breakdown')
    && appJs.includes('storage-breakdown') && appJs.includes('Voice notes'));
  // Static guards for the pinned chat layout + no-zoom (Miraj bug):
  // the header and input bar must be flex children of a fixed-height
  // column, never scrolling away with the messages — and the sticky
  // headers must not be killed by a later position: relative rule.
  check('chat screen is a fixed-height column, messages scroll on their own',
    styleCss.includes('#screen-chat, #screen-channel, #screen-app { height: 100dvh; }')
    && styleCss.includes('#chat-messages, #channel-posts, .tab-page { min-height: 0; }')
    && styleCss.includes('.chat-header, .chat-input-row { flex-shrink: 0; }'));
  check('sticky headers are not overridden to position relative',
    !styleCss.includes('.app-header { position: relative; }')
    && !styleCss.includes('.chat-header { position: relative; }'));
  check('pinch-zoom is off app-wide, double-tap zoom off on controls',
    styleCss.includes('touch-action: pan-x pan-y;')
    && styleCss.includes('button, input, textarea, select, a { touch-action: manipulation; }'));
  // Static guards for the WhatsApp-style Chat theme + Wallpaper flow.
  check('theme + wallpaper + preview logic exists in the client',
    appJs.includes('function openThemeOverlay') && appJs.includes('function openWallpaperOverlay')
    && appJs.includes('function openWallpaperPreview') && appJs.includes('function renderThemeCards')
    && appJs.includes('function renderBubblePalette') && appJs.includes('s19_chat_dim_')
    && appJs.includes('wallpaperWithDim') && appJs.includes('bubbleTextFor')
    && appJs.includes('preview-dim') && appJs.includes('btn-preview-done'));
  check('bundled wallpapers are referenced (3 nature photos + 1 AI image)',
    appJs.includes('media-generation-nature-palm-0-d7019b95-33b0-4080-a168-11452696861b.jpg')
    && appJs.includes('media-generation-nature-desert-0-b72be574-928d-4c61-89d6-f58db9cb588d.jpg')
    && appJs.includes('media-generation-nature-mountain-0-1a82b33a-a647-4613-b63b-14fbe7b99b41.jpg')
    && appJs.includes('media-generation-ai-dream-0-6ab45dc5-0529-4c8b-8b2d-8e21d10edefa.jpg'));
  check('preview cropper keeps its own pinch-zoom (touch-action none on the wall)',
    styleCss.includes('.preview-wall') && styleCss.includes('touch-action: none'));
  check('bubble colour uses a CSS variable with a readable text colour',
    styleCss.includes('--bubble-mine') && appJs.includes("setProperty('--bubble-mine'")
    && appJs.includes("setProperty('--bubble-mine-text'"));
  check('server stores the bubble colour (column + API validation)',
    fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('bubble_color')
    && fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').includes('bad_bubble_color'));
  check('Settings has the five new rows and their screens (no dead rows)',
    idxHtml2.includes('settings-notif-row') && idxHtml2.includes('settings-storage-row')
    && idxHtml2.includes('settings-access-row') && idxHtml2.includes('settings-help-row')
    && idxHtml2.includes('settings-invite-row')
    && idxHtml2.includes('settings-notif-overlay') && idxHtml2.includes('settings-storage-overlay')
    && idxHtml2.includes('settings-access-overlay') && idxHtml2.includes('settings-help-overlay'));
  const ringBlock = (appJs.match(/const RING_MELODIES = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const ringKeys = (ringBlock.match(/^\s{2}[a-z]+:/gm) || []).length;
  check('22 built-in call ringtones (15 + 8-bit Bounce, Alien, Alpha, Asteroid, Atomic Bell, Aurora, Beep Once)', ringKeys === 22, { ringKeys });
  check('7 new ringtones exist with the same names as the phone tone list (original melodies, not system files)',
    ['bitbounce', 'alien', 'alpha', 'asteroid', 'atomicbell', 'aurora', 'beeponce'].every((k) => ringBlock.includes(k + ':'))
    && appJs.includes("'8-bit Bounce'") && appJs.includes("'Alien'") && appJs.includes("'Alpha'")
    && appJs.includes("'Asteroid'") && appJs.includes("'Atomic Bell'") && appJs.includes("'Aurora'") && appJs.includes("'Beep Once'"));
  check('ringtone volume slider in Notifications: slider + % label in the markup, volume setting key, previews + full ring scale with it (soft ringback unchanged)',
    idxHtml2.includes('notif-volume-slider') && idxHtml2.includes('notif-volume-state')
    && appJs.includes('ringtoneVolume') && appJs.includes('ringtoneVolumeFactor')
    && appJs.includes('RING_VOL.full * ringtoneVolumeFactor()')
    && appJs.includes("ringMode === 'full' ? RING_VOL.full * ringtoneVolumeFactor()"));
  const msgBlock = (appJs.match(/const MSG_TONES = \{([\s\S]*?)\n\};/) || [])[1] || '';
  const msgKeys = (msgBlock.match(/^\s{2}[a-z]+:/gm) || []).length;
  check('6 built-in message tones', msgKeys === 6, { msgKeys });
  check('Notifications screen: per-device sound toggles, 22 ringtones + 6 message tones + custom tones + Silent, preview, and the call/message paths respect them',
    appJs.includes('s19_notif') && appJs.includes('loadNotifSettings') && appJs.includes('saveNotifSettings')
    && appJs.includes('RING_MELODIES') && appJs.includes('sunrise') && appJs.includes('starlight') && appJs.includes('festival')
    && appJs.includes('MSG_TONES') && appJs.includes('chirp') && appJs.includes('whistle')
    && appJs.includes('previewRingtone') && appJs.includes('previewMsgTone') && appJs.includes('playMsgBeep')
    && appJs.includes('callSound') && appJs.includes('msgSound') && appJs.includes('groupSound')
    && appJs.includes('msgTone') && appJs.includes('notif-msgtone-row')
    && idxHtml2.includes('msgtone-dialog') && idxHtml2.includes('ringtone-list') && idxHtml2.includes('msgtone-list'));
  check('custom tones: IndexedDB store, 1 MB cap, max 5, add-your-own row, delete, blob playback',
    appJs.includes('s19-tones') && appJs.includes('s19_custom_tones') && appJs.includes('CUSTOM_TONE_MAX')
    && appJs.includes('1024 * 1024') && appJs.includes('custom-tone-input')
    && appJs.includes('Add your own') && appJs.includes('addCustomTone') && appJs.includes('deleteCustomTone')
    && appJs.includes('getCustomToneBlob') && appJs.includes('playCustomToneOnce')
    && idxHtml2.includes('custom-tone-input'));
  // A visible + icon in both picker headers opens the same file input
  // as the bottom "+ Add your own" row (Bijoy 2026-11-08 23:17 — the
  // bottom row sits below 22 tones, so it was easy to miss).
  check('ringtone + message-tone pickers have a + icon in the header to add a tone from a file',
    idxHtml2.includes('btn-ringtone-add') && idxHtml2.includes('btn-msgtone-add')
    && idxHtml2.includes('dialog-add-btn')
    && appJs.includes("btn-ringtone-add") && appJs.includes("btn-msgtone-add")
    && appJs.includes("customToneTarget = 'ring'") && appJs.includes("customToneTarget = 'msg'")
    && styleCss.includes('.dialog-add-btn'));
  check('Silent is a valid ringtone and message tone (no sound, call/message still works)',
    appJs.includes("'silent'") && appJs.includes('Silent') && appJs.includes('ringtoneDisplayName')
    && appJs.includes('msgToneDisplayName'));
  // Guard: dialog backdrops must sit ABOVE the full-screen settings
  // overlays (z-index 55). At 40 the ringtone/message-tone pickers
  // rendered in the DOM but stayed invisible behind Settings, and
  // taps did nothing (Bijoy reported it 2026-11-08 22:51; a live
  // browser test reproduced it). 65 also clears the status/photo
  // viewers (60) and stays below the toast (70) and media viewer (80).
  const dialogZ = Number((styleCss.match(/\.dialog-backdrop \{[^}]*z-index:\s*(\d+)/) || [])[1] || 0);
  const overlayZ = Number((styleCss.match(/\.profile-overlay \{[^}]*z-index:\s*(\d+)/) || [])[1] || 0);
  check('dialog backdrop z-index is above the settings overlay z-index (pickers visible)', dialogZ > overlayZ && dialogZ > 0 && overlayZ > 0, { dialogZ, overlayZ });
  check('Storage and data screen mirrors the meters and splits auto-download by photos/videos',
    idxHtml2.includes('storage2-used') && idxHtml2.includes('meter2-total')
    && idxHtml2.includes('autodl-photos-row') && idxHtml2.includes('autodl-videos-row')
    && appJs.includes('s19_autosave_photos') && appJs.includes('s19_autosave_videos')
    && appJs.includes('autosavePhotosOn') && appJs.includes('autosaveVideosOn'));
  check('Accessibility screen: larger text and reduce motion, stored per-device and applied on load',
    idxHtml2.includes('access-text-row') && idxHtml2.includes('access-motion-row')
    && appJs.includes('s19_a11y') && appJs.includes('applyA11y')
    && styleCss.includes('html.large-text') && styleCss.includes('html.reduce-motion'));
  check('Help screen states plainly that messages are NOT end-to-end encrypted and has a contact action',
    idxHtml2.includes('help-contact-row') && appJs.includes('help-contact-row')
    && appJs.includes('App link copied'));
  check('Invite a friend uses the system share sheet with a clipboard fallback',
    appJs.includes('settings-invite-row') && appJs.includes('navigator.share')
    && appJs.includes('navigator.clipboard.writeText'));
  // Two-step verification was cancelled by the user and must not exist
  // anywhere: no PIN, no second code, no columns, no endpoints, no row.
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const dbJs = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  check('two-step verification is fully absent (cancelled by the user)',
    !appJs.includes('two-step') && !appJs.includes('two_step') && !appJs.includes('twostep')
    && !idxHtml2.includes('two-step') && !idxHtml2.includes('Two-step')
    && !serverJs.includes('two-step') && !serverJs.includes('two_step')
    && !dbJs.includes('two_step'));

  console.log('== delete message + last seen + missed call ==');
  // Last seen: every authenticated request touches it (throttled to
  // once a minute per user), and the peer's value rides in the inbox
  // and in the message fetch.
  const meSeen = await get('/api/me', tokA);
  check('my last_seen is set after authenticated requests',
    meSeen.status === 200 && typeof meSeen.data.lastSeen === 'number' && meSeen.data.lastSeen > 0, meSeen);
  const convsSeen = await get('/api/conversations', tokB);
  const seenConv = (convsSeen.data.conversations || []).find((c) => c.phone === BIJOY);
  check('friend sees my last_seen in the inbox',
    convsSeen.status === 200 && seenConv && seenConv.lastSeen > 0, seenConv);
  const msgsSeen = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('message fetch carries the peer last_seen',
    msgsSeen.status === 200 && typeof msgsSeen.data.peerLastSeen === 'number' && msgsSeen.data.peerLastSeen > 0, { peerLastSeen: msgsSeen.data && msgsSeen.data.peerLastSeen });
  // Delete for me: my copy goes away, the friend still sees it.
  const delMe = await post('/api/messages', { to: FRIEND, body: 'delete-me test' }, tokA);
  const delMeId = delMe.data.message.id;
  const delMeRes = await post('/api/messages/' + delMeId + '/delete', { scope: 'me' }, tokA);
  check('delete for me works', delMeRes.status === 200 && delMeRes.data.scope === 'me', delMeRes);
  const delMeFetchA = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  check('my fetch no longer includes the message I deleted for me',
    delMeFetchA.status === 200 && !(delMeFetchA.data.messages || []).some((m) => m.id === delMeId), { found: (delMeFetchA.data.messages || []).some((m) => m.id === delMeId) });
  const delMeFetchB = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  check('friend still sees the message I deleted for me',
    delMeFetchB.status === 200 && (delMeFetchB.data.messages || []).some((m) => m.id === delMeId), { n: (delMeFetchB.data.messages || []).length });
  // Delete for everyone: the friend sees a placeholder, and the media
  // endpoint refuses the bytes afterwards.
  const delAll = await post('/api/messages', { to: FRIEND, body: 'delete-all test' }, tokA);
  const delAllId = delAll.data.message.id;
  const delAllPhoto = await sendMedia(FRIEND, 'image', 'del-photo.png', 'image/png', PNG_1X1, tokA);
  const delAllPhotoId = delAllPhoto.data.message.id;
  const delAllRes = await post('/api/messages/' + delAllId + '/delete', { scope: 'all' }, tokA);
  check('delete for everyone works', delAllRes.status === 200 && delAllRes.data.scope === 'all', delAllRes);
  const delAllFetchB = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  const delAllMsgB = (delAllFetchB.data.messages || []).find((m) => m.id === delAllId);
  check('friend fetch shows the deleted-for-all flag, not the text',
    delAllFetchB.status === 200 && delAllMsgB && delAllMsgB.deleted_for_all === 1, delAllMsgB);
  const delAllPhotoRes = await post('/api/messages/' + delAllPhotoId + '/delete', { scope: 'all' }, tokA);
  check('delete for everyone works for a photo too', delAllPhotoRes.status === 200, delAllPhotoRes);
  const delPhotoMediaB = await get('/api/media/' + delAllPhotoId, tokB);
  check('deleted photo bytes refused for the receiver (404)', delPhotoMediaB.status === 404, delPhotoMediaB);
  const delPhotoMediaA = await get('/api/media/' + delAllPhotoId, tokA);
  check('deleted photo bytes refused for the sender too (404)', delPhotoMediaA.status === 404, delPhotoMediaA);
  const delPhotoMediaGrid = await get('/api/chat-media?with=' + FRIEND, tokA);
  check('deleted photo is gone from the profile media grid',
    delPhotoMediaGrid.status === 200 && !(delPhotoMediaGrid.data.media || []).some((m) => m.id === delAllPhotoId), { n: (delPhotoMediaGrid.data.media || []).length });
  // Only the sender may delete for everyone; strangers may not delete
  // at all; bad input is rejected.
  const delAllByReceiver = await post('/api/messages/' + delAllId + '/delete', { scope: 'all' }, tokB);
  check('receiver cannot delete for everyone', delAllByReceiver.status === 403 && delAllByReceiver.data.error === 'not_owner', delAllByReceiver);
  const delByStranger = await post('/api/messages/' + delAllId + '/delete', { scope: 'me' }, tokG);
  check('stranger cannot delete the message', delByStranger.status === 403, delByStranger);
  const delBadScope = await post('/api/messages/' + delAllId + '/delete', { scope: 'both' }, tokA);
  check('bad delete scope rejected', delBadScope.status === 400, delBadScope);
  const delMsgMissing = await post('/api/messages/999999/delete', { scope: 'me' }, tokA);
  check('deleting a missing message is 404', delMsgMissing.status === 404, delMsgMissing);
  const delAnon = await post('/api/messages/' + delAllId + '/delete', { scope: 'me' });
  check('delete needs a session', delAnon.status === 401, delAnon);
  // Missed call: an unanswered offer shows in the receiver's inbox as
  // "Missed voice call" / "Missed video call"; once answered, it stops.
  const offerVoice = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'x', type: 'offer', video: false } }, tokA);
  check('voice offer posts', offerVoice.status === 200, offerVoice);
  const convsMissedVoice = await get('/api/conversations', tokB);
  const missedVoice = (convsMissedVoice.data.conversations || []).find((c) => c.phone === BIJOY);
  check('unanswered voice offer shows as a missed call in the inbox',
    convsMissedVoice.status === 200 && missedVoice && missedVoice.missedAt > 0 && missedVoice.missedVideo === 0, missedVoice);
  const offerVideo = await post('/api/calls/signal', { to: FRIEND, kind: 'offer', payload: { sdp: 'x', type: 'offer', video: true } }, tokA);
  check('video offer posts', offerVideo.status === 200, offerVideo);
  const convsMissedVideo = await get('/api/conversations', tokB);
  const missedVideo = (convsMissedVideo.data.conversations || []).find((c) => c.phone === BIJOY);
  check('unanswered video offer shows as a missed VIDEO call',
    convsMissedVideo.status === 200 && missedVideo && missedVideo.missedAt > 0 && missedVideo.missedVideo === 1, missedVideo);
  const answerBack = await post('/api/calls/signal', { to: BIJOY, kind: 'answer', payload: { sdp: 'y', type: 'answer' } }, tokB);
  check('answer posts', answerBack.status === 200, answerBack);
  const convsAnswered = await get('/api/conversations', tokB);
  const answeredConv = (convsAnswered.data.conversations || []).find((c) => c.phone === BIJOY);
  check('an answered call no longer shows as missed',
    convsAnswered.status === 200 && answeredConv && answeredConv.missedAt === 0, answeredConv);
  // Static guards for the WhatsApp-copy build: white header (no logo
  // in it), camera button, search magnifier, SVG nav in WhatsApp
  // order (Updates before Calls), Chats badge, SVG input bar, white
  // theme colour, and the client-side pieces (date pills, linkify,
  // doc cards, delete menu, last seen, start chatting). idxHtml and
  // appJs2 are the on-disk files read earlier in this suite.
  check('app header has no logo image', !idxHtml.includes('alt="S_19"'));
  check('app header has a camera button', idxHtml.includes('id="btn-header-camera"'));
  check('app header has a small gear for Settings and no ⋮ menu',
    idxHtml.includes('id="btn-header-settings"') && !idxHtml.includes('id="btn-app-menu"') && !idxHtml.includes('id="app-menu"') && appJs2.includes('btn-header-settings'));
  check('search bar has a magnifier icon', idxHtml.includes('class="search-icon"'));
  check('bottom nav order is Chats, Updates, Calls',
    idxHtml.indexOf('data-tab="updates"') > idxHtml.indexOf('data-tab="chats"') &&
    idxHtml.indexOf('data-tab="calls"') > idxHtml.indexOf('data-tab="updates"'));
  check('Chats tab has an unread badge', idxHtml.includes('id="nav-chats-badge"'));
  check('bottom nav uses outline SVG icons, not emoji',
    (() => {
      const nav = idxHtml.slice(idxHtml.indexOf('<nav class="bottom-nav">'), idxHtml.indexOf('</nav>'));
      return nav.includes('<svg') && !['💬', '📞', '⭕', '🛠️', '🛡️'].some((e) => nav.includes(e));
    })());
  check('input bar uses SVG icons, not emoji',
    !idxHtml.includes('>😊<') && !idxHtml.includes('>📎<') && !idxHtml.includes('>🎤</button>') && !idxHtml.includes('>➤</button>'));
  check('theme-color meta is white in light mode, dark in dark mode (media pair)',
    idxHtml.includes('media="(prefers-color-scheme: light)" content="#FFFFFF"')
    && idxHtml.includes('media="(prefers-color-scheme: dark)" content="#0B141A"'));
  const manifest2 = await fetch(BASE + '/manifest.json');
  const manifestData2 = await manifest2.json().catch(() => null);
  check('manifest theme and background are white',
    manifestData2 && manifestData2.theme_color === '#FFFFFF' && manifestData2.background_color === '#FFFFFF', manifestData2);
  check('client renders date separators', appJs2.includes('date-sep') && appJs2.includes('fmtDateLong'));
  check('client linkifies URLs in text bubbles', appJs2.includes('function linkify'));
  check('client renders WhatsApp document cards', appJs2.includes('docCardHtml') && appJs2.includes('doc-card'));
  check('client has the delete-message menu', idxHtml.includes('Delete for everyone') && idxHtml.includes('Delete for me') && appJs2.includes('/delete'));
  check('client shows last seen / online in the chat header', appJs2.includes('formatLastSeen') && appJs2.includes("'online'"));
  check('client renders the Start chatting section', appJs2.includes('start-chatting') && appJs2.includes('Start chatting'));
  check('client renders the missed-call preview', appJs2.includes('Missed voice call') && appJs2.includes('Missed video call'));
  check('theme-color follows the theme (white light, dark in dark mode)',
    appJs2.includes("meta[name=\"theme-color\"]") && appJs2.includes("'#0B141A'") && appJs2.includes("'#FFFFFF'"));
  check('Settings has the auto-save photos & videos toggle',
    idxHtml.includes('id="settings-autosave-row"') && idxHtml.includes('Auto-save photos &amp; videos'));
  check('client auto-saves received photos/videos once (never voice/files)',
    appJs2.includes('s19_autosave') && appJs2.includes('maybeAutosave') && appJs2.includes('s19_autosaved') &&
    appJs2.includes("m.media_kind !== 'image' && m.media_kind !== 'video'"));
  check('client has the new-group flow and group info',
    idxHtml.includes('id="new-group-dialog"') && idxHtml.includes('id="group-info-overlay"') && idxHtml.includes('New group') &&
    appJs2.includes('openGroup') && appJs2.includes('fetchGroupMessages') && appJs2.includes('group-sender-name'));

  console.log('== group chats ==');
  const STRANGER = '8801911000004'; // a fresh number (8801911000003 is CHARLIE in the block tests)
  const tokS = await login(STRANGER, 'Stranger Test');
  // Create: creator becomes admin, members are added, no cap.
  const grp = await post('/api/groups', { name: 'Test Group', members: [FRIEND, GMAIL_USER] }, tokA);
  check('create a group with two members',
    grp.status === 200 && grp.data.group && grp.data.group.id > 0 && grp.data.group.members.length === 3 &&
    grp.data.group.members.find((m) => m.phone === BIJOY).role === 'admin', grp.data && grp.data.group);
  const gid = grp.data.group.id;
  const badGrp = await post('/api/groups', { name: '   ', members: [] }, tokA);
  check('group without a name is rejected', badGrp.status === 400, badGrp);
  const groupsB = await get('/api/groups', tokB);
  check('a member sees the group in their list',
    groupsB.status === 200 && (groupsB.data.groups || []).some((g) => g.id === gid), { n: (groupsB.data.groups || []).length });
  const groupsS = await get('/api/groups', tokS);
  check('a non-member does not see the group',
    groupsS.status === 200 && !(groupsS.data.groups || []).some((g) => g.id === gid), { n: (groupsS.data.groups || []).length });
  const grpMsgS = await get('/api/groups/' + gid + '/messages?afterId=0', tokS);
  check('non-member cannot read group messages', grpMsgS.status === 403, grpMsgS);
  const grpSendS = await post('/api/groups/' + gid + '/messages', { body: 'I should not be here' }, tokS);
  check('non-member cannot send to the group', grpSendS.status === 403, grpSendS);
  const grpInfoS = await get('/api/groups/' + gid, tokS);
  check('non-member cannot read the group info', grpInfoS.status === 403, grpInfoS);
  // Text: sender names ride along, so the client can label bubbles.
  const gMsgA = await post('/api/groups/' + gid + '/messages', { body: 'Hello group' }, tokA);
  check('send a group text message', gMsgA.status === 200 && gMsgA.data.message.body === 'Hello group' && gMsgA.data.message.senderName === 'Bijoy Test', gMsgA.data && gMsgA.data.message);
  const gFetchB = await get('/api/groups/' + gid + '/messages?afterId=0', tokB);
  const gMsgB = (gFetchB.data.messages || []).find((m) => m.body === 'Hello group');
  check('member fetches the group text with the sender name',
    gFetchB.status === 200 && gMsgB && gMsgB.senderName === 'Bijoy Test', gMsgB);
  const gReplyB = await post('/api/groups/' + gid + '/messages', { body: 'Hi Bijoy' }, tokB);
  check('member replies in the group', gReplyB.status === 200 && gReplyB.data.message.senderName === 'Friend Test', gReplyB.data && gReplyB.data.message);
  const gFetchA = await get('/api/groups/' + gid + '/messages?afterId=0', tokA);
  check('creator fetches the reply with the sender name',
    gFetchA.status === 200 && (gFetchA.data.messages || []).some((m) => m.body === 'Hi Bijoy' && m.senderName === 'Friend Test'), { n: (gFetchA.data.messages || []).length });
  // Media in a group: same original-quality upload, members can fetch
  // the bytes, non-members get 403.
  const gPhoto = await post('/api/messages/media', { groupId: gid, mediaKind: 'image', fileName: 'group-photo.png', mimeType: 'image/png', size: Buffer.from(PNG_1X1, 'base64').length, data: PNG_1X1, clientKey: 'gphoto1' }, tokA);
  check('send a group photo (original bytes)',
    gPhoto.status === 200 && gPhoto.data.message.media_kind === 'image' && gPhoto.data.message.group_id === gid, gPhoto.data && gPhoto.data.message);
  const gPhotoId = gPhoto.data.message.id;
  const gPhotoDataB = await get('/api/media/' + gPhotoId, tokB);
  check('member downloads the group photo bytes',
    gPhotoDataB.status === 200 && gPhotoDataB.data.data === PNG_1X1, gPhotoDataB);
  const gPhotoDataS = await get('/api/media/' + gPhotoId, tokS);
  check('non-member cannot download group media', gPhotoDataS.status === 403, gPhotoDataS);
  // Group messages must never leak into the 1-to-1 inbox or chat.
  const convsAfterGrp = await get('/api/conversations', tokA);
  check('group messages do not create a 1-to-1 inbox row',
    convsAfterGrp.status === 200 && !(convsAfterGrp.data.conversations || []).some((c) => !c.phone), { n: (convsAfterGrp.data.conversations || []).length });
  const oneToOneAfterGrp = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  check('group texts do not appear in the 1-to-1 chat',
    oneToOneAfterGrp.status === 200 && !(oneToOneAfterGrp.data.messages || []).some((m) => m.body === 'Hello group'), { n: (oneToOneAfterGrp.data.messages || []).length });
  // Inbox preview: group name + last message prefixed with the sender.
  const groupsA = await get('/api/groups', tokA);
  const grpRow = (groupsA.data.groups || []).find((g) => g.id === gid);
  check('group inbox row has the last message and sender name',
    groupsA.status === 200 && grpRow && grpRow.lastSenderName === 'Bijoy Test' && grpRow.unread === 0, grpRow);
  // Any member may add members — no cap: 25 more in one call.
  const addByMember = await post('/api/groups/' + gid + '/members', { phones: [STRANGER] }, tokB);
  check('a non-admin member can add a member',
    addByMember.status === 200 && addByMember.data.added === 1 && addByMember.data.group.memberCount === 4, addByMember.data && addByMember.data.group);
  const many = [];
  for (let i = 0; i < 25; i++) many.push('8801911000' + String(100 + i));
  const addMany = await post('/api/groups/' + gid + '/members', { phones: many }, tokA);
  check('25 members added at once — no cap',
    addMany.status === 200 && addMany.data.added === 25 && addMany.data.group.memberCount === 29, addMany.data && addMany.data.group);
  const grpInfo = await get('/api/groups/' + gid, tokA);
  check('group info lists all 29 members',
    grpInfo.status === 200 && grpInfo.data.group.members.length === 29, { n: grpInfo.data.group && grpInfo.data.group.members.length });
  // Remove: only an admin may remove, and never themselves.
  const removeByMember = await fetch(BASE + '/api/groups/' + gid + '/members/' + encodeURIComponent(many[0]), { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokB } });
  check('a non-admin member cannot remove anyone', removeByMember.status === 403, { status: removeByMember.status });
  const removeSelf = await fetch(BASE + '/api/groups/' + gid + '/members/' + encodeURIComponent(BIJOY), { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokA } });
  check('an admin cannot remove themselves', removeSelf.status === 400, { status: removeSelf.status });
  const removeByAdmin = await fetch(BASE + '/api/groups/' + gid + '/members/' + encodeURIComponent(many[0]), { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokA } });
  check('the admin removes a member', removeByAdmin.status === 200, { status: removeByAdmin.status });
  const grpInfoAfterRemove = await get('/api/groups/' + gid, tokA);
  check('removed member is gone from the group',
    grpInfoAfterRemove.status === 200 && !(grpInfoAfterRemove.data.group.members || []).some((m) => m.phone === many[0]), { n: grpInfoAfterRemove.data.group.members.length });
  // Leave: the member is out and cannot read or send anymore.
  const leaveB = await post('/api/groups/' + gid + '/leave', {}, tokB);
  check('a member leaves the group', leaveB.status === 200, leaveB);
  const grpMsgAfterLeave = await get('/api/groups/' + gid + '/messages?afterId=0', tokB);
  check('after leaving, the member cannot read group messages', grpMsgAfterLeave.status === 403, grpMsgAfterLeave);
  const groupsAfterLeave = await get('/api/groups', tokB);
  check('after leaving, the group is gone from the member list',
    groupsAfterLeave.status === 200 && !(groupsAfterLeave.data.groups || []).some((g) => g.id === gid), { n: (groupsAfterLeave.data.groups || []).length });
  // Seen ticks: a message counts as seen only when EVERY member who
  // was in the group when it was sent has read it. A small two-member
  // group keeps the check exact.
  const grp2 = await post('/api/groups', { name: 'Seen Test', members: [FRIEND] }, tokA);
  const gid2 = grp2.data.group.id;
  const seenMsg = await post('/api/groups/' + gid2 + '/messages', { body: 'seen test' }, tokA);
  const seenId = seenMsg.data.message.id;
  const seenBefore = await get('/api/groups/' + gid2 + '/messages?afterId=0', tokA);
  const seenTickBefore = (seenBefore.data.ticks || []).find((t) => t.id === seenId);
  check('group message is not seen before the other member reads it',
    seenBefore.status === 200 && seenTickBefore && seenTickBefore.read === 0, seenTickBefore);
  await get('/api/groups/' + gid2 + '/messages?afterId=0', tokB);
  const seenAfter = await get('/api/groups/' + gid2 + '/messages?afterId=0', tokA);
  const seenTickAfter = (seenAfter.data.ticks || []).find((t) => t.id === seenId);
  check('group message is seen once every member has read it',
    seenAfter.status === 200 && seenTickAfter && seenTickAfter.delivered === 1 && seenTickAfter.read === 1, seenTickAfter);
  // Delete in a group: the sender can delete for everyone; a member
  // can delete for themselves; a non-member cannot delete at all.
  const gDel = await post('/api/groups/' + gid2 + '/messages', { body: 'delete me please' }, tokA);
  const gDelId = gDel.data.message.id;
  const gDelMe = await post('/api/messages/' + gDelId + '/delete', { scope: 'me' }, tokB);
  check('group member deletes for themselves', gDelMe.status === 200 && gDelMe.data.scope === 'me', gDelMe);
  const gDelFetchB = await get('/api/groups/' + gid2 + '/messages?afterId=0', tokB);
  check('group message deleted for me is hidden from that member',
    gDelFetchB.status === 200 && !(gDelFetchB.data.messages || []).some((m) => m.id === gDelId), { n: (gDelFetchB.data.messages || []).length });
  const gDelAll = await post('/api/messages/' + gDelId + '/delete', { scope: 'all' }, tokA);
  check('group sender deletes for everyone', gDelAll.status === 200 && gDelAll.data.scope === 'all', gDelAll);
  const gDelFetchA = await get('/api/groups/' + gid2 + '/messages?afterId=0', tokA);
  const gDelMsgA = (gDelFetchA.data.messages || []).find((m) => m.id === gDelId);
  check('group delete-for-all shows the flag, not the text',
    gDelFetchA.status === 200 && gDelMsgA && gDelMsgA.deleted_for_all === 1, gDelMsgA);
  const gDelByStranger = await post('/api/messages/' + gDelId + '/delete', { scope: 'me' }, tokS);
  check('non-member cannot delete a group message', gDelByStranger.status === 403, gDelByStranger);

  console.log('== WhatsApp essentials: reactions, reply, forward, star, view-once, edit ==');
  // A fresh thread for these checks, so earlier messages cannot leak in.
  const base = await post('/api/messages', { to: FRIEND, body: 'Essentials base message' }, tokA);
  check('essentials base message sends', base.status === 200 && base.data.message.id, base);
  const baseId = base.data.message.id;

  // --- reactions ---
  const react = await post('/api/messages/' + baseId + '/react', { emoji: '❤️' }, tokB);
  check('react with ❤️', react.status === 200 && react.data.reacted === true && react.data.emoji === '❤️', react);
  const fetchReact = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  const reactMsg = (fetchReact.data.messages || []).find((m) => m.id === baseId);
  check('reaction rides on the message fetch with the reactor name',
    reactMsg && (reactMsg.reactions || []).some((r) => r.emoji === '❤️' && r.phone === FRIEND && r.name === 'Friend Test'), reactMsg);
  const reactAgain = await post('/api/messages/' + baseId + '/react', { emoji: '❤️' }, tokB);
  check('same emoji again removes the reaction (toggle)',
    reactAgain.status === 200 && reactAgain.data.reacted === false, reactAgain);
  const reactSwap = await post('/api/messages/' + baseId + '/react', { emoji: '🔥' }, tokB);
  const reactSwap2 = await post('/api/messages/' + baseId + '/react', { emoji: '👍' }, tokB);
  check('a different emoji replaces the reaction',
    reactSwap.status === 200 && reactSwap2.status === 200, { s1: reactSwap.status, s2: reactSwap2.status });
  const fetchSwap = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  const swapMsg = (fetchSwap.data.messages || []).find((m) => m.id === baseId);
  check('one reaction per user after a swap',
    swapMsg && (swapMsg.reactions || []).filter((r) => r.phone === FRIEND).length === 1
    && swapMsg.reactions[0].emoji === '👍', swapMsg);
  const reactStranger = await post('/api/messages/' + baseId + '/react', { emoji: '❤️' }, tokS);
  check('a stranger cannot react to a message they cannot see', reactStranger.status === 403, reactStranger);
  const reactBad = await post('/api/messages/' + baseId + '/react', { emoji: '' }, tokB);
  check('empty reaction rejected', reactBad.status === 400, reactBad);

  // --- reply / quote ---
  const reply = await post('/api/messages', { to: BIJOY, body: 'I agree with that', replyTo: baseId }, tokB);
  check('reply sends with a quote snapshot',
    reply.status === 200 && reply.data.message.reply_to === baseId
    && reply.data.message.reply_body === 'Essentials base message'
    && reply.data.message.reply_sender === 'Bijoy Test', reply.data && reply.data.message);
  const replyId = reply.data.message.id;
  const fetchReply = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  const replyMsg = (fetchReply.data.messages || []).find((m) => m.id === replyId);
  check('the reply quote survives the fetch',
    replyMsg && replyMsg.reply_to === baseId && replyMsg.reply_body === 'Essentials base message', replyMsg);
  const replyBad = await post('/api/messages', { to: BIJOY, body: 'bad quote', replyTo: 999999 }, tokB);
  check('reply to a missing message is rejected', replyBad.status === 400 && replyBad.data.error === 'bad_reply', replyBad);
  // Reply to a message from another chat is rejected too.
  const otherChat = await post('/api/messages', { to: GMAIL_USER, body: 'other chat message' }, tokA);
  const otherId = otherChat.data.message.id;
  const crossReply = await post('/api/messages', { to: BIJOY, body: 'cross chat quote', replyTo: otherId }, tokB);
  check('reply cannot quote a message from another chat', crossReply.status === 400 && crossReply.data.error === 'bad_reply', crossReply);
  // Swipe-to-reply is detected during pointermove (not only at
  // pointerup): on a real phone pointerleave fires when the finger
  // slides off the bubble and pointercancel fires when the browser
  // claims the touch for scrolling, so pointerup almost never saw a
  // valid swipe (Bijoy reported it 2026-11-08 23:10). Leave/cancel now
  // clear only the long-press timer, and the bubble declares
  // touch-action pan-y so horizontal pointer events are not hijacked.
  const swipeBlock = (appJs.match(/function attachDeleteHandlers[\s\S]*?\n\}/) || [])[0] || '';
  const leaveBlock = (swipeBlock.match(/for \(const ev of \['pointerleave', 'pointercancel'\]\) \{[\s\S]*?\n  \}/) || [])[0] || '';
  check('swipe-to-reply is detected on pointermove; leave/cancel only clear the long-press timer; bubble has touch-action pan-y',
    swipeBlock.includes("addEventListener('pointermove'") && swipeBlock.includes('startReply(m)')
    && swipeBlock.includes('swipeDone') && !leaveBlock.includes('swipeStart = null')
    && /\.msg \{[^}]*touch-action: pan-y/.test(styleCss));
  // Swipe-to-reply VISIBLY slides the bubble: while the finger drags
  // right the bubble translates 1:1 (clamped at 72px) with the
  // transition off, a ↩️ badge fades in at the vacated left edge, and
  // a drag that stops short snaps back. Bijoy reported 2026-11-08
  // 23:23 that the pull was invisible — only "Reply" appeared later.
  check('swipe-to-reply visibly slides the bubble aside: translateX follows the finger (clamped 72px), msg-swiping disables the transition mid-drag, the reply-arrow badge fades in with dx and resets on snap-back',
    swipeBlock.includes("div.style.transform = 'translateX('") && swipeBlock.includes('Math.min(dx, 72)')
    && swipeBlock.includes('msg-swiping') && swipeBlock.includes('getSwipeIc')
    && swipeBlock.includes('resetSwipeVisual') && swipeBlock.includes('dx / 60')
    && /\.msg \{[^}]*transition: transform \.18s ease/.test(styleCss)
    && /\.msg\.msg-swiping \{ transition: none; \}/.test(styleCss)
    && /\.swipe-reply-ic \{[^}]*opacity: 0;[^}]*transition: opacity \.12s/.test(styleCss));
  // Back navigation, one step at a time: Bijoy reported 2026-11-08
  // 23:25 that one back press from inside a chat exited the whole
  // app. Every layer pushes one history entry on open; popstate closes
  // only the topmost layer; in-app back arrows go through
  // history.back() so no stale entry remains; at the inbox the stack
  // is empty and back exits as normal (no entry is pushed at load —
  // pushState appears exactly once, inside pushBackLayer).
  check('back button goes one step at a time: layers push a history entry on open and popstate closes the topmost; chat, settings, profile, theme, wallpaper, viewers and dialogs wired',
    appJs.includes('history.pushState({ s19layer: id },') && appJs.includes("window.addEventListener('popstate'")
    && appJs.includes('history.back()') && appJs.includes('function pushBackLayer')
    && appJs.includes('function goBackLayer') && appJs.includes('function dismissBackLayer')
    && appJs.includes("pushBackLayer('chat'") && appJs.includes("pushBackLayer('channel'")
    && appJs.includes("pushBackLayer('settings-overlay'") && appJs.includes("pushBackLayer('profile-overlay'")
    && appJs.includes("pushBackLayer('settings-notif-overlay'") && appJs.includes("pushBackLayer('settings-storage-overlay'")
    && appJs.includes("pushBackLayer('settings-access-overlay'") && appJs.includes("pushBackLayer('settings-help-overlay'")
    && appJs.includes("pushBackLayer('edit-field-dialog'") && appJs.includes("pushBackLayer('theme-overlay'")
    && appJs.includes("pushBackLayer('wallpaper-overlay'") && appJs.includes("pushBackLayer('wallpaper-preview'")
    && appJs.includes("pushBackLayer('starred-overlay'") && appJs.includes("pushBackLayer('group-info-overlay'")
    && appJs.includes("pushBackLayer('status-viewer'") && appJs.includes("pushBackLayer('photo-viewer'")
    && appJs.includes("pushBackLayer('media-viewer'") && appJs.includes("pushBackLayer('msg-action-dialog'")
    && appJs.includes("pushBackLayer('delete-msg-dialog'") && appJs.includes("pushBackLayer('reaction-who-dialog'")
    && appJs.includes("pushBackLayer('ringtone-dialog'") && appJs.includes("pushBackLayer('msgtone-dialog'")
    && appJs.includes("pushBackLayer('forward-dialog'") && appJs.includes("pushBackLayer('media-share-dialog'")
    && appJs.includes("pushBackLayer('disappearing-dialog'") && appJs.includes("pushBackLayer('report-dialog'")
    && appJs.includes("pushBackLayer('send-photo-dialog'") && appJs.includes("pushBackLayer('manage-storage-dialog'")
    && appJs.includes("pushBackLayer('media-visibility-dialog'") && appJs.includes("pushBackLayer('add-to-group-dialog'")
    && appJs.includes("pushBackLayer('pin-dialog'") && appJs.includes("pushBackLayer('locked-chats-dialog'")
    && appJs.includes("pushBackLayer('add-contact-dialog'") && appJs.includes("pushBackLayer('new-group-dialog'")
    && appJs.includes("pushBackLayer('add-group-members-dialog'") && appJs.includes("pushBackLayer('new-channel-dialog'")
    && appJs.includes("pushBackLayer('push-dialog'")
    && (appJs.match(/history\.pushState/g) || []).length === 1, null);

  // --- forward ---
  const fwd = await post('/api/messages/' + baseId + '/forward', { targets: [{ to: GMAIL_USER }] }, tokB);
  check('forward sends a labelled copy',
    fwd.status === 200 && fwd.data.messages.length === 1 && fwd.data.messages[0].forwarded === 1
    && fwd.data.messages[0].body === 'Essentials base message', fwd.data && fwd.data.messages);
  const fwdFetch = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokG);
  check('the forwarded copy arrives in the target chat',
    fwdFetch.status === 200 && (fwdFetch.data.messages || []).some((m) => m.forwarded === 1 && m.body === 'Essentials base message'), { n: (fwdFetch.data.messages || []).length });
  const fwdMany = await post('/api/messages/' + baseId + '/forward', {
    targets: [{ to: GMAIL_USER }, { to: GMAIL_USER }, { to: GMAIL_USER }, { to: GMAIL_USER }, { to: GMAIL_USER }, { to: GMAIL_USER }],
  }, tokB);
  check('forward to more than 5 chats is rejected', fwdMany.status === 400, fwdMany);
  const fwdStranger = await post('/api/messages/' + baseId + '/forward', { targets: [{ to: GMAIL_USER }] }, tokS);
  check('a stranger cannot forward a message they cannot see', fwdStranger.status === 403, fwdStranger);
  // Forward a photo: the copy reuses the original bytes (media_ref),
  // no second copy is stored.
  const fwdPhoto = await post('/api/messages/' + imgId + '/forward', { targets: [{ to: GMAIL_USER }] }, tokB);
  check('forward a photo reuses the original media row',
    fwdPhoto.status === 200 && fwdPhoto.data.messages[0].media_kind === 'image'
    && fwdPhoto.data.messages[0].forwarded === 1, fwdPhoto.data && fwdPhoto.data.messages);
  const fwdPhotoId = fwdPhoto.data.messages[0].id;
  const fwdPhotoData = await get('/api/media/' + fwdPhotoId, tokG);
  check('the forwarded photo downloads from the original bytes',
    fwdPhotoData.status === 200 && fwdPhotoData.data.data === PNG_1X1, fwdPhotoData);

  // --- starred messages ---
  const star = await post('/api/messages/' + baseId + '/star', { star: true }, tokB);
  check('star a message', star.status === 200 && star.data.starred === 1, star);
  const fetchStar = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  const starMsg = (fetchStar.data.messages || []).find((m) => m.id === baseId);
  check('the star flag rides on the fetch (mine only)',
    starMsg && starMsg.starred === 1, starMsg);
  const fetchStarOther = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  const starMsgOther = (fetchStarOther.data.messages || []).find((m) => m.id === baseId);
  check('the other side does not see my star',
    starMsgOther && starMsgOther.starred === 0, starMsgOther);
  const starredList = await get('/api/messages/starred?with=' + BIJOY, tokB);
  check('starred list returns the starred message',
    starredList.status === 200 && (starredList.data.messages || []).some((m) => m.id === baseId), { n: (starredList.data.messages || []).length });
  const unstar = await post('/api/messages/' + baseId + '/star', { star: false }, tokB);
  const starredAfter = await get('/api/messages/starred?with=' + BIJOY, tokB);
  check('unstar removes it from the list',
    unstar.status === 200 && !(starredAfter.data.messages || []).some((m) => m.id === baseId), { n: (starredAfter.data.messages || []).length });
  const starStranger = await post('/api/messages/' + baseId + '/star', { star: true }, tokS);
  check('a stranger cannot star a message they cannot see', starStranger.status === 403, starStranger);

  // --- edit message ---
  const editable = await post('/api/messages', { to: FRIEND, body: 'typo heree' }, tokA);
  const editableId = editable.data.message.id;
  const edit = await post('/api/messages/' + editableId + '/edit', { body: 'typo fixed' }, tokA);
  check('edit my own text message within 15 minutes',
    edit.status === 200 && edit.data.message.body === 'typo fixed' && edit.data.message.edited_at > 0, edit.data && edit.data.message);
  const editOther = await post('/api/messages/' + editableId + '/edit', { body: 'not mine' }, tokB);
  check("cannot edit someone else's message", editOther.status === 403, editOther);
  const editMedia = await post('/api/messages/' + imgId + '/edit', { body: 'not text' }, tokA);
  check('cannot edit a media message', editMedia.status === 400 && editMedia.data.error === 'not_text', editMedia);
  const editEmpty = await post('/api/messages/' + editableId + '/edit', { body: '   ' }, tokA);
  check('cannot edit to an empty message', editEmpty.status === 400, editEmpty);
  // Too old: backdate the message past the 15-minute window.
  const oldMsg = await post('/api/messages', { to: FRIEND, body: 'old message' }, tokA);
  const oldId = oldMsg.data.message.id;
  await execSql('UPDATE messages SET created_at = created_at - 16 * 60 * 1000 WHERE id = ' + oldId);
  const editOld = await post('/api/messages/' + oldId + '/edit', { body: 'too late' }, tokA);
  check('cannot edit after 15 minutes', editOld.status === 403 && editOld.data.error === 'too_old', editOld);

  // --- view-once media ---
  const vo = await post('/api/messages/media', { to: FRIEND, mediaKind: 'image', fileName: 'secret.png', mimeType: 'image/png', size: Buffer.from(PNG_1X1, 'base64').length, data: PNG_1X1, duration: 0, clientKey: 'vo-' + Date.now(), viewOnce: true }, tokA);
  check('send a view-once photo',
    vo.status === 200 && vo.data.message.view_once === 1 && vo.data.message.media_kind === 'image', vo.data && vo.data.message);
  const voId = vo.data.message.id;
  const voFetch = await get('/api/messages?with=' + BIJOY + '&afterId=0', tokB);
  const voMsg = (voFetch.data.messages || []).find((m) => m.id === voId);
  check('the receiver fetch shows the view-once flag',
    voMsg && voMsg.view_once === 1 && voMsg.viewed === 0, voMsg);
  const voFirst = await get('/api/media/' + voId, tokB);
  check('the receiver opens the view-once photo once',
    voFirst.status === 200 && voFirst.data.data === PNG_1X1, voFirst);
  const voSecond = await get('/api/media/' + voId, tokB);
  check('a second fetch finds nothing (410)',
    voSecond.status === 410 && voSecond.data.error === 'view_once_gone', voSecond);
  const voSender = await get('/api/media/' + voId, tokA);
  check('the sender can never re-open their own view-once photo', voSender.status === 410, voSender);
  const voFetchSender = await get('/api/messages?with=' + FRIEND + '&afterId=0', tokA);
  check('the sender poll learns the view-once photo was opened',
    voFetchSender.status === 200 && (voFetchSender.data.viewedOnce || []).includes(voId), voFetchSender.data && voFetchSender.data.viewedOnce);
  const voForward = await post('/api/messages/' + voId + '/forward', { targets: [{ to: GMAIL_USER }] }, tokB);
  check('view-once media cannot be forwarded', voForward.status === 400 && voForward.data.error === 'view_once', voForward);
  const voChatMedia = await get('/api/chat-media?with=' + FRIEND, tokA);
  check('view-once media never shows in the profile media grid',
    voChatMedia.status === 200 && !(voChatMedia.data.media || []).some((m) => m.id === voId), { n: (voChatMedia.data.media || []).length });
  const voNormal = await get('/api/media/' + imgId, tokB);
  check('a normal photo still downloads more than once', voNormal.status === 200 && voNormal.data.data === PNG_1X1, voNormal);

  // --- group reactions + reply ---
  // (Friend left the group earlier in the suite, so the group checks
  // use Bijoy, who is still a member.)
  const gReact = await post('/api/messages/' + gMsgA.data.message.id + '/react', { emoji: '👍' }, tokA);
  check('react to a group message', gReact.status === 200 && gReact.data.reacted === true, gReact);
  const gFetchReact = await get('/api/groups/' + gid + '/messages?afterId=0', tokA);
  const gReactMsg = (gFetchReact.data.messages || []).find((m) => m.id === gMsgA.data.message.id);
  check('the group reaction rides on the group fetch',
    gReactMsg && (gReactMsg.reactions || []).some((r) => r.emoji === '👍' && r.phone === BIJOY), gReactMsg);
  const gReply = await post('/api/groups/' + gid + '/messages', { body: 'replying in the group', replyTo: gMsgA.data.message.id }, tokA);
  check('reply in a group quotes the group message',
    gReply.status === 200 && gReply.data.message.reply_to === gMsgA.data.message.id
    && gReply.data.message.reply_body === 'Hello group', gReply.data && gReply.data.message);

  // Static: the client wires every new feature (action sheet, reply bar,
  // forward picker, starred list, pinned chats, view-once toggle).
  check('client has the action sheet + reply bar + forward dialog + starred overlay + pin + view-once',
    appJs.includes('openMsgActions') && appJs.includes('startReply') && appJs.includes('openForward')
    && appJs.includes('openStarred') && appJs.includes('s19_pinned') && appJs.includes('viewOnceNext')
    && appJs.includes('openViewOnce') && appJs.includes('startEdit')
    && idxHtml2.includes('msg-action-dialog') && idxHtml2.includes('reply-bar')
    && idxHtml2.includes('forward-dialog') && idxHtml2.includes('starred-overlay')
    && idxHtml2.includes('menu-starred') && idxHtml2.includes('attach-view-once'), null);
  // Static: the quick-reaction row is 7 emojis + a ➕ button (the 8th
  // emoji was dropped so the + fits on a narrow phone screen); tapping
  // + opens the full emoji panel in reaction mode, so any emoji can be
  // used as a reaction (Bijoy 2026-11-08 23:16).
  const quickBlock = (appJs.match(/const QUICK_REACTIONS = \[([^\]]*)\]/) || [])[1] || '';
  const quickCount = (quickBlock.match(/'[^']+'/g) || []).length;
  check('quick reactions are 7 emojis + a + button opening the full emoji panel',
    quickCount === 7 && !quickBlock.includes('🎉')
    && appJs.includes("more.textContent = '➕'") && appJs.includes('reactionMode = true'), { quickCount });

  // Static: the share button sits on the photo/video bubble itself
  // (bottom-right of the media), opening a sheet with "Share to chat"
  // (the existing forward flow) and "Share outside" (system share sheet
  // via navigator.share, download fallback when unsupported, silent on
  // a user-cancelled share). View-once is excluded: loadMediaInto
  // returns early for view-once before the button is ever added, the
  // sheet refuses it, and the server's forward endpoint rejects it.
  const loadMediaIdx = appJs.indexOf('function loadMediaInto');
  const voReturnIdx = appJs.indexOf('if (m.view_once) return;', loadMediaIdx);
  // The call site sits inside loadMediaInto, after the view-once early
  // return (the definition of addMediaShareBtn lives earlier in the
  // file, so search from the return, not from the start).
  const shareBtnIdx = appJs.indexOf('addMediaShareBtn(wrap, m)', voReturnIdx);
  check('video/photo bubbles carry a share button on the media itself, opening a share sheet (Share to chat / Share outside), view-once excluded',
    appJs.includes('media-share-btn') && appJs.includes('addMediaShareBtn') && appJs.includes('openMediaShare')
    && appJs.includes('shareOutside') && appJs.includes('navigator.share') && appJs.includes('canShare')
    && appJs.includes('btn-share-to-chat') && appJs.includes('btn-share-outside')
    && appJs.includes('downloadBlob') && appJs.includes('was downloaded instead')
    && appJs.includes("if (kind === 'image' || kind === 'video') addMediaShareBtn(wrap, m)")
    && loadMediaIdx > -1 && voReturnIdx > loadMediaIdx && shareBtnIdx > voReturnIdx
    && idxHtml2.includes('media-share-dialog') && idxHtml2.includes('btn-share-to-chat') && idxHtml2.includes('btn-share-outside')
    && styleCss.includes('.media-share-btn') && styleCss.includes('.msg-media { position: relative; }')
    && serverJs.includes('/api/messages/:id/forward') && serverJs.includes("error: 'view_once'"), null);

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
