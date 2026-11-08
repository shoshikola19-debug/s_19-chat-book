// S_19 CHAT BOOK — frontend (single-page app, Bengali UI)
// ---------------------------------------------------------------------------
// Login stays on the device: the session token lives in localStorage, so the
// user is NOT asked for a code every time the app opens — only on a new
// device or after an explicit logout. Weak-network behaviour: messages are
// fetched incrementally (only newer than the last seen id), polling pauses
// while the tab is hidden or offline, and messages typed offline wait in an
// outbox and send themselves when the network returns.

const $ = (id) => document.getElementById(id);
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const bn = (s) => String(s).replace(/[0-9]/g, (d) => BN_DIGITS[+d]);
const bytesOf = (s) => new TextEncoder().encode(s).length;
const fmtTime = (ts) => {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const fmtDate = (ts) => new Date(ts).toLocaleDateString('bn-BD', { day: 'numeric', month: 'short' });

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ---- session ---------------------------------------------------------------
function loadSession() {
  try { return JSON.parse(localStorage.getItem('s19_session') || 'null'); } catch { return null; }
}
function saveSession(s) { localStorage.setItem('s19_session', JSON.stringify(s)); }
function clearSession() { localStorage.removeItem('s19_session'); }
let session = loadSession();

// ---- API -------------------------------------------------------------------
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (session && session.token) headers.Authorization = 'Bearer ' + session.token;
  const res = await fetch(path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (res.status === 401) { // session expired/invalid -> log out locally
    clearSession();
    session = null;
    showScreen('screen-welcome');
    throw new Error('logged_out');
  }
  if (!res.ok) throw new Error((data && data.error) || ('http_' + res.status));
  return data;
}

// ---- daily data meter (Tools tab) ------------------------------------------
// Estimate only: message bytes counted exactly, voice calls at ~16 kbps
// (2 KB per second — the low-bandwidth Opus setting). Target: 5–10 MB/day.
const CALL_BYTES_PER_SEC = 2000;
function usageKey() { return 's19_usage_' + new Date().toISOString().slice(0, 10); }
function loadUsage() {
  try { return JSON.parse(localStorage.getItem(usageKey()) || '{"msg":0,"callSec":0}'); } catch { return { msg: 0, callSec: 0 }; }
}
function saveUsage(u) { localStorage.setItem(usageKey(), JSON.stringify(u)); }
function addMsgBytes(n) { const u = loadUsage(); u.msg += n; saveUsage(u); renderMeter(); }
function addCallSeconds(n) { const u = loadUsage(); u.callSec += n; saveUsage(u); renderMeter(); }
function usageTotalBytes() { const u = loadUsage(); return u.msg + u.callSec * CALL_BYTES_PER_SEC; }
function renderMeter() {
  const u = loadUsage();
  const total = usageTotalBytes();
  const callBytes = u.callSec * CALL_BYTES_PER_SEC;
  $('meter-total').textContent = bn((total / 1e6).toFixed(2)) + ' MB';
  $('meter-msg').textContent = bn(Math.round(u.msg / 1024)) + ' KB';
  $('meter-call').textContent = bn(Math.round(callBytes / 1024)) + ' KB (' + bn(Math.floor(u.callSec / 60)) + ' মিনিট)';
  $('meter-fill').style.width = Math.min(100, (total / 10e6) * 100) + '%';
}

// ---- screens ----------------------------------------------------------------
const SCREENS = ['screen-welcome', 'screen-phone', 'screen-code', 'screen-name', 'screen-app', 'screen-chat', 'screen-channel'];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
  if (id === 'screen-app') renderMeter();
}
function fillCountrySelect(selectEl, selectedDial) {
  const list = window.COUNTRIES || [['Bangladesh', '+880']];
  selectEl.innerHTML = '';
  for (const [name, dial] of list) {
    const o = document.createElement('option');
    o.value = dial;
    o.textContent = name + ' (' + dial + ')';
    selectEl.appendChild(o);
  }
  selectEl.value = selectedDial || '+880';
}
function currentDial() { return $('country-select').value; }

// Identity display: phone numbers show with a +, Gmail addresses as-is.
function displayId(id) {
  if (!id) return '';
  return String(id).includes('@') ? String(id) : '+' + id;
}
function isEmailText(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '').trim()); }

// ---- login flow --------------------------------------------------------------
// Login has two methods: phone number (code by SMS) or Gmail (code by
// email — free). The identity is the full phone digits or the Gmail
// address; everything after login works the same for both.
let loginPhone = ''; // full digits, e.g. 8801XXXXXXXXX
let loginDial = '+880';
let loginMethod = 'phone'; // 'phone' | 'email'
let loginEmail = ''; // Gmail address, lowercased
function setLoginMethod(m) {
  loginMethod = m;
  $('btn-method-phone').classList.toggle('active', m === 'phone');
  $('btn-method-email').classList.toggle('active', m === 'email');
  $('phone-form').classList.toggle('hidden', m !== 'phone');
  $('email-form').classList.toggle('hidden', m !== 'email');
  $('login-title').textContent = m === 'phone' ? 'ফোন নম্বর দাও' : 'Gmail ঠিকানা দাও';
  $('phone-error').classList.add('hidden');
}
$('btn-method-phone').addEventListener('click', () => setLoginMethod('phone'));
$('btn-method-email').addEventListener('click', () => setLoginMethod('email'));

