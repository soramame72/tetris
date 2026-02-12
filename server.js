const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const KEEPALIVE_URL = process.env.KEEPALIVE_URL;

// CORS設定
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json());

// データ構造
const rooms = new Map(); // roomId -> Room
const quickMatchQueue = new Set(); // クイックマッチ待機中のクライアント
const clients = new Map(); // ws -> ClientInfo

class Room {
  constructor(id, name, password = null, maxPlayers = 99) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.maxPlayers = maxPlayers;
    this.players = new Map(); // playerId -> PlayerState
    this.gameStarted = false;
    this.createdAt = Date.now();
  }

  addPlayer(playerId, ws, playerName) {
    if (this.players.size >= this.maxPlayers) return false;
    
    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      ws: ws,
      score: 0,
      linesCleared: 0,
      isAlive: true,
      field: Array.from({length: 20}, () => Array(10).fill("")),
      attackQueue: 0
    });
    
    return true;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
  }

  broadcast(data, excludePlayerId = null) {
    this.players.forEach((player, id) => {
      if (id !== excludePlayerId && player.ws.readyState === WebSocket.OPEN) {
        player.ws.send(JSON.stringify(data));
      }
    });
  }

  getPlayerList() {
    return Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      score: p.score,
      linesCleared: p.linesCleared,
      isAlive: p.isAlive
    }));
  }
}

// ユーティリティ関数
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function generateRoomCode() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

