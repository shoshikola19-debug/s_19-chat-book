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
  // Opt-in timeout (ms): abort a hung request so the caller can fail
  // fast and retry instead of waiting forever. Default 0 = no timeout.
  const timeoutMs = opts.timeoutMs || 0;
  const fetchOpts = { ...opts, headers };
  delete fetchOpts.timeoutMs;
  let ctrl = null;
  let timer = null;
  if (timeoutMs > 0) {
    ctrl = new AbortController();
    fetchOpts.signal = ctrl.signal;
    timer = setTimeout(() => ctrl.abort(), timeoutMs);
  }
  try {
    const res = await fetch(path, fetchOpts);
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
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  // The Storage and data sub-screen shows the same numbers.
  const t2 = $('meter2-total');
  if (t2) {
    t2.textContent = $('meter-total').textContent;
    $('meter2-msg').textContent = $('meter-msg').textContent;
    $('meter2-call').textContent = $('meter-call').textContent;
    $('meter2-vcall').textContent = $('meter-vcall').textContent;
    $('meter2-fill').style.width = $('meter-fill').style.width;
  }
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
  // Both theme-color metas (the light/dark media pair in index.html)
  // are set to the app theme, so the strip follows the app theme even
  // when it differs from the OS preference. Before JS runs, the pair
  // gives the OS-correct colour on its own.
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) =>
    m.setAttribute('content', t.mode === 'dark' ? '#0B141A' : '#FFFFFF'));
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

// ---- Accessibility (Settings) ------------------------------------------------
// Per-device, applied on load: Larger text bumps the text that matters,
// Reduce motion turns off animations. Both are just classes on <html>.
function loadA11y() {
  try { return JSON.parse(localStorage.getItem('s19_a11y') || '{}'); }
  catch { return {}; }
}
function applyA11y() {
  const a = loadA11y();
  document.documentElement.classList.toggle('large-text', !!a.largeText);
  document.documentElement.classList.toggle('reduce-motion', !!a.reduceMotion);
}
applyA11y();

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
    // The Storage and data sub-screen shows the same numbers.
    const u2 = $('storage2-used');
    if (u2) {
      u2.textContent = $('storage-used').textContent;
      $('storage2-count').textContent = $('storage-count').textContent;
      $('storage2-fill').style.width = $('storage-fill').style.width;
    }
  } catch { /* offline — keep the last numbers */ }
}

// ---- screens ----------------------------------------------------------------
const SCREENS = ['screen-welcome', 'screen-phone', 'screen-code', 'screen-name', 'screen-app', 'screen-chat', 'screen-channel'];
function showScreen(id) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', s !== id);
  if (id === 'screen-app') renderMeter();
}

// ---- Back navigation (Android / system back button) -----------------------
// The app is a single page, so without history entries the system back
// button exits the app from anywhere — even from inside a chat. Every
// full-screen layer and modal dialog pushes ONE history entry when it
// opens; a back press (popstate) closes only the topmost layer, one
// press at a time. At the inbox the stack is empty, so back exits the
// app as normal — no entry is ever pushed at load.
// A layer closed programmatically (its action finished, or another
// layer replaced it) is marked "dead" in the stack, but its history
// entry stays put: the popstate handler skips dead entries by chaining
// one more history.back(), so a dead entry never swallows a visible
// back press. Closers must be idempotent — they can run twice.
const backStack = []; // {id, close, dead} in open order, mirroring history
function pushBackLayer(id, close) {
  dismissBackLayer(id); // re-opening must not stack a second entry
  history.pushState({ s19layer: id }, '');
  backStack.push({ id, close, dead: false });
}
function dismissBackLayer(id) {
  // Programmatic close: mark the entry dead (its history entry stays
  // and is skipped by the popstate handler). It does NOT run the
  // closer — the caller hides the layer itself. (Running the closer
  // here would recurse, since closers call this to mark themselves.)
  const e = backStack.find((x) => x.id === id);
  if (!e) return false;
  e.dead = true;
  return true;
}
function goBackLayer(id) {
  // In-app back / close button for layer `id`: let the system history
  // do the closing when this layer is the top live one, so no stale
  // entry remains. Otherwise dismiss it directly.
  for (let i = backStack.length - 1; i >= 0; i--) {
    const e = backStack[i];
    if (e.dead) continue;
    if (e.id === id) { history.back(); return; }
    break;
  }
  dismissBackLayer(id);
}
window.addEventListener('popstate', () => {
  if (!backStack.length) return; // at/below the base entry: exit as normal
  const top = backStack.pop();
  if (top.dead) { history.back(); return; } // skip it, keep going back
  top.close();
});
// One-line closer for a plain overlay/dialog: hide the element and
// mark its back layer dead. Used both as the registered closer (run by
// popstate) and for programmatic closes.
function hideLayer(elId) { $(elId).classList.add('hidden'); dismissBackLayer(elId); }
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
  // A ?chat=<peer> link (from "Add shortcut") jumps straight into
  // that chat once the app is in.
  handleDeepLink();
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
function closeSettings() {
  $('settings-overlay').classList.add('hidden');
  closeSettingsSubs();
  dismissBackLayer('settings-overlay');
}
function openSettings() {
  if (!myProfile) return;
  $('settings-avatar').innerHTML = avatarHtml(myProfile.name, myProfile.phone, myProfile.avatar);
  $('settings-name').textContent = myProfile.name || '';
  $('settings-about').textContent = myProfile.about || 'Hey there! I am using S_19 CHAT BOOK.';
  $('settings-phone').textContent = displayId(myProfile.phone);
  renderAutosaveRow();
  renderPhotoGuardRow();
  $('settings-overlay').classList.remove('hidden');
  pushBackLayer('settings-overlay', closeSettings);
}
// Inbox header gear: opens Settings directly (the old ⋮ menu only
// ever held Settings, so nothing is lost by removing it).
$('btn-header-settings').addEventListener('click', openSettings);
// Header camera (WhatsApp-style): opens the device camera. The photo
// is then sent to a chat you pick — the inbox itself has no chat open,
// so picking first and sending second is the only honest flow. The
// photo sends at original quality, like every chat photo.
$('btn-header-camera').addEventListener('click', () => $('file-camera').click());
let pendingCameraFile = null;
$('file-camera').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  pendingCameraFile = f;
  const list = $('send-photo-list');
  list.innerHTML = '';
  const addRow = (label, sub, onPick) => {
    const b = document.createElement('button');
    b.className = 'option-btn';
    b.type = 'button';
    b.innerHTML = '<b>' + escapeHtml(label) + '</b>' + (sub ? '<br><small>' + escapeHtml(sub) + '</small>' : '');
    b.addEventListener('click', () => {
      hideLayer('send-photo-dialog');
      onPick();
    });
    list.appendChild(b);
  };
  for (const c of allContacts) addRow(peerName(c), displayId(c.phone), () => {
    openChat(c.phone, c.name);
    if (pendingCameraFile) sendMediaFile('image', pendingCameraFile);
    pendingCameraFile = null;
  });
  for (const g of myGroups) addRow(g.name, 'Group • ' + ((g.members || []).length) + ' members', () => {
    openGroup(g.id, g.name);
    if (pendingCameraFile) sendMediaFile('image', pendingCameraFile);
    pendingCameraFile = null;
  });
  if (!allContacts.length && !myGroups.length) {
    list.innerHTML = '<div class="empty-note">Add a friend first, then take a photo to send them.</div>';
  }
  $('send-photo-dialog').classList.remove('hidden');
  pushBackLayer('send-photo-dialog', () => hideLayer('send-photo-dialog'));
});
$('btn-send-photo-cancel').addEventListener('click', () => {
  pendingCameraFile = null;
  goBackLayer('send-photo-dialog');
});
$('tools-profile-card').addEventListener('click', openSettings);
$('btn-close-settings').addEventListener('click', () => goBackLayer('settings-overlay'));
// Tapping your own photo opens the guarded viewer; tapping the 📷
// badge (or the photo, when none is set yet) opens the picker to
// change it. The global avatar-tap handler below skips this wrap.
$('settings-avatar-wrap').addEventListener('click', (e) => {
  if (e.target.closest('.settings-avatar-camera') || !myProfile.avatar) {
    $('settings-avatar-input').click();
    return;
  }
  openPhotoViewer(myProfile.avatar, myProfile.name);
});
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
  pushBackLayer('edit-field-dialog', () => hideLayer('edit-field-dialog'));
  input.focus();
}
$('settings-name-row').addEventListener('click', () => openEditField('name'));
$('settings-about-row').addEventListener('click', () => openEditField('about'));
$('btn-edit-field-cancel').addEventListener('click', () => goBackLayer('edit-field-dialog'));
$('btn-edit-field-save').addEventListener('click', async () => {
  const v = $('edit-field-input').value.trim();
  if (editFieldKind === 'name' && !v) { toast('Please enter a name'); return; }
  try {
    const body = {};
    body[editFieldKind] = v;
    myProfile = await api('/api/profile', { method: 'POST', body: JSON.stringify(body) });
    renderMyProfile();
    hideLayer('edit-field-dialog');
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
  if (tab === 'chats') loadInbox(); // instant render from the saved inbox cache, then a background refresh
  if (tab === 'updates') loadUpdates();
  if (tab === 'calls') loadCallsTab();
  if (tab === 'tools') { renderMeter(); loadStorage(); }
  if (tab === 'admin') loadAdmin();
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// A contact's photo when they set one, otherwise a WhatsApp-style
// default avatar: a person silhouette in a muted brown circle — the
// same in light and dark mode, in every place an avatar appears
// (inbox, chat header, contact info, group members, status, Settings).
// The avatar is a data URL (no quotes in base64), so it is safe inside
// an <img src="..."> built this way.
function avatarHtml(name, phone, avatar) {
  if (avatar) return '<img src="' + avatar + '" alt="">';
  return '<span class="avatar-default" aria-hidden="true">' +
    '<svg viewBox="0 0 24 24"><path d="M12 12c2.2 0 4-1.8 4-4s-1.8-4-4-4-4 1.8-4 4 1.8 4 4 4zm0 2c-2.7 0-8 1.3-8 4v2h16v-2c0-2.7-5.3-4-8-4z"/></svg></span>';
}
function peerName(c) { return c.name || displayId(c.phone); }

// ---- inbox -------------------------------------------------------------------
let allContacts = [];
// Inbox first-load state: the list must never look silently empty.
// inboxLoaded turns true the first time /api/conversations succeeds;
// until then the list shows "Loading chats…", and once the retries
// below are exhausted it shows a tap-to-retry error row instead. A
// failed fetch is never mistaken for an empty inbox.
let inboxLoaded = false;
let inboxLoading = false;
let inboxLoadFailed = false;
let inboxLoadAttempts = 0;
// Last-seen unread totals, for the new-message beep (null = not yet
// known — the first load never beeps).
let prevUnreadDM = null;
let prevUnreadGroup = null;
let inboxRetryTimer = null;
const INBOX_MAX_RETRIES = 3;
const INBOX_RETRY_DELAY_MS = 3000;
const INBOX_FETCH_TIMEOUT_MS = 30000;
// Instant inbox: WhatsApp shows its saved chat list at once and
// refreshes in the background. After every successful fetch the inbox
// is saved to localStorage — only what the inbox renders (peer, name,
// avatar, preview, time, unread, favorite, mute, missed-call flags;
// groups the same way). On app open the saved list renders
// immediately, before any network call.
const INBOX_CACHE_KEY = 's19_inbox_cache';
const INBOX_CACHE_MAX_ROWS = 100;
let inboxCached = false; // the list on screen comes from the cache
let inboxRefreshFailed = false; // background refresh failed while showing the cache
let groupsLoaded = false;
function saveInboxCache() {
  try {
    let prev = null;
    try { prev = JSON.parse(localStorage.getItem(INBOX_CACHE_KEY) || 'null'); } catch {}
    prev = prev || {};
    const data = {
      savedAt: Date.now(),
      // Only the half that actually loaded this session is replaced,
      // so a failed groups fetch never wipes the saved groups (and
      // vice versa).
      conversations: (inboxLoaded ? conversations : (prev.conversations || [])).slice(0, INBOX_CACHE_MAX_ROWS).map((c) => ({
        phone: c.phone, name: c.name, avatar: c.avatar || '',
        lastMessage: c.lastMessage || '', lastAt: c.lastAt || 0,
        unread: c.unread || 0, favorite: c.favorite ? 1 : 0, muted: c.muted ? 1 : 0,
        missedAt: c.missedAt || 0, missedVideo: c.missedVideo ? 1 : 0,
      })),
      groups: (groupsLoaded ? myGroups : (prev.groups || [])).slice(0, INBOX_CACHE_MAX_ROWS).map((g) => ({
        id: g.id, name: g.name, lastMessage: g.lastMessage || '',
        lastSenderName: g.lastSenderName || '', lastAt: g.lastAt || 0, unread: g.unread || 0,
      })),
    };
    localStorage.setItem(INBOX_CACHE_KEY, JSON.stringify(data));
  } catch { /* the cache is best-effort — storage full or blocked */ }
}
function restoreInboxCache() {
  try {
    const data = JSON.parse(localStorage.getItem(INBOX_CACHE_KEY) || 'null');
    if (!data || !Array.isArray(data.conversations) || !Array.isArray(data.groups)) return false;
    conversations = data.conversations;
    myGroups = data.groups;
    inboxCached = true;
    return true;
  } catch { return false; }
}
// One fetch at a time (the 3-second poll can overlap a retry), and a
// fresh burst of up to 3 automatic retries, 3s apart, when the first
// load fails — e.g. right after a deploy restarts the server, when the
// first request can take 20s+ or fail outright. The 3-second poll
// keeps trying in the background too, so the list recovers on its own
// once the server is back.
async function loadInbox() {
  // Instant render: if we have never loaded fresh data this session,
  // show the saved list at once — before any network call — exactly
  // like WhatsApp. The fresh fetch below then replaces it.
  if (!inboxLoaded && !inboxCached && restoreInboxCache()) {
    inboxRefreshFailed = false;
    renderInbox();
  }
  if (!inboxLoading) {
    if (!inboxLoaded && !inboxCached && !inboxLoadFailed) renderInbox(); // "Loading chats…" while the first fetch is in flight
    inboxLoading = true;
    try {
      const r = await api('/api/conversations', { timeoutMs: INBOX_FETCH_TIMEOUT_MS });
      conversations = r.conversations || [];
      // New-message beep: unread in chats other than the one open on
      // screen. The open chat beeps from its own poll instead, so one
      // message never beeps twice. Muted chats never beep.
      const dmUnread = conversations.reduce((s, c) => s + ((c.muted || c.phone === activeChat) ? 0 : (c.unread || 0)), 0);
      if (prevUnreadDM !== null && dmUnread > prevUnreadDM && !document.hidden && loadNotifSettings().msgSound) playMsgBeep();
      prevUnreadDM = dmUnread;
      inboxLoaded = true;
      inboxCached = false;
      inboxRefreshFailed = false;
      inboxLoadFailed = false;
      inboxLoadAttempts = 0;
      if (inboxRetryTimer) { clearTimeout(inboxRetryTimer); inboxRetryTimer = null; }
      saveInboxCache();
      renderInbox();
    } catch (e) {
      if (e && e.message === 'logged_out') return; // api() already logged out
      if (!inboxLoaded) {
        if (inboxCached) {
          // Keep the cached list on screen; only a small hint says
          // the refresh failed. The 3-second poll keeps trying in
          // the background, and the hint clears on the next success.
          inboxRefreshFailed = true;
          renderInbox();
        } else if (inboxLoadAttempts < INBOX_MAX_RETRIES) {
          inboxLoadAttempts++;
          renderInbox(); // still "Loading chats…" — not failed yet
          if (!inboxRetryTimer) {
            inboxRetryTimer = setTimeout(() => { inboxRetryTimer = null; loadInbox(); }, INBOX_RETRY_DELAY_MS);
          }
        } else {
          inboxLoadFailed = true;
          renderInbox(); // tap-to-retry error row
        }
      }
      // If we loaded once already, keep the last list on screen.
    } finally {
      inboxLoading = false;
    }
  }
  try {
    const g = await api('/api/groups');
    myGroups = g.groups || [];
    groupsLoaded = true;
    const gUnread = myGroups.reduce((s, gr) => s + ((gr.id === activeGroup) ? 0 : (gr.unread || 0)), 0);
    if (prevUnreadGroup !== null && gUnread > prevUnreadGroup && !document.hidden && loadNotifSettings().groupSound) playMsgBeep();
    prevUnreadGroup = gUnread;
    saveInboxCache();
    renderInbox();
  } catch { /* offline — keep the last list on screen */ }
  try {
    const c = await api('/api/contacts');
    allContacts = c.contacts || [];
    renderStartChatting();
  } catch { /* offline — keep the last list on screen */ }
}
// Tap-to-retry from the inbox error row: a fresh burst of retries.
function retryInboxLoad() {
  inboxLoadAttempts = 0;
  inboxLoadFailed = false;
  renderInbox(); // back to "Loading chats…" while the fresh fetch runs
  loadInbox();
}
const MISSED_PHONE_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/><line x1="23" y1="1" x2="17" y2="7"/><line x1="17" y1="1" x2="23" y2="7"/></svg>';
// Favorites filter: when on, the inbox shows only favorited 1-to-1
// chats (groups cannot be favorited — the chat ⋮ menu that sets the
// flag only exists in 1-to-1 chats).
let favoritesOnly = false;
// Pinned chats: per-device, survives reloads (localStorage s19_pinned).
// Pinned rows stick to the top of the inbox, newest first among pinned,
// with a 📌 mark. Pinned + Favorites compose: a pinned favorite still
// shows in the Favorites filter.
function getPinned() {
  try { return JSON.parse(localStorage.getItem('s19_pinned') || '[]'); } catch { return []; }
}
function setPinned(list) {
  try { localStorage.setItem('s19_pinned', JSON.stringify(list)); } catch { /* storage unavailable */ }
}
function togglePin(key) {
  const list = getPinned();
  const i = list.indexOf(key);
  if (i >= 0) { list.splice(i, 1); toast('Chat unpinned'); }
  else { list.unshift(key); toast('Chat pinned'); }
  setPinned(list);
  renderInbox();
}
// A long-press on an inbox row pins/unpins it. The row is rebuilt by
// renderInbox the moment the press fires, so the click that follows the
// pointer-up must be swallowed — this flag does that. (Right-click fires
// no click, so it needs no flag.)
let suppressRowClick = false;
function consumeRowClick() {
  if (!suppressRowClick) return false;
  suppressRowClick = false;
  return true;
}
function attachInboxRowPin(row, key) {
  let timer = null;
  row.addEventListener('pointerdown', () => {
    timer = setTimeout(() => { suppressRowClick = true; togglePin(key); }, 500);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
    row.addEventListener(ev, () => clearTimeout(timer));
  }
  row.addEventListener('contextmenu', (e) => { e.preventDefault(); togglePin(key); });
}
function renderInbox() {
  const q = chatSearch.trim().toLowerCase();
  const list = $('chat-list');
  list.innerHTML = '';
  // Before the first successful load, never show the empty note: a
  // failed fetch is not an empty inbox. While the first fetch (and its
  // automatic retries) is still trying, show "Loading chats…"; once
  // the retries are exhausted, show the tap-to-retry error row. When
  // the list on screen comes from the cache, the rows below render
  // from that cache through this same path.
  if (!inboxLoaded && !inboxCached) {
    if (inboxLoadFailed) {
      list.innerHTML = '<div class="inbox-error" id="inbox-error">Couldn\'t load chats. Tap to retry.</div>';
      $('inbox-error').addEventListener('click', retryInboxLoad);
    } else {
      list.innerHTML = '<div class="inbox-loading">Loading chats…</div>';
    }
    return;
  }
  // Subtle non-blocking hint when the cached list could not be
  // refreshed — the list itself stays exactly as saved.
  if (inboxCached && inboxRefreshFailed) {
    const hint = document.createElement('div');
    hint.className = 'inbox-refresh-hint';
    hint.textContent = "Couldn't refresh - showing saved chats.";
    list.appendChild(hint);
  }
  // Locked chats are hidden from the list entirely (see the chat-lock
  // section) — they only surface through the "Locked chats" row below.
  const lockedSet = new Set(getLockedChats());
  // 1-to-1 chats and groups share one list, newest first — exactly
  // like WhatsApp. A group row shows its name, the last message
  // prefixed with the sender's name ("Sany: Hi"), and a 👥 avatar.
  const rows = conversations.filter((c) => !lockedSet.has(c.phone) && (!q || peerName(c).toLowerCase().includes(q) || c.phone.includes(q)))
    .map((c) => ({ kind: 'chat', ...c }));
  const grows = myGroups.filter((g) => !q || g.name.toLowerCase().includes(q))
    .map((g) => ({ kind: 'group', ...g }));
  let all = [...rows, ...grows].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  // Pinned chats stick to the top (newest first among pinned).
  const pinned = new Set(getPinned());
  const pinKey = (c) => (c.kind === 'group' ? 'group:' + c.id : c.phone);
  all.sort((a, b) => {
    const ap = pinned.has(pinKey(a)) ? 0 : 1;
    const bp = pinned.has(pinKey(b)) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (b.lastAt || 0) - (a.lastAt || 0);
  });
  if (favoritesOnly) all = all.filter((c) => c.kind === 'chat' && c.favorite);
  // The truly-empty note only appears after a successful load that
  // returned zero chats (or a clean cached list that was empty when
  // saved). A failed refresh never produces it — with a cached-empty
  // list and a failed refresh, only the hint above shows.
  if (!all.length && (inboxLoaded || !inboxRefreshFailed)) {
    const note = document.createElement('div');
    note.className = 'empty-note';
    note.innerHTML = 'Inbox is empty.<br>Tap the green + button to add a friend\'s number or Gmail and start messaging.';
    list.appendChild(note);
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
          '<div class="chat-row-top"><span class="chat-row-name">' + escapeHtml(c.name) + (pinned.has('group:' + c.id) ? ' <span class="pinned-mark">📌</span>' : '') + '</span>' +
          '<span class="chat-row-time">' + (c.lastAt ? fmtTime(c.lastAt) : '') + '</span></div>' +
          '<div class="chat-row-top"><span class="chat-row-msg">' + preview + '</span>' +
          (c.unread ? '<span class="badge">' + bn(c.unread) + '</span>' : '') + '</div>' +
        '</div>';
      row.addEventListener('click', () => { if (consumeRowClick()) return; openGroup(c.id, c.name); });
      attachInboxRowPin(row, 'group:' + c.id);
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
        '<div class="chat-row-top"><span class="chat-row-name">' + escapeHtml(peerName(c)) + (c.muted ? ' 🔇' : '') + (pinned.has(c.phone) ? ' <span class="pinned-mark">📌</span>' : '') + '</span>' +
        '<span class="chat-row-time">' + rowTime + '</span></div>' +
        '<div class="chat-row-top">' + preview +
        (c.unread ? '<span class="badge">' + bn(c.unread) + '</span>' : '') + '</div>' +
      '</div>';
    row.addEventListener('click', () => { if (consumeRowClick()) return; openChat(c.phone, c.name); });
    attachInboxRowPin(row, c.phone);
    list.appendChild(row);
  }
  // Locked chats stay hidden from the list; one row at the bottom opens
  // them behind the PIN.
  const locked = getLockedChats().filter((p) => conversations.some((c) => c.phone === p));
  if (locked.length && !q) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">🔒</div><div class="chat-row-body">' +
      '<div class="chat-row-top"><span class="chat-row-name">Locked chats</span>' +
      '<span class="chat-row-time"></span></div>' +
      '<div class="chat-row-top"><span class="chat-row-msg">' + bn(locked.length) + ' hidden chat' + (locked.length === 1 ? '' : 's') + '</span></div></div>';
    row.addEventListener('click', async () => {
      if (!(await verifyLockPin('Enter your PIN to see your locked chats.'))) return;
      renderLockedChatsDialog();
      $('locked-chats-dialog').classList.remove('hidden');
      pushBackLayer('locked-chats-dialog', () => hideLayer('locked-chats-dialog'));
    });
    list.appendChild(row);
  }
  // Total unread on the Chats tab (green circle, hidden at 0) — chats
  // and groups together. Locked chats do not count while hidden.
  const totalUnread = conversations.filter((c) => !lockedSet.has(c.phone)).reduce((s, c) => s + (c.unread || 0), 0)
    + myGroups.reduce((s, g) => s + (g.unread || 0), 0);
  const badge = $('nav-chats-badge');
  badge.textContent = bn(totalUnread);
  badge.classList.toggle('hidden', totalUnread === 0);
  // Favorites chip: shown whenever at least one chat is favorited.
  const favChip = $('favorites-chip');
  favChip.classList.toggle('hidden', !conversations.some((c) => c.favorite));
  favChip.classList.toggle('active', favoritesOnly);
  renderStartChatting();
}
$('favorites-chip').addEventListener('click', () => {
  favoritesOnly = !favoritesOnly;
  renderInbox();
});
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
  pushBackLayer('add-contact-dialog', () => hideLayer('add-contact-dialog'));
});
$('add-country-select').addEventListener('change', () => {
  $('add-dial-prefix').textContent = $('add-country-select').value;
});
$('btn-cancel-add').addEventListener('click', () => goBackLayer('add-contact-dialog'));
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
    hideLayer('add-contact-dialog');
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
  chatMsgById.clear();
  cancelReplyEdit();
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
  pushBackLayer('chat', closeChat);
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
  chatMsgById.clear();
  cancelReplyEdit();
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
  pushBackLayer('chat', closeChat);
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
    const firstFetch = chatAfterId === 0; // opening the chat loads history — never beep for that
    const r = await api('/api/groups/' + activeGroup + '/messages?afterId=' + chatAfterId);
    let gotIncoming = false;
    for (const m of r.messages || []) {
      appendMessage(m);
      if (m.sender !== session.phone) gotIncoming = true;
      chatAfterId = Math.max(chatAfterId, m.id);
    }
    if (!firstFetch && gotIncoming && !document.hidden && loadNotifSettings().groupSound) playMsgBeep();
    applyTicks(r.ticks);
    if (r.viewedOnce) markViewedOnce(r.viewedOnce);
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
    if (t && el.dataset.ts) {
      el.querySelector('.msg-meta').innerHTML = metaHtml({
        sender: session.phone,
        created_at: Number(el.dataset.ts),
        edited_at: el.dataset.edited === '1' ? 1 : 0,
        starred: el.dataset.starred === '1' ? 1 : 0,
        ...t,
      });
    }
  });
}
// ---- new group + group info ---------------------------------------------------
// New-group dialog, shared by the + button and the profile's
// "Create group with <Name>" row (which pre-selects that person).
function showNewGroupDialog(preselectPhone) {
  hideLayer('add-contact-dialog');
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
    const checked = preselectPhone && c.phone === preselectPhone ? ' checked' : '';
    label.innerHTML = '<input type="checkbox" value="' + escapeHtml(c.phone) + '"' + checked + '> ' + escapeHtml(peerName(c));
    list.appendChild(label);
  }
  $('new-group-dialog').classList.remove('hidden');
  pushBackLayer('new-group-dialog', () => hideLayer('new-group-dialog'));
}
$('btn-new-group').addEventListener('click', () => showNewGroupDialog());
$('btn-cancel-group').addEventListener('click', () => goBackLayer('new-group-dialog'));
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
    hideLayer('new-group-dialog');
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
    pushBackLayer('group-info-overlay', () => hideLayer('group-info-overlay'));
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
$('btn-close-group-info').addEventListener('click', () => goBackLayer('group-info-overlay'));
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
  pushBackLayer('add-group-members-dialog', () => hideLayer('add-group-members-dialog'));
});
$('btn-cancel-add-members').addEventListener('click', () => goBackLayer('add-group-members-dialog'));
$('btn-confirm-add-members').addEventListener('click', async () => {
  const phones = [...document.querySelectorAll('#add-group-members-list input:checked')].map((i) => i.value);
  if (!phones.length) { hideLayer('add-group-members-dialog'); return; }
  try {
    await api('/api/groups/' + activeGroup + '/members', { method: 'POST', body: JSON.stringify({ phones }) });
    hideLayer('add-group-members-dialog');
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
    dismissBackLayer('group-info-overlay');
    $('group-info-overlay').classList.add('hidden');
    dismissBackLayer('chat');
    closeChat();
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
  // theme. The stored value is one of: a data: URL (picked photo),
  // wallpapers/<file>.jpg (bundled), gradient:<css> or color:#RRGGBB.
  const photo = savedChatPhoto(activeChat);
  const dim = savedChatDim(activeChat);
  const w = wallpaperWithDim(photo, dim);
  box.classList.toggle('has-photo', !!photo);
  box.style.backgroundImage = w.image;
  box.style.backgroundColor = w.color;
  // Outgoing-bubble colour for this chat (server-stored, '' = default).
  const bc = chatSettings && chatSettings.bubbleColor ? chatSettings.bubbleColor : '';
  if (bc) {
    box.style.setProperty('--bubble-mine', bc);
    box.style.setProperty('--bubble-mine-text', bubbleTextFor(bc));
  } else {
    box.style.removeProperty('--bubble-mine');
    box.style.removeProperty('--bubble-mine-text');
  }
  // Last seen / disappearing indicator under the peer's name.
  updatePeerSubline();
}
function updateChatMenuLabels() {
  if (!chatSettings) return;
  $('menu-mute').textContent = chatSettings.muted ? 'Unmute notifications' : 'Mute notifications';
  $('menu-block').textContent = chatSettings.blockedByMe ? 'Unblock' : 'Block';
  $('menu-favorite').textContent = chatSettings.favorite ? 'Remove from Favorites' : 'Add to Favorites';
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
// Back from a chat goes to the chats list, one step at a time —
// never straight out of the app (see the back-navigation block above).
function closeChat() {
  activeChat = null;
  activeGroup = null;
  groupInfo = null;
  showScreen('screen-app');
  loadInbox();
}
$('btn-back-chats').addEventListener('click', () => goBackLayer('chat'));

// The menu has two views: the main list and the "More ▸" submenu.
// It always opens on the main view — the submenu is only reached by
// tapping More, and closes back to the main view when the menu hides.
function resetMenuView() {
  $('chat-menu-main').classList.remove('hidden');
  $('chat-menu-more').classList.add('hidden');
}
function hideChatMenu() {
  $('chat-menu').classList.add('hidden');
  resetMenuView();
}
$('btn-chat-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('chat-menu').classList.contains('hidden')) resetMenuView();
  $('chat-menu').classList.toggle('hidden');
  $('attach-menu').classList.add('hidden');
});
document.addEventListener('click', (e) => {
  if (!$('chat-menu').classList.contains('hidden') && !e.target.closest('#chat-menu') && e.target.id !== 'btn-chat-menu') {
    hideChatMenu();
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
  pushBackLayer('disappearing-dialog', () => hideLayer('disappearing-dialog'));
});
$('btn-disappearing-cancel').addEventListener('click', () => goBackLayer('disappearing-dialog'));
document.querySelectorAll('#disappearing-dialog .option-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (!activeChat) return;
    const secs = Number(b.dataset.disappearing);
    hideLayer('disappearing-dialog');
    saveChatSettings({ disappearing: secs },
      secs === 0 ? 'Disappearing messages turned off' : 'Disappearing messages on — messages will delete after ' + disappearLabel(secs));
  });
});
// ---- chat ⋮ menu: new items (WhatsApp order) ------------------------------
// New group → the New-group flow. View contact → the contact-info
// screen. Search → the in-chat search bar. Media → the profile's media
// grid. More ▸ swaps to the submenu (Report / Block / Clear chat /
// Export chat / Add shortcut / Add to Favorites).
$('menu-new-group').addEventListener('click', () => {
  hideChatMenu();
  showNewGroupDialog();
});
$('menu-view-contact').addEventListener('click', () => {
  hideChatMenu();
  openProfile();
});
$('menu-search').addEventListener('click', () => {
  hideChatMenu();
  openChatSearch();
});
$('menu-media').addEventListener('click', () => {
  hideChatMenu();
  openProfileMediaOnOpen = true;
  openProfile();
});
$('menu-more').addEventListener('click', () => {
  $('chat-menu-main').classList.add('hidden');
  $('chat-menu-more').classList.remove('hidden');
});
$('menu-more-back').addEventListener('click', () => resetMenuView());
$('menu-report').addEventListener('click', () => {
  hideChatMenu();
  if (!activeChat) return;
  $('report-dialog-title').textContent = 'Report ' + ($('chat-peer-name').textContent || displayId(activeChat));
  $('report-reason').value = '';
  $('report-dialog').classList.remove('hidden');
  pushBackLayer('report-dialog', () => hideLayer('report-dialog'));
});
$('btn-report-cancel').addEventListener('click', () => goBackLayer('report-dialog'));
$('btn-report-submit').addEventListener('click', async () => {
  if (!activeChat) return;
  const reason = $('report-reason').value.trim();
  hideLayer('report-dialog');
  try {
    await api('/api/report', { method: 'POST', body: JSON.stringify({ peer: activeChat, reason }) });
    toast('Reported — an admin will review it');
  } catch { toast("Couldn't send the report — check your connection and try again"); }
});
$('menu-export').addEventListener('click', () => {
  hideChatMenu();
  exportChat();
});
$('menu-shortcut').addEventListener('click', () => {
  hideChatMenu();
  copyChatLink();
});
$('menu-favorite').addEventListener('click', () => {
  hideChatMenu();
  if (!activeChat) return;
  const fav = !(chatSettings && chatSettings.favorite);
  saveChatSettings({ favorite: fav }, fav ? 'Added to Favorites' : 'Removed from Favorites');
});
$('menu-starred').addEventListener('click', () => {
  hideChatMenu();
  openStarred();
});
$('profile-starred-row').addEventListener('click', () => {
  hideLayer('profile-overlay');
  openStarred();
});

