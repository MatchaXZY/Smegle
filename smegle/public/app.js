/**
 * Smegle Client v4
 * Complete overhaul: connectivity, features, quality
 */
'use strict';

// ═══ ICE CONFIG — Maximum coverage for all network types ═══════════════════
const ICE_CONFIG = {
  iceServers: [
    // Google STUN (global)
    { urls: ['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302','stun:stun2.l.google.com:19302','stun:stun3.l.google.com:19302','stun:stun4.l.google.com:19302'] },
    // Cloudflare STUN
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Twilio STUN
    { urls: 'stun:global.stun.twilio.com:3478' },
    // OpenRelay TURN — UDP 3478 (most networks)
    { urls: 'turn:openrelay.metered.ca:80',             username: 'openrelayproject', credential: 'openrelayproject' },
    // OpenRelay TURN — TCP 80 (school/hotel WiFi that blocks UDP)
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    // OpenRelay TURNS — TLS 443 (strict firewalls, HTTPS-only networks)
    { urls: 'turns:openrelay.metered.ca:443',            username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
    // Numb TURN (backup)
    { urls: 'turn:numb.viagenie.ca', username: 'webrtc@live.com', credential: 'muazkh' },
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy:  'max-bundle',
  rtcpMuxPolicy: 'require',
  sdpSemantics:  'unified-plan',
  iceTransportPolicy: 'all',
};

// ═══ LOGGING ═══════════════════════════════════════════════════════════════
const L = {
  info:  (...a) => console.log( '%c[S]','color:#2196f3;font-weight:bold',...a),
  warn:  (...a) => console.warn('%c[S]','color:#f59e0b;font-weight:bold',...a),
  error: (...a) => console.error('%c[S]','color:#ef4444;font-weight:bold',...a),
};

// ═══ OFFLINE ═══════════════════════════════════════════════════════════════
let offline = !navigator.onLine;
const offlineBanner = () => {
  let b = document.getElementById('offline-banner');
  if (offline && !b) {
    b = Object.assign(document.createElement('div'), { id:'offline-banner',
      style:'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;text-align:center;padding:10px;font-size:14px;font-weight:600;font-family:Inter,sans-serif',
      textContent:'No internet connection — video chat requires internet access' });
    document.body.prepend(b);
  } else if (!offline && b) b.remove();
};
window.addEventListener('online',  () => { offline=false; offlineBanner(); });
window.addEventListener('offline', () => { offline=true;  offlineBanner(); });
offlineBanner();

// ═══ DOM ═══════════════════════════════════════════════════════════════════
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
const btnScreen         = $('btn-screen');
const btnReport         = $('btn-report');
const reportModal       = $('report-modal');
const reportCancel      = $('report-cancel');
const toastCont         = $('toast-container');
const navLogoHome       = $('nav-logo-home');
const privateModal      = $('private-modal');
const diagPanel         = $('diag-panel');

// ═══ STATE ═════════════════════════════════════════════════════════════════
let socket           = null;
let localStream      = null;
let screenStream     = null;
let pc               = null;
let roomId           = null;
let isInitiator      = false;
let isMuted          = false;
let isCamOff         = false;
let isSharingScreen  = false;
let isInChat         = false;
let pendingIce       = [];
let typingTimer      = null;
let isTyping         = false;
let connectWatchdog  = null;
let healthInterval   = null;
let iceRestartCount  = 0;
let stuckTimer       = null;
let diagInterval     = null;
let msgMap           = new Map(); // id -> element
let mediaRecorder    = null;
let audioChunks      = [];
let recordStart      = 0;
let reactionTarget   = null; // message element being reacted to
const myReactions    = new Map(); // msgId -> emoji

// ═══ THEME ════════════════════════════════════════════════════════════════
const savedTheme = localStorage.getItem('smegle-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcons(savedTheme);

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('smegle-theme', next);
  updateThemeIcons(next);
}
function updateThemeIcons(theme) {
  const darkIcons  = document.querySelectorAll('#icon-dark, .btn-theme-chat svg');
  const lightIcons = document.querySelectorAll('#icon-light');
  darkIcons .forEach(el => el.style.display = theme==='dark'  ? 'none' : '');
  lightIcons.forEach(el => el.style.display = theme==='light' ? 'none' : '');
}

$('btn-theme')      ?.addEventListener('click', toggleTheme);
$('btn-theme-chat') ?.addEventListener('click', toggleTheme);

// ═══ SCREEN HELPERS ════════════════════════════════════════════════════════
function showScreen(name) {
  if (name === 'home') { homeScreen.classList.remove('hidden'); chatScreen.classList.add('hidden'); }
  else                 { homeScreen.classList.add('hidden');    chatScreen.classList.remove('hidden'); }
}

function setStatus(state, text) {
  navStatus.className = `nav-status ${state}`;
  navStatusText.textContent = text;
}

function showToast(msg, dur=3500) {
  const t = Object.assign(document.createElement('div'),{className:'toast',textContent:msg});
  toastCont.appendChild(t);
  setTimeout(()=>t.remove(), dur);
}

// ═══ MARKDOWN RENDERER (lightweight) ═══════════════════════════════════════
function renderMarkdown(text) {
  return text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
    .replace(/\*(.*?)\*/g,'<em>$1</em>')
    .replace(/`(.*?)`/g,'<code>$1</code>')
    .replace(/\[(.+?)\]\((https?:\/\/[^\)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g,'<br>');
}

// ═══ LINK PREVIEWS ═════════════════════════════════════════════════════════
const URL_REGEX = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

function extractUrls(text) {
  const matches = [];
  let m;
  const re = new RegExp(URL_REGEX.source, 'gi');
  while ((m = re.exec(text)) !== null) matches.push(m[0]);
  return matches;
}

function classifyUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace('www.','');
    if (h === 'youtube.com' || h === 'youtu.be') return 'youtube';
    if (h === 'twitter.com' || h === 'x.com')   return 'twitter';
    if (h === 'open.spotify.com')                return 'spotify';
    if (h === 'reddit.com' || h.endsWith('.reddit.com')) return 'reddit';
    if (h === 'github.com')                      return 'github';
    if (h === 'instagram.com')                   return 'instagram';
    if (h === 'twitch.tv')                       return 'twitch';
    if (h === 'tiktok.com')                      return 'tiktok';
    if (/\.(jpg|jpeg|png|gif|webp|svg)(\?|$)/i.test(u.pathname)) return 'image';
    return 'generic';
  } catch(_) { return 'generic'; }
}

function getYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('?')[0];
    return u.searchParams.get('v') || null;
  } catch(_) { return null; }
}

