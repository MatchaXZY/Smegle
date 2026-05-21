/**
 * Smegle Signaling Server v2
 * Language-aware matchmaking + WebRTC relay
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
  pingTimeout: 10000,
  pingInterval: 5000,
  upgradeTimeout: 5000,
  perMessageDeflate: false,
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ status: 'ok', online: onlineCount, waiting: waitingQueue.length, rooms: rooms.size }));
app.get('/terms',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

// ── State ────────────────────────────────────────────────────────────────────
// Queue entries: { socket, language, joinedAt }
const waitingQueue = [];
const rooms    = new Map(); // roomId -> { users: [id, id], created }
const userRoom = new Map(); // socketId -> roomId
let onlineCount = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPartner(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const pid = room.users.find(id => id !== socket.id);
  return pid ? io.sockets.sockets.get(pid) : null;
}

function removeFromQueue(socket) {
  const idx = waitingQueue.findIndex(e => e.socket === socket);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function destroyRoom(socket, reason = 'partner-disconnected') {
  const roomId = userRoom.get(socket.id);
  if (!roomId) return;
  const partner = getPartner(socket, roomId);
  const room = rooms.get(roomId);
  if (room) { room.users.forEach(uid => userRoom.delete(uid)); rooms.delete(roomId); }
  if (partner) partner.emit(reason);
}

function createRoom(entryA, entryB) {
  const roomId = uuidv4();
  rooms.set(roomId, { users: [entryA.socket.id, entryB.socket.id], created: Date.now() });
  userRoom.set(entryA.socket.id, roomId);
  userRoom.set(entryB.socket.id, roomId);
  entryA.socket.emit('matched', { roomId, initiator: true });
  entryB.socket.emit('matched', { roomId, initiator: false });
}

function tryMatch() {
  if (waitingQueue.length < 2) return;

  // Clean disconnected sockets first
  for (let i = waitingQueue.length - 1; i >= 0; i--) {
    if (!waitingQueue[i].socket.connected) waitingQueue.splice(i, 1);
  }

  if (waitingQueue.length < 2) return;

  // Try language-aware match
  for (let i = 0; i < waitingQueue.length; i++) {
    const a = waitingQueue[i];
    const waitSecs = (Date.now() - a.joinedAt) / 1000;

    for (let j = i + 1; j < waitingQueue.length; j++) {
      const b = waitingQueue[j];

      const sameLanguage = a.language === b.language;
      const eitherAny    = a.language === 'any' || b.language === 'any';
      // After 6s waiting, match regardless of language
      const timeoutMatch = waitSecs > 6;

      if (sameLanguage || eitherAny || timeoutMatch) {
        waitingQueue.splice(j, 1);
        waitingQueue.splice(i, 1);
        createRoom(a, b);
        // Keep trying for remaining queue members
        setTimeout(tryMatch, 0);
        return;
      }
    }
  }
}

// ── Broadcast count ───────────────────────────────────────────────────────────
let bcTimer = null;
function broadcastCount() {
  clearTimeout(bcTimer);
  bcTimer = setTimeout(() => {
    io.emit('online-count', onlineCount);
  }, 100);
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  onlineCount++;
  broadcastCount();
  socket.emit('online-count', onlineCount);

  socket.on('join-queue', ({ language = 'any' } = {}) => {
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language, joinedAt: Date.now() });
    socket.emit('waiting');
    tryMatch();
  });

  socket.on('leave-queue', () => removeFromQueue(socket));

  socket.on('offer',         ({ offer, roomId })     => { const p = getPartner(socket, roomId); if (p) p.emit('offer',         { offer });     });
  socket.on('answer',        ({ answer, roomId })    => { const p = getPartner(socket, roomId); if (p) p.emit('answer',        { answer });    });
  socket.on('ice-candidate', ({ candidate, roomId }) => { const p = getPartner(socket, roomId); if (p) p.emit('ice-candidate', { candidate }); });

  socket.on('chat-message', ({ message, roomId }) => {
    if (!message || typeof message !== 'string') return;
    const m = message.trim().slice(0, 2000);
    if (!m) return;
    const p = getPartner(socket, roomId);
    if (p) p.emit('chat-message', { message: m });
  });

  socket.on('typing',      ({ roomId }) => { const p = getPartner(socket, roomId); if (p) p.emit('stranger-typing');      });
  socket.on('stop-typing', ({ roomId }) => { const p = getPartner(socket, roomId); if (p) p.emit('stranger-stop-typing'); });

  socket.on('skip', ({ language = 'any' } = {}) => {
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push({ socket, language, joinedAt: Date.now() });
    socket.emit('waiting');
    tryMatch();
  });

  socket.on('stop', () => {
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    socket.emit('stopped');
  });

  socket.on('report', ({ roomId, reason }) => {
    console.log(`[REPORT] room=${roomId} by=${socket.id} reason=${reason}`);
    socket.emit('report-received');
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    socket.emit('waiting');
    waitingQueue.push({ socket, language: 'any', joinedAt: Date.now() });
    tryMatch();
  });

  socket.on('disconnect', () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastCount();
    removeFromQueue(socket);
    destroyRoom(socket, 'partner-disconnected');
  });
});

// Cleanup stale rooms every 5 min
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const [rid, room] of rooms.entries()) {
    if (room.created < cutoff) { room.users.forEach(uid => userRoom.delete(uid)); rooms.delete(rid); }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Smegle v2 running on port ${PORT}`);
});