// ---- forward (long-press → Forward) ----------------------------------------
// Pick up to 5 chats (1-to-1 or groups). The server copies the text or
// points the copy at the original media row — nothing is re-uploaded.
function openForward(m) {
  forwardTarget = m;
  renderForwardList();
  $('forward-dialog').classList.remove('hidden');
  pushBackLayer('forward-dialog', closeForward);
}
function closeForward() {
  $('forward-dialog').classList.add('hidden');
  forwardTarget = null;
  dismissBackLayer('forward-dialog');
}
function renderForwardList() {
  const list = $('forward-list');
  list.innerHTML = '';
  const selected = new Set();
  const addRow = (key, label, avatar) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'forward-row';
    row.innerHTML = '<div class="avatar">' + avatar + '</div><span>' + escapeHtml(label) + '</span><span class="forward-check hidden">✓</span>';
    row.addEventListener('click', () => {
      if (selected.has(key)) {
        selected.delete(key);
        row.querySelector('.forward-check').classList.add('hidden');
      } else {
        if (selected.size >= FORWARD_MAX) { toast('You can forward to up to 5 chats at a time'); return; }
        selected.add(key);
        row.querySelector('.forward-check').classList.remove('hidden');
      }
    });
    list.appendChild(row);
  };
  for (const c of conversations) addRow('chat:' + c.phone, peerName(c), avatarHtml(c.name, c.phone, c.avatar));
  for (const g of myGroups) addRow('group:' + g.id, g.name + ' (group)', '👥');
  if (!list.children.length) list.innerHTML = '<div class="empty-note">No chats to forward to yet.</div>';
  $('btn-forward-send').onclick = () => doForward(selected);
}
async function doForward(selected) {
  if (!forwardTarget) return;
  if (!selected.size) { toast('Pick at least one chat'); return; }
  const targets = [...selected].map((k) => {
    const [kind, val] = k.split(':');
    return kind === 'group' ? { groupId: Number(val) } : { to: val };
  });
  const target = forwardTarget;
  closeForward();
  try {
    const r = await api('/api/messages/' + target.id + '/forward', { method: 'POST', body: JSON.stringify({ targets }) });
    toast('Forwarded to ' + bn(r.messages.length) + ' chat' + (r.messages.length === 1 ? '' : 's'));
    loadInbox();
  } catch (e) {
    toast(e.message === 'view_once' ? "View-once photos can't be forwarded" : "Couldn't forward — check your connection and try again");
  }
}
$('btn-forward-cancel').addEventListener('click', () => goBackLayer('forward-dialog'));
$('forward-dialog').addEventListener('click', (e) => { if (e.target.id === 'forward-dialog') goBackLayer('forward-dialog'); });

