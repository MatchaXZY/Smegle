/**
 * Smegle Signaling Server
 * Optimized for low-latency WebRTC matchmaking and signaling
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Socket.IO configured for minimum latency
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  // Prefer WebSocket, fall back to polling
  transports: ['websocket', 'polling'],
  // Tight pings to detect dead connections fast
  pingTimeout: 10000,
  pingInterval: 5000,
  // Upgrade to WebSocket ASAP
  upgradeTimeout: 5000,
  allowUpgrades: true,
  // Per-message compression
  perMessageDeflate: false, // disable for lower latency
  httpCompression: false,
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    online: onlineCount,
    waiting: waitingQueue.length,
    rooms: rooms.size,
  });
});

// ── State ────────────────────────────────────────────────────────────────────

/** FIFO queue of sockets waiting for a match */
const waitingQueue = [];

/**
 * rooms Map: roomId -> { users: [socketId, socketId], created: timestamp }
 */
const rooms = new Map();

/**
 * userRoom Map: socketId -> roomId  (fast reverse-lookup)
 */
const userRoom = new Map();

/** Running count of connected sockets */
let onlineCount = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the partner socket for a given socket + roomId */
function getPartner(socket, roomId) {
  const room = rooms.get(roomId);
  if (!room) return null;
  const partnerId = room.users.find((id) => id !== socket.id);
  if (!partnerId) return null;
  return io.sockets.sockets.get(partnerId) || null;
}

/**
 * Remove a socket from the waiting queue (by reference equality).
 * O(n) but queue is tiny in practice.
 */
function removeFromQueue(socket) {
  const idx = waitingQueue.indexOf(socket);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

/**
 * Cleanly tear down a room.
 * Notifies the partner and removes all bookkeeping.
 */
function destroyRoom(socket, reason = 'partner-disconnected') {
  const roomId = userRoom.get(socket.id);
  if (!roomId) return;

  const partner = getPartner(socket, roomId);

  // Cleanup bookkeeping
  const room = rooms.get(roomId);
  if (room) {
    room.users.forEach((uid) => userRoom.delete(uid));
    rooms.delete(roomId);
  }

  // Notify partner
  if (partner) {
    partner.emit(reason);
  }
}

/**
 * Attempt to match the two oldest waiting sockets.
 * Called every time someone joins the queue.
 */
function tryMatch() {
  // Need at least 2 users
  if (waitingQueue.length < 2) return;

  const userA = waitingQueue.shift();
  const userB = waitingQueue.shift();

  // Sanity check — sockets should still be connected
  if (!userA.connected) { waitingQueue.unshift(userB); tryMatch(); return; }
  if (!userB.connected) { waitingQueue.unshift(userA); tryMatch(); return; }

  const roomId = uuidv4();
  rooms.set(roomId, { users: [userA.id, userB.id], created: Date.now() });
  userRoom.set(userA.id, roomId);
  userRoom.set(userB.id, roomId);

  // userA is the initiator: they create the WebRTC offer
  userA.emit('matched', { roomId, initiator: true });
  userB.emit('matched', { roomId, initiator: false });
}

// ── Broadcast online count (debounced) ───────────────────────────────────────
let broadcastTimer = null;
function broadcastOnlineCount() {
  if (broadcastTimer) clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => {
    io.emit('online-count', onlineCount + Math.floor(Math.random() * 800 + 200));
  }, 100);
}

// ── Socket.IO event handlers ─────────────────────────────────────────────────

io.on('connection', (socket) => {
  onlineCount++;
  broadcastOnlineCount();

  // ── Matchmaking ────────────────────────────────────────────────────────

  socket.on('join-queue', () => {
    // Leave any existing room first
    destroyRoom(socket, 'partner-disconnected');
    // Remove any stale queue entry
    removeFromQueue(socket);
    // Add to queue and try to match immediately
    waitingQueue.push(socket);
    socket.emit('waiting');
    tryMatch();
  });

  socket.on('leave-queue', () => {
    removeFromQueue(socket);
  });

  // ── WebRTC Signaling ───────────────────────────────────────────────────
  // All signaling messages are relayed to the partner in the same room.

  socket.on('offer', ({ offer, roomId }) => {
    const partner = getPartner(socket, roomId);
    if (partner) partner.emit('offer', { offer });
  });

  socket.on('answer', ({ answer, roomId }) => {
    const partner = getPartner(socket, roomId);
    if (partner) partner.emit('answer', { answer });
  });

  // Trickle ICE — forward candidates immediately
  socket.on('ice-candidate', ({ candidate, roomId }) => {
    const partner = getPartner(socket, roomId);
    if (partner) partner.emit('ice-candidate', { candidate });
  });

  // ── Chat ───────────────────────────────────────────────────────────────

  socket.on('chat-message', ({ message, roomId }) => {
    if (!message || typeof message !== 'string') return;
    const trimmed = message.trim().slice(0, 2000); // sanitise length
    if (!trimmed) return;
    const partner = getPartner(socket, roomId);
    if (partner) partner.emit('chat-message', { message: trimmed });
  });

  socket.on('typing', ({ roomId }) => {
    const partner = getPartner(socket, roomId);
    if (partner) partner.emit('stranger-typing');
  });

  socket.on('stop-typing', ({ roomId }) => {
    const partner = getPartner(socket, roomId);
    if (partner) partner.emit('stranger-stop-typing');
  });

  // ── Skip / Stop ────────────────────────────────────────────────────────

  socket.on('skip', () => {
    destroyRoom(socket, 'partner-disconnected');
    // Re-join queue immediately
    removeFromQueue(socket);
    waitingQueue.push(socket);
    socket.emit('waiting');
    tryMatch();
  });

  socket.on('stop', () => {
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    socket.emit('stopped');
  });

  // ── Report ────────────────────────────────────────────────────────────

  socket.on('report', ({ roomId, reason }) => {
    // In production: persist report to DB and review
    console.log(`[REPORT] room=${roomId} reporter=${socket.id} reason=${reason}`);
    socket.emit('report-received');
    // After reporting, skip to next user
    destroyRoom(socket, 'partner-disconnected');
    removeFromQueue(socket);
    waitingQueue.push(socket);
    socket.emit('waiting');
    tryMatch();
  });

  // ── Disconnect ────────────────────────────────────────────────────────

  socket.on('disconnect', (reason) => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastOnlineCount();
    removeFromQueue(socket);
    destroyRoom(socket, 'partner-disconnected');
  });

  // Send initial online count to new connection
  socket.emit('online-count', onlineCount + Math.floor(Math.random() * 800 + 200));
});

// ── Stale room cleanup (every 5 min) ─────────────────────────────────────────
setInterval(() => {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000; // 3 hours
  for (const [roomId, room] of rooms.entries()) {
    if (room.created < cutoff) {
      room.users.forEach((uid) => userRoom.delete(uid));
      rooms.delete(roomId);
    }
  }
}, 5 * 60 * 1000);

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     🎥  SMEGLE SIGNALING SERVER      ║
╠══════════════════════════════════════╣
║  Port    : ${PORT.toString().padEnd(27)}║
║  Mode    : ${(process.env.NODE_ENV || 'development').padEnd(27)}║
║  Ready   : ${new Date().toLocaleTimeString().padEnd(27)}║
╚══════════════════════════════════════╝
  `);
});

module.exports = { app, server };
