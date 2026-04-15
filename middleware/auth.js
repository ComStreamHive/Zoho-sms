const jwt = require('jsonwebtoken');

module.exports = function (req, res, next) {
    console.log("🔐 AUTH MIDDLEWARE HIT");

    const extensionKey = req.headers['x-extension-key'];
    const queryKey = req.query.key;
    const referer = req.headers.referer || '';

    // console.log({
    //     extensionKey,
    //     queryKey,
    //     authHeader: req.headers['authorization']
    // });

    // ✅ 1. Allow Chrome Extension
    if (extensionKey === 'zoho-sms-ext-2024') {
        console.log("✅ Extension allowed");
        return next();
    }

    // ✅ 2. Allow Zoho page
    if (referer.includes('zohosms.streamtechnologies.in')) {
        console.log("✅ Zoho page allowed");
        return next();
    }

    // ✅ 3. Allow via key
    if (queryKey === 'zoho-sms-2024') {
        console.log("✅ Key allowed");
        return next();
    }

    // 🔐 4. JWT for others
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        console.log("❌ No token");
        return res.status(401).json({ success: false, message: 'No token' });
    }

    const token = authHeader.split(' ')[1];

 try {
    // const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // console.log("✅ JWT valid:", decoded);
    next();
} catch (err) {
    // console.log("❌ JWT ERROR:", err.message);
    return res.status(403).json({ success: false, message: err.message });
}
};