// ---- share button on a photo/video bubble ---------------------------------
// The ⤴ button sits on the media itself (bottom-right), so sharing a
// video/photo is one tap instead of a long-press. It opens a small sheet
// with two options: "Share to chat" (the same forward flow as the
// long-press menu) and "Share outside" (the phone's system share sheet).
// View-once media is never shareable: the button is never added for it
// (loadMediaInto returns early), openMediaShare refuses it, and the
// server's forward endpoint rejects it too.
function addMediaShareBtn(wrap, m) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'media-share-btn';
  btn.setAttribute('aria-label', 'Share');
  btn.textContent = '⤴';
  btn.addEventListener('click', (e) => { e.stopPropagation(); openMediaShare(m); });
  wrap.appendChild(btn);
}
let mediaShareTarget = null;
function openMediaShare(m) {
  if (!m || m.view_once || m.deleted_for_all) return;
  mediaShareTarget = m;
  $('media-share-dialog').classList.remove('hidden');
  pushBackLayer('media-share-dialog', closeMediaShare);
}
function closeMediaShare() {
  $('media-share-dialog').classList.add('hidden');
  mediaShareTarget = null;
  dismissBackLayer('media-share-dialog');
}
$('btn-share-to-chat').addEventListener('click', () => { const m = mediaShareTarget; closeMediaShare(); if (m) openForward(m); });
$('btn-share-outside').addEventListener('click', () => { const m = mediaShareTarget; closeMediaShare(); if (m) shareOutside(m); });
$('btn-media-share-cancel').addEventListener('click', () => goBackLayer('media-share-dialog'));
$('media-share-dialog').addEventListener('click', (e) => { if (e.target.id === 'media-share-dialog') goBackLayer('media-share-dialog'); });

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
// Share a photo/video outside the app through the phone's own share
// sheet. Prefers bytes already on the phone (mediaCache) so it stays
// quick; otherwise fetches them once from the server (sender/receiver
// only — the endpoint enforces that). If file sharing is not supported
// here, the file is downloaded instead and the toast says so plainly.
// A user-cancelled share stays silent; a genuine failure gets a toast.
async function shareOutside(m) {
  if (!m || m.view_once) return;
  let file;
  try {
    const cached = mediaCache.get(m.id);
    if (cached) {
      const blob = await (await fetch(cached)).blob();
      file = new File([blob], m.media_name || (m.media_kind === 'video' ? 'video' : 'photo'), { type: blob.type || 'application/octet-stream' });
    } else {
      const r = await api('/api/media/' + m.id);
      const url = dataUrl(r.mimeType, r.data);
      mediaCache.set(m.id, url);
      const blob = await (await fetch(url)).blob();
      file = new File([blob], r.fileName || m.media_name || (m.media_kind === 'video' ? 'video' : 'photo'), { type: r.mimeType || 'application/octet-stream' });
    }
  } catch {
    toast("Couldn't share it — check your connection and try again");
    return;
  }
  if (!navigator.share || !(navigator.canShare && navigator.canShare({ files: [file] }))) {
    downloadBlob(file, file.name);
    toast('Sharing is not supported here — the file was downloaded instead');
    return;
  }
  try {
    await navigator.share({ files: [file] });
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user cancelled the share sheet — stay silent
    toast("Couldn't share it — try again");
  }
}

// ---- starred messages (chat ⋮ menu / contact info) --------------------------
// Newest first. Tapping a row jumps to that message in the chat — if it
// is loaded (the chat view holds the recent history).
async function openStarred() {
  $('starred-overlay').classList.remove('hidden');
  pushBackLayer('starred-overlay', () => hideLayer('starred-overlay'));
  const list = $('starred-list');
  list.innerHTML = '<div class="empty-note">Loading…</div>';
  try {
    const q = activeGroup
      ? '/api/messages/starred?groupId=' + activeGroup
      : '/api/messages/starred?with=' + encodeURIComponent(activeChat);
    const r = await api(q);
    list.innerHTML = '';
    if (!(r.messages || []).length) {
      list.innerHTML = '<div class="empty-note">No starred messages in this chat yet.<br>Long-press a message, then tap Star.</div>';
      return;
    }
    for (const m of r.messages) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'starred-row';
      const who = m.sender === session.phone ? 'You' : (m.group_id ? (m.senderName || displayId(m.sender)) : peerNameOf(m));
      const text = m.media_kind ? mediaLabel(m.media_kind, m.media_name) : (m.body || '');
      row.innerHTML = '<div class="starred-row-body">⭐ ' + escapeHtml(text) + '</div>' +
        '<div class="starred-row-meta">' + escapeHtml(who) + ' • ' + fmtDateLong(m.created_at) + ' ' + fmtTime(m.created_at) + '</div>';
      row.addEventListener('click', () => {
        hideLayer('starred-overlay');
        jumpToMessage(m.id);
      });
      list.appendChild(row);
    }
  } catch {
    list.innerHTML = '<div class="empty-note">Couldn\'t load starred messages.</div>';
  }
}
$('btn-close-starred').addEventListener('click', () => goBackLayer('starred-overlay'));

// ---- export chat (menu: More ▸ Export chat) --------------------------------
// Downloads the whole 1-to-1 history as a .txt transcript, one line per
// message. Paginates through /api/messages (200 per page) so long chats
// export in full. Uses the same endpoint as the chat view, so Clear-chat
// and disappearing rules apply exactly as on screen.
async function exportChat() {
  if (!activeChat) return;
  const peer = conversations.find((c) => c.phone === activeChat) || {};
  const peerName = peer.name || displayId(activeChat);
  const myName = (session && session.name) || 'Me';
  const lines = [];
  let afterId = 0;
  try {
    for (;;) {
      const r = await api('/api/messages?with=' + encodeURIComponent(activeChat) + '&afterId=' + afterId);
      const msgs = r.messages || [];
      if (!msgs.length) break;
      for (const m of msgs) {
        afterId = Math.max(afterId, m.id);
        const when = new Date(m.created_at);
        const stamp = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ', ' +
          when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const who = m.sender === session.phone ? myName : peerName;
        if (m.deleted_for_all) { lines.push('[' + stamp + '] ' + who + ': [Deleted message]'); continue; }
        if (m.media_kind) {
          const kindLabel = m.media_kind === 'image' ? 'Photo' : m.media_kind === 'video' ? 'Video' : m.media_kind === 'voice' ? 'Voice message' : 'File';
          const detail = (m.media_name ? m.media_name + ' ' : '') + (m.media_size ? '(' + fmtBytes(m.media_size) + ')' : '');
          lines.push('[' + stamp + '] ' + who + ': [' + kindLabel + '] ' + detail);
        } else {
          lines.push('[' + stamp + '] ' + who + ': ' + (m.body || ''));
        }
      }
      if (msgs.length < 200) break;
    }
  } catch {
    toast("Couldn't export — check your connection and try again");
    return;
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = peerName.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-') + '-chat.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Chat exported');
}

// ---- chat shortcut (menu: More ▸ Add shortcut) ---------------------------
// Browsers cannot place a per-chat icon on the home screen directly, so
// the honest version is a deep link: opening it while logged in jumps
// straight into this chat. The link is copied; handleDeepLink() on boot
// does the opening.
async function copyChatLink() {
  if (!activeChat) return;
  const url = 'https://s-19-chat-book.onrender.com/?chat=' + encodeURIComponent(activeChat);
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    window.prompt('Copy this chat link:', url);
  }
  toast('Chat link copied — paste it on your home screen');
}
function handleDeepLink() {
  let chat = '';
  try { chat = new URLSearchParams(window.location.search).get('chat') || ''; } catch { chat = ''; }
  if (!chat || !/^[+0-9A-Za-z@._-]{6,64}$/.test(chat)) return;
  const tryOpen = () => {
    const peer = conversations.find((c) => c.phone === chat);
    openChat(chat, peer ? peer.name : undefined);
  };
  // Wait for the inbox so the peer's name resolves, then open the chat.
  if (conversations.length || myGroups.length) tryOpen();
  else loadInbox().then(tryOpen).catch(tryOpen);
}
// ---- Chat theme + Wallpaper (WhatsApp-style) --------------------------
// A per-chat theme is a wallpaper + an outgoing-bubble colour. The
// wallpaper lives on this phone only (localStorage; picked photos are
// downscaled to 1280px — photos SENT in chats stay 100% original, this
// rule does not change). The bubble colour is stored on the server in
// chat_settings, so it survives reinstalls. "Only you can see this
// theme." 1-to-1 chats only — group chats keep the default look.
// Wallpaper src encoding (stored in s19_chat_bg_<peer>):
//   data:...            picked gallery photo (data URL, legacy format)
//   wallpapers/<file>   bundled photo (served from /wallpapers/)
//   gradient:<css>      CSS gradient wallpaper
//   color:#RRGGBB       solid colour wallpaper
function chatPhotoKey(peer) { return 's19_chat_bg_' + peer; }
function chatDimKey(peer) { return 's19_chat_dim_' + peer; }
function savedChatPhoto(peer) {
  try { return localStorage.getItem(chatPhotoKey(peer)) || ''; } catch { return ''; }
}
function savedChatDim(peer) {
  try {
    const d = Number(localStorage.getItem(chatDimKey(peer)) || 0);
    return isNaN(d) ? 0 : Math.max(0, Math.min(80, d));
  } catch { return 0; }
}
// Split a stored wallpaper src into a CSS background image / colour.
function wallpaperCss(src) {
  if (!src) return { image: '', color: '' };
  if (src.indexOf('gradient:') === 0) return { image: src.slice(9), color: '' };
  if (src.indexOf('color:') === 0) return { image: '', color: src.slice(6) };
  return { image: 'url("' + src + '")', color: '' };
}
// The same wallpaper with a dark overlay for the brightness slider:
// a dimmed photo/gradient gets a black gradient layer on top; a solid
// colour is mixed toward black by the dim amount (0 = full bright).
function wallpaperWithDim(src, dim) {
  const base = wallpaperCss(src);
  const d = Math.max(0, Math.min(80, dim || 0)) / 100;
  if (base.image) {
    return d > 0
      ? { image: 'linear-gradient(rgba(0,0,0,' + d + '), rgba(0,0,0,' + d + ')), ' + base.image, color: '' }
      : base;
  }
  if (base.color) return { image: '', color: d > 0 ? darkenHex(base.color, d) : base.color };
  return base;
}
function darkenHex(hex, f) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.round(((n >> 16) & 255) * (1 - f));
  const g = Math.round(((n >> 8) & 255) * (1 - f));
  const b = Math.round((n & 255) * (1 - f));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}
