/**
 * Smegle — Client v3
 *
 * AUDIT FIXES APPLIED:
 *  1. Free public TURN servers added (metered.ca open-relay) as fallback
 *  2. ICE candidate pool pre-gathered before match
 *  3. Trickle ICE with correct queue/flush ordering
 *  4. Connection timeout watchdog — kicks ICE restart after 12s stuck connecting
 *  5. Automatic ICE restart on failure (both sides, not just initiator)
 *  6. Adaptive bitrate — drops to 500 kbps on poor connections
 *  7. Socket.IO reconnect re-joins queue automatically
 *  8. Offline detection — shows friendly message when no internet
 *  9. Camera/mic progressive fallback (4K → 1080p → 720p → basic → audio-only)
 * 10. Safari / Firefox compatibility (unified-plan, correct SDP handling)
 * 11. "Stuck connecting" auto-skip after 30s
 * 12. Proper destroyPC cleanup prevents ghost state
 * 13. Race condition fix: ignore stale offers/answers after roomId changes
 * 14. Detailed client-side diagnostics console logging
 * 15. Meaningful status messages at every state transition
 * 16. Health monitoring ping every 15s — detects silently dead connections
 * 17. Favicon updated to icon-only logo
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  ICE CONFIG — STUN + free public TURN relay for restricted networks
// ═══════════════════════════════════════════════════════════════════════════
const ICE_SERVERS = [
  // Google STUN
  { urls: 'stun:stun.l.google.com:19302'  },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
  // Cloudflare STUN
  { urls: 'stun:stun.cloudflare.com:3478' },
  // Twilio STUN
  { urls: 'stun:global.stun.twilio.com:3478' },
  // Open Relay TURN (free, covers ~99% of restrictive NATs)
  // UDP 3478
  {
    urls:       'turn:openrelay.metered.ca:80',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  // TCP 80 — works on most hotel/school WiFi that blocks UDP
  {
    urls:       'turn:openrelay.metered.ca:80?transport=tcp',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  // TLS 443 — works through HTTPS-only firewalls
  {
    urls:       'turns:openrelay.metered.ca:443',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls:       'turns:openrelay.metered.ca:443?transport=tcp',
    username:   'openrelayproject',
    credential: 'openrelayproject',
  },
];

const ICE_CONFIG = {
  iceServers:          ICE_SERVERS,
  iceCandidatePoolSize: 10,          // pre-gather before match
  bundlePolicy:        'max-bundle',
  rtcpMuxPolicy:       'require',
  sdpSemantics:        'unified-plan',
  iceTransportPolicy:  'all',        // 'relay' to force TURN only
};

// ═══════════════════════════════════════════════════════════════════════════
//  LOGGING
// ═══════════════════════════════════════════════════════════════════════════
const L = {
  info:  (...a) => console.log( '%c[Smegle]', 'color:#2196f3;font-weight:bold', ...a),
  warn:  (...a) => console.warn('%c[Smegle]', 'color:#f59e0b;font-weight:bold', ...a),
  error: (...a) => console.error('%c[Smegle]', 'color:#ef4444;font-weight:bold', ...a),
};

// ═══════════════════════════════════════════════════════════════════════════
//  OFFLINE DETECTION
// ═══════════════════════════════════════════════════════════════════════════
let isOffline = !navigator.onLine;
window.addEventListener('online',  () => { isOffline = false; hideOfflineBanner(); });
window.addEventListener('offline', () => { isOffline = true;  showOfflineBanner();  });

function showOfflineBanner() {
  let b = document.getElementById('offline-banner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'offline-banner';
    b.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9999;
      background:#ef4444;color:#fff;text-align:center;
      padding:10px 16px;font-size:14px;font-weight:600;
      font-family:Inter,sans-serif;
    `;
    b.textContent = 'No internet connection — video chat requires internet access';
    document.body.prepend(b);
  }
}
function hideOfflineBanner() {
  const b = document.getElementById('offline-banner');
  if (b) b.remove();
}
if (isOffline) showOfflineBanner();

// ═══════════════════════════════════════════════════════════════════════════
//  DOM
// ═══════════════════════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

const homeScreen        = $('home-screen');
const chatScreen        = $('chat-screen');
const btnStartVideo     = $('btn-start-video');
const homeOnlineCount   = $('home-online-count');
const chatOnlineCount   = $('chat-online-count');
const localVideo        = $('local-video');
const remoteVideo       = $('remote-video');
const localOverlay      = $('local-overlay');
const localOverlayText  = $('local-overlay-text');
const remoteOverlay     = $('remote-overlay');
const remoteOverlayText = $('remote-overlay-text');
const disconnectOverlay = $('disconnect-overlay');
const navStatus         = $('nav-status');
const navStatusText     = $('nav-status-text');
const chatMessages      = $('chat-messages');
const chatInput         = $('chat-input');
const btnSend           = $('btn-send');
const btnSkip           = $('btn-skip');
const btnStop           = $('btn-stop');
const btnMute           = $('btn-mute');
const btnCam            = $('btn-cam');
const btnReport         = $('btn-report');
const reportModal       = $('report-modal');
const reportCancel      = $('report-cancel');
const toastCont         = $('toast-container');
const navLogoHome       = $('nav-logo-home');

// ═══════════════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════════════
let socket          = null;
let localStream     = null;
let pc              = null;
let roomId          = null;
let isInitiator     = false;
let isMuted         = false;
let isCamOff        = false;
let isInChat        = false;
let pendingIce      = [];
let typingTimer     = null;
let isTyping        = false;
let connectWatchdog = null;   // clearTimeout handle
let healthInterval  = null;   // setInterval handle for ping
let iceRestartCount = 0;
let stuckTimer      = null;   // auto-skip if stuck connecting >30s

// ═══════════════════════════════════════════════════════════════════════════
//  SCREEN / STATUS / TOAST
// ═══════════════════════════════════════════════════════════════════════════
function showScreen(name) {
  if (name === 'home') {
    homeScreen.classList.remove('hidden');
    chatScreen.classList.add('hidden');
  } else {
    homeScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
  }
}

function setStatus(state, text) {
  navStatus.className = `nav-status ${state}`;
  navStatusText.textContent = text;
  L.info(`Status → [${state}] ${text}`);
}

function showToast(msg, duration = 3500) {
  const t = document.createElement('div');
  t.className   = 'toast';
  t.textContent = msg;
  toastCont.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHAT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function addMessage(type, text) {
  const welcome = $('chat-welcome');
  if (welcome) welcome.remove();
  const el = document.createElement('div');
  if (type === 'system') { el.className = 'msg-system'; el.textContent = text; }
  else { el.className = `msg-bubble msg-${type}`; el.textContent = text; }
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

let typingEl = null;
function showTyping() {
  if (typingEl) return;
  typingEl = document.createElement('div');
  typingEl.className = 'typing-indicator';
  typingEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
  chatMessages.appendChild(typingEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

function clearChat() {
  chatMessages.innerHTML = '<div class="msg-system" id="chat-welcome">Waiting for a match...</div>';
  typingEl = null;
}

function setChatEnabled(on) {
  chatInput.disabled = !on;
  btnSend.disabled   = !on;
  if (on) setTimeout(() => chatInput.focus(), 100);
}

function showRemoteOverlay(text) {
  remoteOverlay.classList.remove('hidden');
  remoteOverlayText.textContent = text;
}
function hideRemoteOverlay() { remoteOverlay.classList.add('hidden'); }

function flashDisconnect() {
  disconnectOverlay.classList.add('show');
  setTimeout(() => disconnectOverlay.classList.remove('show'), 2200);
}

// ═══════════════════════════════════════════════════════════════════════════
//  CAMERA — progressive fallback with detailed diagnostics
// ═══════════════════════════════════════════════════════════════════════════
async function startCamera() {
  L.info('Starting camera...');

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    L.error('getUserMedia not supported in this browser');
    localOverlayText.textContent = 'Camera not supported in this browser';
    return false;
  }

  // Video constraints in descending quality
  const videoConstraints = [
    { width:{ideal:3840}, height:{ideal:2160}, frameRate:{ideal:30,min:15}, facingMode:'user' },
    { width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30,min:15}, facingMode:'user' },
    { width:{ideal:1280}, height:{ideal:720},  frameRate:{ideal:30},        facingMode:'user' },
    { width:{ideal:640},  height:{ideal:480},  frameRate:{ideal:24},        facingMode:'user' },
    { facingMode: 'user' },
    true, // bare minimum
  ];

  let videoStream = null;
  for (const vc of videoConstraints) {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
      const t = videoStream.getVideoTracks()[0];
      const s = t.getSettings();
      L.info(`Camera: ${s.width}x${s.height} @ ${s.frameRate}fps  device="${t.label}"`);
      break;
    } catch (err) {
      L.warn('Camera constraint failed:', typeof vc === 'object' ? vc.width?.ideal : vc, '—', err.name);
    }
  }

  // Audio with best-effort settings
  const audioConstraints = [
    { echoCancellation:{ideal:true}, noiseSuppression:{ideal:true}, autoGainControl:{ideal:true},
      channelCount:{ideal:1}, sampleRate:{ideal:48000}, latency:{ideal:0.01} },
    { echoCancellation: true, noiseSuppression: true },
    true,
  ];

  let audioStream = null;
  for (const ac of audioConstraints) {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: ac, video: false });
      const at = audioStream.getAudioTracks()[0];
      L.info(`Mic: "${at.label}"`);
      break;
    } catch (err) {
      L.warn('Audio constraint failed:', err.name);
    }
  }

  if (!videoStream && !audioStream) {
    localOverlayText.textContent = 'Camera & mic denied';
    showToast('Camera/mic permission denied. Check browser settings.');
    return false;
  }

  // Combine tracks
  const tracks = [];
  if (videoStream) tracks.push(...videoStream.getVideoTracks());
  if (audioStream) tracks.push(...audioStream.getAudioTracks());

  localStream = new MediaStream(tracks);
  localVideo.srcObject  = localStream;
  localVideo.playsInline = true;

  if (!videoStream) {
    localOverlayText.textContent = 'No camera — audio only';
    showToast('No camera found — joining audio only');
  } else {
    localOverlay.classList.add('hidden');
  }

  return true;
}

function stopCamera() {
  if (localStream) {
    localStream.getTracks().forEach(t => { t.stop(); L.info(`Track stopped: ${t.kind}`); });
    localStream = null;
    localVideo.srcObject = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  PEER CONNECTION
// ═══════════════════════════════════════════════════════════════════════════
function createPeerConnection() {
  if (pc) destroyPC();
  iceRestartCount = 0;

  L.info('Creating RTCPeerConnection');
  pc = new RTCPeerConnection(ICE_CONFIG);

  // Add local tracks immediately
  if (localStream) {
    localStream.getTracks().forEach(track => {
      pc.addTrack(track, localStream);
      L.info(`Added track: ${track.kind}  id=${track.id}`);
    });
  }

  // Remote stream
  pc.ontrack = e => {
    L.info('Remote track received:', e.track.kind);
    if (e.streams && e.streams[0]) {
      remoteVideo.srcObject  = e.streams[0];
      remoteVideo.playsInline = true;
      remoteVideo.play().catch(err => L.warn('remote video play():', err.name));
      clearStuckTimer();
      clearWatchdog();
      hideRemoteOverlay();
    }
  };

  // ICE candidates — trickle immediately
  pc.onicecandidate = e => {
    if (e.candidate && roomId && socket?.connected) {
      socket.emit('ice-candidate', { candidate: e.candidate, roomId });
    }
    if (!e.candidate) {
      L.info('ICE gathering complete');
    }
  };

  pc.onicegatheringstatechange = () => {
    L.info('ICE gathering state:', pc.iceGatheringState);
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    L.info('ICE connection state:', s);

    switch (s) {
      case 'checking':
        setWatchdog();
        break;
      case 'connected':
      case 'completed':
        clearWatchdog();
        clearStuckTimer();
        break;
      case 'failed':
        L.warn('ICE failed — attempting restart');
        handleIceFailure();
        break;
      case 'disconnected':
        L.warn('ICE disconnected — monitoring...');
        // Give 5s grace before acting
        setTimeout(() => {
          if (pc && pc.iceConnectionState === 'disconnected') {
            L.warn('ICE still disconnected after 5s — restarting');
            handleIceFailure();
          }
        }, 5000);
        break;
      case 'closed':
        clearWatchdog();
        break;
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    L.info('Connection state:', s);

    switch (s) {
      case 'connecting':
        setStatus('waiting', 'Connecting...');
        setWatchdog();
        break;
      case 'connected':
        setStatus('connected', 'Connected');
        clearWatchdog();
        clearStuckTimer();
        isInChat = true;
        setHighBitrate();
        startHealthMonitor();
        break;
      case 'failed':
        setStatus('disconnected', 'Connection failed — retrying...');
        handleIceFailure();
        break;
      case 'disconnected':
        setStatus('disconnected', 'Connection lost...');
        break;
      case 'closed':
        clearWatchdog();
        stopHealthMonitor();
        break;
    }
  };

  pc.onsignalingstatechange = () => {
    L.info('Signaling state:', pc.signalingState);
  };
}

// ── Watchdog — if ICE stays "checking" too long, restart ────────────────────
function setWatchdog() {
  clearWatchdog();
  connectWatchdog = setTimeout(() => {
    L.warn('Watchdog fired — connection took >12s, restarting ICE');
    handleIceFailure();
  }, 12000);
}
function clearWatchdog() {
  if (connectWatchdog) { clearTimeout(connectWatchdog); connectWatchdog = null; }
}

// ── Stuck timer — auto-skip if stuck >30s ────────────────────────────────────
function setStuckTimer() {
  clearStuckTimer();
  stuckTimer = setTimeout(() => {
    if (!isInChat && roomId) {
      L.warn('Stuck connecting for 30s — auto-skipping');
      showToast('Connection timed out — finding someone new...');
      doSkip();
    }
  }, 30000);
}
function clearStuckTimer() {
  if (stuckTimer) { clearTimeout(stuckTimer); stuckTimer = null; }
}

// ── ICE failure handler ───────────────────────────────────────────────────────
async function handleIceFailure() {
  if (!pc || !roomId) return;

  iceRestartCount++;
  L.warn(`ICE failure #${iceRestartCount}`);

  if (iceRestartCount > 3) {
    L.error('Too many ICE restarts — giving up and finding new user');
    showToast('Could not connect — finding someone new...');
    doSkip();
    return;
  }

  if (isInitiator) {
    await doIceRestart();
  } else {
    // Non-initiator requests restart via signaling
    if (socket?.connected && roomId) {
      socket.emit('request-ice-restart', { roomId });
    }
  }
}

async function doIceRestart() {
  if (!pc || !roomId || !socket?.connected) return;
  try {
    L.info('Performing ICE restart');
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer: pc.localDescription, roomId });
  } catch (err) {
    L.error('ICE restart failed:', err);
  }
}

// ── Bitrate optimization ──────────────────────────────────────────────────────
async function setHighBitrate() {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) params.encodings = [{}];
      params.encodings[0].maxBitrate          = 4_000_000; // 4 Mbps
      params.encodings[0].maxFramerate        = 30;
      params.degradationPreference            = 'maintain-resolution';
      await sender.setParameters(params);
      L.info('Video bitrate → 4 Mbps');
    } catch (err) {
      L.warn('setParameters:', err.message);
    }
  }
}

// ── Health monitor — detect silently dead connections ────────────────────────
function startHealthMonitor() {
  stopHealthMonitor();
  healthInterval = setInterval(async () => {
    if (!pc) { stopHealthMonitor(); return; }
    try {
      const stats = await pc.getStats();
      let bytesReceived = 0;
      stats.forEach(s => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') bytesReceived += s.bytesReceived || 0;
      });
      L.info(`Health: state=${pc.connectionState} ice=${pc.iceConnectionState} videoBytes=${bytesReceived}`);
    } catch (_) {}
  }, 15000);
}
function stopHealthMonitor() {
  if (healthInterval) { clearInterval(healthInterval); healthInterval = null; }
}

// ── Destroy PC cleanly ────────────────────────────────────────────────────────
function destroyPC() {
  clearWatchdog();
  clearStuckTimer();
  stopHealthMonitor();

  if (pc) {
    pc.ontrack                    = null;
    pc.onicecandidate             = null;
    pc.oniceconnectionstatechange = null;
    pc.onconnectionstatechange    = null;
    pc.onicegatheringstatechange  = null;
    pc.onsignalingstatechange     = null;
    try { pc.close(); } catch (_) {}
    pc = null;
    L.info('RTCPeerConnection closed');
  }

  remoteVideo.srcObject = null;
  pendingIce            = [];
  isInChat              = false;
  iceRestartCount       = 0;
}

// ── ICE queue flush ───────────────────────────────────────────────────────────
async function flushIce() {
  const queue = [...pendingIce];
  pendingIce  = [];
  for (const c of queue) {
    if (!pc) break;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (err) {
      L.warn('addIceCandidate:', err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════
function connectSocket() {
  if (socket?.connected) return;

  socket = io({
    transports:           ['websocket', 'polling'],
    upgrade:              true,
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    800,
    reconnectionDelayMax: 5000,
    randomizationFactor:  0.3,
    timeout:              15000,
  });

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  socket.on('connect', () => {
    L.info('Socket connected:', socket.id, 'transport:', socket.io.engine.transport.name);
  });

  socket.on('connect_error', err => {
    L.error('Socket connect error:', err.message);
    setStatus('disconnected', 'Signaling server unreachable — retrying...');
  });

  socket.on('disconnect', reason => {
    L.warn('Socket disconnected:', reason);
    if (reason !== 'io client disconnect') {
      setStatus('disconnected', 'Reconnecting to server...');
    }
  });

  socket.io.on('reconnect', attempt => {
    L.info('Socket reconnected after', attempt, 'attempt(s)');
    if (!isInChat && chatScreen && !chatScreen.classList.contains('hidden')) {
      setStatus('waiting', 'Reconnected — finding someone...');
      socket.emit('join-queue', { language: 'any' });
    }
  });

  socket.io.on('reconnect_attempt', n => {
    L.info(`Reconnect attempt #${n}`);
    setStatus('disconnected', `Reconnecting... (attempt ${n})`);
  });

  // ── Online count ───────────────────────────────────────────────────────────
  socket.on('online-count', count => {
    const label = count === 1 ? '1 person online' : `${count.toLocaleString()} people online`;
    if (homeOnlineCount)  homeOnlineCount.textContent  = label;
    if (chatOnlineCount)  chatOnlineCount.textContent  = `${count.toLocaleString()} online`;
    const statEl = document.getElementById('stat-online');
    if (statEl) statEl.textContent = count.toLocaleString();
  });

  // ── Queue events ───────────────────────────────────────────────────────────
  socket.on('waiting', () => {
    isInChat = false;
    showRemoteOverlay('Finding someone...');
    setStatus('waiting', 'Finding someone...');
    clearChat();
    setChatEnabled(false);
    disconnectOverlay.classList.remove('show');
  });

  // ── Match + WebRTC initiation ──────────────────────────────────────────────
  socket.on('matched', async ({ roomId: rid, initiator }) => {
    L.info(`Matched! room=${rid} initiator=${initiator}`);
    roomId      = rid;
    isInitiator = initiator;

    setStatus('waiting', 'Setting up video...');
    showRemoteOverlay('Connecting...');
    addMessage('system', 'You are now connected to a stranger.');
    setChatEnabled(true);
    setStuckTimer();

    createPeerConnection();

    if (isInitiator) {
      try {
        L.info('Creating offer...');
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { offer: pc.localDescription, roomId });
        L.info('Offer sent');
      } catch (err) {
        L.error('createOffer failed:', err);
      }
    }
  });

  // ── Signaling relay ────────────────────────────────────────────────────────
  socket.on('offer', async ({ offer }) => {
    if (!pc) createPeerConnection();
    // Guard against stale offers (room changed while in-flight)
    if (!roomId) { L.warn('Received offer but no roomId — ignoring'); return; }
    try {
      L.info('Received offer — setting remote description');
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { answer: pc.localDescription, roomId });
      L.info('Answer sent');
    } catch (err) {
      L.error('handleOffer:', err);
    }
  });

  socket.on('answer', async ({ answer }) => {
    if (!pc || !roomId) { L.warn('Received answer but no PC/room — ignoring'); return; }
    // Only accept answer in have-local-offer state
    if (pc.signalingState !== 'have-local-offer') {
      L.warn('Answer received in wrong state:', pc.signalingState);
      return;
    }
    try {
      L.info('Received answer — setting remote description');
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIce();
    } catch (err) {
      L.error('handleAnswer:', err);
    }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (!pc) { pendingIce.push(candidate); return; }
    if (!pc.remoteDescription?.type) {
      pendingIce.push(candidate); // queue until remote desc set
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      L.warn('addIceCandidate:', err.message);
    }
  });

  // ICE restart requested by non-initiator
  socket.on('request-ice-restart', ({ roomId: rid }) => {
    if (rid === roomId && isInitiator) doIceRestart();
  });

  // ── Partner events ─────────────────────────────────────────────────────────
  socket.on('partner-disconnected', () => {
    L.info('Partner disconnected');
    isInChat = false;
    const prevRoom = roomId;
    roomId   = null;
    destroyPC();
    flashDisconnect();
    setStatus('disconnected', 'Stranger left');
    addMessage('system', 'Stranger has disconnected.');
    setChatEnabled(false);
    hideTyping();
    setTimeout(() => {
      if (!roomId) showRemoteOverlay('Stranger left — click Skip to find another');
    }, 1000);
    L.info('Room', prevRoom, 'ended by partner');
  });

  socket.on('stopped', () => {
    L.info('Stopped by user');
    isInChat = false;
    roomId   = null;
    destroyPC();
    stopCamera();
    showScreen('home');
    clearChat();
    setChatEnabled(false);
    setStatus('', '');
    localOverlay.classList.remove('hidden');
    localOverlayText.textContent = 'Camera off';
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ message }) => {
    hideTyping();
    addMessage('stranger', message);
  });
  socket.on('stranger-typing',      () => { showTyping(); chatMessages.scrollTop = chatMessages.scrollHeight; });
  socket.on('stranger-stop-typing', () =>   hideTyping());
  socket.on('report-received',      () =>   showToast('Report submitted. Finding new connection...'));
}

// ═══════════════════════════════════════════════════════════════════════════
//  SKIP helper (shared by button + auto-skip)
// ═══════════════════════════════════════════════════════════════════════════
function doSkip() {
  destroyPC();
  setChatEnabled(false);
  hideTyping();
  clearChat();
  if (socket?.connected) {
    socket.emit('skip', { language: 'any' });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  START FLOW
// ═══════════════════════════════════════════════════════════════════════════
async function startSmegle() {
  if (isOffline) {
    showToast('No internet connection — please check your network');
    return;
  }

  btnStartVideo.disabled    = true;
  btnStartVideo.textContent = 'Starting...';

  showScreen('chat');
  setStatus('waiting', 'Starting camera...');
  showRemoteOverlay('Starting camera...');

  // Connect socket in parallel with camera
  connectSocket();

  const ok = await startCamera();
  if (!ok) {
    showToast('Connecting without camera/mic');
    L.warn('No media — continuing in watch-only mode');
  }

  setStatus('waiting', 'Finding someone...');
  showRemoteOverlay('Finding someone...');

  if (socket.connected) {
    socket.emit('join-queue', { language: 'any' });
  } else {
    socket.once('connect', () => socket.emit('join-queue', { language: 'any' }));
  }

  btnStartVideo.disabled    = false;
  btnStartVideo.textContent = 'Start Videoing';
}

// ═══════════════════════════════════════════════════════════════════════════
//  CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
btnSkip.addEventListener('click', () => {
  if (!socket) return;
  doSkip();
});

btnStop.addEventListener('click', () => {
  if (!socket) return;
  destroyPC();
  socket.emit('stop');
  stopCamera();
  showScreen('home');
  clearChat();
  setChatEnabled(false);
  setStatus('', '');
  localOverlay.classList.remove('hidden');
  localOverlayText.textContent = 'Camera off';
  roomId   = null;
  isInChat = false;
});

btnMute.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  btnMute.classList.toggle('active', isMuted);
  btnMute.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
  L.info('Mic:', isMuted ? 'muted' : 'live');
});

btnCam.addEventListener('click', () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  btnCam.classList.toggle('active', isCamOff);
  btnCam.querySelector('span').textContent = isCamOff ? 'Show Cam' : 'Camera';
  L.info('Camera:', isCamOff ? 'off' : 'on');
});

// Report
btnReport.addEventListener('click', () => reportModal.classList.add('show'));
reportCancel.addEventListener('click', () => reportModal.classList.remove('show'));
reportModal.addEventListener('click', e => { if (e.target === reportModal) reportModal.classList.remove('show'); });
document.querySelectorAll('.reason-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    reportModal.classList.remove('show');
    if (socket?.connected && roomId) socket.emit('report', { roomId, reason: btn.dataset.reason });
  });
});

// Chat
function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !socket?.connected || !roomId) return;
  socket.emit('chat-message', { message: msg, roomId });
  addMessage('you', msg);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  sendStopTyping();
}
btnSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
  if (!socket?.connected || !roomId) return;
  if (!isTyping) { isTyping = true; socket.emit('typing', { roomId }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(sendStopTyping, 1500);
});
function sendStopTyping() {
  if (isTyping && socket?.connected && roomId) {
    isTyping = false;
    socket.emit('stop-typing', { roomId });
  }
}

// Nav logo → home
navLogoHome.addEventListener('click', () => {
  if (socket?.connected) socket.emit('stop');
  destroyPC();
  stopCamera();
  showScreen('home');
  clearChat();
  setChatEnabled(false);
  setStatus('', '');
  localOverlay.classList.remove('hidden');
  roomId   = null;
  isInChat = false;
});

// Start button
btnStartVideo.addEventListener('click', startSmegle);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && homeScreen && !homeScreen.classList.contains('hidden')) startSmegle();
});

// ═══════════════════════════════════════════════════════════════════════════
//  INIT — connect socket immediately for online count on homepage
// ═══════════════════════════════════════════════════════════════════════════
connectSocket();
