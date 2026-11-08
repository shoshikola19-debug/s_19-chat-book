// S_19 CHAT BOOK — frontend (single-page app, Bengali UI)
// ---------------------------------------------------------------------------
// Login stays on the device: the session token lives in localStorage, so the
// user is NOT asked for a code every time the app opens — only on a new
// device or after an explicit logout. Weak-network behaviour: messages are
// fetched incrementally (only newer than the last seen id), polling pauses
// while the tab is hidden or offline, and messages typed offline wait in an
// outbox and send themselves when the network returns.

const $ = (id) => document.getElementById(id);
const bn = (s) => String(s);
const bytesOf = (s) => new TextEncoder().encode(s).length;
const fmtTime = (ts) => {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const fmtDate = (ts) => new Date(ts).toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
// Long date for date separators ("October 26, 2026") and 12-hour clock
// for "last seen 6:40 AM".
const fmtDateLong = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const fmtDateShortYear = (ts) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtTime12 = (ts) => {
  const d = new Date(ts);
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + ampm;
};

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
// (2 KB per second — the low-bandwidth Opus setting), video calls at
// ~1.5 Mbps (720p, ~187 KB per second — about 11 MB a minute).
// Target: 5–10 MB/day for messages + voice; video is counted separately.
const CALL_BYTES_PER_SEC = 2000;
const VCALL_BYTES_PER_SEC = 187500;
function usageKey() { return 's19_usage_' + new Date().toISOString().slice(0, 10); }
function loadUsage() {
  try { return JSON.parse(localStorage.getItem(usageKey()) || '{"msg":0,"callSec":0,"videoSec":0}'); } catch { return { msg: 0, callSec: 0, videoSec: 0 }; }
}
function saveUsage(u) { localStorage.setItem(usageKey(), JSON.stringify(u)); }
function addMsgBytes(n) { const u = loadUsage(); u.msg += n; saveUsage(u); renderMeter(); }
function addCallSeconds(n, isVideo) {
  const u = loadUsage();
  if (isVideo) u.videoSec = (u.videoSec || 0) + n; else u.callSec += n;
  saveUsage(u); renderMeter();
}
function usageTotalBytes() { const u = loadUsage(); return u.msg + u.callSec * CALL_BYTES_PER_SEC + (u.videoSec || 0) * VCALL_BYTES_PER_SEC; }
function renderMeter() {
  const u = loadUsage();
  const total = usageTotalBytes();
  const callBytes = u.callSec * CALL_BYTES_PER_SEC;
  const vcallBytes = (u.videoSec || 0) * VCALL_BYTES_PER_SEC;
  $('meter-total').textContent = bn((total / 1e6).toFixed(2)) + ' MB';
  $('meter-msg').textContent = bn(Math.round(u.msg / 1024)) + ' KB';
  $('meter-call').textContent = bn(Math.round(callBytes / 1024)) + ' KB (' + bn(Math.floor(u.callSec / 60)) + ' min)';
  $('meter-vcall').textContent = bn(Math.round(vcallBytes / 1024)) + ' KB (' + bn(Math.floor((u.videoSec || 0) / 60)) + ' min)';
  $('meter-fill').style.width = Math.min(100, (total / 10e6) * 100) + '%';
}

// ---- theme (Tools tab picker) ------------------------------------------------
// Global theme lives only on this phone (localStorage): light/dark mode +
// accent colour (green/blue/purple). It restyles the inbox AND the chat
// screens through CSS variables, and applies before login too.
const THEME_ACCENTS = ['green', 'blue', 'purple'];
function loadTheme() {
  try {
    const t = JSON.parse(localStorage.getItem('s19_theme') || '{}');
    return { mode: t.mode === 'dark' ? 'dark' : 'light', accent: THEME_ACCENTS.includes(t.accent) ? t.accent : 'green' };
  } catch { return { mode: 'light', accent: 'green' }; }
}
function applyTheme() {
  const t = loadTheme();
  document.documentElement.dataset.theme = t.mode;
  document.documentElement.dataset.accent = t.accent;
  // The strip below the bottom nav (Android system area) follows the
  // theme colour: white in light mode, dark in dark mode — never green.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t.mode === 'dark' ? '#0B141A' : '#FFFFFF');
  document.querySelectorAll('#btn-theme-light, #btn-theme-dark').forEach((b) => {
    b.classList.toggle('active', (b.id === 'btn-theme-dark') === (t.mode === 'dark'));
  });
  document.querySelectorAll('.theme-swatch[data-accent]').forEach((b) => {
    b.classList.toggle('selected', b.dataset.accent === t.accent);
  });
  // Gallery photo as the inbox background (this phone only).
  let inboxBg = '';
  try { inboxBg = localStorage.getItem('s19_inbox_bg') || ''; } catch {}
  const app = $('app');
  app.classList.toggle('has-photo', !!inboxBg);
  app.style.backgroundImage = inboxBg ? 'url(' + inboxBg + ')' : '';
  $('btn-inbox-bg-remove').classList.toggle('hidden', !inboxBg);
}
function setTheme(mode, accent) {
  const t = loadTheme();
  if (mode) t.mode = mode;
  if (accent) t.accent = accent;
  localStorage.setItem('s19_theme', JSON.stringify(t));
  applyTheme();
}
$('btn-theme-light').addEventListener('click', () => setTheme('light'));
$('btn-theme-dark').addEventListener('click', () => setTheme('dark'));
document.querySelectorAll('.theme-swatch[data-accent]').forEach((b) =>
  b.addEventListener('click', () => setTheme(null, b.dataset.accent)));

// A gallery photo as a background: scaled down to at most 1280px on the
// long side so it fits in the phone's local storage (a full phone photo
// would not). This is a wallpaper, not a sent photo — photos sent in
// chats still go at 100% original quality, untouched.
function downscaleImageFile(file, maxDim) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('bad_image'));
      img.onload = () => {
        const max = maxDim || 1280;
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
$('btn-inbox-bg-pick').addEventListener('click', () => $('inbox-bg-input').click());
$('inbox-bg-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const url = await downscaleImageFile(file);
    try { localStorage.setItem('s19_inbox_bg', url); }
    catch { toast('That photo is too big — choose a smaller one'); return; }
    applyTheme();
    toast('Inbox photo set');
  } catch { toast("Couldn't read that photo — choose another one"); }
});
$('btn-inbox-bg-remove').addEventListener('click', () => {
  try { localStorage.removeItem('s19_inbox_bg'); } catch {}
  applyTheme();
  toast('Inbox photo removed');
});

// ---- media storage (Tools tab) ------------------------------------------------
// How much of the 1 GB free storage my media uses. Shown on the Tools tab.
async function loadStorage() {
  try {
    const r = await api('/api/storage');
    const bytes = r.mediaBytes || 0;
    $('storage-used').textContent = bytes >= 1024 * 1024
      ? bn((bytes / (1024 * 1024)).toFixed(1)) + ' MB'
      : bn(Math.round(bytes / 1024)) + ' KB';
    $('storage-count').textContent = bn(r.mediaCount || 0) ;
    $('storage-fill').style.width = Math.min(100, (bytes / (r.limitBytes || 1073741824)) * 100) + '%';
  } catch { /* offline — keep the last numbers */ }
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
// The broadcast sender "S_19 CHAT BOOK" is shown as-is (no + in front).
function displayId(id) {
  if (!id) return '';
  if (id === 'S_19 CHAT BOOK') return id;
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
  $('login-title').textContent = m === 'phone' ? 'Enter your phone number' : 'Enter your Gmail address';
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
    $('phone-error').textContent = 'Type the correct number';
    $('phone-error').classList.remove('hidden');
    return;
  }
  $('phone-error').classList.add('hidden');
  try {
    const r = await api('/api/request-code', { method: 'POST', body: JSON.stringify({ phone: raw, dial }) });
    loginDial = dial;
    loginPhone = (dial.replace(/\D/g, '') + raw.replace(/^0/, ''));
    $('code-phone-label').textContent = dial + ' ' + raw;
    $('btn-change-number').textContent = 'Change number';
    if (r.testCode) {
      $('test-code').textContent = r.testCode;
      $('test-code-box').classList.remove('hidden');
    } else {
      $('test-code-box').classList.add('hidden');
      toast('Code sent by SMS');
    }
    $('code-error').classList.add('hidden');
    $('code-input').value = '';
    showScreen('screen-code');
    $('code-input').focus();
  } catch (e) {
    $('phone-error').textContent = e.message === 'too_many_codes'
      ? 'Too many code requests — try again in a bit'
      : e.message === 'blocked'
      ? 'This account has been blocked — contact the admin'
      : "Couldn't send the code — check your connection and try again";
    $('phone-error').classList.remove('hidden');
  }
}
async function requestEmailCode() {
  const email = $('email-input').value.trim().toLowerCase();
  if (!isEmailText(email)) {
    $('phone-error').textContent = 'Type the correct Gmail address';
    $('phone-error').classList.remove('hidden');
    return;
  }
  $('phone-error').classList.add('hidden');
  try {
    const r = await api('/api/request-code', { method: 'POST', body: JSON.stringify({ email }) });
    loginEmail = email;
    $('code-phone-label').textContent = email;
    $('btn-change-number').textContent = 'Change Gmail';
    if (r.testCode) {
      $('test-code').textContent = r.testCode;
      $('test-code-box').classList.remove('hidden');
    } else {
      $('test-code-box').classList.add('hidden');
      toast('Code sent to Gmail');
    }
    $('code-error').classList.add('hidden');
    $('code-input').value = '';
    showScreen('screen-code');
    $('code-input').focus();
  } catch (e) {
    $('phone-error').textContent = e.message === 'too_many_codes'
      ? 'Too many code requests — try again in a bit'
      : e.message === 'blocked'
      ? 'This account has been blocked — contact the admin'
      : "Couldn't send the code — check your connection and try again";
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
    toast('Code sent again');
  } catch { toast("Couldn't send the code"); }
});
$('btn-change-number').addEventListener('click', () => showScreen('screen-phone'));

async function verifyCode() {
  const code = $('code-input').value.replace(/\D/g, '');
  if (code.length !== 6) {
    $('code-error').textContent = 'Type the 6-digit code';
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
      e.message === 'wrong_code' ? 'Wrong code — check and type it again'
      : e.message === 'code_expired' ? 'Code expired — get a new code'
      : e.message === 'too_many_attempts' ? 'Too many wrong attempts — get a new code'
      : e.message === 'blocked' ? 'This account has been blocked — contact the admin'
      : "Couldn't verify — check your connection and try again";
    $('code-error').classList.remove('hidden');
  }
}
$('btn-verify-code').addEventListener('click', verifyCode);
$('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });

async function saveName() {
  const name = $('name-input').value.trim();
  if (!name) {
    $('name-error').textContent = 'Type your name';
    $('name-error').classList.remove('hidden');
    return;
  }
  $('name-error').classList.add('hidden');
  try {
    const r = await api('/api/set-name', { method: 'POST', body: JSON.stringify({ name }) });
    session.name = r.name;
    saveSession(session);
    enterApp();
  } catch { toast("Name didn't save — try again"); }
}
$('btn-save-name').addEventListener('click', saveName);
$('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveName(); });

// ---- main app ----------------------------------------------------------------
let conversations = [];
let activeChat = null; // peer phone
let peerLastSeen = 0; // ms timestamp of the peer's last activity (0 = unknown)
let chatAfterId = 0;
let chatSearch = '';
let channelSearch = '';
let myGroups = []; // groups I belong to, for the inbox
let activeGroup = null; // group id when a group chat is open (no group calls)
let groupInfo = null; // the open group's full info {id, name, members, ...}

// Chat header sub-line: "online" when the peer was active in the last
// minute, "last seen 6:40 AM" today, "last seen Oct 26, 2026" before
// that. Unknown (never seen) falls back to the peer's number.
function formatLastSeen(ts) {
  if (!ts) return '';
  if (Date.now() - ts < 60 * 1000) return 'online';
  const sameDay = new Date(ts).toDateString() === new Date().toDateString();
  return sameDay ? 'last seen ' + fmtTime12(ts) : 'last seen ' + fmtDateShortYear(ts);
}
function updatePeerSubline() {
  if (!activeChat) return;
  let s = formatLastSeen(peerLastSeen);
  if (!s) s = displayId(activeChat);
  if (chatSettings && chatSettings.disappearing) s += ' • ⏳ ' + disappearLabel(chatSettings.disappearing);
  $('chat-peer-phone').textContent = s;
}

function enterApp() {
  $('tools-name').textContent = session.name || 'My name';
  $('tools-phone').textContent = displayId(session.phone);
  showScreen('screen-app');
  switchTab('chats');
  refreshAll();
  startPolling();
  setupPushNotifications();
  checkAdmin();
  loadMyProfile();
}

// ---- Settings: my photo, name and About ("Current mood") ----------------
// WhatsApp-style: ⋮ menu → Settings, or tap the profile card in Tools.
// The photo is downscaled to 256px before upload (a profile photo is
// small by design — the 100%-original-quality rule is for photos SENT
// in chats, not for avatars). Friends see the photo and About in the
// inbox, chat header and contact profile.
let myProfile = null;
function renderMyProfile() {
  if (!myProfile) return;
  $('tools-avatar').innerHTML = avatarHtml(myProfile.name, myProfile.phone, myProfile.avatar);
  $('tools-name').textContent = myProfile.name || 'My name';
  $('tools-phone').textContent = displayId(myProfile.phone);
  session.name = myProfile.name;
}
async function loadMyProfile() {
  try {
    myProfile = await api('/api/me');
    renderMyProfile();
  } catch { /* offline — keep the session values on screen */ }
}
function openSettings() {
  if (!myProfile) return;
  $('settings-avatar').innerHTML = avatarHtml(myProfile.name, myProfile.phone, myProfile.avatar);
  $('settings-name').textContent = myProfile.name || '';
  $('settings-about').textContent = myProfile.about || 'Hey there! I am using S_19 CHAT BOOK.';
  $('settings-phone').textContent = displayId(myProfile.phone);
  renderAutosaveRow();
  $('settings-overlay').classList.remove('hidden');
}
// Inbox header gear: opens Settings directly (the old ⋮ menu only
// ever held Settings, so nothing is lost by removing it).
$('btn-header-settings').addEventListener('click', openSettings);
// Header camera (WhatsApp-style): opens the photo picker, like the
// camera button in the chat input bar.
$('btn-header-camera').addEventListener('click', () => $('file-image').click());
$('tools-profile-card').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));
$('settings-avatar-wrap').addEventListener('click', () => $('settings-avatar-input').click());
$('settings-avatar-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const url = await downscaleImageFile(file, 256);
    myProfile = await api('/api/profile', { method: 'POST', body: JSON.stringify({ avatar: url }) });
    renderMyProfile();
    $('settings-avatar').innerHTML = avatarHtml(myProfile.name, myProfile.phone, myProfile.avatar);
    toast('Profile photo updated');
  } catch { toast("Couldn't update the photo — try another one"); }
});
let editFieldKind = null; // 'name' | 'about'
function openEditField(kind) {
  editFieldKind = kind;
  const isName = kind === 'name';
  $('edit-field-title').textContent = isName ? 'Name' : 'About';
  const input = $('edit-field-input');
  input.value = isName ? (myProfile.name || '') : (myProfile.about || '');
  input.maxLength = isName ? 60 : 140;
  input.placeholder = isName ? 'Your name' : 'Current mood…';
  $('edit-field-dialog').classList.remove('hidden');
  input.focus();
}
$('settings-name-row').addEventListener('click', () => openEditField('name'));
$('settings-about-row').addEventListener('click', () => openEditField('about'));
$('btn-edit-field-cancel').addEventListener('click', () => $('edit-field-dialog').classList.add('hidden'));
$('btn-edit-field-save').addEventListener('click', async () => {
  const v = $('edit-field-input').value.trim();
  if (editFieldKind === 'name' && !v) { toast('Please enter a name'); return; }
  try {
    const body = {};
    body[editFieldKind] = v;
    myProfile = await api('/api/profile', { method: 'POST', body: JSON.stringify(body) });
    renderMyProfile();
    $('edit-field-dialog').classList.add('hidden');
    openSettings();
    toast(editFieldKind === 'name' ? 'Name updated' : 'About updated');
  } catch { toast("Couldn't save — check your connection and try again"); }
});

