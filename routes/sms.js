const express = require('express');
const router = express.Router();
const axios = require('axios');
const auth = require('../middleware/auth');

const NS_CONFIG = {
  baseUrl: process.env.NETSAPIENS_API_URL,
  domain: process.env.EVENT_SUBSCRIPTION_DOMAIN,
  userId: process.env.NETSAPIENS_USER_ID,
  bearerToken: process.env.NETSAPIENS_BEARER_TOKEN,
  fromNumber: process.env.NETSAPIENS_FROM_NUMBER
};

const FIXED_SESSION_ID = (process.env.NETSAPIENS_SMS_SESSION_ID || '').toString();

function cleanPhone(phone) {
  if (!phone) return '';
  const c = phone.toString().replace(/\D/g, '');
  if (c.length === 11 && c.startsWith('1')) return c.substring(1);
  return c;
}
function extKeyAuth(req, res, next) {
    const key = req.headers['x-extension-key'];
    if (key === 'zoho-sms-ext-2024') return next();
    return res.status(401).json({ success: false, error: 'Unauthorized' });
}

function formatPhone(phone) {
  const c = cleanPhone(phone);
  if (c.length === 10) return `(${c.substr(0, 3)}) ${c.substr(3, 3)}-${c.substr(6, 4)}`;
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
  const fromNumber = cleanPhone(msg['from-number'] || '');
  const dialedNumber = cleanPhone(msg.dialed || '');

  if (apiDirection === 'orig') return 'inbound';
  if (apiDirection === 'term') return 'outbound';
  if (fromNumber === ourNumberClean) return 'outbound';
  if (fromNumber === targetPhoneClean) return 'inbound';
  if (dialedNumber === targetPhoneClean) return 'outbound';
  return 'inbound';
}

