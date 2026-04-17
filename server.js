const express    = require('express');
const cors       = require('cors');
const bodyParser = require('body-parser');
const path       = require('path');
const axios      = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

const PAGE_ACCESS_KEY = process.env.PAGE_ACCESS_KEY || 'zoho-sms-2024';

// ── CORS ──────────────────────────────────────────────────────────────────────
// Must come FIRST — before any route or middleware.
// 'x-extension-key' must be in allowedHeaders or the preflight for
// /api/sms/new-messages will be rejected by the browser.
// OPTIONS must be in methods or preflight for POST /api/sms/send fails.
app.use(cors({
    origin:         '*',
    methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-extension-key'],
    credentials:    false
}));
 app.options('/(.*)', cors());// respond to all preflight requests immediately

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ── Config ────────────────────────────────────────────────────────────────────
const NS_CONFIG = {
    baseUrl:      process.env.NETSAPIENS_API_URL,
    domain:       process.env.EVENT_SUBSCRIPTION_DOMAIN,
    userId:       process.env.NETSAPIENS_USER_ID,
    bearerToken:  process.env.NETSAPIENS_BEARER_TOKEN,
    fromNumber:   process.env.NETSAPIENS_FROM_NUMBER,
    fixedSession: (process.env.NETSAPIENS_SMS_SESSION_ID || '').toString()
};

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── Access control ────────────────────────────────────────────────────────────
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
</html>`;

const ALLOWED_SOURCES = [
    'zohosms.streamtechnologies.in',
    'zoho.in',
    'zoho.com',
    'zohocrm.com',
    'zohoapps.com',
];

function isAllowedSource(req) {
    const referer = req.headers.referer || req.headers.referrer || '';
    const origin  = req.headers.origin  || '';
    return ALLOWED_SOURCES.some(s => referer.includes(s) || origin.includes(s));
}

function requireZohoOrigin(req, res, next) {
    if (isAllowedSource(req)) return next();
    res.status(403).json({ success: false, error: 'Access denied' });
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'Zoho SMS Server - Running', timestamp: new Date().toISOString() });
});

// ── Serve SMS page ────────────────────────────────────────────────────────────
// Access priority:
//   1. ?key=zoho-sms-2024  →  allow  (Chrome extension opens tab with this key)
//   2. trusted referer/origin  →  allow  (Zoho CRM embedded widget)
//   3. everything else  →  block
//
// WHY the key check is needed:
//   When chrome.tabs.create() opens this URL, the browser tab sends 
//   Referer: chrome-extension://[id]/popup.html  which is NOT in ALLOWED_SOURCES.
//   The ?key param is the only signal we have that the request is from our extension.
app.get('/sms-form.html', (req, res) => {
    if (req.query.key === PAGE_ACCESS_KEY) {
        console.log('✅ sms-form.html → served via extension key');
        return res.sendFile(path.join(__dirname, 'public', 'sms-form.html'));
    }
    if (isAllowedSource(req)) {
        console.log('✅ sms-form.html → served via trusted referer');
        return res.sendFile(path.join(__dirname, 'public', 'sms-form.html'));
    }
    console.log(`🔒 sms-form.html blocked | referer="${req.headers.referer}" key="${req.query.key}"`);
    res.status(403).send(ACCESS_DENIED_HTML);
});

app.get('/admin/verify', (req, res) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.json({ success: false, message: 'No token' });

    const token = authHeader.split(' ')[1];
    if (!token) return res.json({ success: false, message: 'No token' });

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        return res.json({ success: true, user: decoded });
    } catch (err) {
        return res.json({ success: false, message: 'Invalid or expired token' });
    }
});

// ── SMS API routes ────────────────────────────────────────────────────────────
// /new-messages  →  Chrome extension background worker (identified by x-extension-key header)
// /history       →  sms-form.html page (same-origin referer: zohosms.streamtechnologies.in)
// /send          →  sms-form.html page (same-origin referer: zohosms.streamtechnologies.in)
// app.use('/api/sms', (req, res, next) => {
//     // Chrome extension polling — identified by custom header
//     if (req.path === '/new-messages' &&
//         req.headers['x-extension-key'] === 'zoho-sms-ext-2024') {
//         return next();
//     }

//     // sms-form.html makes relative fetch() calls — browser sets referer to page origin
//     const referer = req.headers.referer || '';
//     if (referer.includes('zohosms.streamtechnologies.in')) return next();

//     // Zoho CRM domains
//     requireZohoOrigin(req, res, next);
// }, require('./routes/sms'));

app.use('/api/sms', (req, res, next) => {

    // ✅ Extension
    if (req.path === '/new-messages' &&
        req.headers['x-extension-key'] === 'zoho-sms-ext-2024') {
        return next();
    }

    // ✅ Zoho page
    const referer = req.headers.referer || '';
    if (referer.includes('zohosms.streamtechnologies.in')) return next();

    // ✅ NEW: Allow JWT users
    if (req.headers['authorization']) {
        return next();
    }

    // ❌ Block others
    requireZohoOrigin(req, res, next);

}, require('./routes/sms'));

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4501;
app.listen(PORT, '127.0.0.1', () => {
    console.log(`🚀 Zoho SMS Server running on port ${PORT}`);
    console.log(`🔑 Page access key: ${PAGE_ACCESS_KEY}`);
    console.log(`📱 From number:     ${NS_CONFIG.fromNumber}`);
    console.log(`🔗 Session ID:      ${NS_CONFIG.fixedSession}`);
});