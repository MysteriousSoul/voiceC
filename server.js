const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);

// ─── Güvenlik ───
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'", "ws:", "wss:"],
      mediaSrc: ["'self'", "blob:"],
      imgSrc: ["'self'", "data:"]
    }
  }
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 dakika
  max: 100,
  message: 'Çok fazla istek gönderdiniz, lütfen bekleyin.'
}));

app.use(express.static(path.join(__dirname, 'public')));

// ─── Oda & Kullanıcı Yönetimi ───
const rooms = new Map();   // roomId -> Set<ws>
const users = new Map();   // ws -> { id, name, roomId, muted }

const MAX_ROOM_SIZE = 10;
const NAME_MAX_LEN = 20;
const ROOM_MAX_LEN = 30;

function sanitize(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'&]/g, '').substring(0, maxLen);
}

function broadcastToRoom(roomId, msg, exclude) {
  const room = rooms.get(roomId);
  if (!room) return;
  const data = JSON.stringify(msg);
  room.forEach(client => {
    if (client !== exclude && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

function getRoomUsers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  const list = [];
  room.forEach(ws => {
    const u = users.get(ws);
    if (u) list.push({ id: u.id, name: u.name, muted: u.muted });
  });
  return list;
}

function leaveRoom(ws) {
  const user = users.get(ws);
  if (!user || !user.roomId) return;
  const { roomId, id, name } = user;
  const room = rooms.get(roomId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(roomId);
    } else {
      broadcastToRoom(roomId, {
        type: 'user-left',
        userId: id,
        userName: name,
        users: getRoomUsers(roomId)
      });
    }
  }
  user.roomId = null;
}

// ─── WebSocket Sunucusu ───
const wss = new WebSocket.Server({ server, maxPayload: 64 * 1024 }); // 64KB limit

wss.on('connection', (ws, req) => {
  const userId = uuidv4();
  users.set(ws, { id: userId, name: '', roomId: null, muted: false });

  // Heartbeat
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch { return; }

    const user = users.get(ws);
    if (!user) return;

    switch (msg.type) {
      case 'join': {
        const name = sanitize(msg.name, NAME_MAX_LEN);
        const roomId = sanitize(msg.roomId, ROOM_MAX_LEN);
        if (!name || !roomId) return;

        leaveRoom(ws);
        user.name = name;
        user.roomId = roomId;
        user.muted = false;

        if (!rooms.has(roomId)) rooms.set(roomId, new Set());
        const room = rooms.get(roomId);

        if (room.size >= MAX_ROOM_SIZE) {
          ws.send(JSON.stringify({ type: 'error', message: 'Oda dolu (max 10 kişi)' }));
          return;
        }

        room.add(ws);

        ws.send(JSON.stringify({
          type: 'joined',
          userId,
          roomId,
          users: getRoomUsers(roomId)
        }));

        broadcastToRoom(roomId, {
          type: 'user-joined',
          userId,
          userName: name,
          users: getRoomUsers(roomId)
        }, ws);
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (!msg.targetId || !user.roomId) return;
        const room = rooms.get(user.roomId);
        if (!room) return;
        room.forEach(client => {
          const target = users.get(client);
          if (target && target.id === msg.targetId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: msg.type,
              senderId: user.id,
              sdp: msg.sdp,
              candidate: msg.candidate
            }));
          }
        });
        break;
      }

      case 'mute-toggle': {
        user.muted = !user.muted;
        if (user.roomId) {
          broadcastToRoom(user.roomId, {
            type: 'user-muted',
            userId: user.id,
            muted: user.muted
          });
        }
        break;
      }

      case 'leave': {
        leaveRoom(ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    leaveRoom(ws);
    users.delete(ws);
  });

  ws.on('error', () => {
    leaveRoom(ws);
    users.delete(ws);
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎙️  Sesli sohbet sunucusu çalışıyor: http://localhost:${PORT}`);
});
