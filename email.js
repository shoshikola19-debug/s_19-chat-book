// S_19 CHAT BOOK — email sender (Gmail OAuth2 / Mailjet / Brevo / Resend / generic HTTP API / Gmail SMTP)
// ---------------------------------------------------------------------------
// This file sends a real 6-digit login code by email when the environment
// variables are set. When they are NOT set, it reports "not_configured"
// and the server falls back to TEST mode (the code is shown on screen).
// Email codes are FREE (unlike SMS, which costs money per message) — that
// is why Gmail login costs nothing while phone login needs an SMS pack.
//
// Supported providers:
//   - "gmail_oauth" (Gmail API with OAuth2) — RECOMMENDED: sends through
//     Bijoy's own Gmail (s19chatbook@gmail.com) over HTTPS (port 443),
//     so it works on Render's free tier. No third-party gatekeeper, no
//     phone verification, no trial expiry, no domain needed. The app
//     uses a refresh token (created once with the s19chatbook account)
//     to get a fresh access token for every send. Plain fetch, no new
//     dependency. Setup is in .env.example / README.md — the one thing
//     that must NOT be skipped: the OAuth consent screen must be set
//     to Production/published (NOT Testing), or the refresh token
//     expires after 7 days.
//   - "mailjet" (mailjet.com) — DEAD for us: Mailjet's Compliance team
//     declined the activation request and CLOSED the account (decision
//     final, no appeal). Kept in code as a fallback; it sends over HTTPS
//     (port 443). Free tier: 6,000 emails/month, 200/day, no card.
//     NO domain needed — validate ONE sender email address in Mailjet
//     (they email you a confirmation link) and use that address as
//     EMAIL_FROM. Sends to any Gmail. API keys need NO phone
//     verification (unlike Brevo). Auth is HTTP Basic: API Key as the
//     username, Secret Key as the password. The Secret Key is shown
//     ONCE when created — copy it at once.
//   - "brevo"   (brevo.com) — BLOCKED for us: creating a Brevo API key
//     needs phone verification and the SMS code never arrives on
//     Bijoy's phone (waited, resent, number re-checked — still
//     nothing), so no Brevo key can be made. Kept in code as a
//     fallback; it sends over HTTPS (port 443). Free tier: 300
//     emails/day, no card. NO domain needed — verify ONE sender
//     email address in Brevo (they email you a confirmation link)
//     and use that address as EMAIL_FROM. Sends to any Gmail.
//   - "resend"  (resend.com) — free tier: 100 emails/day, no card.
//     BUT: without a verified domain Resend only sends to the Resend
//     account's own email address, so it CANNOT send codes to just any
//     Gmail. Use "gmail_oauth" for that.
//   - "generic" — any JSON POST email API (api_key + from + to + subject
//                 + message fields)
//   - "smtp"    — Gmail SMTP with an App Password. LOCAL-DEV ONLY:
//                 Render's free tier blocks ALL outbound SMTP ports
//                 (25, 465, 587), so from Render the connection always
//                 times out — it is NOT a wrong password. SMTP still
//                 works when the server runs on your own computer.
//                 Setup: turn on 2-Step Verification on the Google
//                 account, create an App Password (Google Account →
//                 Security → App passwords), and use that 16-character
//                 password as EMAIL_SMTP_PASS.
//
// Required env vars (see .env.example):
//   EMAIL_PROVIDER  "gmail_oauth" | "mailjet" | "brevo" | "resend" | "generic" | "smtp"
//   EMAIL_API_URL   send-email endpoint URL, e.g. https://api.resend.com/emails
//                   (resend / generic only — smtp does not use it, and
//                   brevo defaults to https://api.brevo.com/v3/smtp/email
//                   and mailjet defaults to https://api.mailjet.com/v3.1/send
//                   when it is empty. gmail_oauth uses GMAIL_API_URL
//                   instead, defaulting to the Gmail send endpoint.)
//   EMAIL_API_KEY   API key from the provider dashboard
//                   (resend / generic / brevo / mailjet — not used by smtp
//                   or gmail_oauth)
//   EMAIL_API_SECRET  Mailjet Secret Key (mailjet only — Basic auth
//                   password. Shown once when created; copy it at once.)
//   GMAIL_OAUTH_CLIENT_ID  Google Cloud OAuth client ID (gmail_oauth only)
//   GMAIL_OAUTH_CLIENT_SECRET  Google Cloud OAuth client secret
//                   (gmail_oauth only — shown when the client is created;
//                   treat it like a password, never put it in git)
//   GMAIL_OAUTH_REFRESH_TOKEN  OAuth refresh token for the sending Gmail
//                   account (gmail_oauth only — created once by
//                   authorizing with that account; it does not expire
//                   while the consent screen is Production/published)
//   GMAIL_OAUTH_TOKEN_URL  token endpoint, default
//                   https://oauth2.googleapis.com/token (gmail_oauth only)
//   GMAIL_API_URL  Gmail send endpoint, default
//                   https://gmail.googleapis.com/gmail/v1/users/me/messages/send
//                   (gmail_oauth only)
//   EMAIL_FROM      sender address shown in the inbox,
//                   e.g. "S_19 CHAT BOOK <login@s19chatbook.app>"
//                   (mailjet / brevo: MUST be the sender address
//                   validated/verified in Mailjet/Brevo, e.g.
//                   s19chatbook@gmail.com; gmail_oauth: MUST be the
//                   Gmail account the refresh token belongs to, e.g.
//                   s19chatbook@gmail.com; smtp: defaults
//                   to "S_19 CHAT BOOK <EMAIL_SMTP_USER>")
//   EMAIL_SMTP_HOST  SMTP host, default smtp.gmail.com (smtp only)
//   EMAIL_SMTP_PORT  SMTP port, default 587 (smtp only; use 465 with
//                    EMAIL_SMTP_SECURE=true)
//   EMAIL_SMTP_SECURE  "true" for port 465 (implicit TLS), default "false"
//                    (port 587 uses STARTTLS)
//   EMAIL_SMTP_USER  the Gmail address that sends the codes (smtp only)
//   EMAIL_SMTP_PASS  the 16-character Gmail App Password (smtp only)
//
// No key, password or credential is stored in this file. Ever. The
// password is never logged — not even on failure.