// Readable bubble text: dark bubbles get light text, pale ones dark.
function bubbleTextFor(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return '#111B21';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.45 ? '#E9EDEF' : '#111B21';
}
const BUNDLED_WALLPAPERS = {
  palm: 'wallpapers/media-generation-nature-palm-0-d7019b95-33b0-4080-a168-11452696861b.jpg',
  desert: 'wallpapers/media-generation-nature-desert-0-b72be574-928d-4c61-89d6-f58db9cb588d.jpg',
  mountain: 'wallpapers/media-generation-nature-mountain-0-1a82b33a-a647-4613-b63b-14fbe7b99b41.jpg',
  aiDream: 'wallpapers/media-generation-ai-dream-0-6ab45dc5-0529-4c8b-8b2d-8e21d10edefa.jpg',
};
const WALLPAPER_GRADIENTS = {
  sunset: 'linear-gradient(180deg, #3E7CB1 0%, #8FC1E3 45%, #F7F3D8 100%)',
  iridescent: 'linear-gradient(135deg, #f6d5f7 0%, #c9f0ff 35%, #ffe9a8 70%, #f9a8d4 100%)',
  midnight: 'linear-gradient(160deg, #0B1220 0%, #1B2A4A 55%, #05070F 100%)',
};
// Outgoing-bubble colours (first = WhatsApp green default).
const BUBBLE_COLORS = ['#D9FDD3', '#00A884', '#34B7F1', '#D6EAF8', '#EADCF8', '#FCE4EC', '#FFE0B2', '#FFF9C4', '#B2DFDB', '#005C4B'];
const WALLPAPER_COLORS = ['#ECE5DD', '#D9FDD3', '#D6EAF8', '#EADCF8', '#FCE4EC', '#FFE0B2', '#FFF9C4', '#B2DFDB', '#0B141A', '#075E54'];
// Theme cards pair a wallpaper with a bubble colour.
const THEME_CARDS = {
  featured: [
    { name: 'Sunset sky', src: 'gradient:' + WALLPAPER_GRADIENTS.sunset, bubble: '#D6EAF8' },
    { name: 'Iridescent', src: 'gradient:' + WALLPAPER_GRADIENTS.iridescent, bubble: '#EADCF8' },
    { name: 'Midnight', src: 'gradient:' + WALLPAPER_GRADIENTS.midnight, bubble: '#005C4B' },
    { name: 'AI dream', src: BUNDLED_WALLPAPERS.aiDream, bubble: '#FCE4EC' },
  ],
  nature: [
    { name: 'Palm sunset', src: BUNDLED_WALLPAPERS.palm, bubble: '#D9FDD3' },
    { name: 'Desert dunes', src: BUNDLED_WALLPAPERS.desert, bubble: '#FFE0B2' },
    { name: 'Mountain lake', src: BUNDLED_WALLPAPERS.mountain, bubble: '#D6EAF8' },
  ],
  live: [
    { name: 'Iridescent', src: 'gradient:' + WALLPAPER_GRADIENTS.iridescent, bubble: '#EADCF8' },
    { name: 'Sunset sky', src: 'gradient:' + WALLPAPER_GRADIENTS.sunset, bubble: '#34B7F1' },
    { name: 'Midnight', src: 'gradient:' + WALLPAPER_GRADIENTS.midnight, bubble: '#B2DFDB' },
  ],
};
// "Use AI" shows AI-made wallpapers bundled with the app — there is no
// live image service connected, so nothing is generated on demand.
const AI_CARDS = [
  { name: 'AI dream', src: BUNDLED_WALLPAPERS.aiDream, bubble: '#FCE4EC' },
  { name: 'AI iridescent', src: 'gradient:' + WALLPAPER_GRADIENTS.iridescent, bubble: '#EADCF8' },
  { name: 'AI midnight', src: 'gradient:' + WALLPAPER_GRADIENTS.midnight, bubble: '#005C4B' },
];
function cardBackgroundStyle(src) {
  const w = wallpaperCss(src);
  return w.image ? { backgroundImage: w.image } : { backgroundColor: w.color };
}
function renderThemeCards() {
  for (const section of ['featured', 'nature', 'live']) {
    const box = $('theme-cards-' + section);
    if (!box || box.dataset.built) continue;
    box.dataset.built = '1';
    for (const card of THEME_CARDS[section]) {
      const b = document.createElement('button');
      b.className = 'theme-card';
      b.type = 'button';
      Object.assign(b.style, cardBackgroundStyle(card.src));
      b.style.setProperty('--bubble-mine', card.bubble);
      b.style.setProperty('--bubble-mine-text', bubbleTextFor(card.bubble));
      b.innerHTML = '<span class="theme-card-bubbles"><span class="mini-bubble theirs">Hi!</span>' +
        '<span class="mini-bubble mine">Hello 😊</span></span>' +
        '<span class="theme-card-name">' + escapeHtml(card.name) + '</span>';
      b.addEventListener('click', () => openWallpaperPreview(card.src, card.bubble, 'theme'));
      box.appendChild(b);
    }
  }
  for (const [boxId, cards, withBubbles] of [
    ['wp-cards-featured', THEME_CARDS.featured, false],
    ['wp-cards-nature', THEME_CARDS.nature, false],
    ['wp-cards-live', THEME_CARDS.live, false],
    ['wp-cards-ai', AI_CARDS, false],
    ['theme-cards-ai', AI_CARDS, true],
  ]) {
    const box = $(boxId);
    if (!box || box.dataset.built) continue;
    box.dataset.built = '1';
    for (const card of cards) {
      const b = document.createElement('button');
      b.className = 'theme-card';
      b.type = 'button';
      Object.assign(b.style, cardBackgroundStyle(card.src));
      if (withBubbles) {
        b.style.setProperty('--bubble-mine', card.bubble);
        b.style.setProperty('--bubble-mine-text', bubbleTextFor(card.bubble));
        b.innerHTML = '<span class="theme-card-bubbles"><span class="mini-bubble theirs">Hi!</span>' +
          '<span class="mini-bubble mine">Hello 😊</span></span>' +
          '<span class="theme-card-name">' + escapeHtml(card.name) + '</span>';
      } else {
        b.innerHTML = '<span class="theme-card-name">' + escapeHtml(card.name) + '</span>';
      }
      b.addEventListener('click', () => openWallpaperPreview(card.src, currentBubbleColor(), 'wallpaper'));
      box.appendChild(b);
    }
  }
}
function currentBubbleColor() {
  return (chatSettings && chatSettings.bubbleColor) || '';
}
function renderBubblePalette() {
  const box = $('bubble-palette');
  if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  for (const c of BUBBLE_COLORS) {
    const b = document.createElement('button');
    b.className = 'bubble-swatch';
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.dataset.bubble = c;
    b.addEventListener('click', () => {
      if (!activeChat) return;
      document.querySelectorAll('.bubble-swatch').forEach((x) => x.classList.toggle('selected', x.dataset.bubble === c));
      const mini = $('bubble-mini-preview');
      mini.style.setProperty('--bubble-mine', c);
      mini.style.setProperty('--bubble-mine-text', bubbleTextFor(c));
      saveChatSettings({ bubbleColor: c }, 'Bubble colour changed');
    });
    box.appendChild(b);
  }
  const cur = currentBubbleColor() || '#D9FDD3';
  document.querySelectorAll('.bubble-swatch').forEach((x) => x.classList.toggle('selected', x.dataset.bubble === cur));
  const mini = $('bubble-mini-preview');
  mini.style.setProperty('--bubble-mine', cur);
  mini.style.setProperty('--bubble-mine-text', bubbleTextFor(cur));
}
function renderWallpaperColors() {
  const box = $('wp-color-palette');
  if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  for (const c of WALLPAPER_COLORS) {
    const b = document.createElement('button');
    b.className = 'bubble-swatch';
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.addEventListener('click', () => openWallpaperPreview('color:' + c, currentBubbleColor(), 'wallpaper'));
    box.appendChild(b);
  }
}
// ---- Chat theme screen ----
function openThemeOverlay() {
  if (!activeChat) return;
  renderThemeCards();
  renderBubblePalette();
  // The palette is built once, but the selected colour can change
  // (e.g. a theme card was applied) — re-mark it on every open.
  const cur = currentBubbleColor() || '#D9FDD3';
  document.querySelectorAll('.bubble-swatch').forEach((x) => x.classList.toggle('selected', x.dataset.bubble === cur));
  const mini = $('bubble-mini-preview');
  mini.style.setProperty('--bubble-mine', cur);
  mini.style.setProperty('--bubble-mine-text', bubbleTextFor(cur));
  $('theme-bubble-section').classList.remove('hidden');
  $('theme-ai-section').classList.add('hidden');
  $('theme-overlay').classList.remove('hidden');
  pushBackLayer('theme-overlay', () => hideLayer('theme-overlay'));
}
$('menu-chat-theme').addEventListener('click', () => {
  if (!activeChat) return;
  $('chat-menu').classList.add('hidden');
  openThemeOverlay();
});
$('btn-close-theme').addEventListener('click', () => goBackLayer('theme-overlay'));
$('theme-tab-bubble').addEventListener('click', () => {
  $('theme-bubble-section').classList.remove('hidden');
  $('theme-ai-section').classList.add('hidden');
});
$('theme-tab-ai').addEventListener('click', () => {
  renderThemeCards();
  $('theme-bubble-section').classList.add('hidden');
  $('theme-ai-section').classList.remove('hidden');
});
$('theme-tab-wallpaper').addEventListener('click', () => {
  $('theme-overlay').classList.add('hidden');
  openWallpaperOverlay(true);
});
$('btn-theme-default').addEventListener('click', () => {
  if (!activeChat) return;
  try { localStorage.removeItem(chatPhotoKey(activeChat)); } catch {}
  try { localStorage.removeItem(chatDimKey(activeChat)); } catch {}
  hideLayer('theme-overlay');
  saveChatSettings({ chatTheme: '', bubbleColor: '' }, 'Default theme set');
});
// ---- Wallpaper screen ----
let wallpaperReturnToTheme = false;
function closeWallpaperOverlay() {
  $('wallpaper-overlay').classList.add('hidden');
  if (wallpaperReturnToTheme) $('theme-overlay').classList.remove('hidden');
  dismissBackLayer('wallpaper-overlay');
}
function openWallpaperOverlay(fromTheme) {
  wallpaperReturnToTheme = !!fromTheme;
  renderThemeCards();
  renderWallpaperColors();
  $('wp-color-section').classList.add('hidden');
  $('wp-ai-section').classList.add('hidden');
  $('wallpaper-overlay').classList.remove('hidden');
  pushBackLayer('wallpaper-overlay', closeWallpaperOverlay);
}
$('btn-close-wallpaper').addEventListener('click', () => goBackLayer('wallpaper-overlay'));
$('wp-tab-gallery').addEventListener('click', () => $('chat-bg-input').click());
$('wp-tab-color').addEventListener('click', () => {
  $('wp-ai-section').classList.add('hidden');
  $('wp-color-section').classList.remove('hidden');
});
$('wp-tab-ai').addEventListener('click', () => {
  renderThemeCards();
  $('wp-color-section').classList.add('hidden');
  $('wp-ai-section').classList.remove('hidden');
});
$('chat-bg-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file || !activeChat) return;
  try {
    const url = await downscaleImageFile(file);
    openWallpaperPreview(url, currentBubbleColor(), 'wallpaper');
  } catch { toast("Couldn't read that photo — choose another one"); }
});
// ---- Wallpaper preview: pan / pinch-zoom / brightness ----
let previewState = null; // {src, bubble, dim, zoom, panX, panY, from}
function previewPeerName() {
  const n = ($('chat-peer-name') && $('chat-peer-name').textContent || '').trim();
  return n || 'this';
}
function renderPreviewWall() {
  if (!previewState) return;
  const wall = $('preview-wall');
  const w = wallpaperWithDim(previewState.src, previewState.dim);
  wall.style.backgroundImage = w.image;
  wall.style.backgroundColor = w.color;
  wall.style.transform = 'translate(' + previewState.panX + 'px,' + previewState.panY + 'px) scale(' + previewState.zoom + ')';
  const mine = $('preview-mock-mine');
  if (previewState.bubble) {
    mine.style.background = previewState.bubble;
    mine.style.color = bubbleTextFor(previewState.bubble);
  } else {
    mine.style.background = '';
    mine.style.color = '';
  }
  const fill = $('preview-dim-fill');
  const thumb = $('preview-dim-thumb');
  const slider = $('preview-dim');
  const pct = (previewState.dim / 80) * 100;
  fill.style.height = pct + '%';
  const range = Math.max(0, slider.clientHeight - 48);
  thumb.style.bottom = (8 + (previewState.dim / 80) * range) + 'px';
}
function openWallpaperPreview(src, bubble, from) {
  if (!activeChat) return;
  previewState = {
    src, bubble: bubble || '',
    dim: savedChatDim(activeChat), zoom: 1, panX: 0, panY: 0, from: from || 'wallpaper',
  };
  $('preview-mock-name').textContent = previewPeerName();
  $('preview-mock-mine').textContent = 'Only your "' + previewPeerName() + '" chat will change. Only you see your chat themes.';
  $('wallpaper-overlay').classList.add('hidden');
  $('theme-overlay').classList.add('hidden');
  $('wallpaper-preview').classList.remove('hidden');
  pushBackLayer('wallpaper-preview', closeWallpaperPreview);
  renderPreviewWall();
}
function closeWallpaperPreview() {
  $('wallpaper-preview').classList.add('hidden');
  const from = previewState ? previewState.from : 'wallpaper';
  previewState = null;
  if (from === 'theme') $('theme-overlay').classList.remove('hidden');
  else $('wallpaper-overlay').classList.remove('hidden');
  dismissBackLayer('wallpaper-preview');
}
$('btn-preview-back').addEventListener('click', () => goBackLayer('wallpaper-preview'));
$('btn-preview-done').addEventListener('click', () => {
  if (!activeChat || !previewState) return;
  const st = previewState;
  try {
    if (st.src) {
      localStorage.setItem(chatPhotoKey(activeChat), st.src);
      localStorage.setItem(chatDimKey(activeChat), String(st.dim));
    } else {
      localStorage.removeItem(chatPhotoKey(activeChat));
      localStorage.removeItem(chatDimKey(activeChat));
    }
  } catch { toast('That photo is too big — choose a smaller one'); return; }
  const patch = {};
  if (st.bubble !== currentBubbleColor()) patch.bubbleColor = st.bubble;
  if (chatSettings && chatSettings.chatTheme) patch.chatTheme = '';
  // Done goes straight back to the chat — the theme/wallpaper screens
  // it came from are not reshown, so their layers die here too.
  dismissBackLayer('wallpaper-preview');
  dismissBackLayer('wallpaper-overlay');
  dismissBackLayer('theme-overlay');
  $('wallpaper-preview').classList.add('hidden');
  previewState = null;
  if (Object.keys(patch).length) saveChatSettings(patch, 'Theme set');
  else { applyChatTheme(); toast('Wallpaper set'); }
});
// Pan with one finger / mouse drag, pinch with two — custom pointer
// handlers on the stage (the wall itself has touch-action: none, so
// the browser never hijacks the gesture into a page zoom).
(function () {
  const stage = $('preview-stage');
  if (!stage) return;
  const pointers = new Map();
  let pinchStart = 0;
  let pinchZoom = 1;
  let lastMid = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!previewState) return;
    if (e.target.closest('.dim-slider') || e.target.closest('.preview-zoom')) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinchStart = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      pinchZoom = previewState.zoom;
      lastMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!previewState || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      previewState.panX += e.clientX - prev.x;
      previewState.panY += e.clientY - prev.y;
      clampPreviewPan();
      renderPreviewWall();
    } else if (pointers.size === 2 && pinchStart > 0) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      previewState.zoom = Math.max(1, Math.min(3, pinchZoom * (dist / pinchStart)));
      if (lastMid) {
        previewState.panX += mid.x - lastMid.x;
        previewState.panY += mid.y - lastMid.y;
      }
      lastMid = mid;
      clampPreviewPan();
      renderPreviewWall();
    }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) { pinchStart = 0; lastMid = null; }
  };
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  function clampPreviewPan() {
    const s = previewState;
    const lim = 240 * s.zoom;
    s.panX = Math.max(-lim, Math.min(lim, s.panX));
    s.panY = Math.max(-lim, Math.min(lim, s.panY));
    if (s.zoom <= 1) { s.panX = 0; s.panY = 0; }
  }
})();
$('btn-preview-zoom-in').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!previewState) return;
  previewState.zoom = Math.max(1, Math.min(3, previewState.zoom + 0.25));
  renderPreviewWall();
});
$('btn-preview-zoom-out').addEventListener('click', (e) => {
  e.stopPropagation();
  if (!previewState) return;
  previewState.zoom = Math.max(1, Math.min(3, previewState.zoom - 0.25));
  if (previewState.zoom <= 1) { previewState.panX = 0; previewState.panY = 0; }
  renderPreviewWall();
});
// Brightness slider: drag the sun (or tap the pill) — top is full
// bright (dim 0), bottom is darkest (dim 80). Live-dims the preview.
(function () {
  const slider = $('preview-dim');
  if (!slider) return;
  let dragging = false;
  function setFromEvent(e) {
    if (!previewState) return;
    const r = slider.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    previewState.dim = Math.round(frac * 80);
    renderPreviewWall();
  }
  slider.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    slider.setPointerCapture(e.pointerId);
    setFromEvent(e);
  });
  slider.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
  slider.addEventListener('pointerup', () => { dragging = false; });
  slider.addEventListener('pointercancel', () => { dragging = false; });
})();

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
// Set by the menu's "Media, links, and docs" item: open the profile
// with the media grid already expanded.
let openProfileMediaOnOpen = false;
function updateProfileRows() {
  $('profile-mute-state').textContent = chatSettings && chatSettings.muted ? 'Off' : 'On';
  $('profile-disappearing-state').textContent = chatSettings && chatSettings.disappearing ? disappearLabel(chatSettings.disappearing) : 'Off';
  // Media visibility: null = follow the global auto-save toggle.
  const vis = chatSettings ? chatSettings.mediaVisibility : null;
  $('profile-visibility-state').textContent = vis === 1 ? 'On' : vis === 0 ? 'Off' : 'Default (' + (autosaveOn() ? 'On' : 'Off') + ')';
  // Manage storage: total size of this chat's shared media.
  const total = (profileMedia || []).reduce((s, m) => s + (m.media_size || 0), 0);
  $('profile-storage-size').textContent = fmtBytes(total);
  // Chat lock toggle pill.
  $('profile-lock-toggle').classList.toggle('on', !!profilePeer && isChatLocked(profilePeer));
}
// Groups shared with this person (from myGroups, loaded with the
// inbox). Tap a row to open that group.
function renderProfileGroups() {
  const list = $('profile-groups-list');
  const empty = $('profile-groups-empty');
  list.innerHTML = '';
  const shared = (myGroups || []).filter((g) => (g.members || []).some((m) => m.phone === profilePeer));
  empty.classList.toggle('hidden', shared.length > 0);
  for (const g of shared) {
    const row = document.createElement('button');
    row.className = 'profile-row profile-row-green';
    row.type = 'button';
    row.innerHTML = '<span class="profile-row-icon">' + USERS_SVG + '</span><span class="profile-row-label">' + escapeHtml(g.name) + '</span><span>›</span>';
    row.addEventListener('click', () => {
      hideLayer('profile-overlay');
      openGroup(g.id, g.name);
    });
    list.appendChild(row);
  }
}
const USERS_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
async function openProfile() {
  if (!activeChat) return;
  profilePeer = activeChat;
  const peer = conversations.find((c) => c.phone === activeChat) || {};
  $('profile-avatar').innerHTML = avatarHtml(peer.name, activeChat, peer.avatar);
  $('profile-name').textContent = peer.name || displayId(activeChat);
  $('profile-about').textContent = peer.about || '';
  $('profile-phone').textContent = displayId(activeChat);
  $('profile-joined').textContent = '';
  $('profile-media-count').textContent = '…';
  $('profile-storage-size').textContent = '…';
  $('profile-create-group-label').textContent = 'Create group with ' + (peer.name || displayId(activeChat));
  $('profile-media-grid').classList.add('hidden');
  $('profile-media-grid').innerHTML = '';
  profileMedia = [];
  renderProfileGroups();
  updateProfileRows();
  $('profile-overlay').classList.remove('hidden');
  pushBackLayer('profile-overlay', () => hideLayer('profile-overlay'));
  try {
    if (!chatSettings) {
      chatSettings = await api('/api/chat-settings?with=' + encodeURIComponent(activeChat));
    }
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
    updateProfileRows();
    if (openProfileMediaOnOpen) {
      openProfileMediaOnOpen = false;
      renderProfileMedia();
      $('profile-media-grid').classList.remove('hidden');
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
$('btn-close-profile').addEventListener('click', () => goBackLayer('profile-overlay'));
function toggleProfileMediaGrid() {
  const grid = $('profile-media-grid');
  if (grid.classList.contains('hidden')) {
    renderProfileMedia();
    grid.classList.remove('hidden');
  } else {
    grid.classList.add('hidden');
  }
}
$('profile-media-row').addEventListener('click', toggleProfileMediaGrid);
// Manage storage shows a breakdown of this chat's shared media by kind
// (photos / videos / voice notes / files), with the total — the row
// itself already shows the total size. Nothing is deleted from here:
// to free space, delete messages from the chat.
$('profile-storage-row').addEventListener('click', () => {
  const kinds = { image: ['Photos', 0, 0], video: ['Videos', 0, 0], voice: ['Voice notes', 0, 0], file: ['Files', 0, 0] };
  for (const m of profileMedia || []) {
    const k = kinds[m.media_kind] || kinds.file;
    k[1] += 1;
    k[2] += m.media_size || 0;
  }
  const box = $('storage-breakdown');
  box.innerHTML = '';
  let total = 0;
  for (const key of ['image', 'video', 'voice', 'file']) {
    const [label, n, bytes] = kinds[key];
    total += bytes;
    const row = document.createElement('div');
    row.innerHTML = label + ' <span>' + bn(n) + ' • ' + fmtBytes(bytes) + '</span>';
    box.appendChild(row);
  }
  const tot = document.createElement('div');
  tot.innerHTML = '<b>Total</b> <span><b>' + fmtBytes(total) + '</b></span>';
  box.appendChild(tot);
  $('manage-storage-dialog').classList.remove('hidden');
  pushBackLayer('manage-storage-dialog', () => hideLayer('manage-storage-dialog'));
});
$('btn-manage-storage-close').addEventListener('click', () => goBackLayer('manage-storage-dialog'));
$('profile-mute-row').addEventListener('click', () => {
  if (!activeChat) return;
  const nowMuted = chatSettings && chatSettings.muted;
  saveChatSettings({ muted: nowMuted ? 0 : 1 },
    nowMuted ? 'Notifications turned on' : 'Notifications muted')
    .then(updateProfileRows);
});
$('profile-disappearing-row').addEventListener('click', () => {
  hideLayer('profile-overlay');
  $('menu-disappearing').click();
});
// Media visibility: per-chat auto-save override. Default follows the
// global Settings toggle; On/Off override it either way.
$('profile-visibility-row').addEventListener('click', () => {
  const vis = chatSettings ? chatSettings.mediaVisibility : null;
  document.querySelectorAll('#media-visibility-dialog .option-btn').forEach((b) => {
    const v = b.dataset.vis;
    b.classList.toggle('selected',
      (v === 'default' && (vis === null || vis === undefined)) ||
      (v === 'on' && vis === 1) || (v === 'off' && vis === 0));
  });
  $('media-visibility-dialog').classList.remove('hidden');
  pushBackLayer('media-visibility-dialog', () => hideLayer('media-visibility-dialog'));
});
$('btn-visibility-cancel').addEventListener('click', () => goBackLayer('media-visibility-dialog'));
document.querySelectorAll('#media-visibility-dialog .option-btn').forEach((b) => {
  b.addEventListener('click', () => {
    if (!activeChat) return;
    const v = b.dataset.vis;
    hideLayer('media-visibility-dialog');
    saveChatSettings({ mediaVisibility: v === 'default' ? null : (v === 'on' ? 1 : 0) },
      v === 'default' ? 'Media visibility: follows the global setting'
        : v === 'on' ? 'Photos and videos from this chat will be saved'
        : 'Photos and videos from this chat will not be saved')
      .then(updateProfileRows);
  });
});
// Create group with this person: the New-group flow with them already
// picked — more members can still be added before creating.
$('profile-create-group-row').addEventListener('click', () => {
  if (!profilePeer) return;
  hideLayer('profile-overlay');
  showNewGroupDialog(profilePeer);
});
// Add this person to one of my groups.
$('profile-add-to-groups-row').addEventListener('click', () => {
  const box = $('add-to-group-list');
  box.innerHTML = '';
  if (!myGroups.length) {
    box.innerHTML = '<div class="empty-note">You have no groups yet — create one first.</div>';
  }
  for (const g of myGroups) {
    const already = (g.members || []).some((m) => m.phone === profilePeer);
    const row = document.createElement('button');
    row.className = 'profile-row';
    row.type = 'button';
    row.innerHTML = '<span class="profile-row-icon">👥</span><span class="profile-row-label">' + escapeHtml(g.name) + '</span><span>' + (already ? 'Member ✓' : '›') + '</span>';
    if (!already) {
      row.addEventListener('click', async () => {
        try {
          await api('/api/groups/' + g.id + '/members', { method: 'POST', body: JSON.stringify({ phones: [profilePeer] }) });
          hideLayer('add-to-group-dialog');
          toast('Added to ' + g.name);
          loadInbox();
        } catch { toast("Couldn't add them — check your connection and try again"); }
      });
    }
    box.appendChild(row);
  }
  $('add-to-group-dialog').classList.remove('hidden');
  pushBackLayer('add-to-group-dialog', () => hideLayer('add-to-group-dialog'));
});
$('btn-add-to-group-close').addEventListener('click', () => goBackLayer('add-to-group-dialog'));

// ---- chat lock (per-device PIN) -------------------------------------------
// A locked chat is hidden from the inbox list. The lock lives on this
// phone only (localStorage): the 4-digit PIN is a deterrent on a shared
// device, not server security — the messages still exist on the server.
const LOCK_PIN_KEY = 's19_chat_lock_pin';
const LOCKED_CHATS_KEY = 's19_locked_chats';
function getLockedChats() {
  try { return JSON.parse(localStorage.getItem(LOCKED_CHATS_KEY) || '[]'); } catch { return []; }
}
function setLockedChats(list) {
  try { localStorage.setItem(LOCKED_CHATS_KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
}
function isChatLocked(phone) { return getLockedChats().includes(phone); }
function getLockPin() {
  try { return localStorage.getItem(LOCK_PIN_KEY) || ''; } catch { return ''; }
}
// One PIN dialog for both flows: 'set' (PIN + repeat) and 'verify'.
// Resolves with the typed PIN, or null on Cancel.
let pinResolve = null;
// Closing the PIN dialog without a PIN counts as cancelling the flow:
// the pending promise resolves with null.
function cancelPinDialog() {
  $('pin-dialog').classList.add('hidden');
  if (pinResolve) { const r = pinResolve; pinResolve = null; r(null); }
  dismissBackLayer('pin-dialog');
}
function showPinDialog(mode, message) {
  return new Promise((resolve) => {
    pinResolve = resolve;
    $('pin-dialog-title').textContent = mode === 'set' ? 'Set a PIN' : 'Enter your PIN';
    $('pin-dialog-message').textContent = message;
    $('pin-dialog-input').value = '';
    $('pin-dialog-confirm').value = '';
    $('pin-dialog-confirm').classList.toggle('hidden', mode !== 'set');
    $('pin-dialog').classList.remove('hidden');
    pushBackLayer('pin-dialog', cancelPinDialog);
    $('pin-dialog-input').focus();
  });
}
$('btn-pin-cancel').addEventListener('click', () => goBackLayer('pin-dialog'));
$('btn-pin-ok').addEventListener('click', () => {
  const pin = $('pin-dialog-input').value.trim();
  const confirmPin = $('pin-dialog-confirm').value.trim();
  const setting = !$('pin-dialog-confirm').classList.contains('hidden');
  if (!/^\d{4}$/.test(pin)) { toast('Type a 4-digit PIN'); return; }
  if (setting && pin !== confirmPin) { toast('The PINs do not match'); return; }
  hideLayer('pin-dialog');
  if (pinResolve) { const r = pinResolve; pinResolve = null; r(pin); }
});
async function verifyLockPin(message) {
  const pin = await showPinDialog('verify', message || 'Enter your 4-digit PIN to continue.');
  if (pin === null) return false;
  if (pin !== getLockPin()) { toast('Wrong PIN'); return false; }
  return true;
}
async function lockChat(phone) {
  if (!getLockPin()) {
    const pin = await showPinDialog('set', 'Set a 4-digit PIN. You will need it to open locked chats.');
    if (pin === null) return false;
    try { localStorage.setItem(LOCK_PIN_KEY, pin); } catch { /* storage unavailable */ }
  }
  const list = getLockedChats();
  if (!list.includes(phone)) { list.push(phone); setLockedChats(list); }
  return true;
}
function unlockChat(phone) {
  setLockedChats(getLockedChats().filter((p) => p !== phone));
}
$('profile-lock-row').addEventListener('click', async () => {
  if (!profilePeer) return;
  if (isChatLocked(profilePeer)) {
    if (!(await verifyLockPin('Enter your PIN to unlock this chat.'))) return;
    unlockChat(profilePeer);
    toast('Chat unlocked');
  } else {
    if (!(await lockChat(profilePeer))) return;
    toast('Chat locked and hidden from the inbox');
    hideLayer('profile-overlay');
  }
  updateProfileRows();
  renderInbox();
});
function renderLockedChatsDialog() {
  const box = $('locked-chats-list');
  box.innerHTML = '';
  for (const phone of getLockedChats()) {
    const c = conversations.find((x) => x.phone === phone) || {};
    const row = document.createElement('button');
    row.className = 'profile-row';
    row.type = 'button';
    row.innerHTML = '<span class="profile-row-icon">🔒</span><span class="profile-row-label">' + escapeHtml(peerName(c) || displayId(phone)) + '</span><span>›</span>';
    row.addEventListener('click', () => {
      hideLayer('locked-chats-dialog');
      openChat(phone, c.name);
    });
    box.appendChild(row);
  }
  if (!box.children.length) box.innerHTML = '<div class="empty-note">No locked chats.</div>';
}
$('btn-locked-chats-close').addEventListener('click', () => goBackLayer('locked-chats-dialog'));

// ---- In-chat search (from the profile's Search button) --------------------
// Filters the loaded messages as you type; clearing restores the chat.
// Matches are collected so ↑ / ↓ can jump between them — the current
// match is outlined and scrolled into view.
let chatSearchQuery = '';
let searchMatches = [];
let searchMatchIdx = -1;
function openChatSearch() {
  $('chat-search-bar').classList.remove('hidden');
  $('chat-search-input').value = '';
  $('chat-search-input').focus();
  applyChatSearch('');
}
function closeChatSearch() {
  $('chat-search-bar').classList.add('hidden');
  document.querySelectorAll('#chat-messages .msg.search-hit').forEach((el) => el.classList.remove('search-hit'));
  applyChatSearch('');
}
function highlightSearchMatch() {
  document.querySelectorAll('#chat-messages .msg.search-hit').forEach((el) => el.classList.remove('search-hit'));
  if (!searchMatches.length || searchMatchIdx < 0) return;
  const el = searchMatches[searchMatchIdx];
  if (!el) return;
  el.classList.add('search-hit');
  el.scrollIntoView({ block: 'center' });
}
function stepSearchMatch(dir) {
  if (!searchMatches.length) return;
  searchMatchIdx = (searchMatchIdx + dir + searchMatches.length) % searchMatches.length;
  $('chat-search-count').textContent = bn(String(searchMatchIdx + 1)) + ' of ' + bn(String(searchMatches.length));
  highlightSearchMatch();
}
function applyChatSearch(q) {
  chatSearchQuery = (q || '').trim().toLowerCase();
  searchMatches = [];
  searchMatchIdx = -1;
  document.querySelectorAll('#chat-messages .msg').forEach((el) => {
    const hit = !chatSearchQuery || (el.textContent || '').toLowerCase().includes(chatSearchQuery);
    el.style.display = hit ? '' : 'none';
    if (hit && chatSearchQuery) searchMatches.push(el);
  });
  if (chatSearchQuery && searchMatches.length) {
    searchMatchIdx = 0;
    $('chat-search-count').textContent = '1 of ' + bn(String(searchMatches.length));
    highlightSearchMatch();
  } else {
    $('chat-search-count').textContent = chatSearchQuery ? '0 found' : '';
  }
}
$('chat-search-input').addEventListener('input', (e) => applyChatSearch(e.target.value));
$('btn-close-search').addEventListener('click', closeChatSearch);
$('btn-search-prev').addEventListener('click', () => stepSearchMatch(-1));
$('btn-search-next').addEventListener('click', () => stepSearchMatch(1));
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
    const firstFetch = chatAfterId === 0; // opening the chat loads history — never beep for that
    const r = await api('/api/messages?with=' + encodeURIComponent(activeChat) + '&afterId=' + chatAfterId);
    let gotIncoming = false;
    for (const m of r.messages || []) {
      appendMessage(m);
      if (m.sender === activeChat) gotIncoming = true;
      // Media bytes are counted when the media itself downloads (in
      // loadMediaInto); text bytes are counted here. The body of a media
      // message is only its preview label, so it is not counted.
      if (m.receiver === session.phone && !m.media_kind) addMsgBytes(bytesOf(m.body));
      chatAfterId = Math.max(chatAfterId, m.id);
    }
    // A new message in the chat on screen beeps once — unless this chat
    // is muted, the sound is off, or the tab is hidden (push covers it).
    if (!firstFetch && gotIncoming && !document.hidden && loadNotifSettings().msgSound && !(chatSettings && chatSettings.muted)) playMsgBeep();
    // Re-render ticks for my messages from the ticks map — this works
    // even when this poll brought no new messages, which is how a ✓
    // becomes ✓✓ and then blue (seen) after the friend reads it.
    // Deleted placeholders carry no ticks, so they are skipped.
    applyTicks(r.ticks);
    // View-once messages of mine the friend opened since the last poll.
    if (r.viewedOnce) markViewedOnce(r.viewedOnce);
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
// ---- WhatsApp essentials: reactions, reply, forward, star, pin, view-once, edit ----
const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '🙏', '👍', '🔥'];
const EDIT_WINDOW_MS = 15 * 60 * 1000; // WhatsApp-style edit window
const FORWARD_MAX = 5;
let replyTarget = null;   // message being replied to (quote preview above the input)
let editTarget = null;    // my own text message being edited
let viewOnceNext = false; // attach-menu toggle: the next photo/video is view-once
let actionTarget = null;  // message the action sheet is about
let forwardTarget = null; // message being forwarded
let reactionTarget = null; // message a reaction from the emoji panel is for
let reactionMode = false; // emoji panel is picking a reaction, not typing
const chatMsgById = new Map(); // server id -> last message object on screen (for actions)

// Delete message: long-press (~500 ms) or right-click a bubble opens
// the delete dialog. Pending bubbles have no server id yet, and a
// placeholder that is already deleted cannot be deleted again.
let deleteTarget = null; // message row the delete dialog is about
// Long-press (~500 ms) or right-click a bubble opens the message
// action sheet (reply / react / forward / star / edit / delete).
// A quick swipe right on a bubble replies to it, like WhatsApp — and
// the bubble VISIBLY slides right under the finger while a ↩️ badge
// fades in at its left edge (a fixed badge, positioned once at drag
// start, so it stays in the space the bubble vacates instead of
// sliding along with it).
let swipeIc = null; // shared fixed ↩️ badge, created lazily
function getSwipeIc() {
  if (!swipeIc) {
    swipeIc = document.createElement('div');
    swipeIc.className = 'swipe-reply-ic';
    swipeIc.setAttribute('aria-hidden', 'true');
    swipeIc.textContent = '↩️';
    document.body.appendChild(swipeIc);
  }
  return swipeIc;
}
function attachDeleteHandlers(div, m) {
  if (!m.id) return;
  let pressTimer = null;
  let swipeStart = null;
  let swipeDone = false;
  let swipeRect = null; // bubble rect at drag start (before any transform)
  const resetSwipeVisual = () => {
    div.classList.remove('msg-swiping');
    div.style.transform = '';
    if (swipeIc) swipeIc.style.opacity = '0';
  };
  div.addEventListener('pointerdown', (e) => {
    clearTimeout(pressTimer);
    swipeStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    swipeDone = false;
    resetSwipeVisual();
    // Capture the bubble's rect BEFORE any transform, so the ↩️ badge
    // stays at the bubble's original left edge while it slides away.
    swipeRect = div.getBoundingClientRect();
    pressTimer = setTimeout(() => { pressTimer = null; openMsgActions(m); }, 500);
  });
  // Swipe right to reply: detect it DURING the move, not only at
  // pointerup — on a real phone pointerleave fires when the finger
  // slides off the bubble mid-swipe and pointercancel fires when the
  // browser claims the touch for scrolling, so pointerup almost never
  // sees a valid swipeStart. A vertical move (or a left swipe) is a
  // scroll, not a reply: it only cancels the long-press timer.
  div.addEventListener('pointermove', (e) => {
    if (!swipeStart || swipeDone || pressTimer === null) return;
    const dx = e.clientX - swipeStart.x;
    const dy = e.clientY - swipeStart.y;
    if (Math.abs(dy) > 40 || dx < -20) {
      clearTimeout(pressTimer);
      pressTimer = null;
      resetSwipeVisual();
      return;
    }
    if (dx > 0 && Math.abs(dy) < 40) {
      // Slide the bubble with the finger (clamped at 72px) and fade
      // the ↩️ badge in at the bubble's original left edge.
      const shown = Math.min(dx, 72);
      div.classList.add('msg-swiping');
      div.style.transform = 'translateX(' + shown + 'px)';
      const ic = getSwipeIc();
      const r = swipeRect || div.getBoundingClientRect();
      ic.style.left = Math.max(4, r.left - 36) + 'px';
      ic.style.top = (r.top + r.height / 2 - 14) + 'px';
      ic.style.opacity = String(Math.min(1, dx / 60));
      if (dx > 60) {
        clearTimeout(pressTimer);
        swipeDone = true;
        swipeStart = null;
        resetSwipeVisual();
        startReply(m);
      }
    }
  });
  div.addEventListener('pointerup', (e) => {
    clearTimeout(pressTimer);
    if (swipeStart && !swipeDone && Date.now() - swipeStart.t < 500) {
      const dx = e.clientX - swipeStart.x;
      const dy = e.clientY - swipeStart.y;
      if (dx > 60 && Math.abs(dy) < 40) { swipeDone = true; resetSwipeVisual(); startReply(m); }
    }
    swipeStart = null;
    if (!swipeDone) resetSwipeVisual();
  });
  // Only the long-press timer is cleared here: nulling swipeStart would
  // kill the pointerup fallback, and the move handler has already fired
  // by the time leave/cancel arrives. The visual snaps back either way.
  for (const ev of ['pointerleave', 'pointercancel']) {
    div.addEventListener(ev, () => { clearTimeout(pressTimer); resetSwipeVisual(); });
  }
  div.addEventListener('contextmenu', (e) => { e.preventDefault(); openMsgActions(m); });
}
// The action sheet: 8 quick reactions (+ more) on top, then the
// actions. Edit only shows for my own text messages inside 15 minutes;
// "Delete for everyone" only for my own messages.
function openMsgActions(m) {
  if (!m.id) return;
  const el = document.querySelector('.msg[data-id="' + m.id + '"]');
  if (el && el.classList.contains('msg-deleted')) return;
  actionTarget = m;
  const mine = m.sender === session.phone;
  const canEdit = mine && !m.media_kind && !m.deleted_for_all && (Date.now() - (m.created_at || 0) < EDIT_WINDOW_MS);
  $('msg-action-edit').classList.toggle('hidden', !canEdit);
  $('msg-action-delete-all').classList.toggle('hidden', !mine);
  $('msg-action-star').textContent = m.starred ? 'Unstar' : 'Star';
  const row = $('msg-action-reactions');
  row.innerHTML = '';
  for (const em of QUICK_REACTIONS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = em;
    b.addEventListener('click', () => { closeMsgActions(); sendReaction(m, em); });
    row.appendChild(b);
  }
  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = '➕';
  more.title = 'More reactions';
  more.addEventListener('click', () => {
    reactionTarget = m;
    closeMsgActions();
    reactionMode = true;
    $('emoji-panel').classList.remove('hidden');
    toast('Tap an emoji to react');
  });
  row.appendChild(more);
  $('msg-action-dialog').classList.remove('hidden');
  pushBackLayer('msg-action-dialog', closeMsgActions);
}
function closeMsgActions() {
  $('msg-action-dialog').classList.add('hidden');
  actionTarget = null;
  dismissBackLayer('msg-action-dialog');
}
$('msg-action-cancel').addEventListener('click', () => goBackLayer('msg-action-dialog'));
$('msg-action-dialog').addEventListener('click', (e) => { if (e.target.id === 'msg-action-dialog') goBackLayer('msg-action-dialog'); });
$('msg-action-reply').addEventListener('click', () => { const m = actionTarget; closeMsgActions(); if (m) startReply(m); });
$('msg-action-forward').addEventListener('click', () => { const m = actionTarget; closeMsgActions(); if (m) openForward(m); });
$('msg-action-star').addEventListener('click', () => { const m = actionTarget; closeMsgActions(); if (m) toggleStar(m); });
$('msg-action-edit').addEventListener('click', () => { const m = actionTarget; closeMsgActions(); if (m) startEdit(m); });
$('msg-action-delete-all').addEventListener('click', () => { const m = actionTarget; closeMsgActions(); if (m) openDeleteMenu(m); });
$('msg-action-delete-me').addEventListener('click', () => { const m = actionTarget; closeMsgActions(); if (m) { deleteTarget = m; deleteMessage('me'); } });
function openDeleteMenu(m) {
  if (!m.id) return;
  const el = document.querySelector('.msg[data-id="' + m.id + '"]');
  if (el && el.classList.contains('msg-deleted')) return;
  deleteTarget = m;
  $('btn-delete-everyone').classList.toggle('hidden', m.sender !== session.phone);
  $('delete-msg-dialog').classList.remove('hidden');
  pushBackLayer('delete-msg-dialog', closeDeleteMenu);
}
function closeDeleteMenu() {
  $('delete-msg-dialog').classList.add('hidden');
  deleteTarget = null;
  dismissBackLayer('delete-msg-dialog');
}
$('btn-delete-cancel').addEventListener('click', () => goBackLayer('delete-msg-dialog'));
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
$('delete-msg-dialog').addEventListener('click', (e) => { if (e.target.id === 'delete-msg-dialog') goBackLayer('delete-msg-dialog'); });

// ---- message rendering helpers: quote, forwarded, reactions, meta ----
// The reply quote above a bubble: sender name + quoted text (or media
// label) from the server snapshot. Tapping it jumps to the original.
function quoteHtml(m) {
  if (!m.reply_to) return '';
  return '<div class="msg-quote" data-quote-id="' + m.reply_to + '"><div class="msg-quote-name">' +
    escapeHtml(m.reply_sender || 'Someone') + '</div><div class="msg-quote-text">' +
    escapeHtml(m.reply_body || '') + '</div></div>';
}
function forwardedHtml(m) {
  return m.forwarded ? '<div class="msg-forwarded">Forwarded</div>' : '';
}
// Reaction chips under a bubble, grouped by emoji with a count. My own
// reaction is highlighted; tapping a chip shows who reacted.
function reactionsHtml(m) {
  const list = m.reactions || [];
  if (!list.length) return '';
  const groups = new Map();
  for (const r of list) {
    if (!groups.has(r.emoji)) groups.set(r.emoji, []);
    groups.get(r.emoji).push(r);
  }
  let html = '<div class="msg-reactions">';
  for (const [emoji, who] of groups) {
    const mine = who.some((w) => w.phone === session.phone);
    html += '<button type="button" class="reaction-chip' + (mine ? ' mine' : '') + '" data-emoji="' + escapeHtml(emoji) + '">' +
      escapeHtml(emoji) + ' ' + bn(who.length) + '</button>';
  }
  return html + '</div>';
}
// One line: time + "• Edited" + ⭐ + ticks (mine only). applyTicks
// rebuilds the same line from the bubble's dataset flags.
function metaHtml(m) {
  let s = fmtTime(m.created_at || Date.now());
  if (m.edited_at) s += ' • Edited';
  if (m.starred) s += ' ⭐';
  if (m.sender === session.phone || !m.sender) s += ' ' + tickHtml(m);
  return s;
}
function jumpToMessage(id) {
  const el = document.querySelector('.msg[data-id="' + id + '"]');
  if (!el) { toast('That message is not loaded in this chat'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.style.background = 'rgba(37, 211, 102, .25)';
  setTimeout(() => { el.style.background = ''; }, 1200);
}
function showWhoReacted(m, emoji) {
  const who = (m.reactions || []).filter((r) => r.emoji === emoji);
  $('reaction-who-list').innerHTML = who.map((r) =>
    '<div class="option-btn" style="cursor:default">' + escapeHtml(r.emoji) + ' ' + escapeHtml(r.name || displayId(r.phone)) +
    (r.phone === session.phone ? ' (you)' : '') + '</div>').join('') ||
    '<div class="option-btn" style="cursor:default">No reactions</div>';
  $('reaction-who-dialog').classList.remove('hidden');
  pushBackLayer('reaction-who-dialog', () => hideLayer('reaction-who-dialog'));
}
$('btn-reaction-who-close').addEventListener('click', () => goBackLayer('reaction-who-dialog'));
$('reaction-who-dialog').addEventListener('click', (e) => { if (e.target.id === 'reaction-who-dialog') goBackLayer('reaction-who-dialog'); });
// Taps inside a bubble: quote → jump, reaction chip → who reacted,
// view-once placeholder → open it once.
$('chat-messages').addEventListener('click', (e) => {
  const q = e.target.closest('.msg-quote');
  if (q) { jumpToMessage(Number(q.dataset.quoteId)); return; }
  const chip = e.target.closest('.reaction-chip');
  if (chip) {
    const el = chip.closest('.msg');
    const m = el && chatMsgById.get(Number(el.dataset.id));
    if (m) showWhoReacted(m, chip.dataset.emoji);
    return;
  }
  const vo = e.target.closest('.view-once-box:not(.opened)');
  if (vo) {
    const el = vo.closest('.msg');
    const m = el && chatMsgById.get(Number(el.dataset.id));
    if (m) openViewOnce(m, el);
  }
});
async function sendReaction(m, emoji) {
  if (!m.id) return;
  try {
    const r = await api('/api/messages/' + m.id + '/react', { method: 'POST', body: JSON.stringify({ emoji }) });
    // Refresh the chips from the server's answer: everyone else's
    // reactions stay, mine is replaced (or removed on toggle-off).
    const others = (m.reactions || []).filter((x) => x.phone !== session.phone);
    if (r.reacted) others.push({ emoji: r.emoji, phone: session.phone, name: 'You' });
    m.reactions = others;
    chatMsgById.set(m.id, m);
    refreshReactionsRow(m);
  } catch { toast("Couldn't react — check your connection and try again"); }
}
function refreshReactionsRow(m) {
  const el = document.querySelector('.msg[data-id="' + m.id + '"]');
  if (!el) return;
  el.querySelector('.msg-reactions')?.remove();
  const html = reactionsHtml(m);
  if (html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    el.appendChild(tmp.firstChild);
  }
}
async function toggleStar(m) {
  if (!m.id) return;
  const star = !m.starred;
  try {
    await api('/api/messages/' + m.id + '/star', { method: 'POST', body: JSON.stringify({ star }) });
    m.starred = star ? 1 : 0;
    chatMsgById.set(m.id, m);
    const el = document.querySelector('.msg[data-id="' + m.id + '"]');
    if (el) {
      el.dataset.starred = m.starred ? '1' : '';
      el.querySelector('.msg-meta').innerHTML = metaHtml(m);
    }
  } catch { toast("Couldn't star it — check your connection and try again"); }
}

// ---- reply / edit ---------------------------------------------------------
// The quoted label for a message: its text, or "📷 Photo" / "🎥 Video" /
// "🎤 Voice" / "📄 filename" for media.
function replyLabel(m) {
  if (!m.media_kind) return m.body || '';
  if (m.media_kind === 'image') return '📷 Photo';
  if (m.media_kind === 'video') return '🎥 Video';
  if (m.media_kind === 'voice') return '🎤 Voice';
  return '📄 ' + (m.media_name || 'File');
}
function peerNameOf(m) {
  if (activeGroup) return m.senderName || displayId(m.sender);
  const c = conversations.find((x) => x.phone === m.sender);
  return c ? (c.name || displayId(m.sender)) : displayId(m.sender);
}
function startReply(m) {
  replyTarget = m;
  editTarget = null;
  const name = m.sender === session.phone ? 'You' : peerNameOf(m);
  $('reply-bar-title').textContent = 'Replying to ' + name;
  $('reply-bar-text').textContent = replyLabel(m);
  $('reply-bar').classList.remove('hidden');
  $('chat-input').focus();
}
function startEdit(m) {
  editTarget = m;
  replyTarget = null;
  $('reply-bar-title').textContent = 'Editing message';
  $('reply-bar-text').textContent = m.body || '';
  $('reply-bar').classList.remove('hidden');
  $('chat-input').value = m.body || '';
  updateMicSend();
  $('chat-input').focus();
}
function cancelReplyEdit() {
  replyTarget = null;
  editTarget = null;
  $('reply-bar').classList.add('hidden');
}
$('btn-reply-cancel').addEventListener('click', () => {
  const wasEdit = !!editTarget;
  cancelReplyEdit();
  if (wasEdit) { $('chat-input').value = ''; updateMicSend(); }
});

// ---- view-once ------------------------------------------------------------
// Open a received view-once photo/video: the server hands the bytes
// over once and deletes them in the same request, so the bubble flips
// to "Opened" and can never be viewed again. The sender can never open
// their own view-once media.
async function openViewOnce(m, el) {
  if (m.sender === session.phone || m.viewed) return;
  try {
    const r = await api('/api/media/' + m.id);
    const url = dataUrl(r.mimeType, r.data);
    mediaCache.set(m.id, url);
    m.viewed = 1;
    chatMsgById.set(m.id, m);
    openMediaViewer(url, m.media_kind);
    const wrap = el && el.querySelector('.msg-media');
    if (wrap) wrap.innerHTML = '<div class="view-once-box opened">📷 ' + (m.media_kind === 'video' ? 'Video opened' : 'Photo opened') + '</div>';
  } catch (e) {
    if (e.message === 'view_once_gone') {
      m.viewed = 1;
      toast('This photo was already opened');
      const wrap = el && el.querySelector('.msg-media');
      if (wrap) wrap.innerHTML = '<div class="view-once-box opened">📷 ' + (m.media_kind === 'video' ? 'Video opened' : 'Photo opened') + '</div>';
    } else {
      toast("Couldn't open it — check your connection and try again");
    }
  }
}
// My view-once messages that the receiver opened: flip their bubbles
// to "Opened". The incremental fetch never re-sends old messages, so
// this list rides on the poll.
function markViewedOnce(ids) {
  for (const id of ids || []) {
    const m = chatMsgById.get(id);
    if (!m || m.viewed) continue;
    m.viewed = 1;
    const el = document.querySelector('.msg[data-id="' + id + '"]');
    const wrap = el && el.querySelector('.msg-media');
    if (wrap) wrap.innerHTML = '<div class="view-once-box opened">📷 ' + (m.media_kind === 'video' ? 'Video opened' : 'Photo opened') + '</div>';
  }
}

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
  div.dataset.edited = m.edited_at ? '1' : '';
  div.dataset.starred = m.starred ? '1' : '';
  if (m.id) chatMsgById.set(m.id, m);
  const meta = '<div class="msg-meta">' + (m.pending ? fmtTime(ts) + ' 🕐' : metaHtml(m)) + '</div>';
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
    div.innerHTML = senderLine + quoteHtml(m) + forwardedHtml(m) + mediaHtml(m) + meta + reactionsHtml(m);
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    if (!m.pending) loadMediaInto(div, m);
    attachDeleteHandlers(div, m);
    return;
  }
  div.innerHTML = senderLine + quoteHtml(m) + forwardedHtml(m) + '<div class="msg-body">' + linkify(escapeHtml(m.body)) + '</div>' + meta + reactionsHtml(m);
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
  // View-once: a tap-to-view placeholder, never the photo itself. The
  // sender sees the same placeholder (they can never re-open it), and
  // once viewed both sides see "Photo opened". loadMediaInto never
  // fetches view-once bytes on its own — only the tap does.
  if (m.view_once) {
    if (m.viewed) return wrap + '<div class="view-once-box opened">📷 ' + (kind === 'video' ? 'Video opened' : 'Photo opened') + '</div></div>';
    if (m.sender === session.phone) return wrap + '<div class="view-once-box opened">📷 View once ' + (kind === 'video' ? 'video' : 'photo') + '</div></div>';
    return wrap + '<div class="view-once-box">📷 View once ' + (kind === 'video' ? 'video' : 'photo') + ' — tap to view</div></div>';
  }
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
// Photos and videos are toggled separately (keys s19_autosave_photos /
// s19_autosave_videos, both default ON). The old single key s19_autosave
// is honoured once for migration: if it was turned off, both kinds
// start off.
function autosavePhotosOn() {
  try {
    const v = localStorage.getItem('s19_autosave_photos');
    if (v !== null) return v !== 'off';
    return localStorage.getItem('s19_autosave') !== 'off';
  } catch { return true; }
}
function autosaveVideosOn() {
  try {
    const v = localStorage.getItem('s19_autosave_videos');
    if (v !== null) return v !== 'off';
    return localStorage.getItem('s19_autosave') !== 'off';
  } catch { return true; }
}
function setAutosavePhotos(on) {
  try { localStorage.setItem('s19_autosave_photos', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  renderAutosaveRow();
  renderAutodlRows();
}
function setAutosaveVideos(on) {
  try { localStorage.setItem('s19_autosave_videos', on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  renderAutosaveRow();
  renderAutodlRows();
}
// The old single toggle, kept for the main Settings row: it flips both
// kinds together.
function autosaveOn() {
  return autosavePhotosOn() || autosaveVideosOn();
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
  if (!m.id || m.sender === session.phone) return;
  if (m.media_kind !== 'image' && m.media_kind !== 'video') return;
  // Per-chat override wins over the global toggle — but only for the
  // 1-to-1 chat on screen (chatSettings belongs to it). Group chats,
  // and anything rendered without settings, fall back to the global one.
  let on = m.media_kind === 'video' ? autosaveVideosOn() : autosavePhotosOn();
  if (!m.group_id && chatSettings && chatSettings.mediaVisibility !== null && chatSettings.mediaVisibility !== undefined) {
    on = chatSettings.mediaVisibility === 1;
  }
  if (!on) return;
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
  const p = autosavePhotosOn(), v = autosaveVideosOn();
  $('settings-autosave').textContent = (p && v) ? 'On' : (!p && !v) ? 'Off' : (p ? 'Photos only' : 'Videos only');
}
function renderAutodlRows() {
  const p = $('autodl-photos-state'), v = $('autodl-videos-state');
  if (p) p.textContent = autosavePhotosOn() ? 'On' : 'Off';
  if (v) v.textContent = autosaveVideosOn() ? 'On' : 'Off';
}
$('settings-autosave-row').addEventListener('click', () => {
  // The main row flips both kinds together.
  const on = !(autosavePhotosOn() && autosaveVideosOn());
  try {
    localStorage.setItem('s19_autosave_photos', on ? 'on' : 'off');
    localStorage.setItem('s19_autosave_videos', on ? 'on' : 'off');
  } catch { /* storage unavailable */ }
  renderAutosaveRow();
  renderAutodlRows();
  toast(on ? 'Auto-save on — photos and videos from friends will be saved to your phone' : 'Auto-save off');
});

// ---- Profile photo guard -------------------------------------------------
// Per-device toggle, default ON. The guard only changes the photo
// viewer: guarded = no download/save button, no long-press or
// right-click saving, and the photo hides the moment the app loses
// focus. It never blocks opening a photo and never changes who can
// see one — and it cannot stop screenshots, so nothing in the UI
// claims that it does.
function photoGuardOn() {
  try { return localStorage.getItem('s19_photo_guard') !== 'off'; } catch { return true; }
}
function renderPhotoGuardRow() {
  $('settings-photoguard').textContent = photoGuardOn() ? 'On' : 'Off';
}
$('settings-photoguard-row').addEventListener('click', () => {
  try { localStorage.setItem('s19_photo_guard', photoGuardOn() ? 'off' : 'on'); } catch { /* storage unavailable */ }
  renderPhotoGuardRow();
  toast(photoGuardOn() ? 'Profile photo guard on — photos open guarded' : 'Profile photo guard off — photos can be saved from the viewer');
});

// ---- Settings sub-screens ----------------------------------------------------
// Notifications / Storage and data / Accessibility / Help and feedback are
// full-screen overlays on top of the Settings overlay; the back button
// closes the sub-screen and returns to Settings.
const SETTINGS_SUB_OVERLAYS = ['settings-notif-overlay', 'settings-storage-overlay', 'settings-access-overlay', 'settings-help-overlay'];
function closeSettingsSubs() { SETTINGS_SUB_OVERLAYS.forEach((id) => hideLayer(id)); }
$('btn-close-settings').addEventListener('click', closeSettingsSubs);
function renderNotifRows() {
  const s = loadNotifSettings();
  $('notif-msg-state').textContent = s.msgSound ? 'On' : 'Off';
  $('notif-group-state').textContent = s.groupSound ? 'On' : 'Off';
  $('notif-call-state').textContent = s.callSound ? 'On' : 'Off';
  $('notif-ringtone-state').textContent = ringtoneDisplayName(s.ringtone);
  $('notif-msgtone-state').textContent = msgToneDisplayName(s.msgTone);
  const volSlider = $('notif-volume-slider');
  if (volSlider) volSlider.value = String(s.ringtoneVolume);
  const volState = $('notif-volume-state');
  if (volState) volState.textContent = s.ringtoneVolume + '%';
}
$('settings-notif-row').addEventListener('click', () => {
  renderNotifRows();
  $('settings-notif-overlay').classList.remove('hidden');
  pushBackLayer('settings-notif-overlay', () => hideLayer('settings-notif-overlay'));
});
$('btn-close-notif').addEventListener('click', () => goBackLayer('settings-notif-overlay'));
$('notif-msg-row').addEventListener('click', () => {
  saveNotifSettings({ msgSound: !loadNotifSettings().msgSound });
  renderNotifRows();
});
$('notif-group-row').addEventListener('click', () => {
  saveNotifSettings({ groupSound: !loadNotifSettings().groupSound });
  renderNotifRows();
});
$('notif-call-row').addEventListener('click', () => {
  saveNotifSettings({ callSound: !loadNotifSettings().callSound });
  renderNotifRows();
  toast(loadNotifSettings().callSound ? 'Call ringtone on' : 'Call ringtone off — calls will ring silently');
});
$('notif-volume-slider').addEventListener('input', (e) => {
  const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
  saveNotifSettings({ ringtoneVolume: v });
  $('notif-volume-state').textContent = v + '%';
});
// One row in a tone picker: name on the left, a delete × on custom
// tones. Tap the row to hear the tone once and set it.
function toneOptionButton(label, selected, onPick, onDelete) {
  const b = document.createElement('button');
  b.className = 'option-btn tone-btn' + (selected ? ' selected' : '');
  b.type = 'button';
  const name = document.createElement('span');
  name.textContent = label;
  b.appendChild(name);
  if (onDelete) {
    const del = document.createElement('span');
    del.className = 'tone-del';
    del.textContent = '×';
    del.title = 'Delete this tone';
    del.addEventListener('click', (e) => { e.stopPropagation(); onDelete(); });
    b.appendChild(del);
  }
  b.addEventListener('click', () => onPick());
  return b;
}
function toneAddRow(onAdd) {
  const add = document.createElement('button');
  add.className = 'option-btn tone-btn tone-add';
  add.type = 'button';
  const name = document.createElement('span');
  name.textContent = '+ Add your own';
  add.appendChild(name);
  add.addEventListener('click', onAdd);
  return add;
}
// Renders the ringtone picker list: 15 built-ins, Silent, custom tones
// (with a delete ×), and the "+ Add your own" row.
function renderRingtoneList() {
  const list = $('ringtone-list');
  list.innerHTML = '';
  const sel = loadNotifSettings().ringtone;
  for (const key of Object.keys(RING_MELODIES)) {
    list.appendChild(toneOptionButton(RING_NAMES[key], key === sel, () => {
      saveNotifSettings({ ringtone: key });
      renderNotifRows();
      hideLayer('ringtone-dialog');
      previewRingtone(key);
      toast('Ringtone: ' + RING_NAMES[key]);
    }));
  }
  list.appendChild(toneOptionButton('Silent', sel === 'silent', () => {
    saveNotifSettings({ ringtone: 'silent' });
    renderNotifRows();
    hideLayer('ringtone-dialog');
    toast('Ringtone: Silent — calls will not ring');
  }));
  for (const t of customToneRegistry) {
    const key = 'custom:' + t.id;
    list.appendChild(toneOptionButton(t.name, key === sel, () => {
      saveNotifSettings({ ringtone: key });
      renderNotifRows();
      hideLayer('ringtone-dialog');
      previewRingtone(key);
      toast('Ringtone: ' + t.name);
    }, async () => {
      await deleteCustomTone(t.id);
      renderRingtoneList();
      renderNotifRows();
      toast('Custom tone deleted');
    }));
  }
  list.appendChild(toneAddRow(() => { customToneTarget = 'ring'; $('custom-tone-input').click(); }));
}
// Same list for message tones: 6 built-ins, Silent, custom tones, add row.
function renderMsgToneList() {
  const list = $('msgtone-list');
  list.innerHTML = '';
  const sel = loadNotifSettings().msgTone;
  for (const key of Object.keys(MSG_TONES)) {
    list.appendChild(toneOptionButton(MSG_TONE_NAMES[key], key === sel, () => {
      saveNotifSettings({ msgTone: key });
      renderNotifRows();
      hideLayer('msgtone-dialog');
      previewMsgTone(key);
      toast('Message tone: ' + MSG_TONE_NAMES[key]);
    }));
  }
  list.appendChild(toneOptionButton('Silent', sel === 'silent', () => {
    saveNotifSettings({ msgTone: 'silent' });
    renderNotifRows();
    hideLayer('msgtone-dialog');
    toast('Message tone: Silent — no beep for new messages');
  }));
  for (const t of customToneRegistry) {
    const key = 'custom:' + t.id;
    list.appendChild(toneOptionButton(t.name, key === sel, () => {
      saveNotifSettings({ msgTone: key });
      renderNotifRows();
      hideLayer('msgtone-dialog');
      previewMsgTone(key);
      toast('Message tone: ' + t.name);
    }, async () => {
      await deleteCustomTone(t.id);
      renderMsgToneList();
      renderNotifRows();
      toast('Custom tone deleted');
    }));
  }
  list.appendChild(toneAddRow(() => { customToneTarget = 'msg'; $('custom-tone-input').click(); }));
}
// Which picker the "+ Add your own" row came from ('ring' or 'msg').
let customToneTarget = 'ring';
$('custom-tone-input').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const entry = await addCustomTone(f);
    if (customToneTarget === 'msg') renderMsgToneList(); else renderRingtoneList();
    toast('Added "' + entry.name + '" — tap it to use it');
  } catch (err) {
    toast(err && err.message ? err.message : 'Could not add that tone');
  }
});
$('notif-ringtone-row').addEventListener('click', () => {
  renderRingtoneList();
  $('ringtone-dialog').classList.remove('hidden');
  pushBackLayer('ringtone-dialog', () => hideLayer('ringtone-dialog'));
});
$('btn-ringtone-cancel').addEventListener('click', () => goBackLayer('ringtone-dialog'));
// + icon in the ringtone picker header: add your own tone from a file
// (same file input as the "+ Add your own" row at the bottom of the list).
$('btn-ringtone-add').addEventListener('click', () => { customToneTarget = 'ring'; $('custom-tone-input').click(); });
$('notif-msgtone-row').addEventListener('click', () => {
  renderMsgToneList();
  $('msgtone-dialog').classList.remove('hidden');
  pushBackLayer('msgtone-dialog', () => hideLayer('msgtone-dialog'));
});
$('btn-msgtone-cancel').addEventListener('click', () => goBackLayer('msgtone-dialog'));
// + icon in the message-tone picker header: same file add as the ringtone one.
$('btn-msgtone-add').addEventListener('click', () => { customToneTarget = 'msg'; $('custom-tone-input').click(); });
$('settings-storage-row').addEventListener('click', () => {
  renderAutodlRows();
  renderMeter();
  loadStorage();
  $('settings-storage-overlay').classList.remove('hidden');
  pushBackLayer('settings-storage-overlay', () => hideLayer('settings-storage-overlay'));
});
$('btn-close-storage').addEventListener('click', () => goBackLayer('settings-storage-overlay'));
$('autodl-photos-row').addEventListener('click', () => {
  setAutosavePhotos(!autosavePhotosOn());
  toast(autosavePhotosOn() ? 'Photos will be saved automatically' : 'Photos will not be saved automatically');
});
$('autodl-videos-row').addEventListener('click', () => {
  setAutosaveVideos(!autosaveVideosOn());
  toast(autosaveVideosOn() ? 'Videos will be saved automatically' : 'Videos will not be saved automatically');
});
function renderAccessRows() {
  const a = loadA11y();
  $('access-text-state').textContent = a.largeText ? 'On' : 'Off';
  $('access-motion-state').textContent = a.reduceMotion ? 'On' : 'Off';
}
$('settings-access-row').addEventListener('click', () => {
  renderAccessRows();
  $('settings-access-overlay').classList.remove('hidden');
  pushBackLayer('settings-access-overlay', () => hideLayer('settings-access-overlay'));
});
$('btn-close-access').addEventListener('click', () => goBackLayer('settings-access-overlay'));
$('access-text-row').addEventListener('click', () => {
  const a = loadA11y();
  try { localStorage.setItem('s19_a11y', JSON.stringify({ ...a, largeText: !a.largeText })); } catch { /* storage unavailable */ }
  applyA11y();
  renderAccessRows();
});
$('access-motion-row').addEventListener('click', () => {
  const a = loadA11y();
  try { localStorage.setItem('s19_a11y', JSON.stringify({ ...a, reduceMotion: !a.reduceMotion })); } catch { /* storage unavailable */ }
  applyA11y();
  renderAccessRows();
});
$('settings-help-row').addEventListener('click', () => {
  $('settings-help-overlay').classList.remove('hidden');
  pushBackLayer('settings-help-overlay', () => hideLayer('settings-help-overlay'));
});
$('btn-close-help').addEventListener('click', () => goBackLayer('settings-help-overlay'));
// Contact us: there is no support email yet, so the app link is copied
// with a note to send it to the admin with the question. Nothing is
// invented here — no fake email address, no dead chat.
$('help-contact-row').addEventListener('click', async () => {
  const link = 'https://s-19-chat-book.onrender.com';
  try {
    await navigator.clipboard.writeText(link);
    toast('App link copied — send it to the admin (Bijoy) with your question');
  } catch {
    toast('App link: ' + link + ' — send it to the admin with your question');
  }
});
// Invite a friend: the system share sheet, with a clipboard fallback.
$('settings-invite-row').addEventListener('click', async () => {
  const link = 'https://s-19-chat-book.onrender.com';
  const text = 'Join me on S_19 CHAT BOOK — free messages and voice calls with friends.';
  try {
    if (navigator.share) {
      await navigator.share({ title: 'S_19 CHAT BOOK', text, url: link });
      return;
    }
    throw new Error('no share sheet');
  } catch (e) {
    if (e && e.name === 'AbortError') return; // user closed the share sheet
    try {
      await navigator.clipboard.writeText(link);
      toast('App link copied — send it to a friend');
    } catch {
      toast('App link: ' + link);
    }
  }
});

// ---- Full-screen profile photo viewer ------------------------------------
// Opens when tapping a profile photo anywhere (see the capture-phase
// avatar handler below, and the Settings photo handler above).
let photoViewerOpen = false;
function openPhotoViewer(src, name) {
  const guard = photoGuardOn();
  $('photo-viewer-img').src = src;
  $('photo-viewer-name').textContent = name || '';
  $('photo-viewer-guarded').classList.toggle('hidden', !guard);
  const dl = $('photo-viewer-download');
  dl.classList.toggle('hidden', guard);
  if (!guard) dl.href = src;
  $('photo-viewer').classList.remove('hidden', 'photo-hidden');
  photoViewerOpen = true;
  pushBackLayer('photo-viewer', closePhotoViewer);
}
function closePhotoViewer() {
  $('photo-viewer').classList.add('hidden');
  $('photo-viewer-img').removeAttribute('src');
  photoViewerOpen = false;
  dismissBackLayer('photo-viewer');
}
$('btn-close-photo-viewer').addEventListener('click', () => goBackLayer('photo-viewer'));
$('photo-viewer').addEventListener('click', (e) => { if (e.target.id === 'photo-viewer') goBackLayer('photo-viewer'); });
// Guarded: no long-press / right-click saving on the photo.
$('photo-viewer-img').addEventListener('contextmenu', (e) => { if (photoGuardOn()) e.preventDefault(); });
// Guarded: hide the photo the moment the app loses focus, show it
// again when the app comes back.
function hideViewerPhoto() { if (photoViewerOpen && photoGuardOn()) $('photo-viewer').classList.add('photo-hidden'); }
function showViewerPhoto() { $('photo-viewer').classList.remove('photo-hidden'); }
document.addEventListener('visibilitychange', () => { if (document.hidden) hideViewerPhoto(); else showViewerPhoto(); });
window.addEventListener('blur', hideViewerPhoto);
window.addEventListener('focus', showViewerPhoto);
// Tapping a profile photo opens the viewer. Capture phase, so the tap
// never also opens the chat, contact info or call underneath.
// Skipped: status rings (tap opens the status), the Tools profile card
// (tap opens Settings), and the Settings photo (its own handler above).
// Avatars with no photo (the brown default icon, emoji avatars) have
// nothing to view, so they do nothing.
document.addEventListener('click', (e) => {
  const av = e.target.closest('.avatar, .profile-avatar, .profile-head-avatar');
  if (!av) return;
  if (av.closest('.status-ring') || av.closest('#tools-profile-card') || av.closest('#settings-avatar-wrap')) return;
  const img = av.querySelector('img');
  if (!img || !img.getAttribute('src')) return;
  e.stopPropagation();
  e.preventDefault();
  let name = '';
  const row = av.closest('.chat-row');
  if (row) {
    const n = row.querySelector('.chat-row-name');
    if (n) name = n.textContent;
  } else if (av.closest('#chat-peer-box')) {
    name = $('chat-peer-name').textContent;
  } else if (av.closest('#profile-overlay')) {
    name = $('profile-name').textContent;
  }
  openPhotoViewer(img.getAttribute('src'), name);
}, true);

async function loadMediaInto(div, m) {
  const wrap = div.querySelector('.msg-media');
  if (!wrap) return;
  // View-once media is never auto-fetched: the receiver taps the
  // placeholder once to open it, and the server deletes the bytes then.
  if (m.view_once) return;
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
    // Share button on the bubble itself (photo + video only). View-once
    // never reaches here (early return above), deleted messages never
    // reach loadMediaInto, and pending bubbles are not loaded — so the
    // button only ever appears on a real, shareable photo/video, own or
    // received, in 1-to-1 chats and groups alike.
    if (kind === 'image' || kind === 'video') addMediaShareBtn(wrap, m);
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
  pushBackLayer('media-viewer', closeMediaViewer);
}
function closeMediaViewer() {
  const vid = $('media-viewer-video');
  vid.pause();
  vid.removeAttribute('src');
  vid.classList.add('hidden');
  $('media-viewer').classList.add('hidden');
  $('media-viewer-img').src = '';
  dismissBackLayer('media-viewer');
}
$('btn-close-media').addEventListener('click', () => goBackLayer('media-viewer'));
$('media-viewer').addEventListener('click', (e) => {
  if (e.target.id === 'media-viewer') goBackLayer('media-viewer');
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
  // Edit mode: save the new text instead of sending a new message.
  // The bubble keeps its original time and gains an "Edited" mark.
  if (editTarget) {
    const target = editTarget;
    cancelReplyEdit();
    $('chat-input').value = '';
    updateMicSend();
    try {
      const r = await api('/api/messages/' + target.id + '/edit', { method: 'POST', body: JSON.stringify({ body }) });
      const m = r.message;
      chatMsgById.set(m.id, m);
      const el = document.querySelector('.msg[data-id="' + m.id + '"]');
      if (el) {
        el.dataset.edited = '1';
        const bodyEl = el.querySelector('.msg-body');
        if (bodyEl) bodyEl.innerHTML = linkify(escapeHtml(m.body));
        el.querySelector('.msg-meta').innerHTML = metaHtml(m);
      }
    } catch (e) {
      toast(e.message === 'too_old' ? 'That message is too old to edit (15 minutes)' : "Couldn't edit it — check your connection and try again");
    }
    return;
  }
  const replyTo = replyTarget ? replyTarget.id : null;
  const replySnapshot = replyTarget ? {
    reply_to: replyTarget.id,
    reply_body: replyLabel(replyTarget),
    reply_sender: replyTarget.sender === session.phone ? 'You' : peerNameOf(replyTarget),
    reply_media_kind: replyTarget.media_kind || '',
  } : null;
  $('chat-input').value = '';
  updateMicSend();
  const tempId = Date.now() + '_' + Math.floor(Math.random() * 1000);
  appendMessage({ body, sender: session.phone, created_at: Date.now(), pending: true, tempId, group_id: activeGroup || undefined, ...replySnapshot });
  cancelReplyEdit();
  try {
    let r;
    if (activeGroup) {
      r = await api('/api/groups/' + activeGroup + '/messages', { method: 'POST', body: JSON.stringify({ body, replyTo }) });
    } else {
      r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ to: activeChat, body, replyTo }) });
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
    outbox.push({ to: activeChat, body, tempId, created_at: Date.now(), replyTo });
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
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); reactionMode = false; reactionTarget = null; return; }
  if (!panel.children.length) {
    for (const em of EMOJIS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = em;
      b.addEventListener('click', () => {
        // Reaction mode (from the action sheet's "more"): the emoji
        // reacts to that message instead of going into the input.
        if (reactionMode) {
          reactionMode = false;
          panel.classList.add('hidden');
          const target = reactionTarget;
          reactionTarget = null;
          if (target) sendReaction(target, em);
          return;
        }
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
      const r = await api('/api/messages', { method: 'POST', body: JSON.stringify({ to: item.to, body: item.body, replyTo: item.replyTo || null }) });
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
// View once: a toggle for the NEXT photo/video only — it turns itself
// off after one send. The menu stays open so you can pick the photo
// right after turning it on. (Screenshots cannot be blocked in a
// browser — the app never claims otherwise.)
function updateViewOnceToggle() {
  $('view-once-state').textContent = viewOnceNext ? 'On' : 'Off';
}
$('attach-view-once').addEventListener('click', () => {
  viewOnceNext = !viewOnceNext;
  updateViewOnceToggle();
  toast(viewOnceNext ? 'View once ON — the next photo or video can be opened only once' : 'View once off');
});
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
  pendingMedia.set(tempId, { kind, file, fileName: file.name, mimeType: file.type, duration: durationSec || 0, groupId: activeGroup || 0, replyTo: replyTarget ? replyTarget.id : null, viewOnce: viewOnceNext });
  const previewUrl = (kind === 'image' || kind === 'video') ? URL.createObjectURL(file) : '';
  appendMessage({
    tempId, sender: session.phone, created_at: Date.now(),
    body: mediaLabel(kind, file.name), media_kind: kind, media_name: file.name,
    media_type: file.type, media_size: file.size, duration: durationSec || 0,
    localPreviewUrl: previewUrl, pending: true, progress: 0, group_id: activeGroup || undefined,
    reply_to: replyTarget ? replyTarget.id : null,
    reply_body: replyTarget ? replyLabel(replyTarget) : '',
    reply_sender: replyTarget ? (replyTarget.sender === session.phone ? 'You' : peerNameOf(replyTarget)) : '',
    reply_media_kind: replyTarget ? (replyTarget.media_kind || '') : '',
    view_once: viewOnceNext ? 1 : 0,
  });
  // The reply and the view-once flag belong to this one send only.
  cancelReplyEdit();
  viewOnceNext = false;
  updateViewOnceToggle();
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
    if (p.replyTo) uploadBody.replyTo = p.replyTo;
    if (p.viewOnce) uploadBody.viewOnce = true;
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
    pushBackLayer('push-dialog', () => hideLayer('push-dialog'));
    $('btn-push-allow').addEventListener('click', async () => {
      hideLayer('push-dialog');
      try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') await subscribePush(reg);
      } catch { /* optional — polling keeps working */ }
    }, { once: true });
    $('btn-push-later').addEventListener('click', () => {
      localStorage.setItem('s19_push_later_at', String(Date.now()));
      hideLayer('push-dialog');
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
const RING_MELODIES = {
  // Classic — the gentle original arc (E–G–A–C–A–G–E–D, ~3.5 s a loop).
  classic: [
    [659.25, 0.30], [783.99, 0.30], [880.00, 0.30], [1046.50, 0.42],
    [880.00, 0.30], [783.99, 0.30], [659.25, 0.30], [587.33, 0.42],
  ],
  // Gentle — a slow, soft C–E–G rise and fall.
  gentle: [
    [523.25, 0.45], [659.25, 0.45], [783.99, 0.55], [659.25, 0.45], [523.25, 0.65],
  ],
  // Bright — a quick, cheerful up-and-down arpeggio.
  bright: [
    [880.00, 0.18], [1046.50, 0.18], [1318.50, 0.18], [1046.50, 0.18],
    [880.00, 0.18], [1174.66, 0.42],
  ],
  // Sunrise — a slow, warm rise, C–E–G–C.
  sunrise: [
    [523.25, 0.50], [659.25, 0.50], [783.99, 0.50], [1046.50, 0.80],
  ],
  // Chime — a bell alternating high C and G.
  chime: [
    [1046.50, 0.25], [783.99, 0.25], [1046.50, 0.25], [783.99, 0.40], [1046.50, 0.50],
  ],
  // Breeze — a light, quick pentatonic run.
  breeze: [
    [659.25, 0.16], [783.99, 0.16], [880.00, 0.16], [987.77, 0.22], [880.00, 0.16], [783.99, 0.28],
  ],
  // Echo — a motif, a pause, then the motif again.
  echo: [
    [880.00, 0.20], [1046.50, 0.20], [null, 0.25], [880.00, 0.20], [1046.50, 0.35],
  ],
  // Harmony — stepping up in thirds.
  harmony: [
    [523.25, 0.25], [659.25, 0.25], [587.33, 0.25], [698.46, 0.25], [659.25, 0.25], [783.99, 0.40],
  ],
  // Lullaby — a slow, gentle waltz, C–E–G–E–C.
  lullaby: [
    [523.25, 0.50], [659.25, 0.50], [783.99, 0.50], [659.25, 0.50], [523.25, 0.70],
  ],
  // Sparkle — fast, high, twinkling arpeggio.
  sparkle: [
    [1046.50, 0.14], [1318.51, 0.14], [1567.98, 0.14], [1318.51, 0.14], [1046.50, 0.30],
  ],
  // Meadow — a folk-like walk, G–A–B–A–G–E.
  meadow: [
    [392.00, 0.28], [440.00, 0.28], [493.88, 0.28], [440.00, 0.28], [392.00, 0.28], [329.63, 0.45],
  ],
  // Ocean — a slow wave, up and back down.
  ocean: [
    [440.00, 0.45], [523.25, 0.45], [659.25, 0.45], [523.25, 0.45], [440.00, 0.60],
  ],
  // Starlight — twinkles with gaps between them.
  starlight: [
    [1318.51, 0.12], [null, 0.12], [1046.50, 0.12], [null, 0.12], [1567.98, 0.18], [1318.51, 0.30],
  ],
  // Festival — an upbeat, cheerful major run.
  festival: [
    [523.25, 0.16], [659.25, 0.16], [783.99, 0.16], [1046.50, 0.30], [783.99, 0.16], [1046.50, 0.40],
  ],
  // Melody — a gentle, song-like line.
  melody: [
    [659.25, 0.30], [783.99, 0.30], [880.00, 0.30], [783.99, 0.30], [659.25, 0.30], [587.33, 0.45],
  ],
  // 8-bit Bounce — a fast, playful staccato arpeggio (same names as the
  // phone's tone list, but original note sequences — not the system files).
  bitbounce: [
    [1046.50, 0.10], [1318.51, 0.10], [1567.98, 0.10], [1318.51, 0.10],
    [1046.50, 0.10], [1567.98, 0.10], [2093.00, 0.18],
  ],
  // Alien — an eerie, slow descending line in close steps.
  alien: [
    [880.00, 0.40], [830.61, 0.40], [783.99, 0.40], [739.99, 0.50], [698.46, 0.60],
  ],
  // Alpha — a simple, clean three-note chime.
  alpha: [
    [523.25, 0.35], [783.99, 0.35], [1046.50, 0.70],
  ],
  // Asteroid — low, deep booming notes.
  asteroid: [
    [196.00, 0.45], [164.81, 0.45], [146.83, 0.55], [130.81, 0.70],
  ],
  // Atomic Bell — bright, high bell-like tones.
  atomicbell: [
    [1567.98, 0.20], [2093.00, 0.20], [1567.98, 0.20], [2093.00, 0.35], [1760.00, 0.45],
  ],
  // Aurora — a soft, shimmering ascent.
  aurora: [
    [659.25, 0.30], [830.61, 0.30], [987.77, 0.30], [1174.66, 0.30], [1318.51, 0.55],
  ],
  // Beep Once — a single short beep.
  beeponce: [
    [880.00, 0.15],
  ],
};
const RING_NAMES = {
  classic: 'Classic', gentle: 'Gentle', bright: 'Bright', sunrise: 'Sunrise',
  chime: 'Chime', breeze: 'Breeze', echo: 'Echo', harmony: 'Harmony',
  lullaby: 'Lullaby', sparkle: 'Sparkle', meadow: 'Meadow', ocean: 'Ocean',
  starlight: 'Starlight', festival: 'Festival', melody: 'Melody',
  bitbounce: '8-bit Bounce', alien: 'Alien', alpha: 'Alpha', asteroid: 'Asteroid',
  atomicbell: 'Atomic Bell', aurora: 'Aurora', beeponce: 'Beep Once',
};
// Short message tones (2–3 notes each). 'ding' is the original beep
// (E–A, 880 + 1174.66) the app has always used.
const MSG_TONES = {
  ding: [[880.00, 0.12], [1174.66, 0.16]],
  pop: [[523.25, 0.10], [783.99, 0.14]],
  chirp: [[1046.50, 0.08], [1318.51, 0.08], [1046.50, 0.12]],
  ping: [[1174.66, 0.10], [880.00, 0.18]],
  bubble: [[392.00, 0.09], [523.25, 0.09], [659.25, 0.14]],
  whistle: [[987.77, 0.12], [1318.51, 0.20]],
};
const MSG_TONE_NAMES = {
  ding: 'Ding', pop: 'Pop', chirp: 'Chirp', ping: 'Ping', bubble: 'Bubble', whistle: 'Whistle',
};
// 'silent' is a valid choice for both pickers: no ring / no beep.
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
function ringPhrase(melody, peak) {
  try {
    if (!ringCtx || !ringGain) return;
    if (ringGain.gain.value === 0) ringGain.gain.setTargetAtTime(1, ringCtx.currentTime, 0.02);
    // No explicit peak: the incoming-call ringtone ('full') scales with
    // the Ringtone volume slider; the caller ringback ('soft') stays as-is.
    const usePeak = peak !== undefined ? peak : (ringMode === 'full' ? RING_VOL.full * ringtoneVolumeFactor() : (RING_VOL[ringMode] || RING_VOL.full));
    const tune = melody || chosenMelody();
    let t = ringCtx.currentTime + 0.05;
    for (const [freq, dur] of tune) {
      if (!freq) { t += dur; continue; } // a rest: silence, just move time on
      ringNote(freq, t, dur, usePeak); t += dur;
    }
  } catch { /* no sound, call still works */ }
}
let ringCustomAudio = null; // { el, url } while a custom file is ringing
function stopCustomRingAudio() {
  try {
    if (ringCustomAudio) {
      ringCustomAudio.el.pause();
      URL.revokeObjectURL(ringCustomAudio.url);
      ringCustomAudio = null;
    }
  } catch { ringCustomAudio = null; }
}
// The built-in WebAudio loop (phrase, pause, phrase…).
function startBuiltinRingLoop() {
  if (!ensureRingAudio()) return;
  if (ringTimerId) { clearInterval(ringTimerId); ringTimerId = null; }
  ringPhrase();
  const loopMs = (chosenMelody().reduce((s, n) => s + n[1], 0) + RING_PAUSE) * 1000;
  ringTimerId = setInterval(() => ringPhrase(), loopMs);
}
// A custom file rings by looping an Audio element. If the file is gone
// or will not play, fall back to the built-in loop so the call still rings.
function startCustomRingAudio(id) {
  getCustomToneBlob(id).then((blob) => {
    if (!blob || ringMode !== 'full') { if (ringMode === 'full') startBuiltinRingLoop(); return; }
    try {
      stopCustomRingAudio();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.loop = true; a.volume = 0.8 * ringtoneVolumeFactor();
      ringCustomAudio = { el: a, url };
      a.play().catch(() => { stopCustomRingAudio(); if (ringMode === 'full') startBuiltinRingLoop(); });
    } catch { if (ringMode === 'full') startBuiltinRingLoop(); }
  }).catch(() => { if (ringMode === 'full') startBuiltinRingLoop(); });
}
function startRinging(mode) {
  // mode 'soft' = quiet ringback for the caller, 'full' = loud ringtone
  // for the callee. Anything else (or no argument) rings full. The caller
  // always hears the soft built-in ringback; the callee hears the chosen
  // ringtone — a built-in melody, a custom file, or nothing (Silent).
  const m = mode === 'soft' ? 'soft' : 'full';
  if (ringMode === m && (ringTimerId || ringCustomAudio)) return; // already ringing this way
  ringMode = m;
  stopCustomRingAudio();
  if (m === 'full') {
    if (!loadNotifSettings().callSound) return;
    const key = loadNotifSettings().ringtone;
    if (key === 'silent') return; // chosen Silent: ring with no sound
    if (key && key.startsWith('custom:')) { startCustomRingAudio(key.slice(7)); return; }
  }
  startBuiltinRingLoop();
}
function stopRinging() {
  if (ringTimerId) { clearInterval(ringTimerId); ringTimerId = null; }
  stopCustomRingAudio();
  ringMode = null;
  try { if (ringGain && ringCtx) ringGain.gain.setTargetAtTime(0, ringCtx.currentTime, 0.02); } catch {}
}
// First tap anywhere unlocks audio, so a later incoming call can ring even
// though it arrives from a background poll with no gesture of its own.
window.addEventListener('pointerdown', () => { ensureRingAudio(); }, { once: true });

// ---- Custom ringtones (per-device, IndexedDB) -------------------------------
// A custom tone's audio bytes live in IndexedDB (too big for localStorage);
// a small registry (id + file name) lives in localStorage so the
// synchronous settings code can validate and name them. Cap: 5 tones,
// 1 MB each. If IndexedDB is unavailable, adding is refused with a
// clear message instead of failing silently.
const CUSTOM_TONE_MAX = 5;
const CUSTOM_TONE_MAX_BYTES = 1024 * 1024; // 1 MB per file
const CUSTOM_TONE_DB = 's19-tones';
const CUSTOM_TONE_TYPES = ['mp3', 'm4a', 'ogg', 'wav'];
function loadCustomToneRegistry() {
  try {
    const list = JSON.parse(localStorage.getItem('s19_custom_tones') || '[]');
    return Array.isArray(list) ? list.filter((t) => t && t.id && t.name) : [];
  } catch { return []; }
}
let customToneRegistry = loadCustomToneRegistry();
function saveCustomToneRegistry() {
  try { localStorage.setItem('s19_custom_tones', JSON.stringify(customToneRegistry)); } catch { /* storage unavailable */ }
}
function customToneMeta(id) { return customToneRegistry.find((t) => t.id === id) || null; }
function customToneDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('Custom tones are not supported in this browser.')); return; }
    let req;
    try { req = window.indexedDB.open(CUSTOM_TONE_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => { try { req.result.createObjectStore('tones', { keyPath: 'id' }); } catch {} };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Could not open the tone storage.'));
  });
}
function idbPutTone(id, blob) {
  return customToneDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('tones', 'readwrite');
    tx.objectStore('tones').put({ id, blob });
    tx.oncomplete = () => { try { db.close(); } catch {} resolve(); };
    tx.onerror = () => reject(tx.error || new Error('Could not save the tone.'));
  }));
}
function idbDeleteTone(id) {
  return customToneDb().then((db) => new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; try { db.close(); } catch {} resolve(); } };
    try {
      const tx = db.transaction('tones', 'readwrite');
      tx.objectStore('tones').delete(id);
      tx.oncomplete = finish; tx.onerror = finish;
    } catch { finish(); }
  })).catch(() => {});
}
function getCustomToneBlob(id) {
  return customToneDb().then((db) => new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { db.close(); } catch {} resolve(v); } };
    try {
      const tx = db.transaction('tones', 'readonly');
      const req = tx.objectStore('tones').get(id);
      req.onsuccess = () => finish(req.result ? req.result.blob : null);
      req.onerror = () => finish(null);
      tx.onerror = () => finish(null);
    } catch { finish(null); }
  })).catch(() => null);
}
// Adds a picked audio file as a custom tone. Throws an Error with a plain
// message when the file is not audio, is over 1 MB, or the 5-tone cap is hit.
async function addCustomTone(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const okType = (file.type && file.type.startsWith('audio/')) || CUSTOM_TONE_TYPES.includes(ext);
  if (!okType) throw new Error('Please pick an audio file (mp3, m4a, ogg or wav).');
  if (file.size > CUSTOM_TONE_MAX_BYTES) throw new Error('That file is over 1 MB — pick a shorter clip.');
  if (customToneRegistry.length >= CUSTOM_TONE_MAX) throw new Error('You already have 5 custom tones — delete one first.');
  const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try { await idbPutTone(id, file); }
  catch (e) { throw new Error(e && e.message ? e.message : 'Custom tones are not supported in this browser.'); }
  const entry = { id, name: (file.name.replace(/\.[^.]+$/, '') || 'Custom tone').slice(0, 60) };
  customToneRegistry.push(entry);
  saveCustomToneRegistry();
  return entry;
}
async function deleteCustomTone(id) {
  customToneRegistry = customToneRegistry.filter((t) => t.id !== id);
  saveCustomToneRegistry();
  await idbDeleteTone(id);
  // A deleted tone that was selected falls back to the built-in default.
  const s = loadNotifSettings();
  if (s.ringtone === 'custom:' + id) saveNotifSettings({ ringtone: 'classic' });
  if (s.msgTone === 'custom:' + id) saveNotifSettings({ msgTone: 'ding' });
}
// One Audio element at a time for custom-tone previews (tap another tone
// and the first one stops).
let previewAudio = null; // { el, url }
function stopPreviewAudio() {
  try {
    if (previewAudio) { previewAudio.el.pause(); URL.revokeObjectURL(previewAudio.url); previewAudio = null; }
  } catch { previewAudio = null; }
}
function playCustomToneOnce(id) {
  getCustomToneBlob(id).then((blob) => {
    if (!blob) { toast('That custom tone is no longer on this phone'); return; }
    try {
      stopPreviewAudio();
      const url = URL.createObjectURL(blob);
      const a = new Audio(url);
      a.volume = ringtoneVolumeFactor();
      previewAudio = { el: a, url };
      a.onended = () => stopPreviewAudio();
      a.play().catch(() => stopPreviewAudio());
    } catch { stopPreviewAudio(); }
  });
}