$('btn-agree').addEventListener('click', () => {
  fillCountrySelect($('country-select'), localStorage.getItem('s19_last_dial') || '+880');
  $('dial-prefix').textContent = $('country-select').value;
  showScreen('screen-phone');
  $('phone-input').focus();
});
$('country-select').addEventListener('change', () => {
  $('dial-prefix').textContent = $('country-select').value;
  localStorage.setItem('s19_last_dial', $('country-select').value);
});

async function requestCode() {
  if (loginMethod === 'email') return requestEmailCode();
  const raw = $('phone-input').value.replace(/\D/g, '');
  const dial = currentDial();
  if (raw.length < 9 || raw.length > 11) {
    $('phone-error').textContent = 'সঠিক নম্বরটা লেখো';
    $('phone-error').classList.remove('hidden');
    return;
  }
  $('phone-error').classList.add('hidden');
  try {
    const r = await api('/api/request-code', { method: 'POST', body: JSON.stringify({ phone: raw, dial }) });
    loginDial = dial;
    loginPhone = (dial.replace(/\D/g, '') + raw.replace(/^0/, ''));
    $('code-phone-label').textContent = dial + ' ' + raw;
    $('btn-change-number').textContent = 'নম্বর বদলাও';
    if (r.testCode) {
      $('test-code').textContent = r.testCode;
      $('test-code-box').classList.remove('hidden');
    } else {
      $('test-code-box').classList.add('hidden');
      toast('SMS-এ কোড পাঠানো হয়েছে');
    }
    $('code-error').classList.add('hidden');
    $('code-input').value = '';
    showScreen('screen-code');
    $('code-input').focus();
  } catch (e) {
    $('phone-error').textContent = e.message === 'too_many_codes'
      ? 'অনেকবার কোড চাওয়া হয়েছে — একটু পরে আবার চেষ্টা করো'
      : 'কোড পাঠানো যায়নি — নেট দেখে আবার চেষ্টা করো';
    $('phone-error').classList.remove('hidden');
  }
}
async function requestEmailCode() {
  const email = $('email-input').value.trim().toLowerCase();
  if (!isEmailText(email)) {
    $('phone-error').textContent = 'সঠিক Gmail ঠিকানাটা লেখো';
    $('phone-error').classList.remove('hidden');
    return;
  }
  $('phone-error').classList.add('hidden');
  try {
    const r = await api('/api/request-code', { method: 'POST', body: JSON.stringify({ email }) });
    loginEmail = email;
    $('code-phone-label').textContent = email;
    $('btn-change-number').textContent = 'Gmail বদলাও';
    if (r.testCode) {
      $('test-code').textContent = r.testCode;
      $('test-code-box').classList.remove('hidden');
    } else {
      $('test-code-box').classList.add('hidden');
      toast('Gmail-এ কোড পাঠানো হয়েছে');
    }
    $('code-error').classList.add('hidden');
    $('code-input').value = '';
    showScreen('screen-code');
    $('code-input').focus();
  } catch (e) {
    $('phone-error').textContent = e.message === 'too_many_codes'
      ? 'অনেকবার কোড চাওয়া হয়েছে — একটু পরে আবার চেষ্টা করো'
      : 'কোড পাঠানো যায়নি — নেট দেখে আবার চেষ্টা করো';
    $('phone-error').classList.remove('hidden');
  }
}
$('btn-send-code').addEventListener('click', requestCode);
$('phone-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });
$('email-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') requestCode(); });
$('btn-resend-code').addEventListener('click', async () => {
  try {
    const body = loginMethod === 'email' ? { email: loginEmail } : { phone: loginPhone };
    const r = await api('/api/request-code', { method: 'POST', body: JSON.stringify(body) });
    if (r.testCode) { $('test-code').textContent = r.testCode; $('test-code-box').classList.remove('hidden'); }
    toast('কোড আবার পাঠানো হয়েছে');
  } catch { toast('কোড পাঠানো যায়নি'); }
});
$('btn-change-number').addEventListener('click', () => showScreen('screen-phone'));

