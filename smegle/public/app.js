/**
 * Smegle — Frontend App
 * Optimised WebRTC video chat with Socket.IO signaling
 */

'use strict';

// ── ICE configuration ───────────────────────────────────────────────────────
// Multiple STUN servers for faster candidate gathering.
// Add your own TURN credentials below for production NAT traversal.
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:stun4.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // ── TURN (add your own for production) ──────────────────────────────
    // {
    //   urls: 'turn:your-turn-server.com:3478',
    //   username: 'your-username',
    //   credential: 'your-password',
    // },
  ],
  // Pre-gather 10 candidates before connection for faster setup
  iceCandidatePoolSize: 10,
  bundlePolicy:  'max-bundle',
  rtcpMuxPolicy: 'require',
  sdpSemantics:  'unified-plan',
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const homeScreen      = $('home-screen');
const chatScreen      = $('chat-screen');
const btnStartVideo   = $('btn-start-video');
const homeOnlineCount = $('home-online-count');
const chatOnlineCount = $('chat-online-count');

const localVideo    = $('local-video');
const remoteVideo   = $('remote-video');
const localOverlay  = $('local-overlay');
const remoteOverlay = $('remote-overlay');
const remoteOverlayText = $('remote-overlay-text');
const remoteOverlaySub  = $('remote-overlay-sub');
const disconnectOverlay = $('disconnect-overlay');
const remotePanel   = $('remote-panel');

const navStatus     = $('nav-status');
const navStatusText = $('nav-status-text');

const chatMessages  = $('chat-messages');
const chatInput     = $('chat-input');
const btnSend       = $('btn-send');
const chatWelcome   = $('chat-welcome');

const btnSkip   = $('btn-skip');
const btnStop   = $('btn-stop');
const btnMute   = $('btn-mute');
const btnCam    = $('btn-cam');
const btnReport = $('btn-report');

const reportModal  = $('report-modal');
const reportCancel = $('report-cancel');
const toastCont    = $('toast-container');

const navLogoHome  = $('nav-logo-home');

// ── App state ────────────────────────────────────────────────────────────────
let socket       = null;
let localStream  = null;
let pc           = null;          // RTCPeerConnection
let roomId       = null;
let isInitiator  = false;
let isMuted      = false;
let isCamOff     = false;
let isInChat     = false;
let typingTimer  = null;
let isTyping     = false;
let pendingIceCandidates = [];    // Queued before remoteDescription is set

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

// ── Status bar ───────────────────────────────────────────────────────────────
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

// ── Chat helpers ─────────────────────────────────────────────────────────────
function addMessage(type, text) {
  // Remove "waiting" placeholder
  if (chatWelcome && chatWelcome.parentNode === chatMessages) {
    chatWelcome.remove();
  }
  const el = document.createElement('div');
  if (type === 'system') {
    el.className = 'msg-system';
    el.textContent = text;
  } else {
    el.className = `msg-bubble msg-${type}`;
    el.textContent = text;
  }
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

let typingIndicatorEl = null;
function showTypingIndicator() {
  if (typingIndicatorEl) return;
  typingIndicatorEl = document.createElement('div');
  typingIndicatorEl.className = 'typing-indicator';
  typingIndicatorEl.innerHTML = `
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>
    <div class="typing-dot"></div>`;
  chatMessages.appendChild(typingIndicatorEl);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
function hideTypingIndicator() {
  if (typingIndicatorEl) { typingIndicatorEl.remove(); typingIndicatorEl = null; }
}

function clearChat() {
  chatMessages.innerHTML = '<div class="msg-system" id="chat-welcome">Waiting for a match…</div>';
  typingIndicatorEl = null;
}

// ── Enable / disable chat ──────────────────────────────────────────────────
function setChatEnabled(enabled) {
  chatInput.disabled    = !enabled;
  btnSend.disabled      = !enabled;
  if (enabled) chatInput.focus();
}

// ── Remote video overlay control ───────────────────────────────────────────
function showRemoteOverlay(text, sub = '') {
  remoteOverlay.classList.remove('hidden');
  remoteOverlayText.textContent = text;
  remoteOverlaySub.textContent  = sub;
}
function hideRemoteOverlay() {
  remoteOverlay.classList.add('hidden');
}

// ── Disconnect animation ──────────────────────────────────────────────────
function flashDisconnect() {
  disconnectOverlay.classList.add('show');
  setTimeout(() => disconnectOverlay.classList.remove('show'), 2200);
}

// ════════════════════════════════════════════════════════════════════════════
//  CAMERA
// ════════════════════════════════════════════════════════════════════════════
async function startCamera() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width:      { ideal: 1280 },
        height:     { ideal: 720  },
        frameRate:  { ideal: 30   },
        facingMode: 'user',
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
    });
    localVideo.srcObject = localStream;
    localOverlay.classList.add('hidden');
    return true;
  } catch (err) {
    console.error('[Camera] Error:', err);
    localOverlay.querySelector('.overlay-text').textContent =
      err.name === 'NotAllowedError'
        ? 'Camera permission denied'
        : 'Camera unavailable';
    showToast('⚠️ Camera / mic access required');
    return false;
  }
}

