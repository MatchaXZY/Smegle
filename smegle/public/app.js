'use strict';

// ═══ ICE CONFIG ════════════════════════════════════════════════════════════
const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302','stun:stun1.l.google.com:19302','stun:stun2.l.google.com:19302','stun:stun3.l.google.com:19302','stun:stun4.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    { urls: 'turn:openrelay.metered.ca:80',                 username:'openrelayproject', credential:'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:80?transport=tcp',   username:'openrelayproject', credential:'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443',               username:'openrelayproject', credential:'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', username:'openrelayproject', credential:'openrelayproject' },
    { urls: 'turn:numb.viagenie.ca', username:'webrtc@live.com', credential:'muazkh' },
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
function updateOfflineBanner() {
  let b = document.getElementById('offline-banner');
  if (offline && !b) {
    b = document.createElement('div');
    b.id = 'offline-banner';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;text-align:center;padding:10px;font-size:14px;font-weight:600;font-family:Inter,sans-serif';
    b.textContent = 'No internet connection — video chat requires internet access';
    document.body.prepend(b);
  } else if (!offline && b) { b.remove(); }
}
window.addEventListener('online',  () => { offline=false; updateOfflineBanner(); });
window.addEventListener('offline', () => { offline=true;  updateOfflineBanner(); });
updateOfflineBanner();

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
const toastCont         = $('toast-container');
const navLogoHome       = $('nav-logo-home');

// ═══ STATE ═════════════════════════════════════════════════════════════════
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
let connectWatchdog = null;
let healthInterval  = null;
let iceRestartCount = 0;
let stuckTimer      = null;

// ═══ HELPERS ═══════════════════════════════════════════════════════════════
function showScreen(name) {
  if (name === 'home') { homeScreen.classList.remove('hidden'); chatScreen.classList.add('hidden'); }
  else                 { homeScreen.classList.add('hidden');    chatScreen.classList.remove('hidden'); }
}
function setStatus(state, text) { navStatus.className=`nav-status ${state}`; navStatusText.textContent=text; }
function showToast(msg) {
  const t=document.createElement('div'); t.className='toast'; t.textContent=msg;
  toastCont.appendChild(t); setTimeout(()=>t.remove(),3500);
}

// ═══ LINK PREVIEWS ═════════════════════════════════════════════════════════
const URL_RE = /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

