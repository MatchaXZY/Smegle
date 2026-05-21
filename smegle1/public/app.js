'use strict';

// ── ICE config — multiple STUN for fastest candidate gathering ──────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Add TURN here for production:
    // { urls: 'turn:your-server.com:3478', username: 'user', credential: 'pass' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy:  'max-bundle',
  rtcpMuxPolicy: 'require',
  sdpSemantics:  'unified-plan',
};

// ── DOM ─────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const homeScreen       = $('home-screen');
const chatScreen       = $('chat-screen');
const btnStartVideo    = $('btn-start-video');
const homeLangSelect   = $('home-lang');
const homeOnlineCount  = $('home-online-count');
const chatOnlineCount  = $('chat-online-count');
const localVideo       = $('local-video');
const remoteVideo      = $('remote-video');
const localOverlay     = $('local-overlay');
const localOverlayText = $('local-overlay-text');
const remoteOverlay    = $('remote-overlay');
const remoteOverlayText= $('remote-overlay-text');
const disconnectOverlay= $('disconnect-overlay');
const navStatus        = $('nav-status');
const navStatusText    = $('nav-status-text');
const chatMessages     = $('chat-messages');
const chatInput        = $('chat-input');
const btnSend          = $('btn-send');
const chatWelcome      = $('chat-welcome');
const chatLangBadge    = $('chat-lang-badge');
const btnSkip          = $('btn-skip');
const btnStop          = $('btn-stop');
const btnMute          = $('btn-mute');
const btnCam           = $('btn-cam');
const btnReport        = $('btn-report');
const reportModal      = $('report-modal');
const reportCancel     = $('report-cancel');
const toastCont        = $('toast-container');
const navLogoHome      = $('nav-logo-home');

// ── App state ────────────────────────────────────────────────────────────────
let socket               = null;
let localStream          = null;
let pc                   = null;
let roomId               = null;
let isInitiator          = false;
let isMuted              = false;
let isCamOff             = false;
let isInChat             = false;
let currentLanguage      = 'any';
let typingTimer          = null;
let isTyping             = false;
let pendingIce           = [];
let audioCtx             = null;
let gainNode             = null;

// ── Language labels ───────────────────────────────────────────────────────────
const LANG_NAMES = {
  any:'Any', en:'English', es:'Spanish', fr:'French', de:'German',
  pt:'Portuguese', it:'Italian', ru:'Russian', ar:'Arabic', zh:'Chinese',
  ja:'Japanese', ko:'Korean', hi:'Hindi', tr:'Turkish', pl:'Polish',
  nl:'Dutch', sv:'Swedish', id:'Indonesian', th:'Thai', vi:'Vietnamese'
};

// ── Screens ──────────────────────────────────────────────────────────────────
function showScreen(name) {
  if (name === 'home') {
    homeScreen.classList.remove('hidden');
    chatScreen.classList.add('hidden');
  } else {
    homeScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
  }
}

// ── Status ───────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  navStatus.className = `nav-status ${state}`;
  navStatusText.textContent = text;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  toastCont.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Chat ─────────────────────────────────────────────────────────────────────
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
  if (on) chatInput.focus();
}

function showRemoteOverlay(text) {
  remoteOverlay.classList.remove('hidden');
  remoteOverlayText.textContent = text;
}
function hideRemoteOverlay() { remoteOverlay.classList.add('hidden'); }

function flashDisconnect() {
  disconnectOverlay.classList.add('show');
  setTimeout(() => disconnectOverlay.classList.remove('show'), 2000);
}