function getSpotifyEmbed(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return 'https://open.spotify.com/embed/' + parts[0] + '/' + parts[1] + '?utm_source=generator&theme=0';
  } catch(_) {}
  return null;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function buildPreviewCard(url, type, isYou) {
  const card = document.createElement('div');
  card.className = 'link-preview lp-' + (isYou ? 'you' : 'stranger');

  const short = url.length > 55 ? url.slice(0,55) + '\u2026' : url;

  if (type === 'youtube') {
    const vid = getYouTubeId(url);
    if (vid) {
      const thumb = 'https://img.youtube.com/vi/' + vid + '/mqdefault.jpg';
      card.innerHTML = '<a href="' + escHtml(url) + '" target="_blank" rel="noopener" class="lp-yt-link">' +
        '<div class="lp-yt-thumb"><img src="' + thumb + '" alt="YouTube" loading="lazy" onerror="this.closest(\'.link-preview\').remove()"/>' +
        '<div class="lp-yt-play"><svg viewBox="0 0 24 24" fill="white" width="26" height="26"><polygon points="5,3 19,12 5,21"/></svg></div></div>' +
        '<div class="lp-info"><div class="lp-site lp-site-yt"><span class="lp-dot lp-dot-yt"></span>YouTube</div>' +
        '<div class="lp-url">' + escHtml(short) + '</div></div></a>';
      return card;
    }
  }

  if (type === 'spotify') {
    const embed = getSpotifyEmbed(url);
    if (embed) {
      card.innerHTML = '<iframe src="' + escHtml(embed) + '" width="100%" height="80" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy" style="border-radius:8px;display:block;"></iframe>';
      return card;
    }
  }

  if (type === 'image') {
    card.innerHTML = '<a href="' + escHtml(url) + '" target="_blank" rel="noopener"><img src="' + escHtml(url) + '" class="lp-img" loading="lazy" alt="Image" onerror="this.closest(\'.link-preview\').remove()"/></a>';
    return card;
  }

  const icons = {
    twitter:'lp-dot-x', reddit:'lp-dot-reddit', github:'lp-dot-gh',
    twitch:'lp-dot-twitch', tiktok:'lp-dot-tt', instagram:'lp-dot-ig', generic:'lp-dot-link'
  };
  const labels = {
    twitter:'X / Twitter', reddit:'Reddit', github:'GitHub',
    twitch:'Twitch', tiktok:'TikTok', instagram:'Instagram', generic:''
  };
  let domain = '';
  try { domain = new URL(url).hostname.replace('www.',''); } catch(_) {}
  const label = labels[type] || domain;
  const dotClass = icons[type] || 'lp-dot-link';

  card.innerHTML = '<a href="' + escHtml(url) + '" target="_blank" rel="noopener" class="lp-generic-link">' +
    '<div class="lp-info"><div class="lp-site"><span class="lp-dot ' + dotClass + '"></span>' + escHtml(label || domain) + '</div>' +
    '<div class="lp-url">' + escHtml(short) + '</div></div></a>';
  return card;
}

function attachLinkPreviews(msgEl, text, isYou) {
  const urls = extractUrls(text);
  if (!urls.length) return;
  const seen = new Set();
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    const type = classifyUrl(url);
    const card = buildPreviewCard(url, type, isYou);
    msgEl.insertAdjacentElement('afterend', card);
  }
}

// ═══ CHAT HELPERS ══════════════════════════════════════════════════════════
function addMessage(type, text, opts={}) {
  $('chat-welcome')?.remove();
  const id = opts.id || ('m_' + Date.now() + Math.random().toString(36).slice(2));

  let el;
  if (type === 'system') {
    el = Object.assign(document.createElement('div'),{className:'msg-system',textContent:text});
  } else {
    el = document.createElement('div');
    el.className = `msg-bubble msg-${type}`;
    el.dataset.msgId = id;
    el.innerHTML = renderMarkdown(text);

    // Message actions (edit/delete for own messages)
    if (type === 'you') {
      const actions = document.createElement('div');
      actions.className = 'msg-actions';
      actions.innerHTML = `
        <button class="msg-action-btn" data-action="edit" title="Edit">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="msg-action-btn" data-action="delete" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        </button>`;
      el.appendChild(actions);
      actions.addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        if (btn.dataset.action === 'edit') editMessage(el, id);
        if (btn.dataset.action === 'delete') deleteMessage(el, id);
      });
    }

    // Reaction area
    const reacts = document.createElement('div');
    reacts.className = 'msg-reactions';
    reacts.dataset.msgId = id;
    el.appendChild(reacts);

    // Long press / right-click for reactions
    el.addEventListener('contextmenu', e => { e.preventDefault(); showReactionPicker(e, id, el); });
    let pressTimer;
    el.addEventListener('touchstart', () => { pressTimer = setTimeout(()=>showReactionPicker(null,id,el), 500); });
    el.addEventListener('touchend',   () => clearTimeout(pressTimer));

    msgMap.set(id, el);
  }

  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  // Attach link previews after element is in DOM
  if (type !== 'system') attachLinkPreviews(el, text, type === 'you');
  return id;
}