function extractUrls(text) {
  const m=[]; let r; const re=new RegExp(URL_RE.source,'gi');
  while((r=re.exec(text))!==null) m.push(r[0]);
  return m;
}
function classifyUrl(url) {
  try {
    const h=new URL(url).hostname.replace('www.','');
    if(h==='youtube.com'||h==='youtu.be')  return 'youtube';
    if(h==='twitter.com'||h==='x.com')     return 'twitter';
    if(h==='open.spotify.com')             return 'spotify';
    if(h==='reddit.com'||h.endsWith('.reddit.com')) return 'reddit';
    if(h==='github.com')                   return 'github';
    if(h==='instagram.com')                return 'instagram';
    if(h==='twitch.tv')                    return 'twitch';
    if(h==='tiktok.com')                   return 'tiktok';
    if(/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(new URL(url).pathname)) return 'image';
    return 'generic';
  } catch(_){ return 'generic'; }
}
function getYtId(url) {
  try { const u=new URL(url); return u.hostname==='youtu.be'?u.pathname.slice(1).split('?')[0]:u.searchParams.get('v'); } catch(_){ return null; }
}
function escH(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function buildPreview(url, type, isYou) {
  const card=document.createElement('div');
  card.className='link-preview lp-'+(isYou?'you':'stranger');
  const short=url.length>55?url.slice(0,55)+'…':url;

  if(type==='youtube'){
    const vid=getYtId(url);
    if(vid){
      card.innerHTML='<a href="'+escH(url)+'" target="_blank" rel="noopener" class="lp-yt-link">'+
        '<div class="lp-yt-thumb"><img src="https://img.youtube.com/vi/'+vid+'/mqdefault.jpg" loading="lazy" alt="" onerror="this.closest(\'.link-preview\').remove()"/>'+
        '<div class="lp-yt-play"><svg viewBox="0 0 24 24" fill="white" width="26" height="26"><polygon points="5,3 19,12 5,21"/></svg></div></div>'+
        '<div class="lp-info"><div class="lp-site lp-site-yt"><span class="lp-dot lp-dot-yt"></span>YouTube</div><div class="lp-url">'+escH(short)+'</div></div></a>';
      return card;
    }
  }
  if(type==='spotify'){
    try{
      const parts=new URL(url).pathname.split('/').filter(Boolean);
      if(parts.length>=2){
        card.innerHTML='<iframe src="https://open.spotify.com/embed/'+parts[0]+'/'+parts[1]+'?utm_source=generator&theme=0" width="100%" height="80" frameborder="0" allow="autoplay;clipboard-write;encrypted-media;fullscreen;picture-in-picture" loading="lazy" style="border-radius:8px;display:block;"></iframe>';
        return card;
      }
    }catch(_){}
  }
  if(type==='image'){
    card.innerHTML='<a href="'+escH(url)+'" target="_blank" rel="noopener"><img src="'+escH(url)+'" class="lp-img" loading="lazy" alt="" onerror="this.closest(\'.link-preview\').remove()"/></a>';
    return card;
  }
  const icons={twitter:'lp-dot-x',reddit:'lp-dot-reddit',github:'lp-dot-gh',twitch:'lp-dot-twitch',tiktok:'lp-dot-tt',instagram:'lp-dot-ig',generic:'lp-dot-link'};
  const labels={twitter:'X / Twitter',reddit:'Reddit',github:'GitHub',twitch:'Twitch',tiktok:'TikTok',instagram:'Instagram'};
  let domain=''; try{ domain=new URL(url).hostname.replace('www.',''); }catch(_){}
  const label=labels[type]||domain;
  card.innerHTML='<a href="'+escH(url)+'" target="_blank" rel="noopener" class="lp-generic-link">'+
    '<div class="lp-info"><div class="lp-site"><span class="lp-dot '+(icons[type]||'lp-dot-link')+'"></span>'+escH(label)+'</div>'+
    '<div class="lp-url">'+escH(short)+'</div></div></a>';
  return card;
}

function attachPreviews(msgEl, text, isYou) {
  const urls=extractUrls(text); if(!urls.length) return;
  const seen=new Set();
  for(const url of urls){
    if(seen.has(url)) continue; seen.add(url);
    msgEl.insertAdjacentElement('afterend', buildPreview(url,classifyUrl(url),isYou));
  }
}

// ═══ CHAT ══════════════════════════════════════════════════════════════════
function addMessage(type, text) {
  $('chat-welcome')?.remove();
  const el=document.createElement('div');
  if(type==='system'){ el.className='msg-system'; el.textContent=text; }
  else {
    el.className=`msg-bubble msg-${type}`;
    // Plain text — escape HTML, convert URLs to clickable links
    el.innerHTML=escH(text).replace(
      /https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi,
      m=>'<a href="'+m+'" target="_blank" rel="noopener">'+m+'</a>'
    ).replace(/\n/g,'<br>');
  }
  chatMessages.appendChild(el);
  chatMessages.scrollTop=chatMessages.scrollHeight;
  if(type!=='system') attachPreviews(el, text, type==='you');
}

let typingEl=null;
function showTyping(){ if(typingEl)return; typingEl=document.createElement('div'); typingEl.className='typing-indicator'; typingEl.innerHTML='<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>'; chatMessages.appendChild(typingEl); chatMessages.scrollTop=chatMessages.scrollHeight; }
function hideTyping(){ typingEl?.remove(); typingEl=null; }
function clearChat(){ chatMessages.innerHTML='<div class="msg-system" id="chat-welcome">Waiting for a match...</div>'; typingEl=null; }
function setChatEnabled(on){ chatInput.disabled=!on; btnSend.disabled=!on; if(on) setTimeout(()=>chatInput.focus(),100); }
function showRemoteOverlay(t){ remoteOverlay.classList.remove('hidden'); remoteOverlayText.textContent=t; }
function hideRemoteOverlay(){ remoteOverlay.classList.add('hidden'); }
function flashDisconnect(){ disconnectOverlay.classList.add('show'); setTimeout(()=>disconnectOverlay.classList.remove('show'),2200); }

// ═══ CAMERA ════════════════════════════════════════════════════════════════
async function startCamera() {
  if(!navigator.mediaDevices?.getUserMedia){ localOverlayText.textContent='Camera not supported'; return false; }

  const vFallbacks=[
    {width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30,min:15},facingMode:'user'},
    {width:{ideal:1280},height:{ideal:720}, frameRate:{ideal:30,min:15},facingMode:'user'},
    {width:{ideal:640}, height:{ideal:480}, frameRate:{ideal:24},       facingMode:'user'},
    {facingMode:'user'}, true,
  ];
  let videoStream=null;
  for(const vc of vFallbacks){
    try{ videoStream=await navigator.mediaDevices.getUserMedia({video:vc,audio:false}); const t=videoStream.getVideoTracks()[0],s=t.getSettings(); L.info(`Camera ${s.width}x${s.height}@${s.frameRate}fps`); break; }
    catch(e){ L.warn('Video fallback:',e.name); }
  }

  const aFallbacks=[
    {echoCancellation:{ideal:true},noiseSuppression:{ideal:true},autoGainControl:{ideal:true},channelCount:{ideal:1},sampleRate:{ideal:48000},latency:{ideal:0.005}},
    {echoCancellation:true,noiseSuppression:true,autoGainControl:true},
    true,
  ];
  let audioStream=null;
  for(const ac of aFallbacks){
    try{
      audioStream=await navigator.mediaDevices.getUserMedia({audio:ac,video:false});
      const at=audioStream.getAudioTracks()[0];
      L.info('Mic:',at.label);
      // Professional mic? Disable processing for natural sound
      const lbl=at.label.toLowerCase();
      if(lbl.includes('airpod')||lbl.includes('studio')||lbl.includes('blue')||lbl.includes('rode')||lbl.includes('shure')||lbl.includes('focusrite')||lbl.includes('scarlett')||lbl.includes('usb')){
        try{ await at.applyConstraints({echoCancellation:false,noiseSuppression:false,autoGainControl:false}); L.info('Pro mic — processing disabled'); }catch(_){}
      }
      break;
    }catch(e){ L.warn('Audio fallback:',e.name); }
  }

  if(!videoStream&&!audioStream){ localOverlayText.textContent='Camera & mic denied'; showToast('Camera/mic denied — check browser settings'); return false; }

  const tracks=[...(videoStream?.getVideoTracks()||[]),...(audioStream?.getAudioTracks()||[])];
  localStream=new MediaStream(tracks);
  localVideo.srcObject=localStream; localVideo.playsInline=true;
  if(videoStream) localOverlay.classList.add('hidden'); else localOverlayText.textContent='Audio only';
  return true;
}

