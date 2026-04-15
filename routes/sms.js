const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const auth = require('../middleware/auth');
const activeSessions = {}; 

const NS_CONFIG = {
  baseUrl:     process.env.NETSAPIENS_API_URL,
  domain:      process.env.EVENT_SUBSCRIPTION_DOMAIN,
  userId:      process.env.NETSAPIENS_USER_ID,
  bearerToken: process.env.NETSAPIENS_BEARER_TOKEN,
  fromNumber:  process.env.NETSAPIENS_FROM_NUMBER
};

const FIXED_SESSION_ID = (process.env.NETSAPIENS_SMS_SESSION_ID || '').toString();

function cleanPhone(phone) {
  if (!phone) return '';
  const c = phone.toString().replace(/\D/g, '');
  if (c.length === 11 && c.startsWith('1')) return c.substring(1);
  return c;
}

function formatPhone(phone) {
  const c = cleanPhone(phone);
  if (c.length === 10) return `(${c.substr(0,3)}) ${c.substr(3,3)}-${c.substr(6,4)}`;
  return phone;
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

function isOurConversation(msg, ourNumber, targetPhone) {
  const from   = cleanPhone(msg['from-number'] || '');
  const dialed = cleanPhone(msg.dialed || '');
  return (from === ourNumber && dialed === targetPhone) ||
         (from === targetPhone && dialed === ourNumber);
}

function isDuplicate(allMessages, msg, direction) {
  const msgText = (msg.text || '').trim();
  const msgTime = new Date(msg.timestamp || 0).getTime();
  return allMessages.some(m => {
    if (m.id && msg.id && m.id === msg.id) return true;
    const timeDiff = Math.abs(m._rawTime - msgTime);
    return m.text.trim() === msgText && m.direction === direction && timeDiff < 30000;
  });
}

// ── GET /api/sms/history/:phone ───────────────────────────
router.get('/history/:phone', auth, async (req, res) => {
  const phone       = req.params.phone;
  const cleanPhone_ = cleanPhone(phone);
  const ourNumber   = cleanPhone(NS_CONFIG.fromNumber);
  const allMessages = [];

  console.log(`\n📥 History for: ${cleanPhone_} | ourNumber: ${ourNumber}`);

  try {
    if (FIXED_SESSION_ID) {
      try {
        const url      = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${FIXED_SESSION_ID}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        console.log(`   Fixed session: ${messages.length} total messages`);
        let added = 0;
        messages.forEach((msg, idx) => {
          if (!isOurConversation(msg, ourNumber, cleanPhone_)) return;
          const direction = determineDirection(msg, ourNumber, cleanPhone_);
          const msgTime   = new Date(msg.timestamp || 0).getTime();
          if (!isDuplicate(allMessages, msg, direction)) {
            allMessages.push({
              id: msg.id || `fixed-${idx}`, text: msg.text || '',
              from: msg['from-number'] || '', to: msg.dialed || '',
              timestamp: msg.timestamp || new Date().toISOString(),
              direction, status: msg.status || 'delivered',
              source: 'fixed-session', _rawTime: msgTime
            });
            added++;
          }
        });
        console.log(`   Fixed session: ${added} messages for ${cleanPhone_}`);
      } catch (err) {
        console.error(`   ❌ Fixed session error: ${err.message}`);
      }
    }

    const sessionsUrl = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions`;
    const sessionsRes = await axios.get(sessionsUrl, {
      headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
      timeout: 15000
    });
    const sessions        = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
    const matchedSessions = sessions.filter(s => {
      const sid = normalizeSessionId(s['messagesession-id']);
      if (sid === FIXED_SESSION_ID) return false;
      return cleanPhone(s['messagesession-remote']) === cleanPhone_;
    });
    console.log(`   Matched sessions: ${matchedSessions.length}`);

    for (const session of matchedSessions) {
      const sid = normalizeSessionId(session['messagesession-id']);
      try {
        const url      = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${sid}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        let added = 0;
        messages.forEach((msg, idx) => {
          if (!isOurConversation(msg, ourNumber, cleanPhone_)) return;
          const direction = determineDirection(msg, ourNumber, cleanPhone_);
          const msgTime   = new Date(msg.timestamp || 0).getTime();
          if (!isDuplicate(allMessages, msg, direction)) {
            allMessages.push({
              id: msg.id || `session-${sid.substring(0,8)}-${idx}`,
              text: msg.text || '', from: msg['from-number'] || '',
              to: msg.dialed || '',
              timestamp: msg.timestamp || new Date().toISOString(),
              direction, status: msg.status || 'delivered',
              source: 'matched-session', _rawTime: msgTime
            });
            added++;
          }
        });
        console.log(`   Session ${sid.substring(0,16)}...: ${added} messages added`);
      } catch (err) {
        console.error(`   ❌ Session ${sid} error: ${err.message}`);
      }
    }

    allMessages.forEach(m => delete m._rawTime);
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const inbound  = allMessages.filter(m => m.direction === 'inbound').length;
    const outbound = allMessages.filter(m => m.direction === 'outbound').length;
    console.log(`   ✅ Total: ${allMessages.length} (in:${inbound} out:${outbound})`);

    res.json({ success: true, phone: cleanPhone_, messages: allMessages,
      stats: { total: allMessages.length, inbound, outbound } });

  } catch (error) {
    console.error('❌ SMS history error:', error.message);
    res.status(500).json({ success: false, error: error.message, messages: [] });
  }
});

router.post('/extension/heartbeat', auth, (req, res) => {
    const extension = req.user.extension;

    activeSessions[extension] = {
        userId: req.user.id,
        lastSeen: Date.now()
    };

    return res.json({ success: true });
});

// ── POST /api/sms/send ────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Phone and message required' });
  }
  const cleanPhone_ = cleanPhone(phone);
  const apiUrl      = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${FIXED_SESSION_ID}/messages`;
  try {
    await axios.post(apiUrl, {
      type:          'sms',
      message:       message.trim(),
      destination:   cleanPhone_,
      'from-number': NS_CONFIG.fromNumber
    }, {
      headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });
    console.log(`✅ SMS sent to ${cleanPhone_}`);
    res.json({
      success: true,
      message: {
        id: `sent-${Date.now()}`, text: message.trim(),
        from: NS_CONFIG.fromNumber, to: cleanPhone_,
        timestamp: new Date().toISOString(), direction: 'outbound', status: 'sent'
      }
    });
  } catch (error) {
    console.error('❌ SMS send error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ── GET /api/sms/new-messages ─────────────────────────────
// Used by Chrome extension to poll for new inbound messages
router.get('/new-messages', auth, async (req, res) => {
  const since     = req.query.since;
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 60000);
  const ourNumber = cleanPhone(NS_CONFIG.fromNumber);
  const newInbound = [];

  console.log(`\n🔔 Extension poll — since: ${sinceDate.toISOString()}`);

  try {
    // Check fixed session for new inbound messages
    if (FIXED_SESSION_ID) {
      try {
        const url      = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${FIXED_SESSION_ID}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        messages.forEach(msg => {
          const msgTime  = new Date(msg.timestamp || 0);
          const fromClean = cleanPhone(msg['from-number'] || '');
          if (msgTime < sinceDate) return;
          if (fromClean === ourNumber) return; // skip outbound

          const already = newInbound.some(m => {
            if (m.id === msg.id) return true;
            const dt = Math.abs(new Date(m.timestamp) - msgTime);
            return m.text.trim() === (msg.text || '').trim() && dt < 5000;
          });
          if (!already) {
            newInbound.push({
              id:        msg.id || `ext-fixed-${Date.now()}`,
              text:      msg.text || '',
              from:      msg['from-number'] || '',
              to:        msg.dialed || '',
              name:      formatPhone(fromClean),
              timestamp: msg.timestamp,
              direction: 'inbound'
            });
          }
        });
      } catch (err) {
        console.error(`   ❌ Fixed session error: ${err.message}`);
      }
    }

    // Check all sessions with recent activity
    const sessionsUrl = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions`;
    const sessionsRes = await axios.get(sessionsUrl, {
      headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
      timeout: 15000
    });
    const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
    const recent   = sessions.filter(s => {
      const sid      = normalizeSessionId(s['messagesession-id']);
      if (sid === FIXED_SESSION_ID) return false;
      const lastAct  = s['messagesession-last-datetime'];
      return lastAct && new Date(lastAct) >= sinceDate;
    });

    for (const session of recent) {
      const sid        = normalizeSessionId(session['messagesession-id']);
      const remoteClean = cleanPhone(session['messagesession-remote'] || '');
      try {
        const url      = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${sid}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        messages.forEach(msg => {
          const msgTime   = new Date(msg.timestamp || 0);
          const fromClean = cleanPhone(msg['from-number'] || '');
          if (msgTime < sinceDate) return;
          if (fromClean === ourNumber) return; // skip outbound

          const already = newInbound.some(m => {
            if (m.id === msg.id) return true;
            const dt = Math.abs(new Date(m.timestamp) - msgTime);
            return m.text.trim() === (msg.text || '').trim() && dt < 5000;
          });
          if (!already) {
            newInbound.push({
              id:        msg.id || `ext-${sid.substring(0,8)}-${Date.now()}`,
              text:      msg.text || '',
              from:      msg['from-number'] || '',
              to:        msg.dialed || '',
              name:      formatPhone(remoteClean),
              timestamp: msg.timestamp,
              direction: 'inbound'
            });
          }
        });
      } catch (err) {
        console.error(`   ❌ Session ${sid} error: ${err.message}`);
      }
    }

    newInbound.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    console.log(`   🔔 Found ${newInbound.length} new inbound messages`);

    res.json({ success: true, count: newInbound.length, messages: newInbound,
      checkedAt: new Date().toISOString() });

  } catch (error) {
    console.error('❌ Extension poll error:', error.message);
    res.status(500).json({ success: false, error: error.message, messages: [] });
  }
});

module.exports = router;