async function verifyCode() {
  const code = $('code-input').value.replace(/\D/g, '');
  if (code.length !== 6) {
    $('code-error').textContent = '৬ সংখ্যার কোডটা লেখো';
    $('code-error').classList.remove('hidden');
    return;
  }
  $('code-error').classList.add('hidden');
  try {
    const body = loginMethod === 'email' ? { email: loginEmail, code } : { phone: loginPhone, code };
    const r = await api('/api/verify-code', { method: 'POST', body: JSON.stringify(body) });
    session = { token: r.token, phone: r.phone, name: r.name || '' };
    saveSession(session);
    if (r.isNewUser || !r.name) {
      showScreen('screen-name');
      $('name-input').focus();
    } else {
      enterApp();
    }
  } catch (e) {
    $('code-error').textContent =
      e.message === 'wrong_code' ? 'কোডটা ভুল — আবার দেখে লেখো'
      : e.message === 'code_expired' ? 'কোডের মেয়াদ শেষ — নতুন কোড নাও'
      : e.message === 'too_many_attempts' ? 'অনেকবার ভুল হয়েছে — নতুন কোড নাও'
      : 'যাচাই করা যায়নি — নেট দেখে আবার চেষ্টা করো';
    $('code-error').classList.remove('hidden');
  }
}
$('btn-verify-code').addEventListener('click', verifyCode);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });

async function saveName() {
  const name = $('name-input').value.trim();
  if (!name) {
    $('name-error').textContent = 'নামটা লেখো';
    $('name-error').classList.remove('hidden');
    return;
  }
  $('name-error').classList.add('hidden');
  try {
    const r = await api('/api/set-name', { method: 'POST', body: JSON.stringify({ name }) });
    session.name = r.name;
    saveSession(session);
    enterApp();
  } catch { toast('নাম সেভ হয়নি — আবার চেষ্টা করো'); }
}
$('btn-save-name').addEventListener('click', saveName);
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

// ---- main app ----------------------------------------------------------------
let conversations = [];
let activeChat = null; // peer phone
let chatAfterId = 0;
let chatSearch = '';
let channelSearch = '';

function enterApp() {
  $('tools-name').textContent = session.name || 'আমার নাম';
  $('tools-phone').textContent = displayId(session.phone);
  showScreen('screen-app');
  switchTab('chats');
  refreshAll();
  startPolling();
}

function switchTab(tab) {
  for (const t of ['chats', 'calls', 'updates', 'tools']) {
    $('tab-' + t).classList.toggle('hidden', t !== tab);
  }
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'updates') loadUpdates();
  if (tab === 'calls') loadCallsTab();
  if (tab === 'tools') renderMeter();
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function avatarLetter(name, phone) {
  return (name || phone || '?').trim().charAt(0).toUpperCase();
}
function peerName(c) { return c.name || displayId(c.phone); }

// ---- inbox -------------------------------------------------------------------
async function loadInbox() {
  try {
    const r = await api('/api/conversations');
    conversations = r.conversations || [];
    renderInbox();
  } catch { /* offline — keep the last list on screen */ }
}
function renderInbox() {
  const q = chatSearch.trim().toLowerCase();
  const list = $('chat-list');
  list.innerHTML = '';
  const rows = conversations.filter((c) => !q || peerName(c).toLowerCase().includes(q) || c.phone.includes(q));
  if (!rows.length) {
    list.innerHTML = '<div class="empty-note">ইনবক্স খালি।<br>সবুজ + বোতামে বন্ধুর নম্বর বা Gmail যোগ করে মেসেজ শুরু করো।</div>';
    return;
  }
  for (const c of rows) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML =
      '<div class="avatar">' + avatarLetter(c.name, c.phone) + '</div>' +
      '<div class="chat-row-body">' +
        '<div class="chat-row-top"><span class="chat-row-name">' + escapeHtml(peerName(c)) + '</span>' +
        '<span class="chat-row-time">' + (c.lastAt ? fmtTime(c.lastAt) : '') + '</span></div>' +
        '<div class="chat-row-top"><span class="chat-row-msg">' + escapeHtml(c.lastMessage || '') + '</span>' +
        (c.unread ? '<span class="badge">' + bn(c.unread) + '</span>' : '') + '</div>' +
      '</div>';
    row.addEventListener('click', () => openChat(c.phone, c.name));
    list.appendChild(row);
  }
}
$('chat-search').addEventListener('input', (e) => { chatSearch = e.target.value; renderInbox(); });
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- add contact --------------------------------------------------------------
let addMethod = 'phone'; // 'phone' | 'email'
function setAddMethod(m) {
  addMethod = m;
  $('btn-add-method-phone').classList.toggle('active', m === 'phone');
  $('btn-add-method-email').classList.toggle('active', m === 'email');
  $('add-phone-form').classList.toggle('hidden', m !== 'phone');
  $('add-email-form').classList.toggle('hidden', m !== 'email');
  $('add-contact-error').classList.add('hidden');
}
$('btn-add-method-phone').addEventListener('click', () => setAddMethod('phone'));
$('btn-add-method-email').addEventListener('click', () => setAddMethod('email'));
$('btn-add-contact').addEventListener('click', () => {
  setAddMethod('phone');
  fillCountrySelect($('add-country-select'), localStorage.getItem('s19_last_dial') || '+880');
  $('add-dial-prefix').textContent = $('add-country-select').value;
  $('add-phone-input').value = '';
  $('add-email-input').value = '';
  $('add-contact-error').classList.add('hidden');
  $('add-contact-dialog').classList.remove('hidden');
});
$('add-country-select').addEventListener('change', () => {
  $('add-dial-prefix').textContent = $('add-country-select').value;
});
$('btn-cancel-add').addEventListener('click', () => $('add-contact-dialog').classList.add('hidden'));
$('btn-confirm-add').addEventListener('click', async () => {
  let body;
  if (addMethod === 'email') {
    const email = $('add-email-input').value.trim().toLowerCase();
    if (!isEmailText(email)) {
      $('add-contact-error').textContent = 'সঠিক Gmail ঠিকানাটা লেখো';
      $('add-contact-error').classList.remove('hidden');
      return;
    }
    body = { email };
  } else {
    const raw = $('add-phone-input').value.replace(/\D/g, '');
    const dial = $('add-country-select').value;
    if (raw.length < 9 || raw.length > 11) {
      $('add-contact-error').textContent = 'সঠিক নম্বরটা লেখো';
      $('add-contact-error').classList.remove('hidden');
      return;
    }
    body = { phone: raw, dial };
  }
  try {
    const r = await api('/api/contacts', { method: 'POST', body: JSON.stringify(body) });
    $('add-contact-dialog').classList.add('hidden');
    await loadInbox();
    openChat(r.contact.phone, r.contact.name);
  } catch (e) {
    $('add-contact-error').textContent = e.message === 'self_contact' ? 'নিজেকে যোগ করা যায় না' : 'যোগ করা যায়নি — আবার চেষ্টা করো';
    $('add-contact-error').classList.remove('hidden');
  }
});

