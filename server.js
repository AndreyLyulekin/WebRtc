import express from 'express';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, appendFile } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Раздаём статику из ./public (кросс-платформенно)
app.use(express.static(join(__dirname, 'public')));

// --- простейшие комнаты для сигналинга ---
const rooms = new Map();

const logDir = join(__dirname, 'logs');
if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, 'server.log');
function writeLog(event, data = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  appendFile(logFile, line, (err) => err && console.error('log write error:', err));
}
function ipFromReq(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  let ip = xff || req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function notifyPeers(roomId) {
  const peers = rooms.get(roomId);
  if (!peers) return;
  const count = peers.size - 1; // “кроме тебя” — для каждого участника одинаково
  const payload = JSON.stringify({ type: 'peers', count });
  for (const peer of peers) {
    if (peer.readyState === 1) {
      peer.send(payload);
    }
  }
}

function joinRoom(ws, roomId, name) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const peers = rooms.get(roomId);
  ws.roomId = roomId;
  ws.name = name || 'Anonymous';
  peers.add(ws);
  console.log(`[join] ${ws.name} joined ${roomId} (peers: ${peers.size})`);
  ws.send(JSON.stringify({ type: 'peers', count: peers.size - 1 }));
  writeLog('join', { roomId, name: ws.name, ip: ws.ip, peers: peers.size });
  notifyPeers(roomId);
}

function leaveRoom(ws) {
  const peers = rooms.get(ws.roomId);
  if (!peers) return;
  peers.delete(ws);
  console.log(`[leave] ${ws.name || 'peer'} left ${ws.roomId} (left: ${peers.size})`);
  writeLog('leave', { roomId: ws.roomId, name: ws.name, ip: ws.ip, peers: peers.size });
  if (peers.size === 0) {
    rooms.delete(ws.roomId);
  } else {
    // Обновим счётчик у оставшихся
    notifyPeers(ws.roomId);
    // (опционально) оставим событие для логов на клиенте
    broadcast(ws, { type: 'peer-left' });
  }
}

function broadcast(sender, payload) {
  const peers = rooms.get(sender.roomId);
  if (!peers) return;
  for (const peer of peers) {
    if (peer !== sender && peer.readyState === 1) {
      peer.send(JSON.stringify(payload));
    }
  }
}

wss.on('connection', (ws, req) => {
  ws.ip = ipFromReq(req);
  writeLog('ws-connection', { ip: ws.ip });

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join':
        joinRoom(ws, msg.roomId, msg.name);
        break;
      case 'signal':
        if (!ws.roomId) return;
        writeLog('signal', {
          roomId: ws.roomId,
          name: ws.name,
          ip: ws.ip,
          sdpType: msg.data?.description?.type || null,
          hasCandidate: Boolean(msg.data?.candidate),
        });
        broadcast(ws, { type: 'signal', data: msg.data });
        break;
      case 'chat':
        if (!ws.roomId) return;
        writeLog('chat', { roomId: ws.roomId, from: ws.name, ip: ws.ip, text: msg.text });
        broadcast(ws, { type: 'chat', from: ws.name, text: msg.text, ts: Date.now() });
        break;
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n▶ Server running: http://localhost:${PORT}\n`);
});