function provider() {
  return String(process.env.EMAIL_PROVIDER || '').toLowerCase();
}

function isConfigured() {
  if (provider() === 'smtp') {
    // SMTP needs only the Gmail account + its App Password.
    return Boolean(process.env.EMAIL_SMTP_USER && process.env.EMAIL_SMTP_PASS);
  }
  if (provider() === 'brevo') {
    // Brevo's endpoint URL has a built-in default, so only the API key
    // is required. (EMAIL_FROM must also be set to the sender address
    // verified in Brevo — the send itself rejects it otherwise.)
    return Boolean(process.env.EMAIL_API_KEY);
  }
  if (provider() === 'mailjet') {
    // Mailjet's endpoint URL has a built-in default; Basic auth needs
    // BOTH the API Key (username) and the Secret Key (password).
    // (EMAIL_FROM must also be set to the sender address validated in
    // Mailjet — the send itself rejects it otherwise.)
    return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_API_SECRET);
  }
  if (provider() === 'gmail_oauth') {
    // Gmail API over HTTPS with OAuth2: the refresh token is exchanged
    // for a fresh access token on every send. All three OAuth values
    // are required; the endpoint URLs have built-in defaults.
    // (EMAIL_FROM must be the Gmail account the refresh token belongs
    // to — the send itself rejects a different From.)
    return Boolean(
      process.env.GMAIL_OAUTH_CLIENT_ID &&
      process.env.GMAIL_OAUTH_CLIENT_SECRET &&
      process.env.GMAIL_OAUTH_REFRESH_TOKEN,
    );
  }
  return Boolean(
    process.env.EMAIL_PROVIDER &&
    process.env.EMAIL_API_URL &&
    process.env.EMAIL_API_KEY,
  );
}

// Brevo wants a plain address in sender.email, but EMAIL_FROM is often
// written as "Name <address>". Pull the address out of the brackets.
function plainEmail(from) {
  const m = String(from || '').match(/<([^<>]+)>/);
  return (m ? m[1] : String(from || '')).trim();
}

function smtpConfig() {
  const secure = String(process.env.EMAIL_SMTP_SECURE || '').toLowerCase() === 'true';
  const port = Number(process.env.EMAIL_SMTP_PORT || '') || (secure ? 465 : 587);
  return {
    host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
    port,
    secure,
    user: process.env.EMAIL_SMTP_USER || '',
    // The password is read here and passed straight to nodemailer; it is
    // never stored in a module variable and never logged.
    pass: process.env.EMAIL_SMTP_PASS || '',
  };
}