// ---- 1-to-1 chat ---------------------------------------------------------------
function openChat(phone, name) {
  activeChat = phone;
  chatAfterId = 0;
  $('chat-messages').innerHTML = '';
  $('chat-peer-avatar').textContent = avatarLetter(name, phone);
  $('chat-peer-name').textContent = name || displayId(phone);
  $('chat-peer-phone').textContent = displayId(phone);
  showScreen('screen-chat');
  fetchChatMessages();
  api('/api/messages/read', { method: 'POST', body: JSON.stringify({ with: phone }) }).catch(() => {});
}
$('btn-back-chats').addEventListener('click', () => {
  activeChat = null;
  showScreen('screen-app');
  loadInbox();
});

async function fetchChatMessages() {
  if (!activeChat) return;
  try {
    const r = await api('/api/messages?with=' + encodeURIComponent(activeChat) + '&afterId=' + chatAfterId);
    for (const m of r.messages || []) {
      appendMessage(m);
      if (m.receiver === session.phone) addMsgBytes(bytesOf(m.body));
      chatAfterId = Math.max(chatAfterId, m.id);
    }
    // Re-render ticks for my messages from the ticks map — this works
    // even when this poll brought no new messages, which is how a ✓
    // becomes ✓✓ and then blue (seen) after the friend reads it.
    const tickMap = {};
    for (const t of r.ticks || []) tickMap[t.id] = t;
    document.querySelectorAll('#chat-messages .msg.mine').forEach((el) => {
      const id = Number(el.dataset.id);
      const t = tickMap[id];
      if (t && el.dataset.ts) {
        el.querySelector('.msg-meta').innerHTML = fmtTime(Number(el.dataset.ts)) + ' ' + tickHtml(t);
      }
    });
  } catch { /* offline — messages stay as they are */ }
}
// Tick marks: ✓ sent, ✓✓ delivered, blue ✓✓ seen (read).
function tickHtml(m) {
  if (m.read) return '<span class="tick-read">✓✓</span>';
  if (m.delivered) return '✓✓';
  return '✓';
}
function appendMessage(m) {
  const box = $('chat-messages');
  const mine = m.sender === session.phone;
  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'mine' : 'theirs') + (m.pending ? ' msg-pending' : '');
  div.dataset.id = m.id || ('tmp-' + m.tempId);
  div.dataset.ts = m.created_at || Date.now();
  div.innerHTML = '<div>' + escapeHtml(m.body) + '</div>' +
    '<div class="msg-meta">' + fmtTime(m.created_at) + ' ' + (mine ? (m.pending ? '🕐' : tickHtml(m)) : '') + '</div>';
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// Offline outbox: messages typed without network wait here and send
// themselves as soon as the network returns.
function loadOutbox() {
  try { return JSON.parse(localStorage.getItem('s19_outbox') || '[]'); } catch { return []; }
}
function saveOutbox(o) { localStorage.setItem('s19_outbox', JSON.stringify(o)); }