// The server decides who is admin (ADMIN_USERS env var) — /api/me
// carries the flag, and the Admin tab only appears when it is true.
// The server still enforces admin on every /api/admin/* route.
let isAdminUser = false;
async function checkAdmin() {
  try {
    const me = await api('/api/me');
    isAdminUser = !!me.isAdmin;
  } catch { isAdminUser = false; }
  $('nav-admin').classList.toggle('hidden', !isAdminUser);
}

function switchTab(tab) {
  for (const t of ['chats', 'calls', 'updates', 'tools', 'admin']) {
    $('tab-' + t).classList.toggle('hidden', t !== tab);
  }
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab === 'updates') loadUpdates();
  if (tab === 'calls') loadCallsTab();
  if (tab === 'tools') { renderMeter(); loadStorage(); }
  if (tab === 'admin') loadAdmin();
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

function avatarLetter(name, phone) {
  return (name || phone || '?').trim().charAt(0).toUpperCase();
}
// A contact's photo when they set one, otherwise their initial letter.
// The avatar is a data URL (no quotes in base64), so it is safe inside
// an <img src="..."> built this way.
function avatarHtml(name, phone, avatar) {
  if (avatar) return '<img src="' + avatar + '" alt="">';
  return avatarLetter(name, phone);
}
function peerName(c) { return c.name || displayId(c.phone); }

// ---- inbox -------------------------------------------------------------------
let allContacts = [];
async function loadInbox() {
  try {
    const r = await api('/api/conversations');
    conversations = r.conversations || [];
    renderInbox();
  } catch { /* offline — keep the last list on screen */ }
  try {
    const g = await api('/api/groups');
    myGroups = g.groups || [];
    renderInbox();
  } catch { /* offline — keep the last list on screen */ }
  try {
    const c = await api('/api/contacts');
    allContacts = c.contacts || [];
    renderStartChatting();
  } catch { /* offline — keep the last list on screen */ }
}
const MISSED_PHONE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/><line x1="23" y1="1" x2="17" y2="7"/><line x1="17" y1="1" x2="23" y2="7"/></svg>';
function renderInbox() {
  const q = chatSearch.trim().toLowerCase();
  const list = $('chat-list');
  list.innerHTML = '';
  // 1-to-1 chats and groups share one list, newest first — exactly
  // like WhatsApp. A group row shows its name, the last message
  // prefixed with the sender's name ("Sany: Hi"), and a 👥 avatar.
  const rows = conversations.filter((c) => !q || peerName(c).toLowerCase().includes(q) || c.phone.includes(q))
    .map((c) => ({ kind: 'chat', ...c }));
  const grows = myGroups.filter((g) => !q || g.name.toLowerCase().includes(q))
    .map((g) => ({ kind: 'group', ...g }));
  const all = [...rows, ...grows].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  if (!all.length) {
    list.innerHTML = '<div class="empty-note">Inbox is empty.<br>Tap the green + button to add a friend\'s number or Gmail and start messaging.</div>';
  }
  for (const c of all) {
    if (c.kind === 'group') {
      const row = document.createElement('div');
      row.className = 'chat-row';
      const preview = c.lastSenderName
        ? escapeHtml(c.lastSenderName + ': ' + (c.lastMessage || ''))
        : escapeHtml(c.lastMessage || '');
      row.innerHTML =
        '<div class="avatar">👥</div>' +
        '<div class="chat-row-body">' +
          '<div class="chat-row-top"><span class="chat-row-name">' + escapeHtml(c.name) + '</span>' +
          '<span class="chat-row-time">' + (c.lastAt ? fmtTime(c.lastAt) : '') + '</span></div>' +
          '<div class="chat-row-top"><span class="chat-row-msg">' + preview + '</span>' +
          (c.unread ? '<span class="badge">' + bn(c.unread) + '</span>' : '') + '</div>' +
        '</div>';
      row.addEventListener('click', () => openGroup(c.id, c.name));
      list.appendChild(row);
      continue;
    }
    const row = document.createElement('div');
    row.className = 'chat-row';
    // A missed call newer than the last message takes over the preview,
    // in red with a red phone icon — exactly like WhatsApp.
    const missed = c.missedAt && c.missedAt > (c.lastAt || 0);
    const preview = missed
      ? '<span class="chat-row-msg missed">' + MISSED_PHONE_SVG + (c.missedVideo ? 'Missed video call' : 'Missed voice call') + '</span>'
      : '<span class="chat-row-msg">' + escapeHtml(c.lastMessage || '') + '</span>';
    const rowTime = missed ? fmtTime(c.missedAt) : (c.lastAt ? fmtTime(c.lastAt) : '');
    row.innerHTML =
      '<div class="avatar">' + avatarHtml(c.name, c.phone, c.avatar) + '</div>' +
      '<div class="chat-row-body">' +
        '<div class="chat-row-top"><span class="chat-row-name">' + escapeHtml(peerName(c)) + (c.muted ? ' 🔇' : '') + '</span>' +
        '<span class="chat-row-time">' + rowTime + '</span></div>' +
        '<div class="chat-row-top">' + preview +
        (c.unread ? '<span class="badge">' + bn(c.unread) + '</span>' : '') + '</div>' +
      '</div>';
    row.addEventListener('click', () => openChat(c.phone, c.name));
    list.appendChild(row);
  }
  // Total unread on the Chats tab (green circle, hidden at 0) — chats
  // and groups together.
  const totalUnread = conversations.reduce((s, c) => s + (c.unread || 0), 0)
    + myGroups.reduce((s, g) => s + (g.unread || 0), 0);
  const badge = $('nav-chats-badge');
  badge.textContent = bn(totalUnread);
  badge.classList.toggle('hidden', totalUnread === 0);
  renderStartChatting();
}
// "Start chatting": contacts with no conversation yet — a row each with
// a green Chat pill that opens the chat. Hidden while searching and
// when there is nobody to start with.
function renderStartChatting() {
  const box = $('start-chatting');
  if (!box) return;
  const q = chatSearch.trim();
  const withConvo = new Set(conversations.map((c) => c.phone));
  const fresh = !q ? allContacts.filter((c) => !withConvo.has(c.phone)) : [];
  if (!fresh.length) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'section-title';
  head.textContent = 'Start chatting';
  box.appendChild(head);
  for (const c of fresh) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">' + avatarHtml(c.name, c.phone, c.avatar) + '</div>' +
      '<div class="chat-row-body"><div class="chat-row-name">' + escapeHtml(peerName(c)) + '</div>' +
      '<div class="chat-row-msg">' + displayId(c.phone) + '</div></div>' +
      '<button class="start-chat-btn" type="button">Chat</button>';
    row.querySelector('.start-chat-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      openChat(c.phone, c.name);
    });
    row.addEventListener('click', () => openChat(c.phone, c.name));
    box.appendChild(row);
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
      $('add-contact-error').textContent = 'Type the correct Gmail address';
      $('add-contact-error').classList.remove('hidden');
      return;
    }
    body = { email };
  } else {
    const raw = $('add-phone-input').value.replace(/\D/g, '');
    const dial = $('add-country-select').value;
    if (raw.length < 9 || raw.length > 11) {
      $('add-contact-error').textContent = 'Type the correct number';
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
    $('add-contact-error').textContent = e.message === 'self_contact' ? "You can't add yourself" : "Couldn't add — try again";
    $('add-contact-error').classList.remove('hidden');
  }
});

