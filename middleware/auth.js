const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
    console.log("🔐 AUTH MIDDLEWARE HIT");

    const extensionKey = req.headers['x-extension-key'];
    const queryKey = req.query.key;
    const referer = req.headers.referer || '';

    console.log({
        extensionKey,
        queryKey,
        referer,
        authHeader: req.headers['authorization']
    });

    // ✅ 1. Allow Chrome Extension
    if (extensionKey === 'zoho-sms-ext-2024') {
        console.log("✅ Extension allowed");
        return next();
    }

    // ✅ 2. Allow via query key (from popup click)
    if (queryKey === 'zoho-sms-2024') {
        console.log("✅ Query key allowed");
        return next();
    }

    // ✅ 3. Allow Zoho CRM (more correct check)
    if (referer.includes('zoho.com') || referer.includes('zoho.in')) {
        console.log("✅ Zoho allowed");
        return next();
    }

    // 🔐 4. JWT for others
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        console.log("❌ No token");
        return res.status(401).json({ success: false, message: 'No token' });
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ success: false, message: 'Invalid token format' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        console.log("✅ JWT valid");
        req.user = decoded;
        next();
    } catch (err) {
        console.log("❌ JWT ERROR:", err.message);
        return res.status(403).json({ success: false, message: err.message });
    }
};