async function sendMessage() {
  const body = $('chat-input').value.trim();
  if (!body || !activeChat) return;
  $('chat-input').value = '';
  const tempId = Date.now() + '_' + Math.floor(Math.random() * 1000);
  appendMessage({ body, sender: session.phone, created_at: Date.now(), pending: true, tempId });
  try {
    const r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ to: activeChat, body }) });
    addMsgBytes(bytesOf(body));
    document.querySelector('[data-id="tmp-' + tempId + '"]')?.remove();
    appendMessage(r.message);
    chatAfterId = Math.max(chatAfterId, r.message.id);
  } catch {
    const outbox = loadOutbox();
    outbox.push({ to: activeChat, body, tempId, created_at: Date.now() });
    saveOutbox(outbox);
    toast('নেট নেই — মেসেজ জমা থাকলো, নেট এলেই চলে যাবে');
  }
}
$('btn-send-msg').addEventListener('click', sendMessage);
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

async function flushOutbox() {
  const outbox = loadOutbox();
  if (!outbox.length || !navigator.onLine) return;
  const remaining = [];
  for (const item of outbox) {
    try {
      const r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ to: item.to, body: item.body }) });
      addMsgBytes(bytesOf(item.body));
      if (item.to === activeChat) {
        document.querySelector('[data-id="tmp-' + item.tempId + '"]')?.remove();
        appendMessage(r.message);
        chatAfterId = Math.max(chatAfterId, r.message.id);
      }
    } catch { remaining.push(item); }
  }
  saveOutbox(remaining);
  if (remaining.length < outbox.length) loadInbox();
}
window.addEventListener('online', () => { toast('নেট ফিরেছে'); flushOutbox(); refreshAll(); });

// ---- polling (pauses when hidden / offline) -------------------------------------
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !navigator.onLine) return; // save data + battery
    loadInbox();
    if (activeChat) fetchChatMessages();
  }, 3000);
}
async function refreshAll() {
  await loadInbox();
  if (activeChat) fetchChatMessages();
}

// ---- voice calls (WebRTC, low-bandwidth) --------------------------------------
// Voice goes peer-to-peer; the server only passes signalling messages.
// Audio is tuned for weak networks: Opus mono at ~16 kbps with silence
// suppression (DTX), and the connection restarts itself (ICE restart) if
// the network path drops.
let pc = null;
let localStream = null;
let callPeer = null;
let callDir = 'out'; // 'out' = I called, 'in' = I answered
let callStartAt = 0;
let callTimerId = null;
let callSeconds = 0;
let iceRestarts = 0;
let pendingOffer = null;
const MAX_ICE_RESTARTS = 3;

