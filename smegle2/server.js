/**
 * Smegle Signaling Server v3
 * Full audit fixes:
 *  - Proper ping/timeout values to detect dead sockets fast
 *  - Race-condition-safe matchmaking with socket validity checks
 *  - Structured server-side logging for every signaling event
 *  - Health + diagnostics endpoint
 *  - Stale queue/room cleanup on interval
 *  - Graceful handling of malformed payloads
 */

'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');

const app    = express();
const server = http.createServer(app);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  // Allow both transports — polling first so proxies/firewalls don't break upgrade
  transports: ['websocket', 'polling'],
  pingTimeout:       20000,   // how long to wait for pong before killing socket
  pingInterval:       8000,   // how often to ping
  upgradeTimeout:    10000,
  maxHttpBufferSize: 1e6,     // 1 MB max message
  perMessageDeflate: false,   // off for latency
});

// ── Static + routes ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/terms',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/health',  (_req, res) => res.json({
  status:  'ok',
  online:  onlineCount,
  waiting: waitingQueue.length,
  rooms:   rooms.size,
  uptime:  Math.floor(process.uptime()),
  mem:     Math.floor(process.memoryUsage().rss / 1024 / 1024) + 'MB',
  ts:      Date.now(),
}));

// ── State ─────────────────────────────────────────────────────────────────────
const waitingQueue = [];          // [{ socket, language, joinedAt }]
const rooms        = new Map();   // roomId -> { users:[id,id], created }
const userRoom     = new Map();   // socketId -> roomId
let   onlineCount  = 0;

// ── Logging ───────────────────────────────────────────────────────────────────
const log = {
  info:  (...a) => console.log( '[INFO]',  new Date().toISOString(), ...a),
  warn:  (...a) => console.warn('[WARN]',  new Date().toISOString(), ...a),
  error: (...a) => console.error('[ERR]',  new Date().toISOString(), ...a),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function isAlive(socket) {
  return socket && socket.connected;
}

function getPartner(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const pid = room.users.find(id => id !== socket.id);
  if (!pid) return null;
  const partner = io.sockets.sockets.get(pid);
  return isAlive(partner) ? partner : null;
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
  if (partner) {
    partner.emit(reason);
    log.info(`Room ${roomId} destroyed — notified partner ${partner.id} (${reason})`);
  }
}

function createRoom(entryA, entryB) {
  // Final alive-check before committing
  if (!isAlive(entryA.socket) || !isAlive(entryB.socket)) {
    log.warn('createRoom: one socket died before room was created, re-queuing survivor');
    if (isAlive(entryA.socket)) { waitingQueue.push(entryA); tryMatch(); }
    if (isAlive(entryB.socket)) { waitingQueue.push(entryB); tryMatch(); }
    return;
  }

  const roomId = uuidv4();
  rooms.set(roomId, { users: [entryA.socket.id, entryB.socket.id], created: Date.now() });
  userRoom.set(entryA.socket.id, roomId);
  userRoom.set(entryB.socket.id, roomId);

  log.info(`Room ${roomId} created: ${entryA.socket.id} <-> ${entryB.socket.id}`);

  entryA.socket.emit('matched', { roomId, initiator: true  });
  entryB.socket.emit('matched', { roomId, initiator: false });
}

function tryMatch() {
  if (waitingQueue.length < 2) return;

  // Purge dead sockets
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (!isAlive(waitingQueue[i].socket)) waitingQueue.splice(i, 1);
  }
  if (waitingQueue.length < 2) return;

  for (let i = 0; i < waitingQueue.length; i++) {
    const a        = waitingQueue[i];
    const waitSecs = (Date.now() - a.joinedAt) / 1000;

    for (let j = i + 1; j < waitingQueue.length; j++) {
      const b = waitingQueue[j];

      const sameLanguage = a.language === b.language;
      const eitherAny    = a.language === 'any' || b.language === 'any';
      const timedOut     = waitSecs > 6; // open up after 6 s

      if (sameLanguage || eitherAny || timedOut) {
        waitingQueue.splice(j, 1);
        waitingQueue.splice(i, 1);
        createRoom(a, b);
        setImmediate(tryMatch); // non-blocking, process rest of queue
        return;
      }
    }
  }
}

// ── Online count broadcast (debounced 150 ms) ─────────────────────────────────
let bcTimer = null;
function broadcastCount() {
  clearTimeout(bcTimer);
  bcTimer = setTimeout(() => io.emit('online-count', onlineCount), 150);
}

// ── Safe payload extractor ────────────────────────────────────────────────────
function safe(payload, key, fallback = null) {
  try { return (payload && payload[key] !== undefined) ? payload[key] : fallback; }
  catch (_) { return fallback; }
}