/**
 * Send a 6-digit OTP to an email address.
 * Returns { sent: true, provider } on success, or
 * { sent: false, reason } when not configured / failed.
 * Never throws for a provider failure — the caller decides the fallback.
 * The code and the password are never written to any log.
 */
async function sendOtp(email, code) {
  if (!isConfigured()) {
    return { sent: false, reason: 'not_configured' };
  }
  const prov = provider();
  const subject = 'S_19 CHAT BOOK লগইন কোড';
  const message = `S_19 CHAT BOOK: tomar login code ${code}. Kauke code ta dio na. Ei code 10 minute porjonto cholbe.`;

  if (prov === 'smtp') {
    return sendViaSmtp(email, subject, message);
  }

  if (prov === 'brevo') {
    return sendViaBrevo(email, subject, message);
  }

  if (prov === 'mailjet') {
    return sendViaMailjet(email, subject, message);
  }

  if (prov === 'gmail_oauth') {
    return sendViaGmailOAuth(email, subject, message);
  }

  const url = process.env.EMAIL_API_URL;
  const apiKey = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM || 'S_19 CHAT BOOK <login@s19chatbook.app>';

  let headers;
  let payload;
  if (prov === 'resend') {
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
    return { sent: true, provider: prov };
  } catch (err) {
    console.error('[email] send failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }
}

// Brevo transactional email over HTTPS (port 443) — the production path
// on Render's free tier, where outbound SMTP ports are blocked. Plain
// fetch, no new dependency. Brevo replies 201 { messageId } on success
// and 4xx {"message": "...", "code": "..."} on failure.
async function sendViaBrevo(email, subject, message) {
  const url = process.env.EMAIL_API_URL || 'https://api.brevo.com/v3/smtp/email';
  const apiKey = process.env.EMAIL_API_KEY;
  const from = plainEmail(process.env.EMAIL_FROM || 'S_19 CHAT BOOK <login@s19chatbook.app>');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: 'S_19 CHAT BOOK', email: from },
        to: [{ email }],
        subject,
        textContent: message,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Brevo's error body never contains the API key (it travels in a
      // header), so logging the status + body is safe.
      console.error('[email] Brevo HTTP', res.status, text.slice(0, 300));
      return { sent: false, reason: 'email_http_' + res.status };
    }
    return { sent: true, provider: 'brevo' };
  } catch (err) {
    console.error('[email] Brevo send failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }
}

// Mailjet transactional email (Send API v3.1) over HTTPS (port 443) —
// the production path on Render's free tier, where outbound SMTP ports
// are blocked. Plain fetch, no new dependency. Auth is HTTP Basic with
// the API Key as username and the Secret Key as password. Mailjet
// replies 200 { Messages: [{ Status: "success", ... }] } on success
// and 4xx { ErrorMessage: "..." } on failure. Note the CAPITALIZED
// JSON keys (Messages / From / To / TextPart) — that is Mailjet's API.
async function sendViaMailjet(email, subject, message) {
  const url = process.env.EMAIL_API_URL || 'https://api.mailjet.com/v3.1/send';
  const apiKey = process.env.EMAIL_API_KEY;
  const apiSecret = process.env.EMAIL_API_SECRET;
  const from = plainEmail(process.env.EMAIL_FROM || 'S_19 CHAT BOOK <login@s19chatbook.app>');
  // Basic auth: base64("API_KEY:SECRET_KEY"). The key and secret travel
  // only in the Authorization header and are never logged.
  const basic = Buffer.from(apiKey + ':' + apiSecret).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + basic,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        Messages: [{
          From: { Email: from, Name: 'S_19 CHAT BOOK' },
          To: [{ Email: email }],
          Subject: subject,
          TextPart: message,
        }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Mailjet's error body never contains the API key or secret (they
      // travel in a header), so logging the status + body is safe.
      console.error('[email] Mailjet HTTP', res.status, text.slice(0, 300));
      return { sent: false, reason: 'email_http_' + res.status };
    }
    return { sent: true, provider: 'mailjet' };
  } catch (err) {
    console.error('[email] Mailjet send failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }
}

// Encode a header value for RFC2047 (encoded-word) when it holds
// non-ASCII characters — our subject is Bengali, so it always does.
// One encoded-word: =?UTF-8?B?<base64>?= — the subject is short
// enough (~42 UTF-8 bytes -> ~56 base64 chars -> ~68-char word) to
// stay under the 75-character encoded-word limit.
function rfc2047Subject(subject) {
  if (!/[^\x00-\x7F]/.test(subject)) return subject;
  return '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
}

// Gmail's send endpoint wants the whole RFC822 message as base64url
// (base64 with + -> -, / -> _ and no trailing = padding).
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Gmail API with OAuth2 over HTTPS (port 443) — the production path:
// Bijoy's own Gmail (s19chatbook@gmail.com) sends the codes directly,
// so there is no third-party gatekeeper, no phone verification and no
// trial expiry. Plain fetch, no new dependency. Two calls per send:
// (a) refresh the access token with the stored refresh token, then
// (b) send the message. Gmail replies 200 { id } on success and 4xx
// { error: { code, message, ... } } on failure. The client secret,
// refresh token and access token travel only in request bodies/headers
// and are never logged; the login code lives in the message body and
// is never logged either.
async function sendViaGmailOAuth(email, subject, message) {
  const tokenUrl = process.env.GMAIL_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const sendUrl = process.env.GMAIL_API_URL || 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_OAUTH_REFRESH_TOKEN;
  const from = plainEmail(process.env.EMAIL_FROM || 's19chatbook@gmail.com');

  let accessToken;
  try {
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(15000),
    });
    const tokenText = await tokenRes.text();
    if (!tokenRes.ok) {
      // The error body holds only an error code/description — no secret
      // ever comes back from the token endpoint — so logging it is safe.
      console.error('[email] Gmail OAuth token HTTP', tokenRes.status, tokenText.slice(0, 300));
      return { sent: false, reason: 'email_http_' + tokenRes.status };
    }
    let tokenBody = null;
    try { tokenBody = JSON.parse(tokenText); } catch { /* non-JSON reply */ }
    accessToken = tokenBody && tokenBody.access_token;
    if (!accessToken) {
      console.error('[email] Gmail OAuth token reply had no access_token');
      return { sent: false, reason: 'email_rejected' };
    }
  } catch (err) {
    console.error('[email] Gmail OAuth token failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }

  // RFC822 message: From / To / RFC2047-encoded Subject / plain-text
  // body. The From address must be the Gmail account the refresh token
  // belongs to — Gmail rejects a different From.
  const raw = [
    'From: S_19 CHAT BOOK <' + from + '>',
    'To: ' + email,
    'Subject: ' + rfc2047Subject(subject),
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    message,
  ].join('\r\n');

  try {
    const res = await fetch(sendUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: base64url(raw) }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    if (!res.ok) {
      // Gmail's error body never contains the access token (it travels
      // in a header) or the login code (it travels in the base64url
      // raw message), so logging the status + body is safe.
      console.error('[email] Gmail API HTTP', res.status, text.slice(0, 300));
      return { sent: false, reason: 'email_http_' + res.status };
    }
    return { sent: true, provider: 'gmail_oauth' };
  } catch (err) {
    console.error('[email] Gmail API send failed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'network_error' };
  }
}

async function sendViaSmtp(email, subject, message) {
  const cfg = smtpConfig();
  // Gmail only accepts mail from the authenticated account (or one of its
  // verified aliases), so the default sender is the SMTP account itself.
  const from = process.env.EMAIL_FROM || `S_19 CHAT BOOK <${cfg.user}>`;
  let nodemailer;
  try {
    // Lazy require: a missing nodemailer must not break the resend /
    // generic paths (or module load) for installs without the dep.
    nodemailer = require('nodemailer');
  } catch (err) {
    console.error('[email] nodemailer is not installed:', err && err.message ? err.message : err);
    return { sent: false, reason: 'smtp_no_transport' };
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });
  // Hard cap so a stalled SMTP handshake can never hang the login request.
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ sent: false, reason: 'smtp_timeout' }), 20000));
  const send = (async () => {
    try {
      await transporter.sendMail({ from, to: email, subject, text: message });
      return { sent: true, provider: 'smtp' };
    } catch (err) {
      // Log only the error message — never the password or the code.
      console.error('[email] SMTP send failed:', err && err.message ? err.message : err);
      return { sent: false, reason: 'smtp_error' };
    } finally {
      try { transporter.close(); } catch { /* already closed */ }
    }
  })();
  return Promise.race([send, timeout]);
}

module.exports = { sendOtp, isConfigured, smtpConfig };