// ---- 1-to-1 chat ---------------------------------------------------------------
// ---- per-chat settings (⋮ menu) ----------------------------------------------
let chatSettings = null; // this chat's settings (mute / disappearing / theme / block)
function disappearLabel(secs) {
  return secs === 86400 ? '24 hours' : secs === 604800 ? '7 days' : secs === 7776000 ? '90 days' : 'Off';
}
function openChat(phone, name) {
  activeChat = phone;
  activeGroup = null;
  groupInfo = null;
  chatAfterId = 0;
  chatSettings = null;
  $('chat-messages').innerHTML = '';
  $('chat-messages').className = 'chat-messages';
  const peer = conversations.find((c) => c.phone === phone) || {};
  peerLastSeen = peer.lastSeen || 0;
  // A group chat hides the call buttons and the ⋮ menu — show them
  // again for a 1-to-1 chat.
  $('btn-chat-menu').classList.remove('hidden');
  $('btn-video-call-peer').classList.remove('hidden');
  $('btn-call-peer').classList.remove('hidden');
  $('chat-peer-avatar').innerHTML = avatarHtml(name, phone, peer.avatar);
  $('chat-peer-name').textContent = name || displayId(phone);
  $('chat-peer-phone').textContent = displayId(phone);
  updatePeerSubline();
  $('chat-menu').classList.add('hidden');
  $('attach-menu').classList.add('hidden');
  $('emoji-panel').classList.add('hidden');
  updateBlockedNote();
  showScreen('screen-chat');
  updateMicSend();
  fetchChatMessages();
  loadChatSettings();
  api('/api/messages/read', { method: 'POST', body: JSON.stringify({ with: phone }) }).catch(() => {});
}
// ---- group chat -----------------------------------------------------------------
// The group chat reuses the 1-to-1 chat screen and its message bar: same
// emoji panel, attach menu, camera and voice recording. Differences:
// incoming bubbles show the sender's name, the header shows the group
// name + member count, there are NO group calls (the call buttons and
// the per-chat ⋮ menu are hidden), and tapping the header opens the
// group info instead of the contact profile.
function openGroup(id, name) {
  activeGroup = id;
  activeChat = null;
  groupInfo = null;
  chatAfterId = 0;
  chatSettings = null;
  peerLastSeen = 0;
  $('chat-messages').innerHTML = '';
  $('chat-messages').className = 'chat-messages';
  $('chat-peer-avatar').innerHTML = '👥';
  $('chat-peer-name').textContent = name || 'Group';
  $('chat-peer-phone').textContent = '';
  $('btn-chat-menu').classList.add('hidden');
  $('btn-video-call-peer').classList.add('hidden');
  $('btn-call-peer').classList.add('hidden');
  $('chat-menu').classList.add('hidden');
  $('attach-menu').classList.add('hidden');
  $('emoji-panel').classList.add('hidden');
  // A group has no block state — make sure the input is enabled even
  // when the previous chat was a blocked 1-to-1.
  $('chat-blocked-note').classList.add('hidden');
  $('chat-input').disabled = false;
  $('btn-send-msg').disabled = false;
  $('btn-attach').disabled = false;
  $('btn-mic').disabled = false;
  $('btn-input-camera').disabled = false;
  $('btn-emoji').disabled = false;
  $('btn-call-peer').disabled = false;
  showScreen('screen-chat');
  updateMicSend();
  fetchGroupMessages();
  loadGroupInfo();
}
async function loadGroupInfo() {
  if (!activeGroup) return;
  try {
    const r = await api('/api/groups/' + activeGroup);
    groupInfo = r.group;
    const n = (groupInfo.members || []).length;
    $('chat-peer-phone').textContent = n + (n === 1 ? ' member' : ' members');
  } catch { /* offline — the member count stays blank */ }
}
async function fetchGroupMessages() {
  if (!activeGroup) return;
  try {
    const r = await api('/api/groups/' + activeGroup + '/messages?afterId=' + chatAfterId);
    for (const m of r.messages || []) {
      appendMessage(m);
      chatAfterId = Math.max(chatAfterId, m.id);
    }
    applyTicks(r.ticks);
    if (r.group && r.group.memberCount) {
      const n = r.group.memberCount;
      $('chat-peer-phone').textContent = n + (n === 1 ? ' member' : ' members');
    }
    if (chatSearchQuery) applyChatSearch(chatSearchQuery);
  } catch { /* offline */ }
}
// Tick state for MY messages — shared by the 1-to-1 and group polls.
function applyTicks(ticks) {
  const tickMap = {};
  for (const t of ticks || []) tickMap[t.id] = t;
  document.querySelectorAll('#chat-messages .msg.mine:not(.msg-deleted)').forEach((el) => {
    const id = Number(el.dataset.id);
    const t = tickMap[id];
    if (t && el.dataset.ts) el.querySelector('.msg-meta').innerHTML = fmtTime(Number(el.dataset.ts)) + ' ' + tickHtml(t);
  });
}
// ---- new group + group info ---------------------------------------------------
// Create from the + button: the add-contact dialog has a "New group"
// link. Members are picked from contacts — as many as you want, there
// is no cap. The creator becomes the group's admin.
$('btn-new-group').addEventListener('click', () => {
  $('add-contact-dialog').classList.add('hidden');
  $('new-group-name').value = '';
  $('new-group-error').classList.add('hidden');
  const list = $('new-group-members');
  list.innerHTML = '';
  if (!allContacts.length) {
    list.innerHTML = '<div class="empty-note">Add a contact first, then create a group with them.</div>';
  }
  for (const c of allContacts) {
    const label = document.createElement('label');
    label.className = 'option-btn';
    label.innerHTML = '<input type="checkbox" value="' + escapeHtml(c.phone) + '"> ' + escapeHtml(peerName(c));
    list.appendChild(label);
  }
  $('new-group-dialog').classList.remove('hidden');
});
$('btn-cancel-group').addEventListener('click', () => $('new-group-dialog').classList.add('hidden'));
$('btn-confirm-group').addEventListener('click', async () => {
  const name = $('new-group-name').value.trim();
  const phones = [...document.querySelectorAll('#new-group-members input:checked')].map((i) => i.value);
  if (!name) {
    $('new-group-error').textContent = 'Type the group name';
    $('new-group-error').classList.remove('hidden');
    return;
  }
  if (!phones.length) {
    $('new-group-error').textContent = 'Choose at least one member';
    $('new-group-error').classList.remove('hidden');
    return;
  }
  try {
    const r = await api('/api/groups', { method: 'POST', body: JSON.stringify({ name, members: phones }) });
    $('new-group-dialog').classList.add('hidden');
    await loadInbox();
    openGroup(r.group.id, r.group.name);
  } catch {
    $('new-group-error').textContent = "Couldn't create the group";
    $('new-group-error').classList.remove('hidden');
  }
});
// Group info: tap the group name in the chat header. Shows the members
// (admins marked), lets any member add more, lets an admin remove a
// member, and lets anyone leave.
async function openGroupInfo() {
  if (!activeGroup) return;
  try {
    const r = await api('/api/groups/' + activeGroup);
    groupInfo = r.group;
    renderGroupInfo();
    $('group-info-overlay').classList.remove('hidden');
  } catch { toast("Couldn't load the group info"); }
}
function renderGroupInfo() {
  const g = groupInfo;
  if (!g) return;
  $('group-info-name').textContent = g.name;
  const n = (g.members || []).length;
  $('group-info-count').textContent = n + (n === 1 ? ' member' : ' members');
  const amAdmin = (g.members || []).some((m) => m.phone === session.phone && m.role === 'admin');
  const list = $('group-info-members');
  list.innerHTML = '';
  for (const m of g.members || []) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">' + avatarHtml(m.name, m.phone, m.avatar) + '</div>' +
      '<div class="chat-row-body"><div class="chat-row-name">' + escapeHtml(m.name || displayId(m.phone)) + (m.phone === session.phone ? ' (You)' : '') + '</div>' +
      '<div class="chat-row-msg">' + (m.role === 'admin' ? 'Group admin' : displayId(m.phone)) + '</div></div>' +
      (amAdmin && m.phone !== session.phone ? '<button class="btn-link" type="button" style="color:#D32F2F">Remove</button>' : '');
    const btn = row.querySelector('.btn-link');
    if (btn) btn.addEventListener('click', async () => {
      if (!confirm('Remove ' + (m.name || displayId(m.phone)) + ' from the group?')) return;
      try {
        await api('/api/groups/' + activeGroup + '/members/' + encodeURIComponent(m.phone), { method: 'DELETE' });
        toast('Removed');
        openGroupInfo();
        loadGroups();
      } catch { toast("Couldn't remove"); }
    });
    list.appendChild(row);
  }
}
async function loadGroups() {
  try {
    const g = await api('/api/groups');
    myGroups = g.groups || [];
    renderInbox();
  } catch { /* offline */ }
}
$('btn-close-group-info').addEventListener('click', () => $('group-info-overlay').classList.add('hidden'));
$('btn-group-add-member').addEventListener('click', () => {
  if (!activeGroup || !groupInfo) return;
  const inGroup = new Set((groupInfo.members || []).map((m) => m.phone));
  const list = $('add-group-members-list');
  list.innerHTML = '';
  const candidates = allContacts.filter((c) => !inGroup.has(c.phone));
  if (!candidates.length) {
    list.innerHTML = '<div class="empty-note">Everyone in your contacts is already in the group.</div>';
  }
  for (const c of candidates) {
    const label = document.createElement('label');
    label.className = 'option-btn';
    label.innerHTML = '<input type="checkbox" value="' + escapeHtml(c.phone) + '"> ' + escapeHtml(peerName(c));
    list.appendChild(label);
  }
  $('add-group-members-dialog').classList.remove('hidden');
});
$('btn-cancel-add-members').addEventListener('click', () => $('add-group-members-dialog').classList.add('hidden'));
$('btn-confirm-add-members').addEventListener('click', async () => {
  const phones = [...document.querySelectorAll('#add-group-members-list input:checked')].map((i) => i.value);
  if (!phones.length) { $('add-group-members-dialog').classList.add('hidden'); return; }
  try {
    await api('/api/groups/' + activeGroup + '/members', { method: 'POST', body: JSON.stringify({ phones }) });
    $('add-group-members-dialog').classList.add('hidden');
    toast('Members added');
    openGroupInfo();
    loadGroups();
  } catch { toast("Couldn't add members"); }
});
$('btn-group-leave').addEventListener('click', async () => {
  if (!activeGroup) return;
  if (!confirm('Leave this group?')) return;
  try {
    await api('/api/groups/' + activeGroup + '/leave', { method: 'POST' });
    $('group-info-overlay').classList.add('hidden');
    activeGroup = null;
    groupInfo = null;
    showScreen('screen-app');
    loadInbox();
    toast('You left the group');
  } catch { toast("Couldn't leave the group"); }
});
// My settings for this chat: applies the per-chat theme, the mute/block
// labels and the blocked note. Fails silently offline — the menu still
// opens and each action retries on its own.
async function loadChatSettings() {
  if (!activeChat) return;
  try {
    chatSettings = await api('/api/chat-settings?with=' + encodeURIComponent(activeChat));
    applyChatTheme();
    updateChatMenuLabels();
    updateBlockedNote();
  } catch { /* offline */ }
}
function applyChatTheme() {
  const box = $('chat-messages');
  box.classList.remove('chat-theme-green', 'chat-theme-blue', 'chat-theme-purple', 'chat-theme-pink', 'chat-theme-dark');
  if (chatSettings && chatSettings.chatTheme) box.classList.add('chat-theme-' + chatSettings.chatTheme);
  // Gallery photo for this chat (this phone only): it covers the colour
  // theme. Picking a colour clears the photo again (see below).
  const photo = savedChatPhoto(activeChat);
  box.classList.toggle('has-photo', !!photo);
  box.style.backgroundImage = photo ? 'url(' + photo + ')' : '';
  $('btn-chat-bg-remove').classList.toggle('hidden', !photo);
  // Last seen / disappearing indicator under the peer's name.
  updatePeerSubline();
}
function updateChatMenuLabels() {
  if (!chatSettings) return;
  $('menu-mute').textContent = chatSettings.muted ? '🔔 Unmute notifications' : '🔇 Mute notifications';
  $('menu-block').textContent = chatSettings.blockedByMe ? '✅ Unblock' : '🚫 Block';
}
function updateBlockedNote() {
  const note = $('chat-blocked-note');
  let disabled = false;
  if (!chatSettings) {
    note.classList.add('hidden');
  } else if (chatSettings.blockedByMe) {
    note.textContent = "You've blocked this friend — no messages or calls until you unblock them.";
    note.classList.remove('hidden');
    disabled = true;
  } else if (chatSettings.blockedByPeer) {
    note.textContent = "This friend has blocked you — you can't send messages or calls anymore.";
    note.classList.remove('hidden');
    disabled = true;
  } else {
    note.classList.add('hidden');
  }
  $('chat-input').disabled = disabled;
  $('btn-send-msg').disabled = disabled;
  $('btn-attach').disabled = disabled;
  $('btn-mic').disabled = disabled;
  $('btn-input-camera').disabled = disabled;
  $('btn-emoji').disabled = disabled;
  $('btn-call-peer').disabled = disabled;
}
$('btn-back-chats').addEventListener('click', () => {
  activeChat = null;
  activeGroup = null;
  groupInfo = null;
  showScreen('screen-app');
  loadInbox();
});

$('btn-chat-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  $('chat-menu').classList.toggle('hidden');
  $('attach-menu').classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!$('chat-menu').classList.contains('hidden') && !e.target.closest('#chat-menu') && e.target.id !== 'btn-chat-menu') {
    $('chat-menu').classList.add('hidden');
  }
  if (!$('attach-menu').classList.contains('hidden') && !e.target.closest('#attach-menu') && e.target.id !== 'btn-attach') {
    $('attach-menu').classList.add('hidden');
  }
  if (!$('emoji-panel').classList.contains('hidden') && !e.target.closest('#emoji-panel') && e.target.id !== 'btn-emoji') {
    $('emoji-panel').classList.add('hidden');
  }
});
async function saveChatSettings(patch, doneMsg) {
  if (!activeChat) return;
  try {
    chatSettings = await api('/api/chat-settings', { method: 'POST', body: JSON.stringify({ with: activeChat, ...patch }) });
    applyChatTheme();
    updateChatMenuLabels();
    updateBlockedNote();
    if (doneMsg) toast(doneMsg);
    loadInbox();
  } catch { toast("Couldn't change it — check your connection and try again"); }
}
$('menu-mute').addEventListener('click', () => {
  $('chat-menu').classList.add('hidden');
  const muted = !(chatSettings && chatSettings.muted);
  saveChatSettings({ muted }, muted ? 'Notifications muted for this chat' : 'Notifications turned on for this chat');
});
$('menu-disappearing').addEventListener('click', () => {
  if (!activeChat) return;
  $('chat-menu').classList.add('hidden');
  document.querySelectorAll('#disappearing-dialog .option-btn').forEach((b) => {
    b.classList.toggle('selected', Number(b.dataset.disappearing) === (chatSettings ? chatSettings.disappearing : 0));
  });
  $('disappearing-dialog').classList.remove('hidden');
});
$('btn-disappearing-cancel').addEventListener('click', () => $('disappearing-dialog').classList.add('hidden'));
document.querySelectorAll('#disappearing-dialog .option-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (!activeChat) return;
    const secs = Number(b.dataset.disappearing);
    $('disappearing-dialog').classList.add('hidden');
    saveChatSettings({ disappearing: secs },
      secs === 0 ? 'Disappearing messages turned off' : 'Disappearing messages on — messages will delete after ' + disappearLabel(secs));
  });
});
// Per-chat theme: pick first, PREVIEW it, then apply with "Done".
// Nothing changes in the real chat until Apply — so themes and photos
// can be compared before committing. Cancel discards the preview.
let pendingChatTheme = '';
let pendingChatPhoto = '';
function chatPhotoKey(peer) { return 's19_chat_bg_' + peer; }
function savedChatPhoto(peer) {
  try { return localStorage.getItem(chatPhotoKey(peer)) || ''; } catch { return ''; }
}
function updateThemePreview() {
  const p = $('chat-theme-preview');
  p.classList.remove('chat-theme-green', 'chat-theme-blue', 'chat-theme-purple', 'chat-theme-pink', 'chat-theme-dark');
  if (pendingChatPhoto) {
    p.classList.add('has-photo');
    p.style.backgroundImage = 'url(' + pendingChatPhoto + ')';
  } else {
    p.classList.remove('has-photo');
    p.style.backgroundImage = '';
    if (pendingChatTheme) p.classList.add('chat-theme-' + pendingChatTheme);
  }
  document.querySelectorAll('.chat-theme-opt').forEach((b) => {
    b.classList.toggle('selected', !pendingChatPhoto && b.dataset.chatTheme === pendingChatTheme);
  });
  $('btn-chat-bg-remove').classList.toggle('hidden', !pendingChatPhoto && !savedChatPhoto(activeChat));
}
$('menu-chat-theme').addEventListener('click', () => {
  if (!activeChat) return;
  $('chat-menu').classList.add('hidden');
  pendingChatTheme = chatSettings ? chatSettings.chatTheme : '';
  pendingChatPhoto = savedChatPhoto(activeChat);
  updateThemePreview();
  $('chat-theme-dialog').classList.remove('hidden');
});
$('btn-chat-theme-cancel').addEventListener('click', () => $('chat-theme-dialog').classList.add('hidden'));
document.querySelectorAll('.chat-theme-opt').forEach((b) => {
  b.addEventListener('click', () => {
    if (!activeChat) return;
    pendingChatTheme = b.dataset.chatTheme;
    pendingChatPhoto = '';
    updateThemePreview();
  });
});
$('btn-chat-bg-pick').addEventListener('click', () => $('chat-bg-input').click());
$('chat-bg-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !activeChat) return;
  try {
    pendingChatPhoto = await downscaleImageFile(file);
    pendingChatTheme = '';
    updateThemePreview();
  } catch { toast("Couldn't read that photo — choose another one"); }
});
$('btn-chat-bg-remove').addEventListener('click', () => {
  pendingChatPhoto = '';
  updateThemePreview();
});
$('btn-chat-theme-apply').addEventListener('click', () => {
  if (!activeChat) return;
  if (pendingChatPhoto) {
    try { localStorage.setItem(chatPhotoKey(activeChat), pendingChatPhoto); }
    catch { toast('That photo is too big — choose a smaller one'); return; }
    $('chat-theme-dialog').classList.add('hidden');
    applyChatTheme();
    saveChatSettings({ chatTheme: '' }, 'Chat photo set');
  } else {
    try { localStorage.removeItem(chatPhotoKey(activeChat)); } catch {}
    $('chat-theme-dialog').classList.add('hidden');
    applyChatTheme();
    saveChatSettings({ chatTheme: pendingChatTheme }, 'Chat theme changed');
  }
});