function tuneSdp(sdp) {
  // Opus: maxaveragebitrate=16000, stereo=0, usedtx=1 (DTX: almost no data
  // in silence) + application-specific bandwidth cap b=AS:20.
  let out = sdp.replace(/a=fmtp:111[^\r\n]*/g, 'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=16000');
  if (!/a=fmtp:111/.test(out)) {
    out = out.replace(/(a=rtpmap:111 opus\/48000\/2\r\n)/, '$1a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=16000\r\n');
  }
  out = out.replace(/(m=audio[^\r\n]*\r\n)/, '$1b=AS:20\r\n');
  return out;
}
function makePc() {
  // STUN alone often cannot connect two phones on mobile data (both sit
  // behind the operator's NAT), so a free TURN relay is included as a
  // fallback. Without it the call connects in signalling but no voice
  // flows — and the timer, which starts on ICE connect, never starts.
  const peer = new RTCPeerConnection({ iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443'],
      username: 'openrelayproject', credential: 'openrelayproject' },
  ] });
  peer.onicecandidate = (e) => {
    if (e.candidate && callPeer) {
      api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: callPeer, kind: 'ice', payload: e.candidate }) }).catch(() => {});
    }
  };
  peer.ontrack = (e) => {
    const a = $('remote-audio');
    a.srcObject = e.streams[0];
    a.muted = false;
    a.volume = 1;
    // The stream alone is not enough on mobile Chrome: playback must be
    // started explicitly, or the other side stays silent.
    a.play().catch(() => {});
  };
  peer.oniceconnectionstatechange = () => {
    const st = peer.iceConnectionState;
    if ((st === 'disconnected' || st === 'failed') && iceRestarts < MAX_ICE_RESTARTS) {
      iceRestarts++;
      try { peer.restartIce(); } catch { /* ignore */ }
    }
    if (st === 'connected' || st === 'completed') startCallTimer();
  };
  return peer;
}
function fmtCallTime(s) {
  const m = Math.floor(s / 60), ss = s % 60;
  return bn(String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'));
}
function startCallTimer() {
  if (callTimerId || !callStartAt) return;
  callTimerId = setInterval(() => {
    callSeconds = Math.floor((Date.now() - callStartAt) / 1000);
    $('call-timer').textContent = fmtCallTime(callSeconds);
  }, 1000);
}
function showCallOverlay(name, status, incoming) {
  $('call-peer-name').textContent = name;
  $('call-status').textContent = status;
  $('call-timer').textContent = '০০:০০';
  $('btn-mute').textContent = '🎙️';
  $('btn-mute').classList.remove('muted');
  let ans = $('btn-answer');
  if (!ans) {
    ans = document.createElement('button');
    ans.id = 'btn-answer';
    ans.className = 'call-round';
    ans.style.background = '#25D366';
    ans.textContent = '📞';
    ans.addEventListener('click', answerCall);
    document.querySelector('.call-buttons').prepend(ans);
  }
  ans.classList.toggle('hidden', !incoming);
  $('btn-mute').classList.toggle('hidden', Boolean(incoming));
  $('call-overlay').classList.remove('hidden');
}
function hideCallOverlay() {
  $('call-overlay').classList.add('hidden');
  if (callTimerId) { clearInterval(callTimerId); callTimerId = null; }
}
function stopCallTracks() {
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (pc) { pc.close(); pc = null; }
  $('remote-audio').srcObject = null;
}
function logCallHistory(peer, dir, seconds) {
  const h = JSON.parse(localStorage.getItem('s19_call_history') || '[]');
  h.unshift({ peer, dir, seconds, at: Date.now() });
  localStorage.setItem('s19_call_history', JSON.stringify(h.slice(0, 20)));
}

async function startCall(peer, name) {
  if (pc) { toast('একটা কল ইতিমধ্যে চলছে'); return; }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch {
    toast('মাইক্রোফোনের অনুমতি লাগবে — ব্রাউজারে Allow দাও, তারপর আবার চেষ্টা করো');
    return;
  }
  callPeer = peer;
  callDir = 'out';
  iceRestarts = 0;
  callStartAt = 0;
  callSeconds = 0;
  pc = makePc();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  const offer = await pc.createOffer({ offerToReceiveAudio: true });
  offer.sdp = tuneSdp(offer.sdp);
  await pc.setLocalDescription(offer);
  await api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: peer, kind: 'offer', payload: { sdp: offer.sdp, type: offer.type } }) });
  showCallOverlay(name || displayId(peer), 'ডাকছে…', false);
  callStartAt = Date.now();
}
async function answerCall() {
  if (!pendingOffer || !callPeer) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch { toast('মাইক্রোফোনের অনুমতি লাগবে'); return; }
  iceRestarts = 0;
  callDir = 'in';
  callStartAt = Date.now();
  pc = makePc();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer.sdp));
  const answer = await pc.createAnswer();
  answer.sdp = tuneSdp(answer.sdp);
  await pc.setLocalDescription(answer);
  await api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: callPeer, kind: 'answer', payload: { sdp: answer.sdp, type: answer.type } }) });
  pendingOffer = null;
  showCallOverlay($('call-peer-name').textContent, 'কথা হচ্ছে…', false);
  startCallTimer();
}
async function endCall(sendSignal = true) {
  if (sendSignal && callPeer) {
    api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: callPeer, kind: 'end', payload: {} }) }).catch(() => {});
  }
  if (callStartAt && callSeconds > 0) {
    addCallSeconds(callSeconds);
    logCallHistory(callPeer, callDir, callSeconds);
  }
  stopCallTracks();
  hideCallOverlay();
  pendingOffer = null;
  callPeer = null;
  callStartAt = 0;
  callSeconds = 0;
  if (!$('tab-calls').classList.contains('hidden')) loadCallsTab();
}
$('btn-end-call').addEventListener('click', () => endCall(true));
$('btn-mute').addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $('btn-mute').classList.toggle('muted', !track.enabled);
  $('btn-mute').textContent = track.enabled ? '🎙️' : '🔇';
});
$('btn-call-peer').addEventListener('click', () => {
  if (activeChat) startCall(activeChat, $('chat-peer-name').textContent);
});
// Signals arriving while a call is already up (answer / ICE / end).
setInterval(async () => {
  if (!session || document.hidden || !navigator.onLine) return;
  try {
    const r = await api('/api/calls/signals');
    for (const s of r.signals || []) {
      if (!pc) {
        if (s.kind === 'offer') {
          callPeer = s.from;
          pendingOffer = s.payload;
          const name = (conversations.find((c) => c.phone === s.from) || {}).name;
          showCallOverlay(name || displayId(s.from), 'কল আসছে…', true);
        }
        continue;
      }
      if (s.kind === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(s.payload));
        callStartAt = callStartAt || Date.now();
        $('call-status').textContent = 'কথা হচ্ছে…';
        startCallTimer();
      } else if (s.kind === 'ice') {
        try { await pc.addIceCandidate(new RTCIceCandidate(s.payload)); } catch { /* ignore */ }
      } else if (s.kind === 'end') {
        endCall(false);
      }
    }
  } catch { /* offline */ }
}, 3000);

