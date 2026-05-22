/**
 * Smegle Signaling Server v4
 * Full connectivity overhaul + rich features
 */
'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
  pingTimeout:       25000,
  pingInterval:       8000,
  upgradeTimeout:    15000,
  maxHttpBufferSize:  5e6,   // 5MB for image/file sharing
  perMessageDeflate: false,
});

// ── Static + routes ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/terms',   (_, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (_, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/health',  (_, res) => res.json({
  status:  'ok',
  online:  onlineCount,
  waiting: waitingQueue.length,
  rooms:   rooms.size,
  private: privateRooms.size,
  uptime:  Math.floor(process.uptime()),
  mem:     Math.floor(process.memoryUsage().rss / 1024 / 1024) + 'MB',
  ts:      Date.now(),
}));

// ── State ─────────────────────────────────────────────────────────────────────
const waitingQueue = [];
const rooms        = new Map();   // roomId -> { users:[id,id], created }
const userRoom     = new Map();   // socketId -> roomId
const privateRooms = new Map();   // code -> { host:socketId, created }
let   onlineCount  = 0;

// ── Logger ────────────────────────────────────────────────────────────────────
const ts  = () => new Date().toISOString().slice(11,23);
const log = {
  info:  (...a) => console.log( `[${ts()}] INFO `, ...a),
  warn:  (...a) => console.warn( `[${ts()}] WARN `, ...a),
  error: (...a) => console.error(`[${ts()}] ERR  `, ...a),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const alive     = s  => s && s.connected;
const safeGet   = (o, k, d=null) => { try { return o?.[k] ?? d; } catch{return d;} };

function getPartner(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const pid = room.users.find(id => id !== socket.id);
  if (!pid) return null;
  const p = io.sockets.sockets.get(pid);
  return alive(p) ? p : null;
}

function removeFromQueue(socket) {
  const idx = waitingQueue.findIndex(e => e.socket === socket);
  if (idx !== -1) { waitingQueue.splice(idx, 1); return true; }
  return false;
}

function destroyRoom(socket, reason = 'partner-disconnected') {
  const roomId = userRoom.get(socket.id);
  if (!roomId) return;
  const partner = getPartner(socket, roomId);
  const room    = rooms.get(roomId);
  if (room) {
    room.users.forEach(uid => userRoom.delete(uid));
    rooms.delete(roomId);
  }
  if (partner) { partner.emit(reason); log.info(`Room ${roomId} ended — told ${partner.id}`); }
}

function createRoom(entryA, entryB) {
  if (!alive(entryA.socket) || !alive(entryB.socket)) {
    if (alive(entryA.socket)) waitingQueue.push(entryA);
    if (alive(entryB.socket)) waitingQueue.push(entryB);
    setImmediate(tryMatch);
    return;
  }
  const roomId = uuidv4();
  rooms.set(roomId, { users: [entryA.socket.id, entryB.socket.id], created: Date.now() });
  userRoom.set(entryA.socket.id, roomId);
  userRoom.set(entryB.socket.id, roomId);
  log.info(`Match: ${entryA.socket.id} <-> ${entryB.socket.id}  room=${roomId}`);
  entryA.socket.emit('matched', { roomId, initiator: true  });
  entryB.socket.emit('matched', { roomId, initiator: false });
}

function tryMatch() {
  if (waitingQueue.length < 2) return;
  // Purge dead
  for (let i = waitingQueue.length - 1; i >= 0; i--)
    if (!alive(waitingQueue[i].socket)) waitingQueue.splice(i, 1);
  if (waitingQueue.length < 2) return;

  for (let i = 0; i < waitingQueue.length; i++) {
    const a = waitingQueue[i];
    const waitSecs = (Date.now() - a.joinedAt) / 1000;
    for (let j = i+1; j < waitingQueue.length; j++) {
      const b = waitingQueue[j];
      if (a.language === b.language || a.language === 'any' || b.language === 'any' || waitSecs > 5) {
        waitingQueue.splice(j,1); waitingQueue.splice(i,1);
        createRoom(a, b);
        setImmediate(tryMatch);
        return;
      }
    }
  }
}

// Generate random 6-char room code
function genCode() {
  return Math.random().toString(36).slice(2,8).toUpperCase();
}

// ── Online count broadcast ─────────────────────────────────────────────────
let bcTimer = null;
function broadcastCount() {
  clearTimeout(bcTimer);
  bcTimer = setTimeout(() => io.emit('online-count', onlineCount), 120);
}

// ── Relay helper ──────────────────────────────────────────────────────────────
function relay(socket, roomId, event, data) {
  const p = getPartner(socket, roomId);
  if (p) p.emit(event, data);
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on('connection', socket => {
  onlineCount++;
  broadcastCount();
  socket.emit('online-count', onlineCount);
  log.info(`+ ${socket.id}  total=${onlineCount}`);

  // ── Queue ──────────────────────────────────────────────────────────────────
  socket.on('join-queue', (payload={}) => {
    const language = safeGet(payload, 'language', 'any');
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language, joinedAt: Date.now() });
    socket.emit('waiting');
    log.info(`Queue ${socket.id} lang=${language} qlen=${waitingQueue.length}`);
    tryMatch();
  });

  socket.on('leave-queue', () => removeFromQueue(socket));

  // ── Private rooms ──────────────────────────────────────────────────────────
  socket.on('create-private-room', () => {
    // Clean up old private room if any
    for (const [code, r] of privateRooms.entries()) {
      if (r.host === socket.id) { privateRooms.delete(code); break; }
    }
    let code;
    do { code = genCode(); } while (privateRooms.has(code));
    privateRooms.set(code, { host: socket.id, created: Date.now() });
    socket.emit('private-room-created', { code });
    log.info(`Private room ${code} created by ${socket.id}`);
  });

  socket.on('join-private-room', (payload={}) => {
    const code = (safeGet(payload,'code','')).toString().toUpperCase().trim();
    if (!privateRooms.has(code)) {
      socket.emit('private-room-error', { msg: 'Room not found. Check the code and try again.' });
      return;
    }
    const { host: hostId } = privateRooms.get(code);
    const hostSocket = io.sockets.sockets.get(hostId);
    if (!alive(hostSocket)) {
      privateRooms.delete(code);
      socket.emit('private-room-error', { msg: 'Room host disconnected.' });
      return;
    }
    privateRooms.delete(code);
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    const entryA = { socket: hostSocket, language: 'any', joinedAt: Date.now() };
    const entryB = { socket,            language: 'any', joinedAt: Date.now() };
    createRoom(entryA, entryB);
    log.info(`Private room ${code} joined by ${socket.id}`);
  });

  // ── WebRTC signaling ───────────────────────────────────────────────────────
  socket.on('offer', p => {
    const roomId = safeGet(p,'roomId'), offer = safeGet(p,'offer');
    if (!roomId || !offer) return;
    relay(socket, roomId, 'offer', { offer });
  });

  socket.on('answer', p => {
    const roomId = safeGet(p,'roomId'), answer = safeGet(p,'answer');
    if (!roomId || !answer) return;
    relay(socket, roomId, 'answer', { answer });
  });

  socket.on('ice-candidate', p => {
    const roomId = safeGet(p,'roomId'), candidate = safeGet(p,'candidate');
    if (!roomId || !candidate) return;
    relay(socket, roomId, 'ice-candidate', { candidate });
  });

  socket.on('request-ice-restart', p => {
    relay(socket, safeGet(p,'roomId'), 'request-ice-restart', { roomId: safeGet(p,'roomId') });
  });

  // ── Chat messages ──────────────────────────────────────────────────────────
  socket.on('chat-message', p => {
    const roomId = safeGet(p,'roomId');
    const msg    = safeGet(p,'message','');
    if (!roomId || typeof msg !== 'string') return;
    const m = msg.trim().slice(0, 4000);
    if (!m) return;
    relay(socket, roomId, 'chat-message', { message: m, id: safeGet(p,'id') });
  });

  // Image / file sharing (base64, max 4MB)
  socket.on('share-media', p => {
    const roomId = safeGet(p,'roomId');
    const data   = safeGet(p,'data');
    const type   = safeGet(p,'type','image');
    const name   = safeGet(p,'name','file');
    if (!roomId || !data) return;
    if (typeof data === 'string' && data.length > 6_000_000) {
      socket.emit('share-error', { msg: 'File too large (max 4MB)' });
      return;
    }
    relay(socket, roomId, 'share-media', { data, type, name, id: safeGet(p,'id') });
  });

  // Voice messages
  socket.on('voice-message', p => {
    const roomId = safeGet(p,'roomId'), audio = safeGet(p,'audio');
    if (!roomId || !audio) return;
    relay(socket, roomId, 'voice-message', { audio, id: safeGet(p,'id') });
  });

  // Reactions, edits, deletes
  socket.on('react',          p => relay(socket, safeGet(p,'roomId'), 'react',          p));
  socket.on('edit-message',   p => relay(socket, safeGet(p,'roomId'), 'edit-message',   p));
  socket.on('delete-message', p => relay(socket, safeGet(p,'roomId'), 'delete-message', p));

  // Typing
  socket.on('typing',      p => relay(socket, safeGet(p,'roomId'), 'stranger-typing',      {}));
  socket.on('stop-typing', p => relay(socket, safeGet(p,'roomId'), 'stranger-stop-typing', {}));

  // Screen share state
  socket.on('screen-share-started', p => relay(socket, safeGet(p,'roomId'), 'stranger-screen-share-started', {}));
  socket.on('screen-share-stopped', p => relay(socket, safeGet(p,'roomId'), 'stranger-screen-share-stopped', {}));

  // ── Skip / Stop / Report ───────────────────────────────────────────────────
  socket.on('skip', (p={}) => {
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language: safeGet(p,'language','any'), joinedAt: Date.now() });
    socket.emit('waiting');
    tryMatch();
  });

  socket.on('stop', () => {
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    socket.emit('stopped');
  });

  socket.on('report', p => {
    const roomId = safeGet(p,'roomId','?'), reason = safeGet(p,'reason','?');
    log.warn(`REPORT room=${roomId} by=${socket.id} reason=${reason}`);
    socket.emit('report-received');
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language:'any', joinedAt: Date.now() });
    socket.emit('waiting');
    tryMatch();
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastCount();
    removeFromQueue(socket);
    destroyRoom(socket, 'partner-disconnected');
    // Clean up any private rooms this socket hosted
    for (const [code, r] of privateRooms.entries())
      if (r.host === socket.id) { privateRooms.delete(code); break; }
    log.info(`- ${socket.id}  reason=${reason}  total=${onlineCount}`);
  });

  socket.on('error', err => log.error(`Socket err ${socket.id}:`, err.message));
});

// ── Stale cleanup every 5 min ──────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 3*60*60*1000;
  let n = 0;
  for (const [rid, room] of rooms.entries())
    if (room.created < cutoff) { room.users.forEach(u => userRoom.delete(u)); rooms.delete(rid); n++; }
  for (let i = waitingQueue.length-1; i>=0; i--)
    if (!alive(waitingQueue[i].socket)) { waitingQueue.splice(i,1); n++; }
  for (const [code, r] of privateRooms.entries())
    if (Date.now() - r.created > 30*60*1000) { privateRooms.delete(code); n++; }
  if (n) log.info(`Cleanup: removed ${n} stale entries`);
}, 5*60*1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => log.info(`Smegle v4 on port ${PORT}`));