// ---- Contact profile (WhatsApp-style) ------------------------------------
// Tap the name/avatar in a chat header to open it: big avatar, name,
// number, join date, Voice / Video / Search buttons, every photo, video,
// voice note and file shared in this chat, plus mute and disappearing
// settings. "Last seen" is not tracked, so the join date is shown
// instead — nothing is faked.
let profilePeer = null;
let profileMedia = [];
async function loadMediaUrl(id) {
  let url = mediaCache.get(id);
  if (!url) {
    const r = await api('/api/media/' + id);
    url = dataUrl(r.mimeType, r.data);
    mediaCache.set(id, url);
  }
  return url;
}
function updateProfileRows() {
  $('profile-mute-state').textContent = chatSettings && chatSettings.muted ? 'Off' : 'On';
  $('profile-disappearing-state').textContent = chatSettings && chatSettings.disappearing ? disappearLabel(chatSettings.disappearing) : 'Off';
}
async function openProfile() {
  if (!activeChat) return;
  profilePeer = activeChat;
  const peer = conversations.find((c) => c.phone === activeChat) || {};
  $('profile-avatar').innerHTML = avatarHtml(peer.name, activeChat, peer.avatar);
  $('profile-name').textContent = peer.name || displayId(activeChat);
  $('profile-phone').textContent = displayId(activeChat);
  $('profile-about').textContent = peer.about || '';
  $('profile-joined').textContent = '';
  $('profile-media-count').textContent = '…';
  $('profile-media-grid').classList.add('hidden');
  $('profile-media-grid').innerHTML = '';
  updateProfileRows();
  $('profile-overlay').classList.remove('hidden');
  try {
    const r = await api('/api/chat-media?with=' + encodeURIComponent(activeChat));
    profileMedia = r.media || [];
    $('profile-media-count').textContent = bn(String(profileMedia.length));
    if (r.peer && r.peer.created_at) {
      $('profile-joined').textContent = 'Joined: ' + new Date(r.peer.created_at).toLocaleDateString('en-US');
    }
    if (r.peer) {
      if (r.peer.avatar) $('profile-avatar').innerHTML = '<img src="' + r.peer.avatar + '" alt="">';
      if (r.peer.about) $('profile-about').textContent = r.peer.about;
    }
  } catch { $('profile-media-count').textContent = '0'; }
}
async function renderProfileMedia() {
  const grid = $('profile-media-grid');
  grid.innerHTML = '';
  if (!profileMedia.length) {
    grid.innerHTML = '<div class="empty-note">No photos, videos or files in this chat yet.</div>';
    return;
  }
  for (const m of profileMedia) {
    const tile = document.createElement('div');
    tile.className = 'profile-media-tile';
    if (m.media_kind === 'image') {
      tile.innerHTML = '<div class="media-loading">…</div>';
      loadMediaUrl(m.id).then((url) => { if (url) tile.innerHTML = '<img src="' + url + '" alt="">'; })
        .catch(() => { tile.innerHTML = '<div class="media-loading">Didn\'t load</div>'; });
      tile.addEventListener('click', async () => {
        const url = await loadMediaUrl(m.id);
        if (url) openMediaViewer(url, 'image');
      });
    } else if (m.media_kind === 'video') {
      tile.innerHTML = '<div class="profile-media-kind">🎥</div><div class="profile-media-name">' + escapeHtml(m.media_name || 'Video') + '</div>';
      tile.addEventListener('click', async () => {
        const url = await loadMediaUrl(m.id);
        if (url) openMediaViewer(url, 'video');
      });
    } else if (m.media_kind === 'voice') {
      tile.innerHTML = '<div class="profile-media-kind">🎤</div><div class="profile-media-name">Voice' + (m.media_duration ? ' • ' + fmtCallTime(m.media_duration) : '') + '</div>';
      tile.addEventListener('click', async () => {
        const url = await loadMediaUrl(m.id);
        if (url) new Audio(url).play().catch(() => {});
      });
    } else {
      tile.innerHTML = '<div class="profile-media-kind">📄</div><div class="profile-media-name">' + escapeHtml(m.media_name || 'File') + '</div>';
      tile.addEventListener('click', async () => {
        const url = await loadMediaUrl(m.id);
        if (url) { const a = document.createElement('a'); a.href = url; a.download = m.media_name || 'file'; a.click(); }
      });
    }
    grid.appendChild(tile);
  }
}
$('chat-peer-box').addEventListener('click', () => {
  if (activeGroup) openGroupInfo();
  else openProfile();
});
$('btn-close-profile').addEventListener('click', () => $('profile-overlay').classList.add('hidden'));
$('btn-profile-voice').addEventListener('click', () => {
  const peer = profilePeer, name = $('profile-name').textContent;
  $('profile-overlay').classList.add('hidden');
  if (peer) startCall(peer, name, false);
});
$('btn-profile-video').addEventListener('click', () => {
  const peer = profilePeer, name = $('profile-name').textContent;
  $('profile-overlay').classList.add('hidden');
  if (peer) startCall(peer, name, true);
});
$('btn-profile-search').addEventListener('click', () => {
  $('profile-overlay').classList.add('hidden');
  openChatSearch();
});
$('profile-media-row').addEventListener('click', () => {
  const grid = $('profile-media-grid');
  if (grid.classList.contains('hidden')) {
    renderProfileMedia();
    grid.classList.remove('hidden');
  } else {
    grid.classList.add('hidden');
  }
});
$('profile-mute-row').addEventListener('click', () => {
  if (!activeChat) return;
  const nowMuted = chatSettings && chatSettings.muted;
  saveChatSettings({ muted: nowMuted ? 0 : 1 },
    nowMuted ? 'Notifications turned on' : 'Notifications muted')
    .then(updateProfileRows);
});
$('profile-disappearing-row').addEventListener('click', () => {
  $('profile-overlay').classList.add('hidden');
  $('menu-disappearing').click();
});

// ---- In-chat search (from the profile's Search button) --------------------
// Filters the loaded messages as you type; clearing restores the chat.
let chatSearchQuery = '';
function openChatSearch() {
  $('chat-search-bar').classList.remove('hidden');
  $('chat-search-input').value = '';
  $('chat-search-input').focus();
  applyChatSearch('');
}
function closeChatSearch() {
  $('chat-search-bar').classList.add('hidden');
  applyChatSearch('');
}
function applyChatSearch(q) {
  chatSearchQuery = (q || '').trim().toLowerCase();
  let n = 0;
  document.querySelectorAll('#chat-messages .msg').forEach((el) => {
    const hit = !chatSearchQuery || (el.textContent || '').toLowerCase().includes(chatSearchQuery);
    el.style.display = hit ? '' : 'none';
    if (hit && chatSearchQuery) n++;
  });
  $('chat-search-count').textContent = chatSearchQuery ? bn(String(n)) + ' found' : '';
}
$('chat-search-input').addEventListener('input', (e) => applyChatSearch(e.target.value));
$('btn-close-search').addEventListener('click', closeChatSearch);
$('menu-clear').addEventListener('click', async () => {
  if (!activeChat) return;
  $('chat-menu').classList.add('hidden');
  if (!confirm("All messages in this chat will be deleted from your phone. They will stay on your friend's phone. Delete them?")) return;
  try {
    await api('/api/chat-settings/clear', { method: 'POST', body: JSON.stringify({ with: activeChat }) });
    chatAfterId = 0;
    $('chat-messages').innerHTML = '';
    toast('Chat cleared');
    loadInbox();
  } catch { toast("Couldn't clear — check your connection and try again"); }
});
$('menu-block').addEventListener('click', () => {
  if (!activeChat) return;
  $('chat-menu').classList.add('hidden');
  const blocking = !(chatSettings && chatSettings.blockedByMe);
  if (blocking && !confirm("If you block this friend, they won't be able to message or call you, and neither will you. Block them?")) return;
  saveChatSettings({ blocked: blocking }, blocking ? 'Blocked' : 'Unblocked');
});

async function fetchChatMessages() {
  if (!activeChat) return;
  try {
    const r = await api('/api/messages?with=' + encodeURIComponent(activeChat) + '&afterId=' + chatAfterId);
    for (const m of r.messages || []) {
      appendMessage(m);
      // Media bytes are counted when the media itself downloads (in
      // loadMediaInto); text bytes are counted here. The body of a media
      // message is only its preview label, so it is not counted.
      if (m.receiver === session.phone && !m.media_kind) addMsgBytes(bytesOf(m.body));
      chatAfterId = Math.max(chatAfterId, m.id);
    }
    // Re-render ticks for my messages from the ticks map — this works
    // even when this poll brought no new messages, which is how a ✓
    // becomes ✓✓ and then blue (seen) after the friend reads it.
    // Deleted placeholders carry no ticks, so they are skipped.
    applyTicks(r.ticks);
    // The peer's last activity rides on every poll, so "online" /
    // "last seen …" in the header stays fresh without another request.
    if (typeof r.peerLastSeen === 'number') {
      peerLastSeen = r.peerLastSeen;
      updatePeerSubline();
    }
    // A search in progress must also hide newly polled messages.
    if (chatSearchQuery) applyChatSearch(chatSearchQuery);
  } catch { /* offline — messages stay as they are */ }
}
// Tick marks: ✓ sent, ✓✓ delivered, blue ✓✓ seen (read).
function tickHtml(m) {
  if (m.read) return '<span class="tick-read">✓✓</span>';
  if (m.delivered) return '✓✓';
  return '✓';
}
// ---- WhatsApp chat details: date separators, links, doc cards, delete --
function sameDay(a, b) { return new Date(a).toDateString() === new Date(b).toDateString(); }
// Links in a text bubble: escape HTML first, then turn URLs into blue
// underlined clickable links (http/https or www.).
function linkify(escaped) {
  return escaped.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/g, (url) => {
    const href = url.startsWith('www.') ? 'https://' + url : url;
    return '<a href="' + href + '" target="_blank" rel="noopener">' + url + '</a>';
  });
}
const DELETED_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>';
function fileExt(name, mime) {
  const m = String(name || '').match(/\.([A-Za-z0-9]{1,5})$/);
  if (m) return m[1].toUpperCase();
  if (mime) {
    if (mime.includes('pdf')) return 'PDF';
    if (mime.includes('word')) return 'DOC';
    if (mime.includes('sheet') || mime.includes('excel')) return 'XLS';
    if (mime.includes('powerpoint') || mime.includes('presentation')) return 'PPT';
    if (mime.includes('zip')) return 'ZIP';
    if (mime.includes('text')) return 'TXT';
  }
  return 'FILE';
}
function docColor(ext) {
  return { PDF: '#E53935', DOC: '#1E88E5', DOCX: '#1E88E5', XLS: '#43A047', XLSX: '#43A047', PPT: '#FB8C00', PPTX: '#FB8C00', ZIP: '#8E24AA', TXT: '#757575' }[ext] || '#757575';
}
// WhatsApp-style size: "52 kB", "1.2 MB", "800 B".
function fmtFileSize(n) {
  if (n >= 1024 * 1024) return bn((n / (1024 * 1024)).toFixed(1)) + ' MB';
  if (n >= 1024) return bn(Math.round(n / 1024)) + ' kB';
  return bn(n) + ' B';
}
// WhatsApp document card: coloured file-type icon box with the
// extension, filename, and a "52 kB • JPG" line. With an href it is a
// download link; without one it is the still-uploading preview.
function docCardHtml(m, href) {
  const ext = fileExt(m.media_name, m.media_type);
  const inner = '<span class="doc-icon" style="background:' + docColor(ext) + '">' + escapeHtml(ext) + '</span>' +
    '<span class="doc-body"><span class="doc-name">' + escapeHtml(m.media_name || 'File') + '</span><br>' +
    '<span class="doc-meta">' + fmtFileSize(m.media_size || 0) + ' • ' + escapeHtml(ext) + '</span></span>';
  return href
    ? '<a class="doc-card" href="' + href + '" download="' + escapeHtml(m.media_name || 'file') + '">' + inner + '</a>'
    : '<span class="doc-card">' + inner + '</span>';
}
// Delete message: long-press (~500 ms) or right-click a bubble opens
// the delete dialog. Pending bubbles have no server id yet, and a
// placeholder that is already deleted cannot be deleted again.
let deleteTarget = null; // message row the delete dialog is about
function attachDeleteHandlers(div, m) {
  if (!m.id) return;
  let pressTimer = null;
  div.addEventListener('pointerdown', () => {
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => openDeleteMenu(m), 500);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    div.addEventListener(ev, () => clearTimeout(pressTimer));
  }
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); openDeleteMenu(m); });
}
function openDeleteMenu(m) {
  if (!m.id) return;
  const el = document.querySelector('.msg[data-id="' + m.id + '"]');
  if (el && el.classList.contains('msg-deleted')) return;
  deleteTarget = m;
  $('btn-delete-everyone').classList.toggle('hidden', m.sender !== session.phone);
  $('delete-msg-dialog').classList.remove('hidden');
}
function closeDeleteMenu() {
  $('delete-msg-dialog').classList.add('hidden');
  deleteTarget = null;
}
async function deleteMessage(scope) {
  const m = deleteTarget;
  if (!m || !m.id) return;
  closeDeleteMenu();
  try {
    await api('/api/messages/' + m.id + '/delete', { method: 'POST', body: JSON.stringify({ scope }) });
    const el = document.querySelector('.msg[data-id="' + m.id + '"]');
    if (scope === 'me') {
      el?.remove();
      pruneDateSeps();
    } else if (el) {
      const mine = m.sender === session.phone;
      el.classList.add('msg-deleted');
      el.innerHTML = '<div class="deleted-msg">' + DELETED_ICON_SVG + '<span>' + (mine ? 'You deleted this message' : 'This message was deleted') + '</span></div><div class="msg-meta">' + fmtTime(Number(el.dataset.ts)) + '</div>';
    }
    loadInbox();
  } catch { toast("Couldn't delete — check your connection and try again"); }
}
// A date pill with no message under it (its only message was deleted
// for me) is removed.
function pruneDateSeps() {
  const box = $('chat-messages');
  const kids = [...box.children];
  for (let i = 0; i < kids.length; i++) {
    if (!kids[i].classList.contains('date-sep')) continue;
    const next = kids[i + 1];
    if (!next || next.classList.contains('date-sep')) kids[i].remove();
  }
}
$('btn-delete-everyone').addEventListener('click', () => deleteMessage('all'));
$('btn-delete-me').addEventListener('click', () => deleteMessage('me'));
$('btn-delete-cancel').addEventListener('click', closeDeleteMenu);
$('delete-msg-dialog').addEventListener('click', (e) => { if (e.target.id === 'delete-msg-dialog') closeDeleteMenu(); });