// ---- calls tab ----------------------------------------------------------------
async function loadCallsTab() {
  const list = $('call-list');
  list.innerHTML = '';
  const peers = conversations.length ? conversations : (await api('/api/contacts').catch(() => ({ contacts: [] }))).contacts || [];
  if (!peers.length) {
    list.innerHTML = '<div class="empty-note">এখনো কাউকে যোগ করা হয়নি।<br>চ্যাট ট্যাবের + বোতামে নম্বর বা Gmail যোগ করো।</div>';
  }
  for (const p of peers) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">' + avatarLetter(p.name, p.phone) + '</div>' +
      '<div class="chat-row-body"><div class="chat-row-name">' + escapeHtml(peerName(p)) + '</div>' +
      '<div class="chat-row-msg">' + displayId(p.phone) + '</div></div>' +
      '<button class="call-btn" title="কল করো">📞</button>';
    row.querySelector('.call-btn').addEventListener('click', (e) => { e.stopPropagation(); startCall(p.phone, peerName(p)); });
    row.addEventListener('click', () => openChat(p.phone, p.name));
    list.appendChild(row);
  }
  const hist = $('call-history');
  hist.innerHTML = '';
  const h = JSON.parse(localStorage.getItem('s19_call_history') || '[]');
  if (!h.length) hist.innerHTML = '<div class="empty-note">এখনো কোনো কল হয়নি।</div>';
  for (const item of h) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">📞</div><div class="chat-row-body">' +
      '<div class="chat-row-name">' + displayId(item.peer) + '</div>' +
      '<div class="chat-row-msg">' + (item.dir === 'out' ? 'বাইরে যাওয়া কল' : 'আসা কল') + ' • ' + fmtCallTime(item.seconds) + '</div></div>' +
      '<span class="chat-row-time">' + fmtDate(item.at) + ' ' + fmtTime(item.at) + '</span>';
    hist.appendChild(row);
  }
}

// ---- updates: status ------------------------------------------------------------
async function loadUpdates() {
  try {
    const r = await api('/api/statuses');
    const list = $('status-list');
    list.innerHTML = '';
    const mine = (r.statuses || []).filter((s) => s.mine);
    const others = (r.statuses || []).filter((s) => !s.mine);
    const addRow = document.createElement('div');
    addRow.className = 'status-row';
    addRow.innerHTML = '<div class="avatar">+</div><div class="chat-row-body">' +
      '<div class="chat-row-name">আমার স্ট্যাটাস</div>' +
      '<div class="chat-row-msg">' + (mine.length ? escapeHtml(mine[0].text) : '২৪ ঘণ্টা থাকবে') + '</div></div>';
    addRow.addEventListener('click', () => { if (mine.length) showStatus(mine[0]); });
    list.appendChild(addRow);
    for (const s of others) {
      const row = document.createElement('div');
      row.className = 'status-row';
      row.innerHTML = '<div class="status-ring"><div class="avatar">' + avatarLetter(s.name, s.phone) + '</div></div>' +
        '<div class="chat-row-body"><div class="chat-row-name">' + escapeHtml(s.name || displayId(s.phone)) + '</div>' +
        '<div class="chat-row-msg">' + fmtTime(s.created_at) + '</div></div>';
      row.addEventListener('click', () => showStatus(s));
      list.appendChild(row);
    }
    if (!others.length) {
      const d = document.createElement('div');
      d.className = 'empty-note';
      d.textContent = 'বন্ধুদের কোনো স্ট্যাটাস নেই।';
      list.appendChild(d);
    }
  } catch { /* offline */ }
  loadChannels();
}
let viewingStatus = null;
function showStatus(s) {
  viewingStatus = s;
  $('status-viewer-name').textContent = (s.name || displayId(s.phone)) + ' • ' + fmtTime(s.created_at);
  $('status-viewer-text').textContent = s.text;
  let del = $('btn-delete-status');
  if (!del) {
    del = document.createElement('button');
    del.id = 'btn-delete-status';
    del.className = 'btn-danger';
    del.style.cssText = 'position:absolute;bottom:26px;left:50%;transform:translateX(-50%);width:auto;';
    del.textContent = 'স্ট্যাটাস মুছো';
    del.addEventListener('click', async () => {
      try {
        await api('/api/statuses/' + viewingStatus.id, { method: 'DELETE' });
        $('status-viewer').classList.add('hidden');
        loadUpdates();
        toast('স্ট্যাটাস মোছা হয়েছে');
      } catch { toast('মোছা যায়নি'); }
    });
    $('status-viewer').appendChild(del);
  }
  del.classList.toggle('hidden', !s.mine);
  $('status-viewer').classList.remove('hidden');
}
$('btn-close-status').addEventListener('click', () => $('status-viewer').classList.add('hidden'));
$('btn-post-status').addEventListener('click', async () => {
  const text = $('status-input').value.trim();
  if (!text) return;
  try {
    await api('/api/statuses', { method: 'POST', body: JSON.stringify({ text }) });
    $('status-input').value = '';
    loadUpdates();
    toast('স্ট্যাটাস দেওয়া হয়েছে');
  } catch { toast('স্ট্যাটাস দেওয়া যায়নি'); }
});