// WebSocket接続
wss.on('connection', (ws) => {
  const clientId = generateId();
  clients.set(ws, { id: clientId, roomId: null, name: 'Player' });

  console.log(`Client connected: ${clientId}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error('Error parsing message:', error);
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client) {
      console.log(`Client disconnected: ${client.id}`);
      
      // 部屋から退出
      if (client.roomId) {
        leaveRoom(ws, client.roomId);
      }
      
      // クイックマッチキューから削除
      quickMatchQueue.delete(ws);
      
      clients.delete(ws);
    }
  });

  // 接続確認
  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId
  }));
});

// メッセージハンドラ
function handleMessage(ws, data) {
  const client = clients.get(ws);
  
  switch (data.type) {
    case 'setName':
      client.name = data.name;
      break;

    case 'createRoom':
      createRoom(ws, data);
      break;

    case 'joinRoom':
      joinRoom(ws, data);
      break;

    case 'leaveRoom':
      leaveRoom(ws, client.roomId);
      break;

    case 'quickMatch':
      joinQuickMatch(ws);
      break;

    case 'getRooms':
      sendRoomList(ws);
      break;

    case 'startGame':
      startGame(client.roomId);
      break;

    case 'gameUpdate':
      handleGameUpdate(ws, data);
      break;

    case 'gameOver':
      handleGameOver(ws, data);
      break;

    case 'attack':
      handleAttack(ws, data);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }));
      break;
  }
}

// ルーム作成
function createRoom(ws, data) {
  const client = clients.get(ws);
  const roomId = generateRoomCode();
  const room = new Room(
    roomId,
    data.roomName || 'New Room',
    data.password || null,
    data.maxPlayers || 99
  );

  rooms.set(roomId, room);
  room.addPlayer(client.id, ws, client.name);
  client.roomId = roomId;

  ws.send(JSON.stringify({
    type: 'roomCreated',
    roomId: roomId,
    room: {
      id: room.id,
      name: room.name,
      hasPassword: !!room.password,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers
    }
  }));

  console.log(`Room created: ${roomId}`);
}

// ルーム参加
function joinRoom(ws, data) {
  const client = clients.get(ws);
  const room = rooms.get(data.roomId);

  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room not found'
    }));
    return;
  }

  if (room.password && room.password !== data.password) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Incorrect password'
    }));
    return;
  }

  if (!room.addPlayer(client.id, ws, client.name)) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'Room is full'
    }));
    return;
  }

  client.roomId = data.roomId;

  ws.send(JSON.stringify({
    type: 'roomJoined',
    roomId: data.roomId,
    players: room.getPlayerList()
  }));

  room.broadcast({
    type: 'playerJoined',
    player: {
      id: client.id,
      name: client.name
    }
  }, client.id);

  console.log(`Player ${client.id} joined room ${data.roomId}`);
}

// ルーム退出
function leaveRoom(ws, roomId) {
  if (!roomId) return;

  const client = clients.get(ws);
  const room = rooms.get(roomId);

  if (room) {
    room.removePlayer(client.id);
    
    room.broadcast({
      type: 'playerLeft',
      playerId: client.id
    });

    // 部屋が空になったら削除
    if (room.players.size === 0) {
      rooms.delete(roomId);
      console.log(`Room ${roomId} deleted (empty)`);
    }
  }

  client.roomId = null;
}

// クイックマッチ
function joinQuickMatch(ws) {
  const client = clients.get(ws);
  quickMatchQueue.add(ws);

  // 2人以上集まったらマッチング
  if (quickMatchQueue.size >= 2) {
    const players = Array.from(quickMatchQueue).slice(0, 99);
    const roomId = generateRoomCode();
    const room = new Room(roomId, 'Quick Match', null, 99);

    rooms.set(roomId, room);

    players.forEach(playerWs => {
      const playerClient = clients.get(playerWs);
      room.addPlayer(playerClient.id, playerWs, playerClient.name);
      playerClient.roomId = roomId;
      quickMatchQueue.delete(playerWs);

      playerWs.send(JSON.stringify({
        type: 'quickMatchFound',
        roomId: roomId,
        players: room.getPlayerList()
      }));
    });

    // 3秒後にゲーム開始
    setTimeout(() => startGame(roomId), 3000);
  } else {
    ws.send(JSON.stringify({
      type: 'quickMatchWaiting',
      queueSize: quickMatchQueue.size
    }));
  }
}

// ルームリスト送信
function sendRoomList(ws) {
  const roomList = Array.from(rooms.values())
    .filter(room => !room.gameStarted)
    .map(room => ({
      id: room.id,
      name: room.name,
      hasPassword: !!room.password,
      playerCount: room.players.size,
      maxPlayers: room.maxPlayers
    }));

  ws.send(JSON.stringify({
    type: 'roomList',
    rooms: roomList
  }));
}

// ゲーム開始
function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.gameStarted = true;

  room.broadcast({
    type: 'gameStart',
    players: room.getPlayerList()
  });

  console.log(`Game started in room ${roomId}`);
}

// ゲーム状態更新
function handleGameUpdate(ws, data) {
  const client = clients.get(ws);
  const room = rooms.get(client.roomId);
  if (!room) return;

  const player = room.players.get(client.id);
  if (player) {
    player.score = data.score;
    player.linesCleared = data.linesCleared;
    player.field = data.field;
  }

  room.broadcast({
    type: 'playerUpdate',
    playerId: client.id,
    score: data.score,
    linesCleared: data.linesCleared,
    field: data.field
  }, client.id);
}

// ゲームオーバー
function handleGameOver(ws, data) {
  const client = clients.get(ws);
  const room = rooms.get(client.roomId);
  if (!room) return;

  const player = room.players.get(client.id);
  if (player) {
    player.isAlive = false;
  }

  room.broadcast({
    type: 'playerDied',
    playerId: client.id,
    finalScore: data.score
  });

  // 生き残りが1人以下ならゲーム終了
  const alivePlayers = Array.from(room.players.values()).filter(p => p.isAlive);
  if (alivePlayers.length <= 1) {
    room.broadcast({
      type: 'gameEnd',
      winner: alivePlayers[0]?.id,
      rankings: room.getPlayerList().sort((a, b) => b.score - a.score)
    });
  }
}

// 攻撃処理
function handleAttack(ws, data) {
  const client = clients.get(ws);
  const room = rooms.get(client.roomId);
  if (!room) return;

  const targetId = data.targetId;
  const lines = data.lines;

  if (targetId === 'random') {
    // ランダムな生存プレイヤーに攻撃
    const alivePlayers = Array.from(room.players.values())
      .filter(p => p.isAlive && p.id !== client.id);
    
    if (alivePlayers.length > 0) {
      const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      target.attackQueue += lines;
      
      target.ws.send(JSON.stringify({
        type: 'attacked',
        lines: lines,
        fromPlayer: client.name
      }));
    }
  } else {
    // 特定プレイヤーに攻撃
    const target = room.players.get(targetId);
    if (target && target.isAlive) {
      target.attackQueue += lines;
      
      target.ws.send(JSON.stringify({
        type: 'attacked',
        lines: lines,
        fromPlayer: client.name
      }));
    }
  }
}

// HTTPエンドポイント
app.get('/', (req, res) => {
  res.json({
    name: 'Tetris Online Server',
    status: 'running',
    rooms: rooms.size,
    players: clients.size,
    uptime: process.uptime()
  });
});

app.get('/keepalive', (req, res) => {
  res.json({ status: 'alive', timestamp: Date.now() });
});

app.get('/stats', (req, res) => {
  res.json({
    rooms: rooms.size,
    players: clients.size,
    quickMatchQueue: quickMatchQueue.size
  });
});

// Keep-alive設定（Renderスリープ対策）
if (KEEPALIVE_URL) {
  // 14分ごとに自分自身にアクセス
  cron.schedule('*/14 * * * *', async () => {
    try {
      const https = require('https');
      https.get(KEEPALIVE_URL, (res) => {
        console.log(`Keep-alive ping: ${res.statusCode}`);
      });
    } catch (error) {
      console.error('Keep-alive error:', error);
    }
  });
  console.log('Keep-alive scheduled');
}

// サーバー起動
server.listen(PORT, () => {
  console.log(`Tetris server running on port ${PORT}`);
});

// クリーンアップ
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  wss.clients.forEach((client) => {
    client.close();
  });
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