function appendMessage(m) {
  const box = $('chat-messages');
  // A message already on screen is never rendered twice. The 3-second
  // poll can return a message while its upload is still in flight, and
  // the upload's own success handler appends it too — without this
  // guard one photo showed up as two bubbles. Pending bubbles carry
  // data-id="tmp-..." so they never collide with a real id.
  if (m.id && box.querySelector('.msg[data-id="' + m.id + '"]')) return;
  const mine = m.sender === session.phone;
  const ts = m.created_at || Date.now();
  // Date separator: a centred pill before the first message and
  // whenever the day changes. The poll only ever appends newer
  // messages, so comparing with the last bubble on screen is enough.
  // The extra last-separator check covers the send flow: a pending
  // bubble inserts the pill, then the upload's success removes the
  // pending bubble and appends the real one — without it the same
  // day's pill would appear twice.
  const prevMsg = [...box.querySelectorAll('.msg')].pop();
  const lastSep = [...box.querySelectorAll('.date-sep')].pop();
  if ((!prevMsg || !sameDay(Number(prevMsg.dataset.ts), ts)) &&
      (!lastSep || lastSep.textContent !== fmtDateLong(ts))) {
    const sep = document.createElement('div');
    sep.className = 'date-sep';
    sep.textContent = fmtDateLong(ts);
    box.appendChild(sep);
  }
  const div = document.createElement('div');
  div.className = 'msg ' + (mine ? 'mine' : 'theirs') + (m.pending ? ' msg-pending' : '');
  div.dataset.id = m.id || ('tmp-' + m.tempId);
  div.dataset.ts = ts;
  const meta = '<div class="msg-meta">' + fmtTime(ts) + ' ' + (mine ? (m.pending ? '🕐' : tickHtml(m)) : '') + '</div>';
  // Group chats: an incoming bubble starts with the sender's name, so
  // you can tell who wrote what. (My own bubbles need no name.)
  const senderLine = (m.group_id && !mine && m.senderName)
    ? '<div class="group-sender-name">' + escapeHtml(m.senderName) + '</div>' : '';
  // A message the sender deleted for everyone: grey italic placeholder
  // bubble, no content, no ticks, no media — and it cannot be deleted
  // again (openDeleteMenu guards on .msg-deleted).
  if (m.deleted_for_all) {
    div.classList.add('msg-deleted');
    div.innerHTML = '<div class="deleted-msg">' + DELETED_ICON_SVG + '<span>' + (mine ? 'You deleted this message' : 'This message was deleted') + '</span></div><div class="msg-meta">' + fmtTime(ts) + '</div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return;
  }
  if (m.media_kind) {
    // A media message the sender just uploaded carries its bytes locally
    // (localDataUrl), so it renders at once without a round trip.
    if (m.localDataUrl && m.id) mediaCache.set(m.id, m.localDataUrl);
    div.innerHTML = senderLine + mediaHtml(m) + meta;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    if (!m.pending) loadMediaInto(div, m);
    attachDeleteHandlers(div, m);
    return;
  }
  div.innerHTML = senderLine + '<div>' + linkify(escapeHtml(m.body)) + '</div>' + meta;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  attachDeleteHandlers(div, m);
}

// The inside of a media bubble. Pending bubbles (still uploading) show a
// local preview + progress bar + retry; finished ones show a placeholder
// until loadMediaInto() fills in the real bytes (lazy fetch).
function mediaHtml(m) {
  const kind = m.media_kind;
  const wrap = '<div class="msg-media">';
  if (m.pending) {
    let preview = '';
    if ((kind === 'image' || kind === 'video') && m.localPreviewUrl) {
      preview = kind === 'image'
        ? '<img src="' + m.localPreviewUrl + '" alt="Photo">'
        : '<video src="' + m.localPreviewUrl + '" muted playsinline></video>';
    } else if (kind === 'voice') {
      preview = '<div>🎤 Voice • ' + fmtCallTime(m.duration || 0) + '</div>';
    } else {
      preview = docCardHtml(m);
    }
    return wrap + preview +
      '<div class="media-progress"><div style="width:' + (m.progress || 0) + '%"></div></div>' +
      '<div class="media-progress-label">Uploading… ' + bn(m.progress || 0) + '%</div>' +
      '<span class="media-retry hidden">Try again</span></div>';
  }
  const size = m.media_size ? '<div class="media-size">' + fmtBytes(m.media_size) + '</div>' : '';
  if (kind === 'image') return wrap + '<div class="media-loading">📷 Photo loading…</div>' + size + '</div>';
  if (kind === 'video') return wrap + '<div class="media-loading">🎥 Video loading…</div>' + size + '</div>';
  if (kind === 'voice') return wrap + '<div>🎤 Voice' + (m.media_duration ? ' • ' + fmtCallTime(m.media_duration) : '') + ' loading…</div>' + size + '</div>';
  return wrap + docCardHtml(m) + '<div class="media-loading">Loading…</div></div>';
}

// Pulls one message's media bytes (once — then cached) and renders the
// thumbnail / player / download link. The bytes count toward the data
// meter, like a received message.
// ---- auto-save photos & videos (Settings toggle) ---------------------------
// On by default. Every RECEIVED (never my own) photo or video is saved
// to the phone once its bytes have loaded — exactly once per message,
// so a re-render never downloads it twice. Voice notes and files are
// never auto-saved: tap them to download, as before. The ids are kept
// in localStorage (last 500), so the "once" promise survives a restart
// of the app. Note: Chrome may ask once to allow multiple downloads —
// that is the browser's own permission, not a bug in the app.
function autosaveOn() {
  try { return localStorage.getItem('s19_autosave') !== 'off'; } catch { return true; }
}
function wasAutosaved(id) {
  try { return (JSON.parse(localStorage.getItem('s19_autosaved') || '[]')).includes(id); } catch { return false; }
}
function markAutosaved(id) {
  try {
    const ids = JSON.parse(localStorage.getItem('s19_autosaved') || '[]');
    ids.push(id);
    localStorage.setItem('s19_autosaved', JSON.stringify(ids.slice(-500)));
  } catch { /* storage full or unavailable — the in-memory cache still guards this session */ }
}
function maybeAutosave(m, url) {
  if (!autosaveOn() || !m.id || m.sender === session.phone) return;
  if (m.media_kind !== 'image' && m.media_kind !== 'video') return;
  if (wasAutosaved(m.id)) return;
  markAutosaved(m.id);
  const a = document.createElement('a');
  a.href = url;
  a.download = m.media_name || (m.media_kind === 'video' ? 'video' : 'photo');
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function renderAutosaveRow() {
  $('settings-autosave').textContent = autosaveOn() ? 'On' : 'Off';
}
$('settings-autosave-row').addEventListener('click', () => {
  try { localStorage.setItem('s19_autosave', autosaveOn() ? 'off' : 'on'); } catch { /* storage unavailable */ }
  renderAutosaveRow();
  toast(autosaveOn() ? 'Auto-save on — photos and videos from friends will be saved to your phone' : 'Auto-save off');
});

async function loadMediaInto(div, m) {
  const wrap = div.querySelector('.msg-media');
  if (!wrap) return;
  try {
    let url = mediaCache.get(m.id);
    if (!url) {
      const r = await api('/api/media/' + m.id);
      url = dataUrl(r.mimeType, r.data);
      mediaCache.set(m.id, url);
      addMsgBytes(r.size || 0);
    }
    const kind = m.media_kind;
    if (kind === 'image') {
      wrap.innerHTML = '<img src="' + url + '" alt="Photo">';
      wrap.querySelector('img').addEventListener('click', () => openMediaViewer(url));
    } else if (kind === 'video') {
      wrap.innerHTML = '<video src="' + url + '" controls preload="metadata" playsinline></video>';
    } else if (kind === 'voice') {
      wrap.innerHTML = '<div>🎤 Voice' + (m.media_duration ? ' • ' + fmtCallTime(m.media_duration) : '') + '</div><audio src="' + url + '" controls preload="metadata"></audio>';
    } else {
      wrap.innerHTML = docCardHtml(m, url);
    }
    // Auto-save only photos and videos, only received ones, only once.
    maybeAutosave(m, url);
  } catch {
    wrap.innerHTML = '<div class="media-loading">Didn\'t load — <span class="media-retry">Try again</span></div>';
    wrap.querySelector('.media-retry').addEventListener('click', () => loadMediaInto(div, m));
  }
}
function openMediaViewer(url, kind) {
  const img = $('media-viewer-img');
  const vid = $('media-viewer-video');
  if (kind === 'video') {
    img.classList.add('hidden');
    img.src = '';
    vid.src = url;
    vid.classList.remove('hidden');
  } else {
    vid.pause();
    vid.removeAttribute('src');
    vid.classList.add('hidden');
    img.src = url;
    img.classList.remove('hidden');
  }
  $('media-viewer').classList.remove('hidden');
}
function closeMediaViewer() {
  const vid = $('media-viewer-video');
  vid.pause();
  vid.removeAttribute('src');
  vid.classList.add('hidden');
  $('media-viewer').classList.add('hidden');
  $('media-viewer-img').src = '';
}
$('btn-close-media').addEventListener('click', closeMediaViewer);
$('media-viewer').addEventListener('click', (e) => {
  if (e.target.id === 'media-viewer') closeMediaViewer();
});

// Offline outbox: messages typed without network wait here and send
// themselves as soon as the network returns.
function loadOutbox() {
  try { return JSON.parse(localStorage.getItem('s19_outbox') || '[]'); } catch { return []; }
}
function saveOutbox(o) { localStorage.setItem('s19_outbox', JSON.stringify(o)); }

async function sendMessage() {
  const body = $('chat-input').value.trim();
  if (!body || (!activeChat && !activeGroup)) return;
  $('chat-input').value = '';
  updateMicSend();
  const tempId = Date.now() + '_' + Math.floor(Math.random() * 1000);
  appendMessage({ body, sender: session.phone, created_at: Date.now(), pending: true, tempId, group_id: activeGroup || undefined });
  try {
    let r;
    if (activeGroup) {
      r = await api('/api/groups/' + activeGroup + '/messages', { method: 'POST', body: JSON.stringify({ body }) });
    } else {
      r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ to: activeChat, body }) });
    }
    addMsgBytes(bytesOf(body));
    document.querySelector('[data-id="tmp-' + tempId + '"]')?.remove();
    appendMessage(r.message);
    chatAfterId = Math.max(chatAfterId, r.message.id);
  } catch (e) {
    // Groups have no offline outbox in this build: a failed send just
    // drops the pending bubble and says so.
    if (activeGroup) {
      document.querySelector('[data-id="tmp-' + tempId + '"]')?.remove();
      toast("No connection — try again when you're back online");
      return;
    }
    // A block is final — do NOT park the message in the outbox.
    if (e.message === 'you_blocked' || e.message === 'blocked_by_peer') {
      document.querySelector('[data-id="tmp-' + tempId + '"]')?.remove();
      toast(e.message === 'you_blocked' ? "You've blocked this friend" : 'This friend has blocked you');
      loadChatSettings();
      return;
    }
    const outbox = loadOutbox();
    outbox.push({ to: activeChat, body, tempId, created_at: Date.now() });
    saveOutbox(outbox);
    toast("No connection — message saved, it will send when you're back online");
  }
}
$('btn-send-msg').addEventListener('click', sendMessage);
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMessage(); });