// ---- updates: channels ------------------------------------------------------------
let openChannelId = null;
async function loadChannels() {
  try {
    const r = await api('/api/channels?q=' + encodeURIComponent(channelSearch));
    const list = $('channel-list');
    list.innerHTML = '';
    if (!r.channels.length) {
      list.innerHTML = '<div class="empty-note">কোনো চ্যানেল নেই।<br>নতুন চ্যানেল বানাও, বা নাম দিয়ে খুঁজো।</div>';
      return;
    }
    for (const c of r.channels) {
      const row = document.createElement('div');
      row.className = 'chat-row';
      row.innerHTML = '<div class="avatar">📢</div>' +
        '<div class="chat-row-body">' +
          '<div class="chat-row-top"><span class="chat-row-name">' + escapeHtml(c.name) + '</span>' +
          '<span class="chat-row-time">' + (c.lastPostAt ? fmtTime(c.lastPostAt) : '') + '</span></div>' +
          '<div class="chat-row-top"><span class="chat-row-msg">' + escapeHtml(c.lastPost || c.description || '') + '</span>' +
          (c.unread ? '<span class="badge">' + bn(c.unread) + '</span>' : '') + '</div>' +
        '</div>' +
        (c.followed ? '' : '<button class="btn-primary btn-small">ফলো</button>');
      const followBtn = row.querySelector('.btn-primary');
      if (followBtn) {
        followBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await api('/api/channels/' + c.id + '/follow', { method: 'POST' }); loadChannels(); } catch { toast('ফলো করা যায়নি'); }
        });
      }
      row.addEventListener('click', () => openChannel(c));
      list.appendChild(row);
    }
  } catch { /* offline */ }
}
$('channel-search').addEventListener('input', (e) => { channelSearch = e.target.value; loadChannels(); });
$('btn-new-channel').addEventListener('click', () => {
  $('new-channel-name').value = '';
  $('new-channel-desc').value = '';
  $('new-channel-error').classList.add('hidden');
  $('new-channel-dialog').classList.remove('hidden');
});
$('btn-cancel-channel').addEventListener('click', () => $('new-channel-dialog').classList.add('hidden'));
$('btn-confirm-channel').addEventListener('click', async () => {
  const name = $('new-channel-name').value.trim();
  const description = $('new-channel-desc').value.trim();
  if (!name) {
    $('new-channel-error').textContent = 'চ্যানেলের নাম লেখো';
    $('new-channel-error').classList.remove('hidden');
    return;
  }
  try {
    const r = await api('/api/channels', { method: 'POST', body: JSON.stringify({ name, description }) });
    $('new-channel-dialog').classList.add('hidden');
    loadChannels();
    openChannel(r.channel);
  } catch (e) {
    $('new-channel-error').textContent = e.message === 'name_taken' ? 'এই নামে চ্যানেল আছে — অন্য নাম দাও' : 'বানানো যায়নি';
    $('new-channel-error').classList.remove('hidden');
  }
});
async function openChannel(c) {
  openChannelId = c.id;
  $('channel-name').textContent = c.name;
  $('channel-desc').textContent = c.description || '';
  $('channel-post-row').classList.toggle('hidden', !c.mine);
  showScreen('screen-channel');
  await api('/api/channels/' + c.id + '/read', { method: 'POST' }).catch(() => {});
  loadChannelPosts();
  loadChannels();
}
$('btn-back-updates').addEventListener('click', () => {
  openChannelId = null;
  showScreen('screen-app');
  switchTab('updates');
});
async function loadChannelPosts() {
  if (!openChannelId) return;
  try {
    const r = await api('/api/channels/' + openChannelId + '/posts');
    const box = $('channel-posts');
    box.innerHTML = '';
    for (const p of r.posts || []) {
      const div = document.createElement('div');
      div.className = 'msg theirs';
      div.innerHTML = '<div>' + escapeHtml(p.text) + '</div><div class="msg-meta">' + fmtDate(p.created_at) + ' ' + fmtTime(p.created_at) + '</div>';
      box.appendChild(div);
    }
    if (!r.posts.length) box.innerHTML = '<div class="empty-note">এখনো কোনো আপডেট নেই।</div>';
    box.scrollTop = box.scrollHeight;
  } catch { /* offline */ }
}
$('btn-send-post').addEventListener('click', async () => {
  const text = $('channel-post-input').value.trim();
  if (!text || !openChannelId) return;
  try {
    await api('/api/channels/' + openChannelId + '/posts', { method: 'POST', body: JSON.stringify({ text }) });
    $('channel-post-input').value = '';
    loadChannelPosts();
  } catch (e) {
    toast(e.message === 'not_owner' ? 'শুধু মালিক পোস্ট করতে পারে' : 'পোস্ট করা যায়নি');
  }
});

// ---- tools ------------------------------------------------------------------------
$('btn-logout').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
  clearSession();
  session = null;
  activeChat = null;
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  showScreen('screen-welcome');
});

// ---- init -----------------------------------------------------------------------------
(function init() {
  fillCountrySelect($('country-select'), localStorage.getItem('s19_last_dial') || '+880');
  if (session && session.token) {
    // Stay logged in on this device; only the name step is needed if the
    // profile was never finished.
    if (session.name) enterApp();
    else showScreen('screen-name');
  } else {
    showScreen('screen-welcome');
  }
})();