function isOurConversation(msg, ourNumber, targetPhone) {
  const from = cleanPhone(msg['from-number'] || '');
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

router.get('/player', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Call Recording</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: Arial, sans-serif;
      background: #F5F5F5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1rem;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      border: 1px solid #E5E5E5;
      padding: 2rem;
      width: 100%;
      max-width: 420px;
    }
    .header { display: flex; align-items: center; gap: 12px; margin-bottom: 1.5rem; }
    .avatar {
      width: 40px; height: 40px; border-radius: 50%;
      background: #E8F0FE; display: flex; align-items: center;
      justify-content: center; flex-shrink: 0;
    }
    .title { font-size: 15px; font-weight: 500; color: #111; }
    .subtitle { font-size: 13px; color: #888; margin-top: 2px; }
    .error {
      background: #FEF2F2; border: 1px solid #FECACA;
      border-radius: 8px; padding: 12px; font-size: 13px;
      color: #B91C1C; margin-bottom: 1rem; display: none;
    }
    .times {
      display: flex; justify-content: space-between;
      font-size: 12px; color: #888; margin-bottom: 6px;
    }
    .progress-wrap {
      height: 4px; background: #E5E5E5; border-radius: 2px;
      cursor: pointer; margin-bottom: 1rem; position: relative;
    }
    .progress-fill {
      height: 100%; width: 0%; background: #1A73E8;
      border-radius: 2px; pointer-events: none;
    }
    .controls {
      display: flex; align-items: center;
      justify-content: space-between; margin-bottom: 1.5rem;
    }
    .ctrl-group { display: flex; align-items: center; gap: 8px; }
    .btn-icon {
      background: none; border: none; cursor: pointer;
      padding: 6px; color: #888; display: flex; align-items: center;
    }
    .btn-play {
      width: 44px; height: 44px; border-radius: 50%;
      background: #1A73E8; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .vol-wrap { display: flex; align-items: center; gap: 8px; }
    .actions { display: flex; gap: 8px; }
    .btn-action {
      flex: 1; padding: 8px; border: 1px solid #E5E5E5;
      border-radius: 8px; font-size: 13px; color: #555;
      background: none; cursor: pointer; text-align: center; text-decoration: none;
    }
    audio { display: none; }
  </style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="avatar">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1A73E8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.81a19.79 19.79 0 01-3.07-8.63A2 2 0 012 0h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 14z"/>
      </svg>
    </div>
    <div>
      <div class="title">Call recording</div>
      <div class="subtitle" id="status-label">Loading...</div>
    </div>
  </div>

  <div class="error" id="error-msg"></div>

  <div class="times">
    <span id="current-time">0:00</span>
    <span id="total-time">0:00</span>
  </div>
  <div class="progress-wrap" id="progress-bar">
    <div class="progress-fill" id="progress-fill"></div>
  </div>

  <div class="controls">
    <div class="ctrl-group">
      <button class="btn-icon" id="btn-rewind" title="Back 10s">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#888"><path d="M11.5 12l8.5 6V6l-8.5 6zm-1 6V6l-8.5 6 8.5 6z"/></svg>
      </button>
      <button class="btn-play" id="btn-play">
        <svg id="icon-play" width="18" height="18" viewBox="0 0 24 24" fill="white"><path d="M8 5v14l11-7z"/></svg>
        <svg id="icon-pause" width="18" height="18" viewBox="0 0 24 24" fill="white" style="display:none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
      </button>
      <button class="btn-icon" id="btn-forward" title="Forward 10s">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="#888"><path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/></svg>
      </button>
    </div>
    <div class="vol-wrap">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="#888"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
      <input type="range" id="volume" min="0" max="1" step="0.05" value="1" style="width:70px;">
    </div>
  </div>

  <div class="actions">
    <a class="btn-action" id="btn-download" href="#" download="recording.mp3">Download</a>
    <button class="btn-action" id="btn-speed">Speed: 1x</button>
  </div>

  <audio id="audio"></audio>
</div>

<script>
  const audio = document.getElementById('audio');
  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const progressFill = document.getElementById('progress-fill');
  const currentTimeEl = document.getElementById('current-time');
  const totalTimeEl = document.getElementById('total-time');
  const statusLabel = document.getElementById('status-label');
  const errorMsg = document.getElementById('error-msg');
  const btnDownload = document.getElementById('btn-download');
  const btnSpeed = document.getElementById('btn-speed');
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
  let speedIndex = 2;

  function fmt(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  const params = new URLSearchParams(window.location.search);
  const audioUrl = params.get('audio');

  if (!audioUrl) {
    errorMsg.textContent = 'No audio URL provided.';
    errorMsg.style.display = 'block';
    statusLabel.textContent = 'No URL';
  } else {
    const decoded = decodeURIComponent(audioUrl);
    audio.src = decoded;
    btnDownload.href = decoded;
    statusLabel.textContent = 'Ready';

    audio.addEventListener('loadedmetadata', () => {
      totalTimeEl.textContent = fmt(audio.duration);
    });
    audio.addEventListener('error', () => {
      errorMsg.textContent = 'Could not load audio. The URL may require authentication.';
      errorMsg.style.display = 'block';
      statusLabel.textContent = 'Failed';
    });
    audio.addEventListener('timeupdate', () => {
      if (!audio.duration) return;
      progressFill.style.width = ((audio.currentTime / audio.duration) * 100) + '%';
      currentTimeEl.textContent = fmt(audio.currentTime);
    });
    audio.addEventListener('ended', () => {
      iconPlay.style.display = 'block';
      iconPause.style.display = 'none';
      statusLabel.textContent = 'Finished';
    });

    btnPlay.addEventListener('click', () => {
      if (audio.paused) {
        audio.play();
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
        statusLabel.textContent = 'Playing';
      } else {
        audio.pause();
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        statusLabel.textContent = 'Paused';
      }
    });

    document.getElementById('btn-rewind').addEventListener('click', () => {
      audio.currentTime = Math.max(0, audio.currentTime - 10);
    });
    document.getElementById('btn-forward').addEventListener('click', () => {
      audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
    });
    document.getElementById('progress-bar').addEventListener('click', (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
    });
    document.getElementById('volume').addEventListener('input', (e) => {
      audio.volume = e.target.value;
    });
    btnSpeed.addEventListener('click', () => {
      speedIndex = (speedIndex + 1) % speeds.length;
      audio.playbackRate = speeds[speedIndex];
      btnSpeed.textContent = 'Speed: ' + speeds[speedIndex] + 'x';
    });
  }
<\/script>
</div>
</body>
</html>`);
});

// ── GET /api/sms/history/:phone ───────────────────────────
router.get('/history/:phone', auth, async (req, res) => {
  const phone = req.params.phone;
  const cleanPhone_ = cleanPhone(phone);
  const ourNumber = cleanPhone(NS_CONFIG.fromNumber);
  const allMessages = [];

  console.log(`\n📥 History for: ${cleanPhone_} | ourNumber: ${ourNumber}`);

  try {
    if (FIXED_SESSION_ID) {
      try {
        const url = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${FIXED_SESSION_ID}/messages`;
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
          const msgTime = new Date(msg.timestamp || 0).getTime();
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
    const sessions = Array.isArray(sessionsRes.data) ? sessionsRes.data : [];
    const matchedSessions = sessions.filter(s => {
      const sid = normalizeSessionId(s['messagesession-id']);
      if (sid === FIXED_SESSION_ID) return false;
      return cleanPhone(s['messagesession-remote']) === cleanPhone_;
    });
    console.log(`   Matched sessions: ${matchedSessions.length}`);

    for (const session of matchedSessions) {
      const sid = normalizeSessionId(session['messagesession-id']);
      try {
        const url = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${sid}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        let added = 0;
        messages.forEach((msg, idx) => {
          if (!isOurConversation(msg, ourNumber, cleanPhone_)) return;
          const direction = determineDirection(msg, ourNumber, cleanPhone_);
          const msgTime = new Date(msg.timestamp || 0).getTime();
          if (!isDuplicate(allMessages, msg, direction)) {
            allMessages.push({
              id: msg.id || `session-${sid.substring(0, 8)}-${idx}`,
              text: msg.text || '', from: msg['from-number'] || '',
              to: msg.dialed || '',
              timestamp: msg.timestamp || new Date().toISOString(),
              direction, status: msg.status || 'delivered',
              source: 'matched-session', _rawTime: msgTime
            });
            added++;
          }
        });
        console.log(`   Session ${sid.substring(0, 16)}...: ${added} messages added`);
      } catch (err) {
        console.error(`   ❌ Session ${sid} error: ${err.message}`);
      }
    }

    allMessages.forEach(m => delete m._rawTime);
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    const inbound = allMessages.filter(m => m.direction === 'inbound').length;
    const outbound = allMessages.filter(m => m.direction === 'outbound').length;
    console.log(`   ✅ Total: ${allMessages.length} (in:${inbound} out:${outbound})`);

    res.json({
      success: true, phone: cleanPhone_, messages: allMessages,
      stats: { total: allMessages.length, inbound, outbound }
    });

  } catch (error) {
    console.error('❌ SMS history error:', error.message);
    res.status(500).json({ success: false, error: error.message, messages: [] });
  }
});

// ── POST /api/sms/send ────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Phone and message required' });
  }
  const cleanPhone_ = cleanPhone(phone);
  const apiUrl = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${FIXED_SESSION_ID}/messages`;
  try {
    await axios.post(apiUrl, {
      type: 'sms',
      message: message.trim(),
      destination: cleanPhone_,
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
router.get('/new-messages', extKeyAuth, async (req, res) => {
  const since = req.query.since;
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 60000);
  const ourNumber = cleanPhone(NS_CONFIG.fromNumber);
  const newInbound = [];

  console.log(`\n🔔 Extension poll — since: ${sinceDate.toISOString()}`);

  try {
    // Check fixed session for new inbound messages
    if (FIXED_SESSION_ID) {
      try {
        const url = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${FIXED_SESSION_ID}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        messages.forEach(msg => {
          const msgTime = new Date(msg.timestamp || 0);
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
              id: msg.id || `ext-fixed-${Date.now()}`,
              text: msg.text || '',
              from: msg['from-number'] || '',
              to: msg.dialed || '',
              name: formatPhone(fromClean),
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
    const recent = sessions.filter(s => {
      const sid = normalizeSessionId(s['messagesession-id']);
      if (sid === FIXED_SESSION_ID) return false;
      const lastAct = s['messagesession-last-datetime'];
      return lastAct && new Date(lastAct) >= sinceDate;
    });

    for (const session of recent) {
      const sid = normalizeSessionId(session['messagesession-id']);
      const remoteClean = cleanPhone(session['messagesession-remote'] || '');
      try {
        const url = `${NS_CONFIG.baseUrl}/domains/${NS_CONFIG.domain}/users/${NS_CONFIG.userId}/messagesessions/${sid}/messages`;
        const response = await axios.get(url, {
          headers: { 'Authorization': `Bearer ${NS_CONFIG.bearerToken}` },
          timeout: 10000
        });
        const messages = Array.isArray(response.data) ? response.data : [];
        messages.forEach(msg => {
          const msgTime = new Date(msg.timestamp || 0);
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
              id: msg.id || `ext-${sid.substring(0, 8)}-${Date.now()}`,
              text: msg.text || '',
              from: msg['from-number'] || '',
              to: msg.dialed || '',
              name: formatPhone(remoteClean),
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

    res.json({
      success: true, count: newInbound.length, messages: newInbound,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Extension poll error:', error.message);
    res.status(500).json({ success: false, error: error.message, messages: [] });
  }
});

module.exports = router;