// WhatsApp-style input: the green round button is a mic while the field
// is empty and becomes Send once there is text to send.
const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '😢', '😭', '😡', '😴', '🤔', '😅', '🙂', '😉', '😋', '🥰', '😇', '🤗', '👍', '👎', '🙏', '👏', '💪', '❤️', '💔', '🔥', '🎉', '🎂', '🌹', '⭐', '✨', '💯', '😜', '😝', '🙈', '👀', '💤', '🎶', '⚽', '🏏', '🌙', '☀️'];
function updateMicSend() {
  const hasText = $('chat-input').value.trim().length > 0;
  $('btn-mic').classList.toggle('hidden', hasText);
  $('btn-send-msg').classList.toggle('hidden', !hasText);
}
$('chat-input').addEventListener('input', updateMicSend);
$('btn-emoji').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('emoji-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  if (!panel.children.length) {
    for (const em of EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = em;
      b.addEventListener('click', () => {
        const input = $('chat-input');
        input.setRangeText(em, input.selectionStart, input.selectionEnd, 'end');
        input.focus();
        updateMicSend();
      });
      panel.appendChild(b);
    }
  }
  panel.classList.remove('hidden');
});
$('btn-input-camera').addEventListener('click', () => $('file-image').click());

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
    } catch (e) {
      // A block is final — drop the queued message instead of retrying.
      if (e.message !== 'you_blocked' && e.message !== 'blocked_by_peer') remaining.push(item);
    }
  }
  saveOutbox(remaining);
  if (remaining.length < outbox.length) loadInbox();
}
window.addEventListener('online', () => { toast("You're back online"); flushOutbox(); refreshAll(); });

// ---- media messages (photo / video / voice note / file) ---------------------
// Original quality, always: the file bytes are sent exactly as picked —
// no resize, no re-encode, no compression. The caps exist only to protect
// the 1 GB free storage: photo 10 MB, video 50 MB, voice 10 MB, file 5 MB.
// A file over its cap is rejected with a clear message — never squeezed
// to fit, and never silently degraded on a slow network.
const MEDIA_CAPS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024, voice: 10 * 1024 * 1024, file: 5 * 1024 * 1024 };
const MEDIA_CAP_LABEL = { image: '10 MB', video: '50 MB', voice: '10 MB', file: '5 MB' };
const mediaCache = new Map(); // message id -> data URL (already downloaded)
const pendingMedia = new Map(); // tempId -> { kind, file, fileName, mimeType, duration }

function fmtBytes(n) {
  if (n >= 1024 * 1024) return bn((n / (1024 * 1024)).toFixed(1)) + ' MB';
  if (n >= 1024) return bn(Math.round(n / 1024)) + ' KB';
  return bn(n) + ' B';
}
function dataUrl(mime, b64) { return 'data:' + (mime || 'application/octet-stream') + ';base64,' + b64; }
function mediaLabel(kind, fileName) {
  if (kind === 'image') return '📷 Photo';
  if (kind === 'video') return '🎥 Video';
  if (kind === 'voice') return '🎤 Voice';
  return '📄 ' + (fileName || 'File');
}

$('btn-attach').addEventListener('click', (e) => {
  e.stopPropagation();
  $('attach-menu').classList.toggle('hidden');
  $('chat-menu').classList.add('hidden');
});
$('attach-photo').addEventListener('click', () => { $('attach-menu').classList.add('hidden'); $('file-image').click(); });
$('attach-video').addEventListener('click', () => { $('attach-menu').classList.add('hidden'); $('file-video').click(); });
$('attach-file').addEventListener('click', () => { $('attach-menu').classList.add('hidden'); $('file-any').click(); });
$('file-image').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (!activeChat && !activeGroup) { toast('Open a chat first to send a photo'); return; } sendMediaFile('image', f); });
$('file-video').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendMediaFile('video', f); });
$('file-any').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) sendMediaFile('file', f); });

// Upload with progress (fetch has no upload progress, so XHR). The
// percentage shows in the bubble; on failure the bubble offers a retry —
// the file is NEVER shrunk or re-encoded to make the upload faster.
function uploadMediaXhr(body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/messages/media');
    xhr.setRequestHeader('Content-Type', 'application/json');
    if (session && session.token) xhr.setRequestHeader('Authorization', 'Bearer ' + session.token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 401) { clearSession(); session = null; showScreen('screen-welcome'); return reject(new Error('logged_out')); }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      reject(new Error((data && data.error) || ('http_' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.send(JSON.stringify(body));
  });
}
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('read_failed'));
    r.readAsDataURL(file);
  });
}
async function sendMediaFile(kind, file, durationSec) {
  if (!activeChat && !activeGroup) return;
  const cap = MEDIA_CAPS[kind];
  if (file.size > cap) {
    toast("That file is too big — you can't send more than " + MEDIA_CAP_LABEL[kind] + ' (free storage limit)');
    return;
  }
  const tempId = Date.now() + '_' + Math.floor(Math.random() * 1000);
  pendingMedia.set(tempId, { kind, file, fileName: file.name, mimeType: file.type, duration: durationSec || 0, groupId: activeGroup || 0 });
  const previewUrl = (kind === 'image' || kind === 'video') ? URL.createObjectURL(file) : '';
  appendMessage({
    tempId, sender: session.phone, created_at: Date.now(),
    body: mediaLabel(kind, file.name), media_kind: kind, media_name: file.name,
    media_type: file.type, media_size: file.size, duration: durationSec || 0,
    localPreviewUrl: previewUrl, pending: true, progress: 0, group_id: activeGroup || undefined,
  });
  document.querySelector('[data-id="tmp-' + tempId + '"] .media-retry')
    ?.addEventListener('click', () => uploadPendingMedia(tempId));
  await uploadPendingMedia(tempId);
}
async function uploadPendingMedia(tempId) {
  const p = pendingMedia.get(tempId);
  if (!p || (!activeChat && !p.groupId)) return;
  const el = document.querySelector('[data-id="tmp-' + tempId + '"]');
  const setProgress = (pct, failed) => {
    if (!el) return;
    const bar = el.querySelector('.media-progress > div');
    const lab = el.querySelector('.media-progress-label');
    if (bar) bar.style.width = pct + '%';
    if (lab) lab.textContent = failed ? "Couldn't send — tap below to try again" : 'Uploading… ' + bn(pct) + '%';
    const retry = el.querySelector('.media-retry');
    if (retry) retry.classList.toggle('hidden', !failed);
  };
  try {
    const b64 = await fileToBase64(p.file);
    const uploadBody = {
      mediaKind: p.kind, fileName: p.fileName,
      mimeType: p.mimeType, size: p.file.size, data: b64, duration: p.duration,
      // Idempotency key: if this upload is retried after a lost
      // response, the server returns the row it already stored
      // instead of inserting a second copy of the photo/video/file.
      clientKey: tempId,
    };
    if (p.groupId) uploadBody.groupId = p.groupId;
    else uploadBody.to = activeChat;
    const r = await uploadMediaXhr(uploadBody, (pct) => setProgress(pct, false));
    addMsgBytes(p.file.size);
    pendingMedia.delete(tempId);
    el?.remove();
    appendMessage({ ...r.message, localDataUrl: dataUrl(p.mimeType, b64), duration: p.duration });
    chatAfterId = Math.max(chatAfterId, r.message.id);
  } catch (e) {
    if (e.message === 'file_too_big') {
      el?.remove();
      pendingMedia.delete(tempId);
      toast("That file is too big — you can't send more than " + MEDIA_CAP_LABEL[p.kind]);
    } else if (e.message === 'you_blocked') {
      el?.remove();
      pendingMedia.delete(tempId);
      toast("You've blocked this friend");
      loadChatSettings();
    } else if (e.message === 'blocked_by_peer') {
      el?.remove();
      pendingMedia.delete(tempId);
      toast('This friend has blocked you');
      loadChatSettings();
    } else {
      setProgress(0, true); // keep the bubble with a retry link
    }
  }
}

// ---- voice messages (record in the app) -------------------------------------
// A voice MESSAGE is not a voice call: it records with MediaRecorder at
// good quality (128 kbps, no low-bitrate crush) and sends as a media
// message, playable in the chat with its duration shown.
let mediaRecorder = null;
let recChunks = [];
let recStartAt = 0;
let recTimerId = null;
async function startVoiceRec() {
  if (mediaRecorder && mediaRecorder.state === 'recording') return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('Microphone permission needed — tap Allow in the browser');
    return;
  }
  try {
    mediaRecorder = new MediaRecorder(stream, { audioBitsPerSecond: 128000 });
  } catch {
    mediaRecorder = new MediaRecorder(stream);
  }
  // Capture the MIME type NOW, in a local: stopVoiceRec() clears the
  // global mediaRecorder as soon as stop() is called, and onstop fires
  // asynchronously afterwards — reading mediaRecorder.mimeType there
  // threw (null) and the voice note was never sent at all.
  const recMimeType = mediaRecorder.mimeType || 'audio/webm';
  recChunks = [];
  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(recChunks, { type: recMimeType });
    const secs = Math.max(1, Math.round((Date.now() - recStartAt) / 1000));
    if (blob.size > 0) {
      const file = new File([blob], 'voice-' + Date.now() + '.webm', { type: blob.type });
      sendMediaFile('voice', file, secs);
    }
  };
  mediaRecorder.start();
  recStartAt = Date.now();
  $('voice-rec-bar').classList.remove('hidden');
  $('voice-rec-time').textContent = '00:00';
  recTimerId = setInterval(() => {
    $('voice-rec-time').textContent = fmtCallTime(Math.floor((Date.now() - recStartAt) / 1000));
  }, 500);
}
$('attach-voice').addEventListener('click', () => { $('attach-menu').classList.add('hidden'); startVoiceRec(); });
$('btn-mic').addEventListener('click', startVoiceRec);
function stopVoiceRec(send) {
  if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
  $('voice-rec-bar').classList.add('hidden');
  if (!mediaRecorder) return;
  if (send) {
    if (mediaRecorder.state === 'recording') mediaRecorder.stop();
  } else {
    mediaRecorder.onstop = null; // cancel: do not send the recording
    if (mediaRecorder.state === 'recording') mediaRecorder.stop();
    if (mediaRecorder.stream) mediaRecorder.stream.getTracks().forEach((t) => t.stop());
  }
  mediaRecorder = null;
}
$('btn-voice-stop').addEventListener('click', () => stopVoiceRec(true));
$('btn-voice-cancel').addEventListener('click', () => stopVoiceRec(false));

// ---- polling (pauses when hidden / offline) -------------------------------------
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (document.hidden || !navigator.onLine) return; // save data + battery
    loadInbox();
    if (activeChat) fetchChatMessages();
    if (activeGroup) fetchGroupMessages();
  }, 3000);
}
async function refreshAll() {
  await loadInbox();
  if (activeChat) fetchChatMessages();
  if (activeGroup) fetchGroupMessages();
}

// ---- web push notifications ---------------------------------------------------
// After login, this device subscribes for push notifications, so a call or
// a message can arrive even when the app is closed and the screen is off
// (data/WiFi on) — like WhatsApp. The notification itself never carries a
// message text, only the sender's name. If the user says no (or the
// browser does not support push), nothing breaks: the app keeps polling
// exactly as before, and calls/messages arrive while the app is open.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
let pushSetupDone = false;
async function setupPushNotifications() {
  if (pushSetupDone) return;
  pushSetupDone = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission === 'denied') return; // user said no — respect it
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (Notification.permission === 'granted') {
      // Already allowed earlier: just (re)subscribe on this login.
      await subscribePush(reg);
      return;
    }
    // "পরে" বললে ২৪ ঘণ্টা আর জিজ্ঞেস করবে না।
    const laterAt = Number(localStorage.getItem('s19_push_later_at') || 0);
    if (laterAt && Date.now() - laterAt < 24 * 60 * 60 * 1000) return;
    // First explain in-app (Bengali) why notifications are needed, then
    // ask the browser permission from the Allow button's own tap.
    $('push-dialog').classList.remove('hidden');
    $('btn-push-allow').addEventListener('click', async () => {
      $('push-dialog').classList.add('hidden');
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') await subscribePush(reg);
      } catch { /* optional — polling keeps working */ }
    }, { once: true });
    $('btn-push-later').addEventListener('click', () => {
      localStorage.setItem('s19_push_later_at', String(Date.now()));
      $('push-dialog').classList.add('hidden');
    }, { once: true });
  } catch { /* notifications are optional — polling keeps working */ }
}
async function subscribePush(reg) {
  const keyRes = await api('/api/push/vapid-public-key');
  const publicKey = keyRes && keyRes.publicKey;
  if (!publicKey) return; // push is not configured on the server
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }
  await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub }) });
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
let callIsVideo = false; // this call carries a camera picture
let facingMode = 'user'; // front camera first; 🔄 flips to the back one
let camOn = true;
let callConnected = false; // true once media actually connects (ICE / answer)
let iceRestarts = 0;
let pendingOffer = null;
const MAX_ICE_RESTARTS = 3;