// ── Connection handler ────────────────────────────────────────────────────────
io.on('connection', socket => {
  onlineCount++;
  broadcastCount();
  socket.emit('online-count', onlineCount);
  log.info(`+ connected  ${socket.id}  total=${onlineCount}`);

  // ── Queue ──────────────────────────────────────────────────────────────────
  socket.on('join-queue', (payload = {}) => {
    const language = safe(payload, 'language', 'any');
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language, joinedAt: Date.now() });
    socket.emit('waiting');
    log.info(`Queue join  ${socket.id}  lang=${language}  qlen=${waitingQueue.length}`);
    tryMatch();
  });

  socket.on('leave-queue', () => {
    removeFromQueue(socket);
    log.info(`Queue leave ${socket.id}`);
  });

  // ── WebRTC signaling ───────────────────────────────────────────────────────
  socket.on('offer', payload => {
    const roomId = safe(payload, 'roomId');
    const offer  = safe(payload, 'offer');
    if (!roomId || !offer) { log.warn(`Bad offer from ${socket.id}`); return; }
    const p = getPartner(socket, roomId);
    if (p) { p.emit('offer', { offer }); log.info(`Offer relayed ${socket.id} -> ${p.id}`); }
    else log.warn(`Offer: no live partner for room ${roomId}`);
  });

  socket.on('answer', payload => {
    const roomId = safe(payload, 'roomId');
    const answer = safe(payload, 'answer');
    if (!roomId || !answer) { log.warn(`Bad answer from ${socket.id}`); return; }
    const p = getPartner(socket, roomId);
    if (p) { p.emit('answer', { answer }); log.info(`Answer relayed ${socket.id} -> ${p.id}`); }
    else log.warn(`Answer: no live partner for room ${roomId}`);
  });

  socket.on('ice-candidate', payload => {

  // ICE restart request relay
  socket.on('request-ice-restart', payload => {
    const rId = (payload && payload.roomId) ? payload.roomId : null;
    const p = rId ? getPartner(socket, rId) : null;
    if (p) p.emit('request-ice-restart', { roomId: rId });
  });
    const roomId    = safe(payload, 'roomId');
    const candidate = safe(payload, 'candidate');
    if (!roomId || !candidate) return;
    const p = getPartner(socket, roomId);
    if (p) p.emit('ice-candidate', { candidate });
  });

  // ── Chat ───────────────────────────────────────────────────────────────────
  socket.on('chat-message', payload => {
    const roomId  = safe(payload, 'roomId');
    const message = safe(payload, 'message', '');
    if (!roomId || typeof message !== 'string') return;
    const m = message.trim().slice(0, 2000);
    if (!m) return;
    const p = getPartner(socket, roomId);
    if (p) p.emit('chat-message', { message: m });
  });

  socket.on('typing',      payload => { const p = getPartner(socket, safe(payload,'roomId')); if (p) p.emit('stranger-typing');      });
  socket.on('stop-typing', payload => { const p = getPartner(socket, safe(payload,'roomId')); if (p) p.emit('stranger-stop-typing'); });

  // ── Skip / Stop ────────────────────────────────────────────────────────────
  socket.on('skip', (payload = {}) => {
    const language = safe(payload, 'language', 'any');
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language, joinedAt: Date.now() });
    socket.emit('waiting');
    log.info(`Skip        ${socket.id}  qlen=${waitingQueue.length}`);
    tryMatch();
  });

  socket.on('stop', () => {
    log.info(`Stop        ${socket.id}`);
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    socket.emit('stopped');
  });

  // ── Report ─────────────────────────────────────────────────────────────────
  socket.on('report', payload => {
    const roomId = safe(payload, 'roomId', 'unknown');
    const reason = safe(payload, 'reason', 'unspecified');
    log.warn(`[REPORT] room=${roomId}  reporter=${socket.id}  reason=${reason}`);
    socket.emit('report-received');
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language: 'any', joinedAt: Date.now() });
    socket.emit('waiting');
    tryMatch();
  });

  // ── Disconnect ─────────────────────────────────────────────────────────────
  socket.on('disconnect', reason => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastCount();
    removeFromQueue(socket);
    destroyRoom(socket, 'partner-disconnected');
    log.info(`- disconnected ${socket.id}  reason=${reason}  total=${onlineCount}`);
  });

  socket.on('error', err => log.error(`Socket error ${socket.id}:`, err.message));
});

// ── Stale cleanup every 5 min ─────────────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  let cleaned  = 0;
  for (const [rid, room] of rooms.entries()) {
    if (room.created < cutoff) {
      room.users.forEach(uid => userRoom.delete(uid));
      rooms.delete(rid);
      cleaned++;
    }
  }
  // Also purge dead sockets from queue
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (!isAlive(waitingQueue[i].socket)) { waitingQueue.splice(i, 1); cleaned++; }
  }
  if (cleaned) log.info(`Stale cleanup: removed ${cleaned} entries`);
}, 5 * 60 * 1000);

// ── Start ──────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  log.info(`Smegle v3 signaling server on port ${PORT}`);
});
