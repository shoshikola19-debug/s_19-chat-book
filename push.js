// S_19 CHAT BOOK — Web Push notifications (web-push)
// ---------------------------------------------------------------------------
// When a message or a call offer arrives, the recipient's browser is
// notified through the push service — even when the app is closed and the
// screen is off (data/WiFi on), like WhatsApp. The notification itself
// never contains a message text, only the sender's name and a generic
// Bengali line; tapping it opens the app, and the app then fetches the
// message / call signal the normal way (polling).
//
// Keys come from the environment only:
//   VAPID_PUBLIC_KEY  — safe to share; the frontend fetches it from
//                       GET /api/push/vapid-public-key
//   VAPID_PRIVATE_KEY — secret; set it in the Render Dashboard only.
//                       It lives in .vapid-private-key.txt (gitignored)
//                       and must never be committed or pasted in chat.
// If either key is missing, push is silently disabled and everything
// works exactly as before (polling while the app is open).

const VAPID_SUBJECT = 'https://s-19-chat-book.onrender.com';

let webpush = null;
let pushEnabled = false;
const publicKey = process.env.VAPID_PUBLIC_KEY || '';

function initPush() {
  const privateKey = process.env.VAPID_PRIVATE_KEY || '';
  if (publicKey && privateKey) {
    try {
      webpush = require('web-push');
      webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
      pushEnabled = true;
    } catch (e) {
      console.log('[push] invalid VAPID keys — push disabled:', e && e.message);
    }
  }
  return pushEnabled;
}

function isPushEnabled() {
  return pushEnabled;
}

function getPublicKey() {
  return pushEnabled ? publicKey : null;
}

// Send one push payload to every subscription of a user. Fire-and-forget
// by design: it never throws, so a push failure can never fail or delay
// the message/signal response. A 410/404 from the push service means the
// subscription is dead (app uninstalled / permission revoked) — it is
// deleted so it is not tried again. Any other failure keeps the
// subscription; the next message will try again.
async function sendPushToUser(db, phone, payload) {
  if (!pushEnabled || !phone) return;
  let subs = [];
  try {
    subs = await db.all('SELECT endpoint, keys FROM push_subscriptions WHERE user_phone = ?', phone);
  } catch (e) {
    console.error('[push] subscription lookup failed:', e && e.message);
    return;
  }
  for (const s of subs) {
    let sub;
    try {
      sub = { endpoint: s.endpoint, keys: JSON.parse(s.keys || '{}') };
    } catch {
      continue;
    }
    if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) continue;
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      const status = e && e.statusCode;
      if (status === 410 || status === 404) {
        try {
          await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
        } catch { /* ignore */ }
      }
      // Other failures (device offline, push service down) — keep the
      // subscription and try again on the next message/call.
    }
  }
}

module.exports = { initPush, isPushEnabled, getPublicKey, sendPushToUser, VAPID_SUBJECT };