function stopCamera(){ localStream?.getTracks().forEach(t=>t.stop()); localStream=null; localVideo.srcObject=null; }

// ═══ WEBRTC ════════════════════════════════════════════════════════════════
function createPC() {
  if(pc) destroyPC();
  iceRestartCount=0;
  L.info('Creating RTCPeerConnection');
  pc=new RTCPeerConnection(ICE_CONFIG);
  localStream?.getTracks().forEach(t=>{ pc.addTrack(t,localStream); });

  pc.ontrack=e=>{
    if(e.streams?.[0]){ remoteVideo.srcObject=e.streams[0]; remoteVideo.playsInline=true; remoteVideo.play().catch(()=>{}); clearStuck(); clearWatchdog(); hideRemoteOverlay(); }
  };
  pc.onicecandidate=e=>{ if(e.candidate&&roomId&&socket?.connected) socket.emit('ice-candidate',{candidate:e.candidate,roomId}); };
  pc.oniceconnectionstatechange=()=>{
    const s=pc.iceConnectionState; L.info('ICE:',s);
    if(s==='checking') setWatchdog();
    else if(s==='connected'||s==='completed'){ clearWatchdog(); clearStuck(); }
    else if(s==='failed') handleIceFail();
    else if(s==='disconnected') setTimeout(()=>{ if(pc?.iceConnectionState==='disconnected') handleIceFail(); },5000);
  };
  pc.onconnectionstatechange=()=>{
    const s=pc.connectionState; L.info('Conn:',s);
    if(s==='connecting') { setStatus('waiting','Connecting...'); setWatchdog(); }
    else if(s==='connected') { setStatus('connected','Connected'); clearWatchdog(); clearStuck(); isInChat=true; setHighBitrate(); startHealth(); }
    else if(s==='failed') { setStatus('disconnected','Connection failed — retrying...'); handleIceFail(); }
    else if(s==='disconnected') setStatus('disconnected','Connection lost...');
  };
}

function setWatchdog(){ clearWatchdog(); connectWatchdog=setTimeout(()=>{ L.warn('Watchdog fired'); handleIceFail(); },15000); }
function clearWatchdog(){ clearTimeout(connectWatchdog); connectWatchdog=null; }
function setStuck(){ clearStuck(); stuckTimer=setTimeout(()=>{ if(!isInChat&&roomId){ showToast('Connection timed out — finding someone new...'); doSkip(); } },35000); }
function clearStuck(){ clearTimeout(stuckTimer); stuckTimer=null; }