function stopCamera() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream  = null;
    localVideo.srcObject = null;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PEER CONNECTION
// ════════════════════════════════════════════════════════════════════════════
function createPeerConnection() {
  if (pc) destroyPeerConnection();

  pc = new RTCPeerConnection(ICE_CONFIG);

  // ── Add local tracks immediately ────────────────────────────────────────
  if (localStream) {
    localStream.getTracks().forEach((track) => {
      pc.addTrack(track, localStream);
    });
  }

  // ── Remote stream ────────────────────────────────────────────────────────
  pc.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      hideRemoteOverlay();
      remotePanel.classList.add('active');
    }
  };

  // ── Trickle ICE — send candidates immediately ────────────────────────────
  pc.onicecandidate = (event) => {
    if (event.candidate && roomId) {
      socket.emit('ice-candidate', { candidate: event.candidate, roomId });
    }
  };

  // ── Connection state logging ─────────────────────────────────────────────
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log('[WebRTC] Connection state:', s);
    switch (s) {
      case 'connecting':
        setStatus('waiting', 'Connecting…');
        break;
      case 'connected':
        setStatus('connected', 'Connected');
        isInChat = true;
        break;
      case 'disconnected':
      case 'failed':
        console.warn('[WebRTC] Connection failed/disconnected, will retry ICE restart');
        if (pc && pc.restartIce) pc.restartIce();
        break;
      case 'closed':
        setStatus('disconnected', 'Disconnected');
        break;
    }
  };

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    console.log('[ICE] State:', s);
    if (s === 'failed') {
      console.warn('[ICE] Failed, attempting ICE restart');
      if (isInitiator) restartIce();
    }
  };

  return pc;
}

async function restartIce() {
  if (!pc || !roomId) return;
  try {
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer: pc.localDescription, roomId });
  } catch (err) {
    console.error('[ICE Restart] Error:', err);
  }
}