function addMediaMessage(type, src, isGif=false) {
  $('chat-welcome')?.remove();
  const wrap = document.createElement('div');
  wrap.className = `msg-img-wrap${type==='stranger'?' stranger':''}`;
  const img = document.createElement('img');
  img.className = 'msg-img';
  img.src = src;
  img.alt = isGif ? 'GIF' : 'Image';
  img.loading = 'lazy';
  img.onclick = () => window.open(src, '_blank');
  wrap.appendChild(img);
  chatMessages.appendChild(wrap);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addVoiceMessage(type, audioSrc, dur) {
  $('chat-welcome')?.remove();
  const el = document.createElement('div');
  el.className = `voice-msg voice-msg-${type}`;
  el.innerHTML = `
    <button class="voice-play" title="Play">
      <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
    </button>
    <span class="voice-duration">${formatDur(dur)}</span>`;
  const audio = new Audio(audioSrc);
  el.querySelector('.voice-play').onclick = () => audio.paused ? audio.play() : audio.pause();
  chatMessages.appendChild(el);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

const formatDur = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;

function editMessage(el, id) {
  const textNode = el.childNodes[0];
  const current  = el.innerText.replace(/\n/g,'').replace(/edit|delete/gi,'').trim();
  const inp      = document.createElement('input');
  inp.value = current;
  inp.style.cssText = 'width:100%;background:transparent;border:none;outline:none;color:inherit;font-size:13px;font-family:inherit';
  el.textContent = '';
  el.appendChild(inp);
  inp.focus();
  inp.onkeydown = e => {
    if (e.key === 'Enter') {
      const newText = inp.value.trim();
      el.innerHTML = renderMarkdown(newText) + '<span class="msg-edited">(edited)</span>';
      if (socket && roomId) socket.emit('edit-message', { roomId, id, text: newText });
    }
    if (e.key === 'Escape') { el.innerHTML = renderMarkdown(current); }
  };
}

function deleteMessage(el, id) {
  el.style.opacity='0.4';
  el.innerHTML = '<em style="font-size:12px;opacity:.7">Message deleted</em>';
  if (socket && roomId) socket.emit('delete-message', { roomId, id });
}

// Reactions
function showReactionPicker(e, msgId, msgEl) {
  const picker = $('reaction-picker');
  reactionTarget = { id: msgId, el: msgEl };
  const rect = msgEl.getBoundingClientRect();
  picker.style.top  = (rect.top - 48) + 'px';
  picker.style.left = rect.left + 'px';
  picker.style.display = 'flex';
}
document.addEventListener('click', e => {
  if (!e.target.closest('#reaction-picker') && !e.target.closest('.msg-bubble')) {
    $('reaction-picker').style.display = 'none';
  }
});
document.querySelectorAll('.reaction-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!reactionTarget || !roomId || !socket) return;
    const emoji = btn.dataset.emoji;
    const { id, el } = reactionTarget;
    applyReaction(el, id, emoji, true);
    socket.emit('react', { roomId, id, emoji });
    $('reaction-picker').style.display = 'none';
  });
});