// ════════════════════════════════════════════════════════════════════════════
//  CAMERA — Maximum quality, minimum latency
// ════════════════════════════════════════════════════════════════════════════
async function startCamera() {
  // Try highest quality first, fall back progressively
  const constraints = [
    // 4K 30fps — best quality
    {
      video: {
        width:      { ideal: 3840 },
        height:     { ideal: 2160 },
        frameRate:  { ideal: 30, min: 15 },
        facingMode: 'user',
        // Low latency hint
        latency:    { ideal: 0 },
        resizeMode: 'none',
      },
      audio: false, // audio handled separately below
    },
    // 1080p fallback
    {
      video: {
        width:      { ideal: 1920 },
        height:     { ideal: 1080 },
        frameRate:  { ideal: 30, min: 15 },
        facingMode: 'user',
      },
      audio: false,
    },
    // 720p fallback
    {
      video: {
        width:      { ideal: 1280 },
        height:     { ideal: 720  },
        frameRate:  { ideal: 30   },
        facingMode: 'user',
      },
      audio: false,
    },
    // Basic fallback
    { video: { facingMode: 'user' }, audio: false },
  ];

  let videoStream = null;
  for (const c of constraints) {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia(c);
      const vt = videoStream.getVideoTracks()[0];
      const s  = vt.getSettings();
      console.log(`[Camera] ${s.width}x${s.height} @ ${s.frameRate}fps`);
      break;
    } catch (err) {
      console.warn('[Camera] Constraint failed, trying next:', c.video.width?.ideal, err.message);
    }
  }

  if (!videoStream) {
    localOverlayText.textContent = 'Camera unavailable';
    showToast('Camera permission denied or unavailable');
    return false;
  }

  // ── Audio — best possible mic setup ───────────────────────────────────────
  let audioStream = null;
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation:    { ideal: true },
        noiseSuppression:    { ideal: true },
        autoGainControl:     { ideal: true },
        channelCount:        { ideal: 1 },    // mono — lower latency
        sampleRate:          { ideal: 48000 },
        sampleSize:          { ideal: 16 },
        latency:             { ideal: 0.01 }, // 10ms target latency
      }
    });
  } catch (err) {
    console.warn('[Audio] Could not get optimised audio:', err.message);
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      console.warn('[Audio] No audio available');
    }
  }

  // ── Combine into one stream ────────────────────────────────────────────────
  const tracks = [...videoStream.getVideoTracks()];
  if (audioStream) tracks.push(...audioStream.getAudioTracks());
  localStream = new MediaStream(tracks);

  localVideo.srcObject = localStream;
  // Low-latency playback
  localVideo.playsInline = true;

  localOverlay.classList.add('hidden');
  return true;
}

function stopCamera() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
    localVideo.srcObject = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  WebRTC — optimised for low latency + high quality
// ════════════════════════════════════════════════════════════════════════════
function createPeerConnection() {
  if (pc) destroyPC();

  pc = new RTCPeerConnection(ICE_CONFIG);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  // ── Set high bitrate on sender ────────────────────────────────────────────
  // Done after negotiation — see setHighBitrate()

  // ── Remote stream ─────────────────────────────────────────────────────────
  pc.ontrack = e => {
    if (e.streams && e.streams[0]) {
      remoteVideo.srcObject = e.streams[0];
      // Force low-latency playback
      remoteVideo.playsInline = true;
      remoteVideo.play().catch(() => {});
      hideRemoteOverlay();
    }
  };

  // ── ICE — trickle immediately ──────────────────────────────────────────────
  pc.onicecandidate = e => {
    if (e.candidate && roomId) {
      socket.emit('ice-candidate', { candidate: e.candidate, roomId });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[WebRTC] Connection state:', s);
    if (s === 'connected') {
      setStatus('connected', 'Connected');
      isInChat = true;
      setHighBitrate();
    } else if (s === 'connecting') {
      setStatus('waiting', 'Connecting...');
    } else if (s === 'failed') {
      if (pc.restartIce) pc.restartIce();
    }
  };

  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed' && isInitiator) restartIce();
  };
}

// Push video bitrate as high as browser will allow (~4Mbps target)
async function setHighBitrate() {
  if (!pc) return;
  const senders = pc.getSenders();
  for (const sender of senders) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0].maxBitrate    = 4_000_000; // 4 Mbps
      params.encodings[0].maxFramerate  = 30;
      // Prefer high quality over low latency for video (latency already good)
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
      console.log('[WebRTC] Video bitrate set to 4Mbps');
    } catch (err) {
      console.warn('[WebRTC] setParameters failed:', err);
    }
  }
}