function destroyPeerConnection() {
  if (pc) {
    pc.ontrack            = null;
    pc.onicecandidate     = null;
    pc.onconnectionstatechange   = null;
    pc.oniceconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  remoteVideo.srcObject = null;
  remotePanel.classList.remove('active');
  pendingIceCandidates = [];
}

// ── Flush queued ICE candidates (called after setRemoteDescription) ─────────
async function flushPendingIce() {
  while (pendingIceCandidates.length > 0) {
    const candidate = pendingIceCandidates.shift();
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[ICE] Could not add queued candidate:', err);
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  SOCKET.IO — connect + event handlers
// ════════════════════════════════════════════════════════════════════════════
function connectSocket() {
  if (socket && socket.connected) return;

  socket = io({
    transports:    ['websocket', 'polling'],
    upgrade:       true,
    reconnection:  true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    500,
    reconnectionDelayMax: 3000,
    timeout:       8000,
  });

  // ── Connection lifecycle ─────────────────────────────────────────────────
  socket.on('connect', () => {
    console.log('[Socket] Connected:', socket.id);
  });

  socket.on('disconnect', (reason) => {
    console.warn('[Socket] Disconnected:', reason);
    setStatus('disconnected', 'Reconnecting…');
  });

  socket.on('reconnect', () => {
    console.log('[Socket] Reconnected');
    // Re-join queue if we were in one
    if (!isInChat) {
      socket.emit('join-queue');
      setStatus('waiting', 'Finding someone…');
    }
  });

  // ── Online count ─────────────────────────────────────────────────────────
  socket.on('online-count', (count) => {
    const formatted = count.toLocaleString();
    homeOnlineCount.textContent = `${formatted} people online now`;
    chatOnlineCount.textContent = `${formatted} online`;
  });

  // ── Queue / matchmaking ──────────────────────────────────────────────────
  socket.on('waiting', () => {
    isInChat = false;
    showRemoteOverlay('Finding someone…', 'Please wait');
    setStatus('waiting', 'Finding someone…');
    clearChat();
    setChatEnabled(false);
    disconnectOverlay.classList.remove('show');
  });

  socket.on('matched', async ({ roomId: rid, initiator }) => {
    roomId      = rid;
    isInitiator = initiator;
    console.log('[Match] Room:', roomId, '| Initiator:', isInitiator);

    setStatus('waiting', 'Connecting…');
    showRemoteOverlay('Connecting…', 'Setting up video');
    addMessage('system', 'Connected to a stranger — say hi! 👋');
    setChatEnabled(true);

    createPeerConnection();

    if (isInitiator) {
      // Create offer immediately
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        socket.emit('offer', { offer: pc.localDescription, roomId });
        console.log('[WebRTC] Offer sent');
      } catch (err) {
        console.error('[WebRTC] createOffer error:', err);
      }
    }
  });

  // ── WebRTC signaling ─────────────────────────────────────────────────────
  socket.on('offer', async ({ offer }) => {
    console.log('[WebRTC] Received offer');
    if (!pc) createPeerConnection();
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushPendingIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { answer: pc.localDescription, roomId });
      console.log('[WebRTC] Answer sent');
    } catch (err) {
      console.error('[WebRTC] handleOffer error:', err);
    }
  });

  socket.on('answer', async ({ answer }) => {
    console.log('[WebRTC] Received answer');
    if (!pc) return;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushPendingIce();
    } catch (err) {
      console.error('[WebRTC] handleAnswer error:', err);
    }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
      // Queue until remote description is set
      pendingIceCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[ICE] Could not add candidate:', err);
    }
  });

  // ── Partner disconnect ───────────────────────────────────────────────────
  socket.on('partner-disconnected', () => {
    console.log('[Match] Partner disconnected');
    isInChat = false;
    roomId   = null;
    destroyPeerConnection();
    flashDisconnect();
    setStatus('disconnected', 'Stranger left');
    addMessage('system', 'Stranger has disconnected.');
    setChatEnabled(false);
    hideTypingIndicator();
    // Show waiting overlay after brief pause for disconnect animation
    setTimeout(() => {
      showRemoteOverlay('Stranger left', 'Click Skip to find a new one');
    }, 800);
  });

  socket.on('stopped', () => {
    isInChat = false;
    roomId   = null;
    destroyPeerConnection();
    stopCamera();
    showScreen('home');
    localOverlay.classList.remove('hidden');
    localOverlay.querySelector('.overlay-text').textContent = 'Starting camera…';
    clearChat();
    setChatEnabled(false);
    setStatus('', 'Initialising…');
  });

  // ── Chat ─────────────────────────────────────────────────────────────────
  socket.on('chat-message', ({ message }) => {
    hideTypingIndicator();
    addMessage('stranger', message);
  });

  socket.on('stranger-typing', () => {
    showTypingIndicator();
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });

  socket.on('stranger-stop-typing', () => {
    hideTypingIndicator();
  });

  // ── Report ────────────────────────────────────────────────────────────────
  socket.on('report-received', () => {
    showToast('✅ Report submitted. Finding new connection…');
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  START FLOW — one click, instant camera + queue
// ════════════════════════════════════════════════════════════════════════════
async function startSmegle() {
  btnStartVideo.disabled  = true;
  btnStartVideo.textContent = 'Starting…';

  // Show chat screen immediately
  showScreen('chat');
  setStatus('waiting', 'Starting camera…');
  showRemoteOverlay('Finding someone…', 'Starting camera first');

  // Connect socket in parallel with camera start
  connectSocket();

  // Start camera
  const cameraOk = await startCamera();

  if (!cameraOk) {
    // Still go into chat screen but without video
    showToast('Continuing without camera — audio only');
  }

  // Join matchmaking queue immediately
  setStatus('waiting', 'Finding someone…');
  showRemoteOverlay('Finding someone…', 'Please wait');

  // Socket may not be connected yet — wait briefly
  if (socket.connected) {
    socket.emit('join-queue');
  } else {
    socket.once('connect', () => socket.emit('join-queue'));
  }

  btnStartVideo.disabled  = false;
  btnStartVideo.textContent = '▶ \u00a0Start Videoing';
}

// ════════════════════════════════════════════════════════════════════════════
//  CONTROLS
// ════════════════════════════════════════════════════════════════════════════
btnSkip.addEventListener('click', () => {
  if (!socket) return;
  destroyPeerConnection();
  setChatEnabled(false);
  hideTypingIndicator();
  clearChat();
  socket.emit('skip');
});

btnStop.addEventListener('click', () => {
  if (!socket) return;
  destroyPeerConnection();
  socket.emit('stop');
  // UI reset handled in socket 'stopped' handler
  isInChat = false;
  roomId   = null;
  stopCamera();
  showScreen('home');
  clearChat();
  setChatEnabled(false);
  setStatus('', 'Initialising…');
  localOverlay.classList.remove('hidden');
  localOverlay.querySelector('.overlay-text').textContent = 'Starting camera…';
});

btnMute.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach((t) => (t.enabled = !isMuted));
  btnMute.classList.toggle('active', isMuted);
  btnMute.querySelector('span').textContent = isMuted ? 'Unmute' : 'Mute';
});