// ---- ringtone (WebAudio, no audio file) -------------------------------------
// A short ORIGINAL melody, synthesized — never a copied ringtone file.
// The same tune rings on BOTH sides, at two volumes: the CALLER hears a
// soft, quiet ringback while "ডাকছে…", the CALLEE hears the full, louder
// ringtone when the call arrives. Browsers block audio without a user
// gesture: the caller taps the call button (a gesture, fine), but an
// incoming call only arrives through a poll, so the AudioContext is also
// created on the first tap anywhere in the app — then it is already
// running when a call comes in. If playback is still blocked, everything
// here fails silently and the call works exactly as before, just without
// sound.
// The melody — a gentle original arc (E–G–A–C–A–G–E–D, ~3.5 s a loop):
// each note is a soft sine with a warm triangle overtone and a quick
// fade-in/out envelope, so it sounds like a phone ring, not a beep.
const RING_MELODY = [
  [659.25, 0.30], [783.99, 0.30], [880.00, 0.30], [1046.50, 0.42],
  [880.00, 0.30], [783.99, 0.30], [659.25, 0.30], [587.33, 0.42],
];
const RING_PAUSE = 0.9; // silence between loops (seconds)
const RING_VOL = { soft: 0.05, full: 0.22 }; // caller ringback / callee ringtone
let ringCtx = null;
let ringGain = null;
let ringTimerId = null;
let ringMode = null;
function ensureRingAudio() {
  try {
    if (!ringCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ringCtx = new AC();
      ringGain = ringCtx.createGain();
      ringGain.gain.value = 1;
      ringGain.connect(ringCtx.destination);
    }
    if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
    return true;
  } catch { return false; }
}
function ringNote(freq, startAt, dur, peak) {
  try {
    const o1 = ringCtx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = freq;
    const o2 = ringCtx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq;
    const g = ringCtx.createGain();
    g.gain.setValueAtTime(0, startAt);
    g.gain.linearRampToValueAtTime(peak, startAt + 0.03);
    g.gain.setValueAtTime(peak, startAt + Math.max(0.05, dur - 0.06));
    g.gain.linearRampToValueAtTime(0, startAt + dur);
    const g2 = ringCtx.createGain();
    g2.gain.value = 0.35; // quiet warm overtone, same pitch
    o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(ringGain);
    o1.start(startAt); o2.start(startAt);
    o1.stop(startAt + dur + 0.05); o2.stop(startAt + dur + 0.05);
  } catch { /* no sound, call still works */ }
}
function ringPhrase() {
  try {
    if (!ringCtx || !ringGain) return;
    if (ringGain.gain.value === 0) ringGain.gain.setTargetAtTime(1, ringCtx.currentTime, 0.02);
    const peak = RING_VOL[ringMode] || RING_VOL.full;
    let t = ringCtx.currentTime + 0.05;
    for (const [freq, dur] of RING_MELODY) { ringNote(freq, t, dur, peak); t += dur; }
  } catch { /* no sound, call still works */ }
}
function startRinging(mode) {
  // mode 'soft' = quiet ringback for the caller, 'full' = loud ringtone
  // for the callee. Anything else (or no argument) rings full.
  const m = mode === 'soft' ? 'soft' : 'full';
  if (ringTimerId && ringMode === m) return; // already ringing this way
  ringMode = m;
  if (!ensureRingAudio()) return;
  if (ringTimerId) { clearInterval(ringTimerId); ringTimerId = null; }
  ringPhrase();
  const loopMs = (RING_MELODY.reduce((s, n) => s + n[1], 0) + RING_PAUSE) * 1000;
  ringTimerId = setInterval(ringPhrase, loopMs);
}
function stopRinging() {
  if (ringTimerId) { clearInterval(ringTimerId); ringTimerId = null; }
  ringMode = null;
  try { if (ringGain && ringCtx) ringGain.gain.setTargetAtTime(0, ringCtx.currentTime, 0.02); } catch {}
}
// First tap anywhere unlocks audio, so a later incoming call can ring even
// though it arrives from a background poll with no gesture of its own.
window.addEventListener('pointerdown', () => { ensureRingAudio(); }, { once: true });

function tuneSdp(sdp) {
  // Opus: maxaveragebitrate=16000, stereo=0, usedtx=1 (DTX: almost no data
  // in silence) + application-specific bandwidth cap b=AS:20.
  // AUDIO IS SACRED: the audio track is capped low and given top
  // priority (see prioritiseCallTracks), so on a weak network the
  // VIDEO softens first — the voice must never break up or drop.
  let out = sdp.replace(/a=fmtp:111[^\r\n]*/g, 'a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=16000');
  if (!/a=fmtp:111/.test(out)) {
    out = out.replace(/(a=rtpmap:111 opus\/48000\/2\r\n)/, '$1a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;stereo=0;maxaveragebitrate=16000\r\n');
  }
  out = out.replace(/(m=audio[^\r\n]*\r\n)/, '$1b=AS:20\r\n');
  // Video: 720p, good quality (~1.5 Mbps cap). The browser adapts below
  // this when the network drops — video first, never the audio.
  out = out.replace(/(m=video[^\r\n]*\r\n)/, '$1b=AS:1500\r\n');
  return out;
}
// Audio first, video second: on a weak network the video encoder must
// soften (lower bitrate / resolution / framerate) before the audio is
// ever starved. The audio sender gets top priority; the video sender
// gets a 1.5 Mbps ceiling and a balanced degradation preference.
function prioritiseCallTracks(pc) {
  try {
    for (const s of pc.getSenders()) {
      if (!s.track) continue;
      const params = s.getParameters() || {};
      const enc = (params.encodings && params.encodings[0]) || {};
      if (s.track.kind === 'audio') {
        s.setParameters({ ...params, encodings: [{ ...enc, priority: 'high', networkPriority: 'high' }] }).catch(() => {});
      } else if (s.track.kind === 'video') {
        s.setParameters({ ...params, encodings: [{ ...enc, maxBitrate: 1500000, priority: 'medium', networkPriority: 'medium', degradationPreference: 'balanced' }] }).catch(() => {});
      }
    }
  } catch { /* priorities are best-effort — the call works without them */ }
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
    // TCP fallback: if the operator blocks UDP, media can still flow
    // over TURN/TCP on 443 (slower, but a call beats no call).
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject', credential: 'openrelayproject' },
  ] });
  peer.onicecandidate = (e) => {
    if (e.candidate && callPeer) {
      api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: callPeer, kind: 'ice', payload: e.candidate }) }).catch(() => {});
    }
  };
  peer.ontrack = (e) => {
    const stream = e.streams[0];
    if (!stream) return;
    if (e.track.kind === 'video') {
      // The friend's camera: full-screen remote video. The element is
      // muted — its sound is not needed, the voice comes from the audio
      // element below. A muted video is allowed to autoplay, so it
      // renders even when the call took long to connect.
      const v = $('remote-video');
      v.muted = true;
      v.srcObject = stream;
    } else {
      const a = $('remote-audio');
      a.srcObject = stream;
      a.muted = false;
      a.volume = 1;
    }
    resumeRemotePlayback();
  };
  peer.oniceconnectionstatechange = () => {
    const st = peer.iceConnectionState;
    if ((st === 'disconnected' || st === 'failed') && iceRestarts < MAX_ICE_RESTARTS) {
      iceRestarts++;
      try { peer.restartIce(); } catch { /* ignore */ }
    }
    if (st === 'connected' || st === 'completed') {
      startCallTimer();
      // The call is really connected now — say so, in case the timer
      // started earlier on the answer signal alone.
      $('call-status').textContent = callIsVideo ? 'Video call in progress…' : 'On call…';
    } else if (st === 'failed' && callConnected) {
      $('call-status').textContent = 'Connection lost — try again';
    }
  };
  return peer;
}