async function restartIce() {
  if (!pc || !roomId) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer: pc.localDescription, roomId });
  } catch (err) {
    console.error('[ICE restart]', err);
  }
}

function destroyPC() {
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
  pendingIce = [];
}

async function flushIce() {
  while (pendingIce.length) {
    const c = pendingIce.shift();
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { /* ignore */ }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SOCKET
// ════════════════════════════════════════════════════════════════════════════
function connectSocket() {
  if (socket && socket.connected) return;

  socket = io({
    transports:           ['websocket', 'polling'],
    upgrade:              true,
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    500,
    reconnectionDelayMax: 3000,
    timeout:              8000,
  });

  socket.on('connect', () => console.log('[Socket] Connected:', socket.id));

  socket.on('disconnect', () => setStatus('disconnected', 'Reconnecting...'));

  socket.on('reconnect', () => {
    if (!isInChat) {
      socket.emit('join-queue', { language: currentLanguage });
      setStatus('waiting', 'Finding someone...');
    }
  });

  // ── Real online count — no fake inflation ─────────────────────────────────
  socket.on('online-count', count => {
    const label = count === 1 ? '1 person online' : `${count.toLocaleString()} people online`;
    homeOnlineCount.textContent = label;
    chatOnlineCount.textContent = `${count.toLocaleString()} online`;
    const statEl = document.getElementById('stat-online');
    if (statEl) statEl.textContent = count.toLocaleString();
  });

  socket.on('waiting', () => {
    isInChat = false;
    showRemoteOverlay('Finding someone...');
    setStatus('waiting', 'Finding someone...');
    clearChat();
    setChatEnabled(false);
    disconnectOverlay.classList.remove('show');
    updateLangBadge();
  });

  socket.on('matched', async ({ roomId: rid, initiator }) => {
    roomId      = rid;
    isInitiator = initiator;
    console.log('[Match] Room:', roomId, '| Initiator:', isInitiator);
    setStatus('waiting', 'Connecting...');
    showRemoteOverlay('Connecting...');
    addMessage('system', 'Connected to a stranger — say hi!');
    setChatEnabled(true);
    createPeerConnection();

    if (isInitiator) {
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { offer: pc.localDescription, roomId });
      } catch (e) { console.error('[offer]', e); }
    }
  });

  socket.on('offer', async ({ offer }) => {
    if (!pc) createPeerConnection();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { answer: pc.localDescription, roomId });
    } catch (e) { console.error('[answer]', e); }
  });

  socket.on('answer', async ({ answer }) => {
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIce();
    } catch (e) { console.error('[answer set]', e); }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (!pc || !pc.remoteDescription?.type) { pendingIce.push(candidate); return; }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) {}
  });

  socket.on('partner-disconnected', () => {
    isInChat = false;
    roomId   = null;
    destroyPC();
    flashDisconnect();
    setStatus('disconnected', 'Stranger left');
    addMessage('system', 'Stranger has disconnected.');
    setChatEnabled(false);
    hideTyping();
    setTimeout(() => showRemoteOverlay('Stranger left — click Skip to find another'), 1000);
  });

  socket.on('stopped', () => {
    isInChat = false;
    roomId   = null;
    destroyPC();
    stopCamera();
    showScreen('home');
    localOverlay.classList.remove('hidden');
    localOverlayText.textContent = 'Starting camera...';
    clearChat();
    setChatEnabled(false);
    setStatus('', 'Starting...');
  });

  socket.on('chat-message', ({ message }) => {
    hideTyping();
    addMessage('stranger', message);
  });

  socket.on('stranger-typing',      () => { showTyping(); chatMessages.scrollTop = chatMessages.scrollHeight; });
  socket.on('stranger-stop-typing', () => hideTyping());

  socket.on('report-received', () => showToast('Report submitted. Finding new connection...'));
}