async function handleIceFail(){
  if(!pc||!roomId) return;
  iceRestartCount++;
  L.warn('ICE failure #'+iceRestartCount);
  if(iceRestartCount>3){ showToast('Could not connect — finding someone new...'); doSkip(); return; }
  if(isInitiator) await doIceRestart();
  else if(socket?.connected&&roomId) socket.emit('request-ice-restart',{roomId});
}

async function doIceRestart(){
  if(!pc||!roomId||!socket?.connected) return;
  try{ const o=await pc.createOffer({iceRestart:true}); await pc.setLocalDescription(o); socket.emit('offer',{offer:pc.localDescription,roomId}); }
  catch(e){ L.error('ICE restart:',e); }
}

async function setHighBitrate(){
  if(!pc) return;
  for(const s of pc.getSenders()){
    if(s.track?.kind!=='video') continue;
    try{ const p=s.getParameters(); if(!p.encodings?.length) p.encodings=[{}]; p.encodings[0].maxBitrate=4_000_000; p.encodings[0].maxFramerate=30; p.degradationPreference='maintain-resolution'; await s.setParameters(p); }catch(_){}
  }
}

function startHealth(){ stopHealth(); healthInterval=setInterval(async()=>{ if(!pc){stopHealth();return;} try{ await pc.getStats(); }catch(_){} },10000); }
function stopHealth(){ clearInterval(healthInterval); healthInterval=null; }

function destroyPC(){
  clearWatchdog(); clearStuck(); stopHealth();
  if(pc){ pc.ontrack=pc.onicecandidate=pc.oniceconnectionstatechange=pc.onconnectionstatechange=null; try{pc.close();}catch(_){} pc=null; }
  remoteVideo.srcObject=null; pendingIce=[]; isInChat=false; iceRestartCount=0;
}

async function flushIce(){
  const q=[...pendingIce]; pendingIce=[];
  for(const c of q){ if(!pc) break; try{await pc.addIceCandidate(new RTCIceCandidate(c));}catch(e){L.warn('addIce:',e.message);} }
}

