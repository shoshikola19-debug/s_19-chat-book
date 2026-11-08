// S_19 CHAT BOOK — check the email config without sending anything.
// Usage: npm run check-email
//   Reads the EMAIL_* env vars, reports which provider is selected and
//   whether its required values are present, and exits non-zero when the
//   selected provider is missing something. It never sends an email, never
//   prints a password or an API key, and never prints a login code.
//   (On Render, set the vars in Dashboard -> Environment, then check the
//   boot log line "Email mode: REAL EMAIL (smtp)" after a deploy.)

const { isConfigured, smtpConfig } = require('../email');

const provider = String(process.env.EMAIL_PROVIDER || '').toLowerCase();
console.log('provider:', provider || '(none — test-code mode)');
if (provider === 'smtp') {
  const cfg = smtpConfig();
  console.log('smtp host:', cfg.host);
  console.log('smtp port:', cfg.port, cfg.secure ? '(implicit TLS)' : '(STARTTLS)');
  console.log('smtp user:', cfg.user || '(missing)');
  console.log('smtp pass:', cfg.pass ? '(set, hidden)' : '(missing)');
} else if (provider) {
  console.log('api url:', process.env.EMAIL_API_URL ? '(set, hidden)' : '(missing)');
  console.log('api key:', process.env.EMAIL_API_KEY ? '(set, hidden)' : '(missing)');
  console.log('from:', process.env.EMAIL_FROM || '(default)');
}
console.log('configured:', isConfigured());
if (provider && !isConfigured()) {
  console.error('ERROR: EMAIL_PROVIDER is set to "' + provider + '" but its required values are missing.');
  if (provider === 'smtp') {
    console.error('SMTP needs EMAIL_SMTP_USER and EMAIL_SMTP_PASS (the Gmail App Password).');
  } else {
    console.error('This provider needs EMAIL_API_URL and EMAIL_API_KEY.');
  }
  process.exit(1);
}
