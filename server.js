const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const axios      = require('axios');
require('dotenv').config();

const app = express();

const PAGE_ACCESS_KEY = process.env.PAGE_ACCESS_KEY || 'zoho-sms-2024';

// ============================================================
// CORS — allow all (protection handled by middleware below)
// Same pattern as Quickbase old server (doc 5)
// ============================================================
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  credentials: false
}));

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ============================================================
// CONFIG
// ============================================================
const NS_CONFIG = {
  baseUrl:      process.env.NETSAPIENS_API_URL,
  domain:       process.env.EVENT_SUBSCRIPTION_DOMAIN,
  userId:       process.env.NETSAPIENS_USER_ID,
  bearerToken:  process.env.NETSAPIENS_BEARER_TOKEN,
  fromNumber:   process.env.NETSAPIENS_FROM_NUMBER,
  fixedSession: (process.env.NETSAPIENS_SMS_SESSION_ID || '').toString()
};

// ============================================================
// HELPERS
// ============================================================
function cleanPhone(phone) {
  if (!phone) return '';
  const c = phone.toString().replace(/\D/g, '');
  if (c.length === 11 && c.startsWith('1')) return c.substring(1);
  return c;
}

function normalizeSessionId(sessionId) {
  if (!sessionId) return '';
  if (typeof sessionId === 'bigint') return sessionId.toString();
  if (typeof sessionId === 'number') {
    return sessionId.toLocaleString('fullwide', { maximumFractionDigits: 0 }).replace(/,/g, '');
  }
  return sessionId.toString();
}

function determineDirection(msg, ourNumberClean, targetPhoneClean) {
  const apiDirection = msg.direction || '';
  const fromNumber   = cleanPhone(msg['from-number'] || '');
  const dialedNumber = cleanPhone(msg.dialed || '');

  if (apiDirection === 'orig')           return 'inbound';
  if (apiDirection === 'term')           return 'outbound';
  if (fromNumber === ourNumberClean)     return 'outbound';
  if (fromNumber === targetPhoneClean)   return 'inbound';
  if (dialedNumber === targetPhoneClean) return 'outbound';
  return 'inbound';
}

// ============================================================
// ACCESS DENIED HTML
// ============================================================
const ACCESS_DENIED_HTML = `
<!DOCTYPE html>
<html>
<head><title>Access Denied</title></head>
<body style="font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f7f7f7;">
  <div style="background:white;border:1px solid #ddd;border-radius:8px;padding:60px 40px;text-align:center;max-width:450px;">
    <div style="font-size:48px;margin-bottom:16px;">🔒</div>
    <h2 style="color:#721c24;margin-bottom:12px;">Access Denied</h2>
    <p style="color:#495057;font-size:14px;line-height:1.6;">This page can only be accessed from the Zoho CRM application.</p>
  </div>
</body>
</html>
`;

// ============================================================
// ALLOWED SOURCES — for referer/origin checks
// ============================================================
const ALLOWED_SOURCES = [
  'zohosms.streamtechnologies.in',
  'zoho.in',
  'zoho.com',
  'zohocrm.com',
  'zohoapps.com',
];

// ============================================================
// MIDDLEWARE — protect API endpoints
// ============================================================
function requireZohoOrigin(req, res, next) {
  const referer = req.headers.referer || '';
  const origin  = req.headers.origin  || '';

  const isAllowed = ALLOWED_SOURCES.some(source =>
    referer.includes(source) || origin.includes(source)
  );

  if (isAllowed) return next();
  res.status(403).json({ success: false, error: 'Access denied' });
}

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'Zoho SMS Server - Running', timestamp: new Date().toISOString() });
});

// ============================================================
// SERVE SMS PAGE
// Method 1: Referer/Origin check
// Method 2: Static key fallback (Zoho CRM doesn't always send Referer)
// ============================================================
app.get('/sms-form.html', (req, res) => {
  const referer = req.headers.referer || req.headers.referrer || '';
  const origin  = req.headers.origin  || '';

  const allowedSources = [
    'zohosms.streamtechnologies.in',
    'zoho.in',
    'zoho.com',
    'zohocrm.com',
    'zohoapps.com',
  ];

  const isAllowed = allowedSources.some(source =>
    referer.includes(source) || origin.includes(source)
  );

  if (isAllowed) return res.sendFile(path.join(__dirname, 'public', 'sms-form.html'));

  res.status(403).send(ACCESS_DENIED_HTML);
});

// ============================================================
// SMS API ROUTES
// - history & send: need referer from sms-form page or Zoho
// - no restriction needed since same-origin calls from sms-form
// ============================================================
app.use('/api/sms', (req, res, next) => {
  // ✅ Allow Chrome extension to poll for new messages
  if (req.path === '/new-messages' &&
      req.headers['x-extension-key'] === 'zoho-sms-ext-2024') {
    return next();
  }
 
  // Allow same-origin calls from sms-form page
  const referer = req.headers.referer || '';
  if (referer.includes('zohosms.streamtechnologies.in')) return next();
 
  // Allow from Zoho domains
  requireZohoOrigin(req, res, next);
}, require('./routes/sms'));

// ============================================================
// STATIC FILES
// ============================================================
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// START
// ============================================================
const PORT = process.env.PORT || 4501;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 Zoho SMS Server running on port ${PORT}`);
  console.log(`🔑 Page access key: ${PAGE_ACCESS_KEY}`);
  console.log(`📱 From number:     ${NS_CONFIG.fromNumber}`);
  console.log(`🔗 Session ID:      ${NS_CONFIG.fixedSession}`);
});