// ═══ SOCKET ════════════════════════════════════════════════════════════════
function connectSocket(){
  if(socket?.connected) return;
  socket=io({ transports:['websocket','polling'], upgrade:true, reconnection:true, reconnectionAttempts:Infinity, reconnectionDelay:800, reconnectionDelayMax:5000, timeout:15000 });

  socket.on('connect',       ()=>L.info('Socket connected',socket.id));
  socket.on('connect_error', e=>{ L.error('Socket error:',e.message); setStatus('disconnected','Server unreachable — retrying...'); });
  socket.on('disconnect',    r=>{ L.warn('Socket disconnected:',r); setStatus('disconnected','Reconnecting...'); });
  socket.io.on('reconnect',  ()=>{ if(!isInChat&&chatScreen&&!chatScreen.classList.contains('hidden')){ setStatus('waiting','Reconnected — finding someone...'); socket.emit('join-queue',{language:'any'}); } });

  socket.on('online-count', n=>{
    const lbl=n===1?'1 person online':`${n.toLocaleString()} people online`;
    if(homeOnlineCount) homeOnlineCount.textContent=lbl;
    if(chatOnlineCount) chatOnlineCount.textContent=`${n.toLocaleString()} online`;
    const s=$('stat-online'); if(s) s.textContent=n.toLocaleString();
  });

  socket.on('waiting', ()=>{ isInChat=false; showRemoteOverlay('Finding someone...'); setStatus('waiting','Finding someone...'); clearChat(); setChatEnabled(false); disconnectOverlay.classList.remove('show'); });

  socket.on('matched', async({roomId:rid,initiator})=>{
    roomId=rid; isInitiator=initiator; L.info('Matched room='+rid);
    setStatus('waiting','Setting up video...'); showRemoteOverlay('Connecting...');
    addMessage('system','You are now connected to a stranger. Say hi!');
    setChatEnabled(true); setStuck(); createPC();
    if(isInitiator){
      try{ const o=await pc.createOffer({offerToReceiveAudio:true,offerToReceiveVideo:true}); await pc.setLocalDescription(o); socket.emit('offer',{offer:pc.localDescription,roomId}); }
      catch(e){ L.error('createOffer:',e); }
    }
  });

  socket.on('offer', async({offer})=>{
    if(!pc) createPC();
    if(!roomId){ L.warn('offer but no roomId'); return; }
    try{ await pc.setRemoteDescription(new RTCSessionDescription(offer)); await flushIce(); const a=await pc.createAnswer(); await pc.setLocalDescription(a); socket.emit('answer',{answer:pc.localDescription,roomId}); }
    catch(e){ L.error('handleOffer:',e); }
  });

  socket.on('answer', async({answer})=>{
    if(!pc||!roomId||pc.signalingState!=='have-local-offer'){ L.warn('answer ignored, state:',pc?.signalingState); return; }
    try{ await pc.setRemoteDescription(new RTCSessionDescription(answer)); await flushIce(); }
    catch(e){ L.error('handleAnswer:',e); }
  });

  socket.on('ice-candidate', async({candidate})=>{
    if(!candidate) return;
    if(!pc||!pc.remoteDescription?.type){ pendingIce.push(candidate); return; }
    try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(_){}
  });

  socket.on('request-ice-restart', ({roomId:rid})=>{ if(rid===roomId&&isInitiator) doIceRestart(); });

  socket.on('partner-disconnected', ()=>{
    isInChat=false; roomId=null; destroyPC(); flashDisconnect();
    setStatus('disconnected','Stranger left');
    addMessage('system','Stranger has disconnected.');
    setChatEnabled(false); hideTyping();
    setTimeout(()=>{ if(!roomId) showRemoteOverlay('Stranger left — click Skip to find another'); },1000);
  });

  socket.on('stopped', ()=>{
    isInChat=false; roomId=null; destroyPC(); stopCamera();
    showScreen('home'); clearChat(); setChatEnabled(false); setStatus('','');
    localOverlay.classList.remove('hidden'); localOverlayText.textContent='Camera off';
  });

  socket.on('chat-message', ({message})=>{ hideTyping(); addMessage('stranger',message); });
  socket.on('stranger-typing',      ()=>{ showTyping(); chatMessages.scrollTop=chatMessages.scrollHeight; });
  socket.on('stranger-stop-typing', ()=>hideTyping());
}

// ═══ SKIP ══════════════════════════════════════════════════════════════════
function doSkip(){
  destroyPC(); setChatEnabled(false); hideTyping(); clearChat();
  if(socket?.connected) socket.emit('skip',{language:'any'});
}

// ═══ START ═════════════════════════════════════════════════════════════════
async function startSmegle(){
  if(offline){ showToast('No internet — check your connection'); return; }
  btnStartVideo.disabled=true; btnStartVideo.textContent='Starting...';
  showScreen('chat'); setStatus('waiting','Starting camera...'); showRemoteOverlay('Starting camera...');
  connectSocket();
  const ok=await startCamera();
  if(!ok) showToast('Joining without camera/mic');
  setStatus('waiting','Finding someone...'); showRemoteOverlay('Finding someone...');
  if(socket.connected) socket.emit('join-queue',{language:'any'});
  else socket.once('connect',()=>socket.emit('join-queue',{language:'any'}));
  btnStartVideo.disabled=false; btnStartVideo.textContent='Start Videoing';
}

// ═══ CONTROLS ══════════════════════════════════════════════════════════════
btnSkip.addEventListener('click', ()=>{ if(socket) doSkip(); });

btnStop.addEventListener('click', ()=>{
  if(!socket) return;
  destroyPC(); socket.emit('stop'); stopCamera();
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

// Chat
function sendMessage(){
  const msg=chatInput.value.trim();
  if(!msg||!socket?.connected||!roomId) return;
  socket.emit('chat-message',{message:msg,roomId});
  addMessage('you',msg);
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
function sendStopTyping(){ if(isTyping&&socket?.connected&&roomId){isTyping=false;socket.emit('stop-typing',{roomId});} }

// Nav logo home
navLogoHome.addEventListener('click', ()=>{
  if(socket?.connected) socket.emit('stop');
  destroyPC(); stopCamera(); showScreen('home'); clearChat(); setChatEnabled(false); setStatus('','');
  localOverlay.classList.remove('hidden'); roomId=null; isInChat=false;
});

btnStartVideo.addEventListener('click', startSmegle);
document.addEventListener('keydown', e=>{ if(e.key==='Enter'&&homeScreen&&!homeScreen.classList.contains('hidden')) startSmegle(); });

connectSocket();
