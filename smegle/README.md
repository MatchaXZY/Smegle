# 🎥 Smegle — Random Video Chat

An Omegle-style instant random video chat platform, rebuilt from scratch for maximum speed and reliability.

## Features
- ⚡ **Instant matching** — sub-second matchmaking queue
- 🎥 **Real WebRTC video** — both cameras visible immediately after match
- 💬 **Live chat** — messages appear instantly with typing indicators
- ⏭️ **Skip** — skip to next stranger with one click
- 🔇 **Mute / Camera toggle** — full media controls
- 🚩 **Report system** — report inappropriate users
- 📱 **Mobile responsive** — works on all screen sizes
- 🌑 **Dark theme** — modern cinematic UI

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Start the server
```bash
# Production
npm start

# Development (auto-restart on changes)
npm run dev
```

### 3. Open in browser
Navigate to: **http://localhost:3000**

For **two users to connect**, you need two browser tabs/windows (or two different devices on the same network).

---

## Architecture

```
smegle/
├── server.js          — Signaling server (Express + Socket.IO)
├── public/
│   ├── index.html     — Single-page app (all screens)
│   ├── styles.css     — Complete styling
│   └── app.js         — WebRTC + Socket.IO client logic
└── package.json
```

### How the WebRTC handshake works
1. User clicks **Start Videoing** → camera starts + socket connects simultaneously
2. User joins the matchmaking queue on the server
3. Server matches two users, assigns one as **initiator**
4. Initiator creates an RTCPeerConnection + sends an **SDP offer**
5. Other user receives offer, creates answer, sends it back
6. Both sides exchange **ICE candidates** via trickle ICE (immediately, no waiting)
7. WebRTC connection established — both video streams appear

### Speed optimisations
- `iceCandidatePoolSize: 10` — browser pre-gathers ICE candidates before matching
- Trickle ICE — candidates sent one-by-one as gathered (no bulk wait)
- `bundlePolicy: max-bundle` — all media on one transport
- Camera starts **before** matchmaking queue is joined
- Socket.IO prefers WebSocket transport (no polling round-trip)

---

## Production Deployment

### TURN Server (required for ~20% of users behind symmetric NAT)

Without a TURN server, some users on restrictive networks (corporate/mobile) may fail to connect. Add TURN credentials to `app.js`:

```javascript
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: 'turn:your-turn-server.com:3478',
      username: 'your-username',
      credential: 'your-password',
    },
  ],
  // ...
};
```

Free TURN options:
- [Metered](https://www.metered.ca/tools/openrelay/) — free tier available
- [Twilio Network Traversal](https://www.twilio.com/stun-turn) — pay-as-you-go
- Self-host with [coturn](https://github.com/coturn/coturn)

### Environment variables
```bash
PORT=3000        # Server port (default: 3000)
NODE_ENV=production
```

### Deploy to Railway / Render / Fly.io
These platforms work out of the box. Just point to the repo and run `npm start`.

For HTTPS (required for camera access in production), these platforms provide SSL automatically.

---

## Content Moderation Note

This is a foundation — add proper moderation for production:
- Report logs are printed to console; persist these to a database
- Consider AI-based nudity detection (e.g., AWS Rekognition)
- Add rate limiting per IP
- Require email/phone verification for users