function applyReaction(el, id, emoji, isOwn) {
  if (!el) return;
  let reacts = el.querySelector('.msg-reactions');
  if (!reacts) { reacts = document.createElement('div'); reacts.className='msg-reactions'; reacts.dataset.msgId=id; el.appendChild(reacts); }
  const existing = reacts.querySelector(`[data-emoji="${emoji}"]`);
  if (existing) {
    const count = parseInt(existing.dataset.count || '1') + 1;
    existing.dataset.count = count;
    existing.textContent = emoji + (count > 1 ? ' ' + count : '');
  } else {
    const r = document.createElement('span');
    r.className = 'msg-reaction' + (isOwn ? ' mine' : '');
    r.dataset.emoji = emoji;
    r.dataset.count = '1';
    r.textContent = emoji;
    reacts.appendChild(r);
  }
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
function hideTyping() { typingEl?.remove(); typingEl = null; }

function clearChat() {
  chatMessages.innerHTML = '<div class="msg-system" id="chat-welcome">Waiting for a match...</div>';
  typingEl = null;
  msgMap.clear();
}

function setChatEnabled(on) {
  chatInput.disabled = !on;
  btnSend.disabled   = !on;
  if (on) setTimeout(()=>chatInput.focus(), 100);
}

function showRemoteOverlay(text) { remoteOverlay.classList.remove('hidden'); remoteOverlayText.textContent = text; }
function hideRemoteOverlay()     { remoteOverlay.classList.add('hidden'); }
function flashDisconnect()       { disconnectOverlay.classList.add('show'); setTimeout(()=>disconnectOverlay.classList.remove('show'), 2200); }

// ═══ COPY CONVERSATION ═════════════════════════════════════════════════════
$('btn-copy-chat')?.addEventListener('click', () => {
  const lines = [];
  chatMessages.querySelectorAll('.msg-system,.msg-bubble').forEach(el => {
    if (el.classList.contains('msg-system')) lines.push('[System] ' + el.textContent);
    else if (el.classList.contains('msg-you')) lines.push('[You] ' + el.innerText.replace(/edit|delete/gi,'').trim());
    else lines.push('[Stranger] ' + el.innerText.trim());
  });
  navigator.clipboard.writeText(lines.join('\n')).then(()=>showToast('Conversation copied!')).catch(()=>showToast('Could not copy'));
});

// ═══ CAMERA ════════════════════════════════════════════════════════════════
async function startCamera() {
  L.info('Starting camera...');
  if (!navigator.mediaDevices?.getUserMedia) {
    localOverlayText.textContent = 'Camera not supported';
    return false;
  }

  const vConstraints = [
    // Ideal: 1080p — good quality without killing mobile bandwidth
    { width:{ideal:1920}, height:{ideal:1080}, frameRate:{ideal:30,min:15}, facingMode:'user' },
    { width:{ideal:1280}, height:{ideal:720},  frameRate:{ideal:30,min:15}, facingMode:'user' },
    { width:{ideal:640},  height:{ideal:480},  frameRate:{ideal:24},        facingMode:'user' },
    { facingMode:'user' },
    true,
  ];

  let videoStream = null;
  for (const vc of vConstraints) {
    try {
      videoStream = await navigator.mediaDevices.getUserMedia({video:vc, audio:false});
      const t = videoStream.getVideoTracks()[0];
      const s = t.getSettings();
      L.info(`Camera: ${s.width}x${s.height}@${s.frameRate}fps "${t.label}"`);
      break;
    } catch(err) { L.warn('Video fallback:', err.name); }
  }

  // Best-effort audio — professional quality when available
  const aConstraints = [
    {
      echoCancellation:{ideal:true},
      noiseSuppression:{ideal:true},
      autoGainControl: {ideal:true},
      channelCount:    {ideal:1},
      sampleRate:      {ideal:48000},
      sampleSize:      {ideal:16},
      latency:         {ideal:0.005},
      // Disable processing if user has a professional mic (detected by label)
    },
    { echoCancellation:true, noiseSuppression:true, autoGainControl:true },
    true,
  ];

  let audioStream = null;
  for (const ac of aConstraints) {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({audio:ac, video:false});
      const at = audioStream.getAudioTracks()[0];
      L.info(`Mic: "${at.label}"`);

      // If it's a professional/external mic, disable processing for pure sound
      const lbl = at.label.toLowerCase();
      if (lbl.includes('airpod') || lbl.includes('studio') || lbl.includes('blue') ||
          lbl.includes('rode') || lbl.includes('shure') || lbl.includes('focusrite') ||
          lbl.includes('scarlett') || lbl.includes('external') || lbl.includes('usb')) {
        try {
          await at.applyConstraints({ echoCancellation:false, noiseSuppression:false, autoGainControl:false });
          L.info('Pro mic detected — disabled processing for natural sound');
        } catch(_) {}
      }
      break;
    } catch(err) { L.warn('Audio fallback:', err.name); }
  }

  if (!videoStream && !audioStream) {
    localOverlayText.textContent = 'Camera & mic denied';
    showToast('Camera/mic permission denied. Check browser settings.');
    return false;
  }

  const tracks = [];
  if (videoStream) tracks.push(...videoStream.getVideoTracks());
  if (audioStream) tracks.push(...audioStream.getAudioTracks());
  localStream = new MediaStream(tracks);
  localVideo.srcObject   = localStream;
  localVideo.playsInline = true;

  if (videoStream) localOverlay.classList.add('hidden');
  else             localOverlayText.textContent = 'Audio only';
  return true;
}

function stopCamera() {
  localStream?.getTracks().forEach(t=>t.stop());
  localStream = null;
  localVideo.srcObject = null;
}

// ═══ SCREEN SHARE ══════════════════════════════════════════════════════════
async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:{ideal:30}}, audio:true });
    const screenTrack = screenStream.getVideoTracks()[0];

    // Replace video track in peer connection
    if (pc) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(screenTrack);
    }

    // Replace local video preview
    const previewStream = new MediaStream([screenTrack]);
    if (localStream?.getAudioTracks().length) previewStream.addTrack(localStream.getAudioTracks()[0]);
    localVideo.srcObject = previewStream;

    isSharingScreen = true;
    btnScreen.classList.add('active');
    btnScreen.querySelector('span').textContent = 'Stop Share';
    $('local-ss-badge').style.display = '';
    if (socket && roomId) socket.emit('screen-share-started', { roomId });

    screenTrack.onended = stopScreenShare;
    L.info('Screen share started');
  } catch(err) {
    L.warn('Screen share cancelled:', err.name);
  }
}

async function stopScreenShare() {
  if (!isSharingScreen) return;
  screenStream?.getTracks().forEach(t=>t.stop());
  screenStream = null;

  // Restore camera
  if (localStream && pc) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(videoTrack);
    }
  }
  localVideo.srcObject = localStream;
  isSharingScreen = false;
  btnScreen.classList.remove('active');
  btnScreen.querySelector('span').textContent = 'Share';
  $('local-ss-badge').style.display = 'none';
  if (socket && roomId) socket.emit('screen-share-stopped', { roomId });
  L.info('Screen share stopped');
}

// ═══ IMAGE / GIF SHARING ═══════════════════════════════════════════════════
$('file-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  if (file.size > 4_000_000) { showToast('File too large — max 4MB'); return; }
  if (!socket || !roomId) { showToast('Connect to someone first'); return; }

  const reader = new FileReader();
  reader.onload = () => {
    const data = reader.result;
    const isGif = file.type === 'image/gif';
    addMediaMessage('you', data, isGif);
    socket.emit('share-media', { roomId, data, type: isGif ? 'gif' : 'image', name: file.name, id: 'm_'+Date.now() });
  };
  reader.readAsDataURL(file);
});

// GIF picker
const gifPicker = $('gif-picker');
const gifSearch  = $('gif-search');
const gifResults = $('gif-results');