// ---- Notification settings (Settings → Notifications) -----------------------
// Per-device, in localStorage: message sound, group sound, call ringtone
// on/off, which call ringtone (22 built-ins, Silent, or custom:<id>),
// which message tone (6 built-ins, Silent, or custom:<id>), and the
// ringtone volume (0–100, default 100). Defaults: Classic ringtone,
// Ding message tone.
function validToneKey(key, table) {
  if (key === 'silent') return true;
  if (key && key.startsWith('custom:')) return !!customToneMeta(key.slice(7));
  return !!table[key];
}
function loadNotifSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('s19_notif') || '{}');
    const vol = Number(s.ringtoneVolume);
    return {
      msgSound: s.msgSound !== false,
      groupSound: s.groupSound !== false,
      callSound: s.callSound !== false,
      ringtone: validToneKey(s.ringtone, RING_MELODIES) ? s.ringtone : 'classic',
      msgTone: validToneKey(s.msgTone, MSG_TONES) ? s.msgTone : 'ding',
      ringtoneVolume: Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 100,
    };
  } catch {
    return { msgSound: true, groupSound: true, callSound: true, ringtone: 'classic', msgTone: 'ding', ringtoneVolume: 100 };
  }
}
// Ringtone volume as a 0–1 factor. Applies to built-in ringtone previews
// and the incoming-call ringtone ('full'); the caller ringback ('soft')
// and message tones are unaffected.
function ringtoneVolumeFactor() {
  const v = loadNotifSettings().ringtoneVolume;
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 100)) / 100;
}
function saveNotifSettings(patch) {
  try { localStorage.setItem('s19_notif', JSON.stringify({ ...loadNotifSettings(), ...patch })); } catch { /* storage unavailable */ }
}
function chosenMelody() {
  return RING_MELODIES[loadNotifSettings().ringtone] || RING_MELODIES.classic;
}
function ringtoneDisplayName(key) {
  if (key === 'silent') return 'Silent';
  if (key && key.startsWith('custom:')) { const m = customToneMeta(key.slice(7)); return m ? m.name : 'Custom tone'; }
  return RING_NAMES[key] || 'Classic';
}
function msgToneDisplayName(key) {
  if (key === 'silent') return 'Silent';
  if (key && key.startsWith('custom:')) { const m = customToneMeta(key.slice(7)); return m ? m.name : 'Custom tone'; }
  return MSG_TONE_NAMES[key] || 'Ding';
}
// Play one phrase of a ringtone once, so the user can hear it in the
// ringtone picker. Uses the full volume, scaled by the Ringtone volume slider.
function previewRingtone(key) {
  if (key === 'silent') return; // nothing to hear
  if (key && key.startsWith('custom:')) { playCustomToneOnce(key.slice(7)); return; }
  if (!RING_MELODIES[key]) return;
  if (!ensureRingAudio()) return;
  ringPhrase(RING_MELODIES[key], RING_VOL.full * ringtoneVolumeFactor());
}
// Play a message tone once, so the user can hear it in its picker.
function previewMsgTone(key) {
  if (key === 'silent') return;
  if (key && key.startsWith('custom:')) { playCustomToneOnce(key.slice(7)); return; }
  const tone = MSG_TONES[key];
  if (!tone || !ensureRingAudio()) return;
  let t = ringCtx.currentTime + 0.05;
  for (const [freq, dur] of tone) { ringNote(freq, t, dur, 0.10); t += dur; }
}
// Short message beep: the chosen message tone, quieter than a ringtone.
function playMsgBeep() {
  const key = loadNotifSettings().msgTone;
  if (key === 'silent') return;
  if (key && key.startsWith('custom:')) { playCustomToneOnce(key.slice(7)); return; }
  const tone = MSG_TONES[key] || MSG_TONES.ding;
  if (!ensureRingAudio()) return;
  let t = ringCtx.currentTime + 0.05;
  for (const [freq, dur] of tone) { ringNote(freq, t, dur, 0.10); t += dur; }
}

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
  if (loadNotifSettings().callSound) startRinging('soft'); // caller hears a quiet ringback while waiting
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
            if (!st.muted && loadNotifSettings().callSound) startRinging('full'); // callee hears the full ringtone
          }).catch(() => { if (loadNotifSettings().callSound) startRinging('full'); });
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
    // Tapping a past call calls that person back (WhatsApp-style).
    row.addEventListener('click', () => {
      const name = (conversations.find((c) => c.phone === item.peer) || {}).name || displayId(item.peer);
      startCall(item.peer, name);
    });
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
        hideLayer('status-viewer');
        loadUpdates();
        toast('Status deleted');
      } catch { toast("Couldn't delete"); }
    });
    $('status-viewer').appendChild(del);
  }
  del.classList.toggle('hidden', !s.mine);
  $('status-viewer').classList.remove('hidden');
  pushBackLayer('status-viewer', () => hideLayer('status-viewer'));
}
$('btn-close-status').addEventListener('click', () => goBackLayer('status-viewer'));
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
  pushBackLayer('new-channel-dialog', () => hideLayer('new-channel-dialog'));
});
$('btn-cancel-channel').addEventListener('click', () => goBackLayer('new-channel-dialog'));
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
    hideLayer('new-channel-dialog');
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
  pushBackLayer('channel', closeChannel);
  await api('/api/channels/' + c.id + '/read', { method: 'POST' }).catch(() => {});
  loadChannelPosts();
  loadChannels();
}
function closeChannel() {
  openChannelId = null;
  showScreen('screen-app');
  switchTab('updates');
}
$('btn-back-updates').addEventListener('click', () => goBackLayer('channel'));
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
    const [stats, users, channels, settings, reports] = await Promise.all([
      api('/api/admin/stats'),
      api('/api/admin/users'),
      api('/api/admin/channels'),
      api('/api/admin/settings'),
      api('/api/admin/reports'),
    ]);
    $('admin-stat-users').textContent = bn(stats.users);
    $('admin-stat-messages').textContent = bn(stats.messages);
    $('admin-stat-calls').textContent = bn(stats.calls);
    renderAdminUsers(users.users || []);
    renderAdminChannels(channels.channels || []);
    renderAdminReports(reports.reports || []);
    $('admin-banner-input').value = settings.banner || '';
  } catch { toast("Couldn't load admin info"); }
}
function renderAdminReports(reports) {
  const list = $('admin-reports');
  list.innerHTML = '';
  if (!reports.length) {
    list.innerHTML = '<div class="empty-note">No reports.</div>';
    return;
  }
  for (const r of reports) {
    const row = document.createElement('div');
    row.className = 'chat-row';
    row.innerHTML = '<div class="avatar">⚠️</div>' +
      '<div class="chat-row-body">' +
        '<div class="chat-row-name">' + escapeHtml(r.reportedName || r.reported) + '</div>' +
        '<div class="chat-row-msg">Reported by ' + escapeHtml(r.reporterName || r.reporter) +
        (r.reason ? ' — ' + escapeHtml(r.reason) : '') + ' • ' + fmtDate(r.created_at) + '</div></div>' +
      '<button class="btn-link" style="color:#D32F2F">Block</button>';
    row.querySelector('.btn-link').addEventListener('click', async () => {
      try {
        await api('/api/admin/users/block', { method: 'POST', body: JSON.stringify({ phone: r.reported, blocked: true }) });
        toast('Blocked ' + (r.reportedName || r.reported));
        loadAdmin();
      } catch (e) {
        toast(e.message === 'cannot_block_admin' ? "You can't block an admin" : "Couldn't block");
      }
    });
    list.appendChild(row);
  }
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