// ════════════════════════════════════════════════════════════════════════════
//  LANGUAGE BADGE
// ════════════════════════════════════════════════════════════════════════════
function updateLangBadge() {
  const name = LANG_NAMES[currentLanguage] || currentLanguage;
  if (currentLanguage === 'any') {
    chatLangBadge.textContent = '';
    chatLangBadge.style.display = 'none';
  } else {
    chatLangBadge.textContent = name;
    chatLangBadge.style.display = '';
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  START FLOW
// ════════════════════════════════════════════════════════════════════════════
async function startSmegle() {
  currentLanguage = 'any';
  btnStartVideo.disabled   = true;
  btnStartVideo.textContent = 'Starting...';

  showScreen('chat');
  setStatus('waiting', 'Starting camera...');
  showRemoteOverlay('Starting camera...');
  updateLangBadge();

  connectSocket();
  const ok = await startCamera();
  if (!ok) showToast('Continuing without camera');

  setStatus('waiting', 'Finding someone...');
  showRemoteOverlay('Finding someone...');

  if (socket.connected) {
    socket.emit('join-queue', { language: currentLanguage });
  } else {
    socket.once('connect', () => socket.emit('join-queue', { language: currentLanguage }));
  }

  btnStartVideo.disabled    = false;
  btnStartVideo.textContent = 'Start Videoing';
}

// ════════════════════════════════════════════════════════════════════════════
//  CONTROLS
// ════════════════════════════════════════════════════════════════════════════
btnSkip.addEventListener('click', () => {
  if (!socket) return;
  destroyPC();
  setChatEnabled(false);
  hideTyping();
  clearChat();
  socket.emit('skip', { language: currentLanguage });
});

btnStop.addEventListener('click', () => {
  if (!socket) return;
  destroyPC();
  socket.emit('stop');
  stopCamera();
  showScreen('home');
  clearChat();
  setChatEnabled(false);
  setStatus('', 'Starting...');
  localOverlay.classList.remove('hidden');
  localOverlayText.textContent = 'Starting camera...';
  isInChat = false;
  roomId   = null;
});

btnMute.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  btnMute.classList.toggle('active', isMuted);
  btnMute.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
});

btnCam.addEventListener('click', () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !isCamOff);
  btnCam.classList.toggle('active', isCamOff);
  btnCam.querySelector('span').textContent = isCamOff ? 'Show Cam' : 'Camera';
});

btnReport.addEventListener('click', () => reportModal.classList.add('show'));
reportCancel.addEventListener('click', () => reportModal.classList.remove('show'));
reportModal.addEventListener('click', e => { if (e.target === reportModal) reportModal.classList.remove('show'); });
document.querySelectorAll('.reason-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    reportModal.classList.remove('show');
    if (socket && roomId) socket.emit('report', { roomId, reason: btn.dataset.reason });
  });
});

// ── Chat ──────────────────────────────────────────────────────────────────────
function sendMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !socket || !roomId) return;
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
  if (!socket || !roomId) return;
  if (!isTyping) { isTyping = true; socket.emit('typing', { roomId }); }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(sendStopTyping, 1500);
});
function sendStopTyping() {
  if (isTyping && socket && roomId) { isTyping = false; socket.emit('stop-typing', { roomId }); }
}

// ── Nav logo home ─────────────────────────────────────────────────────────────
navLogoHome.addEventListener('click', () => {
  if (socket) socket.emit('stop');
  destroyPC();
  stopCamera();
  showScreen('home');
  clearChat();
  setChatEnabled(false);
  setStatus('', 'Starting...');
  localOverlay.classList.remove('hidden');
  roomId = null; isInChat = false;
});

btnStartVideo.addEventListener('click', startSmegle);
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !homeScreen.classList.contains('hidden')) startSmegle();
});

// Init socket for online count on home page
connectSocket();