$('btn-gif').addEventListener('click', () => {
  if (!roomId) { showToast('Connect to someone first'); return; }
  gifPicker.style.display = gifPicker.style.display === 'none' ? '' : 'none';
  if (gifPicker.style.display !== 'none') gifSearch.focus();
});

let gifTimer;
gifSearch.addEventListener('input', () => {
  clearTimeout(gifTimer);
  const q = gifSearch.value.trim();
  if (!q) { gifResults.innerHTML = '<div class="gif-hint">Type to search GIFs</div>'; return; }
  gifTimer = setTimeout(async () => {
    try {
      // Using Tenor API (free, no key required for basic)
      const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(q)}&key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCDw&limit=9&media_filter=gif`);
      const data = await res.json();
      if (!data.results?.length) { gifResults.innerHTML = '<div class="gif-hint">No GIFs found</div>'; return; }
      gifResults.innerHTML = '';
      data.results.forEach(r => {
        const url = r.media_formats?.gif?.url || r.media_formats?.tinygif?.url;
        if (!url) return;
        const img = document.createElement('img');
        img.src = r.media_formats?.tinygif?.url || url;
        img.loading = 'lazy';
        img.onclick = () => {
          addMediaMessage('you', url, true);
          if (socket && roomId) socket.emit('share-media', { roomId, data: url, type: 'gif-url', name: 'gif', id: 'm_'+Date.now() });
          gifPicker.style.display = 'none';
          gifSearch.value = '';
        };
        gifResults.appendChild(img);
      });
    } catch(_) { gifResults.innerHTML = '<div class="gif-hint">Could not load GIFs</div>'; }
  }, 400);
});

// ═══ VOICE MESSAGES ════════════════════════════════════════════════════════
const btnVoice    = $('btn-voice');
const voiceRecInd = $('voice-recording');

btnVoice.addEventListener('mousedown',  startRecording);
btnVoice.addEventListener('touchstart', startRecording, {passive:true});
btnVoice.addEventListener('mouseup',    stopRecording);
btnVoice.addEventListener('touchend',   stopRecording);
btnVoice.addEventListener('mouseleave', stopRecording);

async function startRecording(e) {
  e.preventDefault();
  if (!navigator.mediaDevices?.getUserMedia) { showToast('Voice not supported in this browser'); return; }
  if (!roomId) { showToast('Connect to someone first'); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recordStart  = Date.now();
    mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg' });
    mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
    mediaRecorder.start();
    voiceRecInd.style.display = '';
    L.info('Recording started');
  } catch(err) { L.warn('Mic for voice msg:', err.name); showToast('Mic access needed for voice messages'); }
}

async function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  voiceRecInd.style.display = 'none';
  const dur = (Date.now() - recordStart) / 1000;

  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    mediaRecorder.stream?.getTracks().forEach(t=>t.stop());
    if (dur < 0.5) { L.info('Recording too short, discarded'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const audio = reader.result;
      addVoiceMessage('you', audio, dur);
      if (socket && roomId) socket.emit('voice-message', { roomId, audio, duration: dur, id: 'm_'+Date.now() });
    };
    reader.readAsDataURL(blob);
    L.info(`Voice message recorded: ${dur.toFixed(1)}s`);
  };
}

// ═══ WEBRTC ═══════════════════════════════════════════════════════════════
function createPeerConnection() {
  if (pc) destroyPC();
  iceRestartCount = 0;
  L.info('Creating RTCPeerConnection with', ICE_CONFIG.iceServers.length, 'ICE servers');

  pc = new RTCPeerConnection(ICE_CONFIG);

  if (localStream) {
    localStream.getTracks().forEach(track => { pc.addTrack(track, localStream); L.info('Added track:', track.kind); });
  }

  pc.ontrack = e => {
    L.info('Remote track:', e.track.kind, 'streams:', e.streams.length);
    if (e.streams?.[0]) {
      remoteVideo.srcObject   = e.streams[0];
      remoteVideo.playsInline = true;
      remoteVideo.play().catch(err => L.warn('play():', err.name));
      clearStuckTimer(); clearWatchdog(); hideRemoteOverlay();
    }
  };

  pc.onicecandidate = e => {
    if (e.candidate && roomId && socket?.connected) {
      socket.emit('ice-candidate', { candidate: e.candidate, roomId });
    }
    if (!e.candidate) L.info('ICE gathering complete. State:', pc.iceGatheringState);
  };

  pc.onicegatheringstatechange = () => L.info('ICE gathering:', pc.iceGatheringState);

  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    L.info('ICE connection:', s);
    updateDiag();
    switch(s) {
      case 'checking':    setWatchdog(); break;
      case 'connected':
      case 'completed':   clearWatchdog(); clearStuckTimer(); break;
      case 'failed':      L.warn('ICE failed'); handleIceFailure(); break;
      case 'disconnected':
        setTimeout(() => { if (pc?.iceConnectionState==='disconnected') handleIceFailure(); }, 5000);
        break;
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    L.info('Connection state:', s);
    updateDiag();
    switch(s) {
      case 'connecting':   setStatus('waiting','Connecting...'); setWatchdog(); break;
      case 'connected':    setStatus('connected','Connected'); clearWatchdog(); clearStuckTimer(); isInChat=true; setHighBitrate(); startHealth(); break;
      case 'failed':       setStatus('disconnected','Connection failed — retrying...'); handleIceFailure(); break;
      case 'disconnected': setStatus('disconnected','Connection lost...'); break;
      case 'closed':       clearWatchdog(); stopHealth(); break;
    }
  };
}

function setWatchdog() {
  clearWatchdog();
  connectWatchdog = setTimeout(()=>{ L.warn('Watchdog: ICE stuck >15s'); handleIceFailure(); }, 15000);
}
function clearWatchdog() { clearTimeout(connectWatchdog); connectWatchdog=null; }

function setStuckTimer() {
  clearStuckTimer();
  stuckTimer = setTimeout(()=>{
    if (!isInChat && roomId) { L.warn('Stuck 35s — auto-skip'); showToast('Connection timed out — finding someone new...'); doSkip(); }
  }, 35000);
}
function clearStuckTimer() { clearTimeout(stuckTimer); stuckTimer=null; }

async function handleIceFailure() {
  if (!pc || !roomId) return;
  iceRestartCount++;
  L.warn('ICE failure #'+iceRestartCount);
  if (iceRestartCount > 3) { showToast('Could not connect — finding someone new...'); doSkip(); return; }
  if (isInitiator) await doIceRestart();
  else if (socket?.connected && roomId) socket.emit('request-ice-restart', { roomId });
}

async function doIceRestart() {
  if (!pc || !roomId || !socket?.connected) return;
  try {
    L.info('ICE restart');
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { offer: pc.localDescription, roomId });
  } catch(err) { L.error('ICE restart failed:', err); }
}

async function setHighBitrate() {
  if (!pc) return;
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try {
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      // Adaptive: 4Mbps target, browser will scale back on congestion
      p.encodings[0].maxBitrate   = 4_000_000;
      p.encodings[0].maxFramerate = 30;
      p.degradationPreference     = 'maintain-resolution';
      await sender.setParameters(p);
      L.info('Video bitrate → 4Mbps');
    } catch(err) { L.warn('setParameters:', err.message); }
  }
}

function destroyPC() {
  clearWatchdog(); clearStuckTimer(); stopHealth();
  if (pc) {
    pc.ontrack=pc.onicecandidate=pc.oniceconnectionstatechange=pc.onconnectionstatechange=pc.onicegatheringstatechange=null;
    try { pc.close(); } catch(_) {}
    pc = null;
    L.info('PC closed');
  }
  remoteVideo.srcObject = null;
  pendingIce = []; isInChat = false; iceRestartCount = 0;
}

async function flushIce() {
  const q = [...pendingIce]; pendingIce = [];
  for (const c of q) {
    if (!pc) break;
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e) { L.warn('addIce:', e.message); }
  }
}

// ═══ HEALTH MONITOR ════════════════════════════════════════════════════════
function startHealth() {
  stopHealth();
  healthInterval = setInterval(async () => {
    if (!pc) { stopHealth(); return; }
    try {
      const stats = await pc.getStats();
      let vBytes=0, aBytes=0, transport='';
      stats.forEach(s => {
        if (s.type==='inbound-rtp' && s.kind==='video') vBytes=s.bytesReceived||0;
        if (s.type==='inbound-rtp' && s.kind==='audio') aBytes=s.bytesReceived||0;
        if (s.type==='candidate-pair' && s.state==='succeeded') transport=s.remoteCandidateId||'';
      });
      updateDiagFull(vBytes, aBytes, transport, stats);
    } catch(_) {}
  }, 5000);
}
function stopHealth() { clearInterval(healthInterval); healthInterval=null; }

// ═══ DIAGNOSTICS ════════════════════════════════════════════════════════════
function updateDiag() {
  if (diagPanel.style.display==='none') return;
  $('d-ice').textContent    = pc?.iceConnectionState || '—';
  $('d-conn').textContent   = pc?.connectionState    || '—';
  $('d-signal').textContent = socket?.connected ? 'OK' : 'Lost';
}

function updateDiagFull(vBytes, aBytes, transportId, stats) {
  if (diagPanel.style.display==='none') return;
  $('d-video').textContent = vBytes ? Math.round(vBytes/1024)+'KB' : '—';
  $('d-audio').textContent = aBytes ? Math.round(aBytes/1024)+'KB' : '—';
  // Determine relay vs direct
  let tp = '—';
  if (stats) {
    stats.forEach(s => {
      if (s.type === 'remote-candidate' && s.id === transportId) {
        tp = s.candidateType === 'relay' ? 'TURN (relay)' : `Direct (${s.candidateType})`;
      }
    });
  }
  $('d-transport').textContent = tp;
  updateDiag();
}

$('btn-diag').addEventListener('click', () => {
  diagPanel.style.display = diagPanel.style.display==='none' ? '' : 'none';
  if (diagPanel.style.display !== 'none') { updateDiag(); clearInterval(diagInterval); diagInterval = setInterval(updateDiag, 2000); }
  else clearInterval(diagInterval);
});
$('diag-close').addEventListener('click', () => { diagPanel.style.display='none'; clearInterval(diagInterval); });

// ═══ SOCKET.IO ═════════════════════════════════════════════════════════════
function connectSocket() {
  if (socket?.connected) return;
  socket = io({
    transports:           ['websocket','polling'],
    upgrade:              true,
    reconnection:         true,
    reconnectionAttempts: Infinity,
    reconnectionDelay:    800,
    reconnectionDelayMax: 5000,
    randomizationFactor:  0.3,
    timeout:              15000,
  });

  socket.on('connect', ()    => L.info('Socket connected', socket.id, '| transport:', socket.io.engine.transport.name));
  socket.on('connect_error', e => { L.error('Socket error:', e.message); setStatus('disconnected','Signaling unreachable — retrying...'); });
  socket.on('disconnect',    r => { L.warn('Socket disconnected:', r); setStatus('disconnected','Reconnecting...'); });

  socket.io.on('reconnect', attempt => {
    L.info('Reconnected after', attempt, 'attempts');
    if (!isInChat && chatScreen && !chatScreen.classList.contains('hidden')) {
      setStatus('waiting','Reconnected — finding someone...'); socket.emit('join-queue',{language:'any'});
    }
  });

  socket.on('online-count', count => {
    const lbl = count===1 ? '1 person online' : `${count.toLocaleString()} people online`;
    if (homeOnlineCount) homeOnlineCount.textContent = lbl;
    if (chatOnlineCount) chatOnlineCount.textContent = `${count.toLocaleString()} online`;
    const s = $('stat-online'); if (s) s.textContent = count.toLocaleString();
  });

  socket.on('waiting', () => {
    isInChat=false; showRemoteOverlay('Finding someone...');
    setStatus('waiting','Finding someone...'); clearChat(); setChatEnabled(false);
    disconnectOverlay.classList.remove('show');
  });

  socket.on('matched', async ({ roomId:rid, initiator }) => {
    L.info('Matched! room='+rid+' initiator='+initiator);
    roomId=rid; isInitiator=initiator;
    setStatus('waiting','Setting up video...'); showRemoteOverlay('Connecting...');
    addMessage('system','You are now connected to a stranger. Say hi!');
    setChatEnabled(true); setStuckTimer(); createPeerConnection();

    if (isInitiator) {
      try {
        L.info('Creating offer...');
        const offer = await pc.createOffer({ offerToReceiveAudio:true, offerToReceiveVideo:true });
        await pc.setLocalDescription(offer);
        socket.emit('offer',{ offer:pc.localDescription, roomId });
        L.info('Offer sent');
      } catch(e) { L.error('createOffer:', e); }
    }
  });

  socket.on('offer', async ({ offer }) => {
    if (!pc) createPeerConnection();
    if (!roomId) { L.warn('Offer but no roomId — ignoring'); return; }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      await flushIce();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer',{ answer:pc.localDescription, roomId });
      L.info('Answer sent');
    } catch(e) { L.error('handleOffer:', e); }
  });

  socket.on('answer', async ({ answer }) => {
    if (!pc || !roomId) { L.warn('Answer but no PC/room'); return; }
    if (pc.signalingState !== 'have-local-offer') { L.warn('Answer in wrong state:', pc.signalingState); return; }
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await flushIce();
    } catch(e) { L.error('handleAnswer:', e); }
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (!pc || !pc.remoteDescription?.type) { pendingIce.push(candidate); return; }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(_) {}
  });

  socket.on('request-ice-restart', ({ roomId:rid }) => {
    if (rid===roomId && isInitiator) doIceRestart();
  });

  socket.on('partner-disconnected', () => {
    L.info('Partner disconnected');
    isInChat=false; const prev=roomId; roomId=null;
    destroyPC(); flashDisconnect();
    setStatus('disconnected','Stranger left');
    addMessage('system','Stranger has disconnected.');
    setChatEnabled(false); hideTyping();
    if (isSharingScreen) stopScreenShare();
    setTimeout(()=>{ if(!roomId) showRemoteOverlay('Stranger left — click Skip to find another'); }, 1000);
  });

  socket.on('stopped', () => {
    isInChat=false; roomId=null;
    destroyPC(); stopCamera();
    if (isSharingScreen) stopScreenShare();
    showScreen('home'); clearChat(); setChatEnabled(false); setStatus('','');
    localOverlay.classList.remove('hidden'); localOverlayText.textContent='Camera off';
  });

  // ── Chat relay ──────────────────────────────────────────────────────────
  socket.on('chat-message', ({ message, id }) => {
    hideTyping(); addMessage('stranger', message, { id });
  });

  socket.on('share-media', ({ data, type, id }) => {
    const isGif = type==='gif' || type==='gif-url';
    // For URL-type GIFs, data is the URL directly
    addMediaMessage('stranger', data, isGif);
  });

  socket.on('voice-message', ({ audio, duration }) => {
    addVoiceMessage('stranger', audio, duration||0);
  });

  socket.on('react', ({ id, emoji }) => {
    const el = msgMap.get(id);
    applyReaction(el, id, emoji, false);
  });

  socket.on('edit-message', ({ id, text }) => {
    const el = msgMap.get(id);
    if (el) el.innerHTML = renderMarkdown(text) + '<span class="msg-edited">(edited)</span>';
  });

  socket.on('delete-message', ({ id }) => {
    const el = msgMap.get(id);
    if (el) { el.style.opacity='0.4'; el.innerHTML='<em style="font-size:12px;opacity:.7">Message deleted</em>'; }
  });

  socket.on('stranger-typing',      () => { showTyping(); chatMessages.scrollTop=chatMessages.scrollHeight; });
  socket.on('stranger-stop-typing', ()  => hideTyping());

  socket.on('stranger-screen-share-started', () => { $('remote-ss-badge').style.display=''; });
  socket.on('stranger-screen-share-stopped', () => { $('remote-ss-badge').style.display='none'; });

  socket.on('report-received', () => showToast('Report submitted. Finding new connection...'));

  // Private room events
  socket.on('private-room-created', ({ code }) => {
    $('private-code-value').textContent = code;
    $('private-code-display').style.display = '';
  });
  socket.on('private-room-error', ({ msg }) => {
    const err = $('code-error');
    err.textContent = msg;
    err.style.display = '';
    setTimeout(()=>err.style.display='none', 4000);
  });
}

// ═══ SKIP HELPER ═══════════════════════════════════════════════════════════
function doSkip() {
  destroyPC(); setChatEnabled(false); hideTyping(); clearChat();
  if (isSharingScreen) stopScreenShare();
  if (socket?.connected) socket.emit('skip',{language:'any'});
}

// ═══ START FLOW ════════════════════════════════════════════════════════════
async function startSmegle() {
  if (offline) { showToast('No internet — check your network'); return; }
  btnStartVideo.disabled=true; btnStartVideo.textContent='Starting...';
  showScreen('chat'); setStatus('waiting','Starting camera...'); showRemoteOverlay('Starting camera...');
  connectSocket();
  const ok = await startCamera();
  if (!ok) showToast('Joining without camera/mic');
  setStatus('waiting','Finding someone...'); showRemoteOverlay('Finding someone...');
  if (socket.connected) socket.emit('join-queue',{language:'any'});
  else socket.once('connect', ()=>socket.emit('join-queue',{language:'any'}));
  btnStartVideo.disabled=false; btnStartVideo.textContent='Start Videoing';
}

// ═══ PRIVATE ROOM UI ═══════════════════════════════════════════════════════
$('btn-open-private').addEventListener('click', () => {
  connectSocket(); // ensure connected
  privateModal.classList.add('show');
  $('private-code-display').style.display='none';
  $('join-code-input').value='';
  $('code-error').style.display='none';
});
$('private-modal-cancel')?.addEventListener('click', ()=>privateModal.classList.remove('show'));
privateModal.addEventListener('click', e=>{ if(e.target===privateModal) privateModal.classList.remove('show'); });

$('btn-create-room').addEventListener('click', () => {
  if (!socket?.connected) connectSocket();
  socket.emit('create-private-room');
});

$('btn-copy-code').addEventListener('click', () => {
  const code = $('private-code-value').textContent;
  navigator.clipboard.writeText(code).then(()=>showToast('Code copied!'));
});

$('btn-join-room').addEventListener('click', async () => {
  const code = $('join-code-input').value.trim().toUpperCase();
  if (code.length !== 6) { const e=$('code-error'); e.textContent='Enter the 6-letter room code'; e.style.display=''; return; }
  privateModal.classList.remove('show');
  btnStartVideo.disabled=true; btnStartVideo.textContent='Joining...';
  showScreen('chat'); setStatus('waiting','Joining private room...'); showRemoteOverlay('Joining room...');
  connectSocket();
  const ok = await startCamera();
  if (!ok) showToast('Joining without camera/mic');
  if (socket.connected) socket.emit('join-private-room',{code});
  else socket.once('connect',()=>socket.emit('join-private-room',{code}));
  btnStartVideo.disabled=false; btnStartVideo.textContent='Start Videoing';
});

// ═══ CONTROLS ══════════════════════════════════════════════════════════════
btnSkip.addEventListener('click', ()=>{ if(socket) doSkip(); });

btnStop.addEventListener('click', ()=>{
  if(!socket) return;
  destroyPC(); socket.emit('stop'); stopCamera();
  if(isSharingScreen) stopScreenShare();
  showScreen('home'); clearChat(); setChatEnabled(false); setStatus('','');
  localOverlay.classList.remove('hidden'); localOverlayText.textContent='Camera off';
  roomId=null; isInChat=false;
});

btnMute.addEventListener('click', ()=>{
  if(!localStream) return;
  isMuted=!isMuted;
  localStream.getAudioTracks().forEach(t=>t.enabled=!isMuted);
  btnMute.classList.toggle('active',isMuted);
  btnMute.querySelector('span').textContent=isMuted?'Unmute':'Mute';
});

btnCam.addEventListener('click', ()=>{
  if(!localStream) return;
  isCamOff=!isCamOff;
  localStream.getVideoTracks().forEach(t=>t.enabled=!isCamOff);
  btnCam.classList.toggle('active',isCamOff);
  btnCam.querySelector('span').textContent=isCamOff?'Show Cam':'Camera';
});

btnScreen.addEventListener('click', ()=>{ isSharingScreen ? stopScreenShare() : startScreenShare(); });

// Report
btnReport.addEventListener('click', ()=>reportModal.classList.add('show'));
reportCancel.addEventListener('click', ()=>reportModal.classList.remove('show'));
reportModal.addEventListener('click', e=>{ if(e.target===reportModal) reportModal.classList.remove('show'); });
document.querySelectorAll('.reason-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    reportModal.classList.remove('show');
    if(socket?.connected && roomId) socket.emit('report',{roomId,reason:btn.dataset.reason});
  });
});

// Chat send
function sendMessage() {
  const msg = chatInput.value.trim();
  if(!msg || !socket?.connected || !roomId) return;
  const id = 'm_'+Date.now();
  socket.emit('chat-message',{message:msg,roomId,id});
  addMessage('you',msg,{id});
  chatInput.value=''; chatInput.style.height='auto';
  sendStopTyping();
}
btnSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();} });
chatInput.addEventListener('input', ()=>{
  chatInput.style.height='auto'; chatInput.style.height=Math.min(chatInput.scrollHeight,100)+'px';
  if(!socket?.connected||!roomId) return;
  if(!isTyping){isTyping=true;socket.emit('typing',{roomId});}
  clearTimeout(typingTimer); typingTimer=setTimeout(sendStopTyping,1500);
});
function sendStopTyping(){
  if(isTyping&&socket?.connected&&roomId){isTyping=false;socket.emit('stop-typing',{roomId});}
}

// Markdown help button
$('btn-md').addEventListener('click', ()=>{
  showToast('**bold** *italic* `code` [link](url)');
});

// Nav logo
navLogoHome.addEventListener('click', ()=>{
  if(socket?.connected) socket.emit('stop');
  destroyPC(); stopCamera();
  if(isSharingScreen) stopScreenShare();
  showScreen('home'); clearChat(); setChatEnabled(false); setStatus('','');
  localOverlay.classList.remove('hidden'); roomId=null; isInChat=false;
});

btnStartVideo.addEventListener('click', startSmegle);
document.addEventListener('keydown', e=>{
  if(e.key==='Enter'&&homeScreen&&!homeScreen.classList.contains('hidden')) startSmegle();
});

// ═══ INIT ══════════════════════════════════════════════════════════════════
connectSocket();
