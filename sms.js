// S_19 CHAT BOOK — SMS sender stub (Bangladeshi gateways, HTTP API style)
// ---------------------------------------------------------------------------
// This file sends a real OTP SMS when the environment variables are set.
// When they are NOT set, it reports "not_configured" and the server falls
// back to TEST mode (the 6-digit code is shown on screen).
//
// Supported providers (both use a plain HTTP POST API):
//   - "amarsms"   (amarsms.com)    — OTP SMS from ৳0.35, 10 free test SMS
//   - "cloudwave" (cloudwavebd.com) — from ৳0.30/SMS, smallest pack 50 SMS
//
// Required env vars (see .env.example):
//   SMS_PROVIDER   "amarsms" | "cloudwave"
//   SMS_API_URL    gateway send-SMS endpoint URL
//   SMS_API_KEY    API key from the gateway dashboard
//   SMS_SENDER_ID  sender ID / mask (e.g. S_19)
//
// No key, password or credential is stored in this file. Ever.
//
// Each gateway has a slightly different request shape; both are JSON POSTs
// with an api key, a recipient number and a message. If the gateway you
// pick uses different field names, adjust the payload in sendViaGateway()
// to match its docs — the rest of the app only calls sendOtp().

function isConfigured() {
  return Boolean(
    process.env.SMS_PROVIDER &&
    process.env.SMS_API_URL &&
    process.env.SMS_API_KEY,
  );
}

/**
 * Send a 6-digit OTP to a phone number (digits only, with country code,
 * e.g. "8801XXXXXXXXX").
 * Returns { sent: true, provider } on success, or
 * { sent: false, reason } when not configured / failed.
 * Never throws for a gateway failure — the caller decides the fallback.
 */
async function sendOtp(phoneDigits, code) {
  if (!isConfigured()) {
    return { sent: false, reason: 'not_configured' };
  }
  const provider = String(process.env.SMS_PROVIDER || '').toLowerCase();
  const url = process.env.SMS_API_URL;
  const apiKey = process.env.SMS_API_KEY;
  const senderId = process.env.SMS_SENDER_ID || 'S_19';
  const message = `S_19 CHAT BOOK: tomar login code ${code}. Kauke code ta dio na.`;

  // Payload shapes follow each gateway's published HTTP API docs.
  let payload;
  if (provider === 'amarsms') {
    payload = {
      api_key: apiKey,
      sender_id: senderId,
      message,
      mobile: phoneDigits,
      type: 'otp',
    };
  } else if (provider === 'cloudwave') {
    payload = {
      api_key: apiKey,
      sender: senderId,
      message,
      to: phoneDigits,
    };
  } else {
    // Generic fallback: same common fields most Bangladeshi gateways use.
    payload = { api_key: apiKey, sender_id: senderId, message, to: phoneDigits };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* non-JSON reply */ }
    if (!res.ok) {
      console.error('[sms] gateway HTTP', res.status, text.slice(0, 300));
      return { sent: false, reason: 'gateway_http_' + res.status };
    }
    // Most gateways reply with a status/success flag; treat HTTP 200 with
    // an explicit failure field as a failure, otherwise accept it.
    if (body && (body.status === 'failed' || body.success === false || body.error)) {
      console.error('[sms] gateway rejected:', JSON.stringify(body).slice(0, 300));
      return { sent: false, reason: 'gateway_rejected' };
    }
    return { sent: true, provider };
  } catch (err) {
    console.error('[sms] send failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { sendOtp, isConfigured };