// Mobile Chrome blocks play() on an element with sound once the tap
// that started the call is more than a few seconds old (autoplay
// policy). A video call takes longer than that to connect, so the first
// play() often fails silently: the timer runs, the local (muted)
// preview works, but the friend's video stays black and silent. So
// playback is re-attempted on every tap on the call screen and every
// 2 seconds while the call runs, until both elements are playing.
let playRetryId = null;
function resumeRemotePlayback() {
  const v = $('remote-video');
  if (v && v.srcObject && v.paused) v.play().catch(() => {});
  const a = $('remote-audio');
  if (a && a.srcObject && a.paused) a.play().catch(() => {});
}
function startPlayRetry() {
  if (playRetryId) return;
  playRetryId = setInterval(resumeRemotePlayback, 2000);
}
function stopPlayRetry() {
  if (playRetryId) { clearInterval(playRetryId); playRetryId = null; }
}
function fmtCallTime(s) {
  const m = Math.floor(s / 60), ss = s % 60;
  return bn(String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0'));
}
function startCallTimer() {
  if (callTimerId || !callStartAt) return;
  callConnected = true;
  startPlayRetry(); // keep re-trying play() until the remote media renders
  callTimerId = setInterval(() => {
    callSeconds = Math.floor((Date.now() - callStartAt) / 1000);
    $('call-timer').textContent = fmtCallTime(callSeconds);
  }, 1000);
}
function showCallOverlay(name, status, incoming, isVideo) {
  $('call-peer-name').textContent = name;
  $('call-status').textContent = status;
  $('call-timer').textContent = '00:00';
  $('btn-mute').textContent = '🎙️';
  $('btn-mute').classList.remove('muted');
  // Video call: the friend's video fills the screen, my preview sits
  // small in the corner, and the camera buttons appear. Audio calls
  // look exactly as before.
  $('call-overlay').classList.toggle('video', Boolean(isVideo));
  $('call-video-wrap').classList.toggle('hidden', !isVideo);
  if (isVideo) {
    // New call: the own-camera preview starts back in its default
    // corner (a drag from the last call does not carry over).
    const lv = $('local-video');
    lv.style.left = ''; lv.style.top = ''; lv.style.right = ''; lv.style.bottom = '';
  }
  $('btn-cam-toggle').classList.toggle('hidden', !isVideo);
  $('btn-cam-switch').classList.toggle('hidden', !isVideo);
  $('btn-cam-toggle').textContent = '📷';
  $('btn-cam-toggle').title = 'Turn camera off';
  camOn = true;
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
  if (incoming) ans.textContent = isVideo ? '🎥' : '📞'; // answer a video call with the video button
  ans.classList.toggle('hidden', !incoming);
  $('btn-mute').classList.toggle('hidden', Boolean(incoming));
  $('call-overlay').classList.remove('hidden');
}
function hideCallOverlay() {
  stopRinging();
  stopPlayRetry();
  $('call-overlay').classList.add('hidden');
  $('call-overlay').classList.remove('video');
  $('call-video-wrap').classList.add('hidden');
  if (callTimerId) { clearInterval(callTimerId); callTimerId = null; }
}
function stopCallTracks() {
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  if (pc) { pc.close(); pc = null; }
  $('remote-audio').srcObject = null;
  $('remote-video').srcObject = null;
  $('local-video').srcObject = null;
  callIsVideo = false;
}
function logCallHistory(peer, dir, seconds, answered = true) {
  const h = JSON.parse(localStorage.getItem('s19_call_history') || '[]');
  h.unshift({ peer, dir, seconds, answered: Boolean(answered), at: Date.now() });
  localStorage.setItem('s19_call_history', JSON.stringify(h.slice(0, 20)));
}

async function startCall(peer, name, isVideo) {
  if (pc) { toast('A call is already in progress'); return; }
  // Video quality FIRST (Bijoy's rule): 720p when the connection
  // allows it, a clean picture — never blurry. MB does not matter.
  // Audio stays sacred even on a weak network: Opus FEC/DTX + top
  // sender priority (see prioritiseCallTracks) — the video softens
  // first, the voice never breaks up.
  const constraints = isVideo
    ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode } }
    : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch {
    toast(isVideo ? 'Camera and microphone permission needed — tap Allow in the browser, then try again'
      : 'Microphone permission needed — tap Allow in the browser, then try again');
    return;
  }
  callPeer = peer;
  callDir = 'out';
  callIsVideo = Boolean(isVideo);
  iceRestarts = 0;
  callStartAt = 0;
  callSeconds = 0;
  callConnected = false;
  pc = makePc();
  localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
  prioritiseCallTracks(pc);
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: Boolean(isVideo) });
  offer.sdp = tuneSdp(offer.sdp);
  await pc.setLocalDescription(offer);
  // video:true tells the callee this is a VIDEO call, so their incoming
  // screen shows it and opens the video UI when they answer.
  await api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: peer, kind: 'offer', payload: { sdp: offer.sdp, type: offer.type, video: Boolean(isVideo) } }) });
  showCallOverlay(name || displayId(peer), 'Ringing…', false, isVideo);
  if (isVideo) $('local-video').srcObject = localStream; // my own preview, small in the corner
  startRinging('soft'); // caller hears a quiet ringback while waiting
  callStartAt = Date.now();
}
async function answerCall() {
  if (!pendingOffer || !callPeer) return;
  const isVideo = Boolean(pendingOffer.video);
  const constraints = isVideo
    ? { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode } }
    : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch { toast(isVideo ? 'Camera and microphone permission needed' : 'Microphone permission needed'); return; }
  try {
    iceRestarts = 0;
    callDir = 'in';
    callIsVideo = isVideo;
    callConnected = false;
    callStartAt = Date.now();
    pc = makePc();
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    prioritiseCallTracks(pc);
    // pendingOffer is the whole { sdp, type } payload — RTCSessionDescription
    // needs that dictionary, not just the sdp string. Passing the string
    // threw a TypeError in Chrome, so the answer signal never went out:
    // the caller kept ringing forever and no voice ever flowed.
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    const answer = await pc.createAnswer();
    answer.sdp = tuneSdp(answer.sdp);
    await pc.setLocalDescription(answer);
    await api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: callPeer, kind: 'answer', payload: { sdp: answer.sdp, type: answer.type, video: isVideo } }) });
    pendingOffer = null;
    stopRinging();
    showCallOverlay($('call-peer-name').textContent, isVideo ? 'Video call in progress…' : 'On call…', false, isVideo);
    if (isVideo) $('local-video').srcObject = localStream;
    startCallTimer();
  } catch (e) {
    // Any step failing here used to die silently and leave the caller
    // ringing forever. Clean up and tell the user in Bengali instead.
    console.error('[answerCall]', e && e.message);
    stopCallTracks();
    hideCallOverlay();
    pendingOffer = null;
    callPeer = null;
    callStartAt = 0;
    callSeconds = 0;
    callConnected = false;
    toast("Couldn't answer the call — check your connection and try again");
  }
}
async function endCall(sendSignal = true) {
  if (sendSignal && callPeer) {
    api('/api/calls/signal', { method: 'POST', body: JSON.stringify({ to: callPeer, kind: 'end', payload: {} }) }).catch(() => {});
  }
  // Log EVERY ended call, including 0-second ones nobody answered — before
  // this only calls longer than 0 s were logged, so a call Bijoy made that
  // nobody picked up left no trace anywhere. `callPeer` is set only while
  // a call is in progress, so a stray or double endCall cannot log twice.
  // `answered` comes from the connection flag, not just the timer: a call
  // answered and ended within a second still counts as answered.
  if (callPeer) {
    const answered = callConnected || callSeconds > 0;
    if (callSeconds > 0) addCallSeconds(callSeconds, callIsVideo);
    logCallHistory(callPeer, callDir, callSeconds, answered);
  }
  stopCallTracks();
  hideCallOverlay();
  pendingOffer = null;
  callPeer = null;
  callStartAt = 0;
  callSeconds = 0;
  callConnected = false;
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
$('btn-video-call-peer').addEventListener('click', () => {
  if (activeChat) startCall(activeChat, $('chat-peer-name').textContent, true);
});
// Any tap on the call screen is a fresh user gesture — use it to
// (re)start the remote video/audio playback if autoplay blocked it.
$('call-overlay').addEventListener('pointerdown', resumeRemotePlayback);

// The small own-camera preview can be dragged anywhere on the call
// screen (like WhatsApp): press it and slide it — it stays where you
// leave it for this call.
const localVideoEl = $('local-video');
let dragLocal = null;
localVideoEl.addEventListener('pointerdown', (e) => {
  const wrap = $('call-video-wrap').getBoundingClientRect();
  const r = localVideoEl.getBoundingClientRect();
  dragLocal = { dx: e.clientX - r.left, dy: e.clientY - r.top, wrap };
  // Switch from the CSS corner (right/bottom) to explicit left/top so
  // the preview follows the finger.
  localVideoEl.style.left = (r.left - wrap.left) + 'px';
  localVideoEl.style.top = (r.top - wrap.top) + 'px';
  localVideoEl.style.right = 'auto';
  localVideoEl.style.bottom = 'auto';
  try { localVideoEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
});
localVideoEl.addEventListener('pointermove', (e) => {
  if (!dragLocal) return;
  const w = dragLocal.wrap.width, h = dragLocal.wrap.height;
  const vw = localVideoEl.offsetWidth, vh = localVideoEl.offsetHeight;
  let x = e.clientX - dragLocal.wrap.left - dragLocal.dx;
  let y = e.clientY - dragLocal.wrap.top - dragLocal.dy;
  x = Math.max(8, Math.min(x, w - vw - 8));
  y = Math.max(8, Math.min(y, h - vh - 8));
  localVideoEl.style.left = x + 'px';
  localVideoEl.style.top = y + 'px';
});
const endLocalDrag = () => { dragLocal = null; };
localVideoEl.addEventListener('pointerup', endLocalDrag);
localVideoEl.addEventListener('pointercancel', endLocalDrag);
$('btn-cam-toggle').addEventListener('click', () => {
  if (!localStream) return;
  const vt = localStream.getVideoTracks()[0];
  if (!vt) return;
  camOn = !camOn;
  vt.enabled = camOn;
  $('btn-cam-toggle').textContent = camOn ? '📷' : '📵';
  $('btn-cam-toggle').title = camOn ? 'Turn camera off' : 'Turn camera on';
  toast(camOn ? 'Camera is on' : 'Camera off — only your voice will go through');
});
$('btn-cam-switch').addEventListener('click', async () => {
  if (!localStream || !pc || !callIsVideo) return;
  const next = facingMode === 'user' ? 'environment' : 'user';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: next }, audio: false,
    });
    const newTrack = stream.getVideoTracks()[0];
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) { oldTrack.stop(); localStream.removeTrack(oldTrack); }
    localStream.addTrack(newTrack);
    facingMode = next;
    $('local-video').srcObject = localStream;
  } catch {
    toast("Couldn't switch the camera — check permission and try again");
  }
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
          const isVideo = Boolean(s.payload && s.payload.video);
          showCallOverlay(name || displayId(s.from), isVideo ? 'Incoming video call…' : 'Incoming call…', true, isVideo);
          // A muted chat gets no sound — the overlay still shows, so the
          // call can be answered if the user sees it. If the settings
          // fetch fails, ring anyway: better a sound than a missed call.
          api('/api/chat-settings?with=' + encodeURIComponent(s.from)).then((st) => {
            if (!st.muted) startRinging('full'); // callee hears the full ringtone
          }).catch(() => startRinging('full'));
        }
        continue;
      }
      if (s.kind === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(s.payload));
        callStartAt = callStartAt || Date.now();
        $('call-status').textContent = 'On call…';
        stopRinging();
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
    list.innerHTML = '<div class="empty-note">No one added yet.<br>Add a number or Gmail with the + button in the Chats tab.</div>';
  }
  for (const p of peers) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">' + avatarHtml(p.name, p.phone, p.avatar) + '</div>' +
      '<div class="chat-row-body"><div class="chat-row-name">' + escapeHtml(peerName(p)) + '</div>' +
      '<div class="chat-row-msg">' + displayId(p.phone) + '</div></div>' +
      '<button class="call-btn" title="Call">📞</button>';
    row.querySelector('.call-btn').addEventListener('click', (e) => { e.stopPropagation(); startCall(p.phone, peerName(p)); });
    row.addEventListener('click', () => openChat(p.phone, p.name));
    list.appendChild(row);
  }
  const hist = $('call-history');
  hist.innerHTML = '';
  const h = JSON.parse(localStorage.getItem('s19_call_history') || '[]');
  if (!h.length) hist.innerHTML = '<div class="empty-note">No calls yet.</div>';
  for (const item of h) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    // Old entries have no `answered` field — they were only logged when the
    // call lasted > 0 s, so they were answered by definition.
    const answered = item.answered !== undefined ? item.answered : item.seconds > 0;
    const dirLabel = item.dir === 'out' ? 'Outgoing call' : 'Incoming call';
    const statusLabel = answered ? fmtCallTime(item.seconds)
      : (item.dir === 'out' ? 'Not answered' : 'Missed call');
    row.innerHTML = '<div class="avatar">📞</div><div class="chat-row-body">' +
      '<div class="chat-row-name">' + displayId(item.peer) + '</div>' +
      '<div class="chat-row-msg">' + dirLabel + ' • ' + statusLabel + '</div></div>' +
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
      '<div class="chat-row-name">My status</div>' +
      '<div class="chat-row-msg">' + (mine.length ? escapeHtml(mine[0].text) : 'Lasts 24 hours') + '</div></div>';
    addRow.addEventListener('click', () => { if (mine.length) showStatus(mine[0]); });
    list.appendChild(addRow);
    for (const s of others) {
      const row = document.createElement('div');
      row.className = 'status-row';
      row.innerHTML = '<div class="status-ring"><div class="avatar">' + avatarHtml(s.name, s.phone, s.avatar) + '</div></div>' +
        '<div class="chat-row-body"><div class="chat-row-name">' + escapeHtml(s.name || displayId(s.phone)) + '</div>' +
        '<div class="chat-row-msg">' + fmtTime(s.created_at) + '</div></div>';
      row.addEventListener('click', () => showStatus(s));
      list.appendChild(row);
    }
    if (!others.length) {
      const d = document.createElement('div');
      d.className = 'empty-note';
      d.textContent = 'No status from friends.';
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
    del.textContent = 'Delete status';
    del.addEventListener('click', async () => {
      try {
        await api('/api/statuses/' + viewingStatus.id, { method: 'DELETE' });
        $('status-viewer').classList.add('hidden');
        loadUpdates();
        toast('Status deleted');
      } catch { toast("Couldn't delete"); }
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
    toast('Status posted');
  } catch { toast("Couldn't post the status"); }
});

// ---- updates: channels ------------------------------------------------------------
let openChannelId = null;
async function loadChannels() {
  try {
    const r = await api('/api/channels?q=' + encodeURIComponent(channelSearch));
    const list = $('channel-list');
    list.innerHTML = '';
    if (!r.channels.length) {
      list.innerHTML = '<div class="empty-note">No channels.<br>Create a new channel, or search by name.</div>';
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
        (c.followed ? '' : '<button class="btn-primary btn-small">Follow</button>');
      const followBtn = row.querySelector('.btn-primary');
      if (followBtn) {
        followBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try { await api('/api/channels/' + c.id + '/follow', { method: 'POST' }); loadChannels(); } catch { toast("Couldn't follow"); }
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
    $('new-channel-error').textContent = 'Type the channel name';
    $('new-channel-error').classList.remove('hidden');
    return;
  }
  try {
    const r = await api('/api/channels', { method: 'POST', body: JSON.stringify({ name, description }) });
    $('new-channel-dialog').classList.add('hidden');
    loadChannels();
    openChannel(r.channel);
  } catch (e) {
    $('new-channel-error').textContent = e.message === 'name_taken' ? 'A channel with this name already exists — choose another name' : "Couldn't create it";
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
    if (!r.posts.length) box.innerHTML = '<div class="empty-note">No updates yet.</div>';
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
    toast(e.message === 'not_owner' ? 'Only the owner can post' : "Couldn't post");
  }
});

// ---- admin panel ---------------------------------------------------------------
// Everything here is admin-only on the server (403 for non-admins). The
// tab itself is hidden unless /api/me said this user is an admin.
async function loadAdmin() {
  if (!isAdminUser) return;
  try {
    const [stats, users, channels, settings] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/users'),
      api('/api/admin/channels'),
      api('/api/admin/settings'),
    ]);
    $('admin-stat-users').textContent = bn(stats.users);
    $('admin-stat-messages').textContent = bn(stats.messages);
    $('admin-stat-calls').textContent = bn(stats.calls);
    renderAdminUsers(users.users || []);
    renderAdminChannels(channels.channels || []);
    $('admin-banner-input').value = settings.banner || '';
  } catch { toast("Couldn't load admin info"); }
}
function renderAdminUsers(users) {
  const list = $('admin-users');
  list.innerHTML = '';
  if (!users.length) {
    list.innerHTML = '<div class="empty-note">No users.</div>';
    return;
  }
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">' + avatarHtml(u.name, u.phone, u.avatar) + '</div>' +
      '<div class="chat-row-body">' +
        '<div class="chat-row-name">' + escapeHtml(u.name || displayId(u.phone)) + '</div>' +
        '<div class="chat-row-msg">' + displayId(u.phone) + ' • ' + fmtDate(u.created_at) +
        (u.blocked ? ' • ⛔ Blocked' : '') + '</div></div>' +
      '<button class="btn-link" style="color:#D32F2F">' + (u.blocked ? 'Unblock' : 'Block') + '</button>';
    row.querySelector('.btn-link').addEventListener('click', async () => {
      try {
        await api('/api/admin/users/block', { method: 'POST', body: JSON.stringify({ phone: u.phone, blocked: !u.blocked }) });
        toast(u.blocked ? 'Unblocked' : 'Blocked');
        loadAdmin();
      } catch (e) {
        toast(e.message === 'cannot_block_admin' ? "You can't block an admin" : "Couldn't change it");
      }
    });
    list.appendChild(row);
  }
}
function renderAdminChannels(channels) {
  const list = $('admin-channels');
  list.innerHTML = '';
  if (!channels.length) {
    list.innerHTML = '<div class="empty-note">No channels.</div>';
    return;
  }
  for (const c of channels) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">📢</div>' +
      '<div class="chat-row-body">' +
        '<div class="chat-row-name">' + escapeHtml(c.name) + '</div>' +
        '<div class="chat-row-msg">' + escapeHtml(c.owner_phone || '') + ' • ' + bn(c.followers || 0) + ' followers</div></div>' +
      '<button class="btn-link" style="color:#D32F2F">Delete</button>';
    row.querySelector('.btn-link').addEventListener('click', async () => {
      if (!confirm('"' + c.name + '" — delete this channel?')) return;
      try {
        await api('/api/admin/channels/' + c.id, { method: 'DELETE' });
        toast('Channel deleted');
        loadAdmin();
        loadChannels();
      } catch { toast("Couldn't delete"); }
    });
    list.appendChild(row);
  }
}
$('btn-admin-broadcast').addEventListener('click', async () => {
  const text = $('admin-broadcast-input').value.trim();
  if (!text) { toast('Write the announcement text'); return; }
  try {
    const r = await api('/api/admin/broadcast', { method: 'POST', body: JSON.stringify({ text }) });
    $('admin-broadcast-input').value = '';
    toast('Announcement sent — to ' + bn(r.recipients) + ' people');
    loadAdmin();
  } catch { toast("Couldn't send the announcement"); }
});
$('btn-admin-save-banner').addEventListener('click', async () => {
  const banner = $('admin-banner-input').value.trim();
  try {
    await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({ banner }) });
    toast(banner ? 'Banner saved' : 'Banner removed');
  } catch { toast("Didn't save"); }
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
  applyTheme();
  fillCountrySelect($('country-select'), localStorage.getItem('s19_last_dial') || '+880');
  // Welcome-screen banner, set by the admin from the Admin panel.
  // Public endpoint, no login needed; empty = hidden.
  fetch('/api/banner').then((r) => r.json()).then((d) => {
    if (d && d.banner) {
      const el = $('welcome-banner');
      el.textContent = d.banner;
      el.classList.remove('hidden');
    }
  }).catch(() => {});
  if (session && session.token) {
    // Stay logged in on this device; only the name step is needed if the
    // profile was never finished.
    if (session.name) enterApp();
    else showScreen('screen-name');
  } else {
    showScreen('screen-welcome');
  }
})();
