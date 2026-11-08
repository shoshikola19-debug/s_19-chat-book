// S_19 CHAT BOOK — email sender stub (Resend-style HTTP API)
// ---------------------------------------------------------------------------
// This file sends a real 6-digit login code by email when the environment
// variables are set. When they are NOT set, it reports "not_configured"
// and the server falls back to TEST mode (the code is shown on screen).
// Email codes are FREE (unlike SMS, which costs money per message) — that
// is why Gmail login costs nothing while phone login needs an SMS pack.
//
// Supported providers (both are plain HTTP POST APIs):
//   - "resend"  (resend.com) — free tier: 100 emails/day, no card
//   - "generic" — any JSON POST email API (api_key + from + to + subject
//                 + message fields)
//
// Required env vars (see .env.example):
//   EMAIL_PROVIDER  "resend" | "generic"
//   EMAIL_API_URL   send-email endpoint URL, e.g. https://api.resend.com/emails
//   EMAIL_API_KEY   API key from the provider dashboard
//   EMAIL_FROM      sender address shown in the inbox,
//                   e.g. "S_19 CHAT BOOK <login@s19chatbook.app>"
//
// No key, password or credential is stored in this file. Ever.

function isConfigured() {
  return Boolean(
    process.env.EMAIL_PROVIDER &&
    process.env.EMAIL_API_URL &&
    process.env.EMAIL_API_KEY,
  );
}

/**
 * Send a 6-digit OTP to an email address.
 * Returns { sent: true, provider } on success, or
 * { sent: false, reason } when not configured / failed.
 * Never throws for a provider failure — the caller decides the fallback.
 */
async function sendOtp(email, code) {
  if (!isConfigured()) {
    return { sent: false, reason: 'not_configured' };
  }
  const provider = String(process.env.EMAIL_PROVIDER || '').toLowerCase();
  const url = process.env.EMAIL_API_URL;
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM || 'S_19 CHAT BOOK <login@s19chatbook.app>';
  const subject = 'S_19 CHAT BOOK লগইন কোড';
  const message = `S_19 CHAT BOOK: tomar login code ${code}. Kauke code ta dio na. Ei code 10 minute porjonto cholbe.`;

  let headers;
  let payload;
  if (provider === 'resend') {
    // Resend API: POST https://api.resend.com/emails with a Bearer key.
    headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey };
    payload = { from, to: [email], subject, text: message };
  } else {
    // Generic fallback: same common fields most JSON email APIs use.
    headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    payload = { api_key: apiKey, from, to: email, subject, message };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON reply */ }
    if (!res.ok) {
      console.error('[email] API HTTP', res.status, text.slice(0, 300));
      return { sent: false, reason: 'email_http_' + res.status };
    }
    // Resend replies { id: ... } on success and { error: ... } on failure;
    // treat an explicit failure field as a failure, otherwise accept it.
    if (body && (body.error || body.success === false)) {
      console.error('[email] API rejected:', JSON.stringify(body).slice(0, 300));
      return { sent: false, reason: 'email_rejected' };
    }
    return { sent: true, provider };
  } catch (err) {
    console.error('[email] send failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { sendOtp, isConfigured };