btnCam.addEventListener('click', () => {
  if (!localStream) return;
  isCamOff = !isCamOff;
  localStream.getVideoTracks().forEach((t) => (t.enabled = !isCamOff));
  btnCam.classList.toggle('active', isCamOff);
  btnCam.querySelector('span').textContent = isCamOff ? 'Show Cam' : 'Camera';
});

// ── Report modal ─────────────────────────────────────────────────────────────
btnReport.addEventListener('click', () => {
  reportModal.classList.add('show');
});
reportCancel.addEventListener('click', () => {
  reportModal.classList.remove('show');
});
reportModal.addEventListener('click', (e) => {
  if (e.target === reportModal) reportModal.classList.remove('show');
});

document.querySelectorAll('.reason-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    reportModal.classList.remove('show');
    if (socket && roomId) {
      socket.emit('report', { roomId, reason: btn.dataset.reason });
    }
  });
});

// ── Chat input ────────────────────────────────────────────────────────────────
function sendChatMessage() {
  const msg = chatInput.value.trim();
  if (!msg || !socket || !roomId) return;
  socket.emit('chat-message', { message: msg, roomId });
  addMessage('you', msg);
  chatInput.value = '';
  // Reset textarea height
  chatInput.style.height = 'auto';
  // Stop typing
  sendStopTyping();
}

btnSend.addEventListener('click', sendChatMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  handleTypingIndicator();
});

// Typing indicators
function handleTypingIndicator() {
  if (!socket || !roomId) return;
  if (!isTyping) {
    isTyping = true;
    socket.emit('typing', { roomId });
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(sendStopTyping, 1500);
}
function sendStopTyping() {
  if (isTyping && socket && roomId) {
    isTyping = false;
    socket.emit('stop-typing', { roomId });
  }
}

// ── Nav logo → home ──────────────────────────────────────────────────────────
navLogoHome.addEventListener('click', () => {
  if (socket) socket.emit('stop');
  destroyPeerConnection();
  stopCamera();
  showScreen('home');
  clearChat();
  setChatEnabled(false);
  setStatus('', 'Initialising…');
  localOverlay.classList.remove('hidden');
  localOverlay.querySelector('.overlay-text').textContent = 'Starting camera…';
  roomId   = null;
  isInChat = false;
});

// ── Start button ──────────────────────────────────────────────────────────────
btnStartVideo.addEventListener('click', startSmegle);

// ── Keyboard shortcut (Enter on home) ────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !homeScreen.classList.contains('hidden')) {
    startSmegle();
  }
});

// ── Connect socket on page load for online count ──────────────────────────────
(function init() {
  // Light socket connect just for online count on homepage
  connectSocket();
})();
