const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// CORS設定
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use(express.json());

// 設定
const CONFIG = {
  MATCH_TIMEOUT: 60000,           // 60秒待機
  MIN_PLAYERS: 2,                 // 最小2人
  IDEAL_PLAYERS: 4,               // 理想4人
  MAX_PLAYERS: 99,                // 最大99人
  ENABLE_RANK_MATCHING: true,     // ランクマッチング有効
  CPU_FILL_ENABLED: true,         // CPU補充有効
  GAME_START_COUNTDOWN: 3000,     // カウントダウン3秒
};

// データ構造
const rooms = new Map();
const clients = new Map();
const rankQueues = {
  'S++': [], 'S+': [], 'S': [], 'A': [], 'B': [], 'C': [], 'D': [], 'E': [], 'F': []
};

// CPU プレイヤークラス
class CPUPlayer {
  constructor(id, difficulty = 'normal') {
    this.id = id;
    this.name = `CPU-${difficulty.toUpperCase()}-${Math.floor(Math.random() * 100)}`;
    this.isCPU = true;
    this.difficulty = difficulty;
    this.score = 0;
    this.linesCleared = 0;
    this.isAlive = true;
    this.field = Array.from({length: 20}, () => Array(10).fill(""));
    this.updateInterval = null;
  }

  start(room) {
    // CPUの自動プレイ（簡易版）
    const speed = this.difficulty === 'easy' ? 3000 : 
                  this.difficulty === 'hard' ? 800 : 1500;
    
    this.updateInterval = setInterval(() => {
      if (!this.isAlive || !room.gameStarted) {
        this.stop();
        return;
      }

      // スコアを増やす
      this.score += Math.floor(Math.random() * 50) + 10;
      this.linesCleared += Math.floor(Math.random() * 2);

      // フィールドを動的に生成（ランダムブロック配置）
      this.generateRandomField();

      // ランダムでミスる（死ぬ）
      const deathChance = this.difficulty === 'easy' ? 0.002 : 
                         this.difficulty === 'hard' ? 0.0005 : 0.001;
      if (Math.random() < deathChance) {
        this.isAlive = false;
        this.die(room);
      }

      // 他のプレイヤーに更新を送信
      this.broadcastUpdate(room);
    }, speed);
  }

  generateRandomField() {
    // フィールドの下部をランダムに埋める
    const colors = ['#0ff', '#00f', '#f80', '#ff0', '#0f0', '#a0f', '#f00'];
    const fillLines = Math.floor(this.score / 500); // スコアに応じて埋まっていく
    const maxFillLines = Math.min(fillLines, 15);
    
    for (let y = 19; y > 19 - maxFillLines; y--) {
      for (let x = 0; x < 10; x++) {
        if (Math.random() < 0.7) {
          this.field[y][x] = colors[Math.floor(Math.random() * colors.length)];
        } else {
          this.field[y][x] = "";
        }
      }
    }
  }

  stop() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  die(room) {
    this.isAlive = false;
    this.stop();
    broadcastToRoom(room.id, {
      type: 'playerDied',
      playerId: this.id,
      score: this.score
    }, null);
    
    checkGameEnd(room);
  }

  broadcastUpdate(room) {
    broadcastToRoom(room.id, {
      type: 'playerUpdate',
      playerId: this.id,
      score: this.score,
      linesCleared: this.linesCleared,
      field: this.field,
      currentPiece: null
    }, null);
  }
}

// Roomクラス
class Room {
  constructor(id, name, password = null, maxPlayers = 99, isQuickMatch = false) {
    this.id = id;
    this.name = name;
    this.password = password;
    this.maxPlayers = maxPlayers;
    this.isQuickMatch = isQuickMatch; // クイックマッチかどうか
    this.players = new Map();
    this.cpuPlayers = new Map();
    this.gameStarted = false;
    this.gameEnded = false;
    this.createdAt = Date.now();
    this.matchTimer = null;
    this.startTime = null;
  }

  addPlayer(playerId, ws, playerName, rank = 'C') {
    if (this.players.size >= this.maxPlayers) return false;
    
    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      rank: rank,
      ws: ws,
      score: 0,
      linesCleared: 0,
      isAlive: true,
      field: Array.from({length: 20}, () => Array(10).fill("")),
    });
    
    return true;
  }

  addCPU(difficulty = 'normal') {
    const cpuId = `cpu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const cpu = new CPUPlayer(cpuId, difficulty);
    this.cpuPlayers.set(cpuId, cpu);
    console.log(`Added CPU player: ${cpu.name}`);
    return cpu;
  }

  removePlayer(playerId) {
    this.players.delete(playerId);
    
    // CPU も削除
    if (this.cpuPlayers.has(playerId)) {
      const cpu = this.cpuPlayers.get(playerId);
      cpu.stop();
      this.cpuPlayers.delete(playerId);
    }
  }

  getAllPlayers() {
    const humanPlayers = Array.from(this.players.values()).map(p => ({
      id: p.id,
      name: p.name,
      rank: p.rank,
      score: p.score,
      isAlive: p.isAlive,
      isCPU: false
    }));

    const cpuPlayersList = Array.from(this.cpuPlayers.values()).map(cpu => ({
      id: cpu.id,
      name: cpu.name,
      rank: 'C',
      score: cpu.score,
      isAlive: cpu.isAlive,
      isCPU: true
    }));

    return [...humanPlayers, ...cpuPlayersList];
  }

  startMatchTimer() {
    console.log(`Room ${this.id}: Starting 60s match timer`);
    
    // 60秒後に開始
    this.matchTimer = setTimeout(() => {
      console.log(`Room ${this.id}: Match timer expired, starting game`);
      this.startGame();
    }, CONFIG.MATCH_TIMEOUT);
  }

  startGame() {
    if (this.gameStarted) return;
    
    if (this.matchTimer) {
      clearTimeout(this.matchTimer);
      this.matchTimer = null;
    }

    // CPU補充（クイックマッチのみ）
    if (CONFIG.CPU_FILL_ENABLED && this.isQuickMatch) {
      const currentPlayers = this.players.size + this.cpuPlayers.size;
      
      // 現在のプレイヤー数に応じてCPU数を決定（大幅に増加）
      let targetTotal = 50; // デフォルトは50人
      if (currentPlayers <= 2) targetTotal = 80; // 2人以下なら80人
      else if (currentPlayers <= 5) targetTotal = 60; // 5人以下なら60人
      
      const needed = targetTotal - currentPlayers;
      
      if (needed > 0) {
        console.log(`Adding ${needed} CPU players to reach ${targetTotal} total (Quick Match only)`);
        for (let i = 0; i < needed; i++) {
          const rand = Math.random();
          const difficulty = rand < 0.2 ? 'easy' : 
                           rand < 0.7 ? 'normal' : 'hard';
          this.addCPU(difficulty);
        }
      }
    }

    this.gameStarted = true;
    this.gameEnded = false;
    this.startTime = Date.now();

    const allPlayers = this.getAllPlayers();

    // CPUを開始
    this.cpuPlayers.forEach(cpu => cpu.start(this));

    // 全プレイヤーにゲーム開始を通知
    broadcastToRoom(this.id, {
      type: 'gameStart',
      players: allPlayers
    });

    console.log(`Game started in room ${this.id} with ${allPlayers.length} players (${this.players.size} human, ${this.cpuPlayers.size} CPU)`);
  }

  endGame() {
    if (this.gameEnded) return;
    
    this.gameEnded = true;
    this.gameStarted = false;

    // CPU停止
    this.cpuPlayers.forEach(cpu => cpu.stop());

    const rankings = this.calculateRankings();

    broadcastToRoom(this.id, {
      type: 'gameEnd',
      rankings: rankings
    });

    console.log(`Game ended in room ${this.id}`);
  }

  calculateRankings() {
    const allPlayers = [];

    // 人間プレイヤー
    this.players.forEach(p => {
      allPlayers.push({
        id: p.id,
        name: p.name,
        score: p.score,
        isAlive: p.isAlive,
        isCPU: false
      });
    });

    // CPUプレイヤー
    this.cpuPlayers.forEach(cpu => {
      allPlayers.push({
        id: cpu.id,
        name: cpu.name,
        score: cpu.score,
        isAlive: cpu.isAlive,
        isCPU: true
      });
    });

    // スコアでソート（生存者優先、その後スコア順）
    allPlayers.sort((a, b) => {
      if (a.isAlive !== b.isAlive) return b.isAlive ? 1 : -1;
      return b.score - a.score;
    });

    return allPlayers;
  }
}

// ユーティリティ関数
function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function broadcastToRoom(roomId, message, excludeWs = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  const messageStr = JSON.stringify(message);
  
  room.players.forEach(player => {
    if (player.ws && player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(messageStr);
    }
  });
}

function tryMatchmaking(rank) {
  const queue = rankQueues[rank];
  if (!queue || queue.length < CONFIG.MIN_PLAYERS) return;

  console.log(`Attempting match for rank ${rank} with ${queue.length} players`);

  // 理想人数に達したら即座にマッチ
  if (queue.length >= CONFIG.IDEAL_PLAYERS) {
    const matched = queue.splice(0, CONFIG.IDEAL_PLAYERS);
    createMatch(matched, rank);
  }
}

function createMatch(players, rank) {
  const roomId = `match_${Date.now()}_${generateId()}`;
  const room = new Room(roomId, `Rank ${rank} Match`, null, CONFIG.MAX_PLAYERS, true); // isQuickMatch = true
  rooms.set(roomId, room);

  console.log(`Created match ${roomId} for ${players.length} players`);

  players.forEach(playerInfo => {
    const { ws, playerId, username } = playerInfo;
    room.addPlayer(playerId, ws, username, rank);
    
    const clientInfo = clients.get(ws);
    if (clientInfo) {
      clientInfo.roomId = roomId;
    }
  });

  // 全員に通知
  const allPlayers = room.getAllPlayers();
  broadcastToRoom(roomId, {
    type: 'quickMatchFound',
    roomId: roomId,
    players: allPlayers
  });

  // 60秒タイマー開始
  room.startMatchTimer();
}

function checkGameEnd(room) {
  if (room.gameEnded) return;

  const alivePlayers = room.getAllPlayers().filter(p => p.isAlive);
  
  console.log(`Checking game end: ${alivePlayers.length} alive players`);

  if (alivePlayers.length <= 1) {
    room.endGame();
  }
}

// WebSocket接続処理
wss.on('connection', (ws) => {
  const clientId = generateId();
  
  clients.set(ws, {
    id: clientId,
    roomId: null,
    username: 'Player',
    rank: 'C'
  });

  ws.send(JSON.stringify({
    type: 'connected',
    clientId: clientId
  }));

  console.log(`Client connected: ${clientId}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      handleMessage(ws, data);
    } catch (error) {
      console.error('Message parse error:', error);
    }
  });

  ws.on('close', () => {
    const clientInfo = clients.get(ws);
    if (!clientInfo) return;

    console.log(`Client disconnected: ${clientInfo.id}`);

    // ルームから削除
    if (clientInfo.roomId) {
      const room = rooms.get(clientInfo.roomId);
      if (room) {
        room.removePlayer(clientInfo.id);
        
        broadcastToRoom(clientInfo.roomId, {
          type: 'playerDisconnected',
          playerId: clientInfo.id,
          players: room.getAllPlayers()
        }, ws);

        // ゲーム中なら終了チェック
        if (room.gameStarted) {
          checkGameEnd(room);
        }

        // 部屋が空なら削除
        if (room.players.size === 0) {
          room.cpuPlayers.forEach(cpu => cpu.stop());
          rooms.delete(clientInfo.roomId);
          console.log(`Room ${clientInfo.roomId} deleted (empty)`);
        }
      }
    }

    // キューから削除
    Object.values(rankQueues).forEach(queue => {
      const index = queue.findIndex(p => p.ws === ws);
      if (index !== -1) queue.splice(index, 1);
    });

    clients.delete(ws);
  });
});

// メッセージハンドラ
function handleMessage(ws, data) {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  switch (data.type) {
    case 'quickMatch':
      handleQuickMatch(ws, data);
      break;
      
    case 'createRoom':
      handleCreateRoom(ws, data);
      break;
      
    case 'joinRoom':
      handleJoinRoom(ws, data);
      break;
      
    case 'leaveRoom':
      handleLeaveRoom(ws);
      break;
      
    case 'startGame':
      handleStartGame(ws);
      break;
      
    case 'gameUpdate':
      handleGameUpdate(ws, data);
      break;
      
    case 'gameOver':
      handleGameOver(ws, data);
      break;
      
    case 'requestGameEnd':
      handleRequestGameEnd(ws);
      break;
      
    case 'attack':
      handleAttack(ws, data);
      break;
      
    case 'chat':
      handleChat(ws, data);
      break;

    case 'forceStart':
      handleForceStart(ws);
      break;
  }
}

function handleQuickMatch(ws, data) {
  const clientInfo = clients.get(ws);
  const rank = data.rank || 'C';
  const username = data.username || 'Player';

  clientInfo.username = username;
  clientInfo.rank = rank;

  console.log(`Quick match request: ${username} (${rank})`);

  // キューに追加
  if (!rankQueues[rank]) rankQueues[rank] = [];
  rankQueues[rank].push({
    ws,
    playerId: clientInfo.id,
    username,
    rank,
    joinedAt: Date.now()
  });

  ws.send(JSON.stringify({
    type: 'quickMatchWaiting'
  }));

  // マッチング試行
  tryMatchmaking(rank);

  // 60秒後に強制マッチング
  setTimeout(() => {
    const queue = rankQueues[rank];
    const playerIndex = queue.findIndex(p => p.ws === ws);
    
    if (playerIndex !== -1) {
      // まだ待機中なら強制マッチ
      console.log(`Force matching for rank ${rank} after 60s`);
      
      if (queue.length >= CONFIG.MIN_PLAYERS) {
        const matched = queue.splice(0, Math.min(queue.length, CONFIG.MAX_PLAYERS));
        createMatch(matched, rank);
      }
    }
  }, CONFIG.MATCH_TIMEOUT);
}

function handleCreateRoom(ws, data) {
  const clientInfo = clients.get(ws);
  const roomId = `room_${generateId()}`;
  const room = new Room(
    roomId,
    data.roomName || 'Private Room',
    data.password || null,
    data.maxPlayers || 99
  );

  rooms.set(roomId, room);
  room.addPlayer(clientInfo.id, ws, data.username || 'Player');
  clientInfo.roomId = roomId;

  ws.send(JSON.stringify({
    type: 'roomCreated',
    roomId: roomId
  }));

  console.log(`Room created: ${roomId}`);
}

function handleJoinRoom(ws, data) {
  const room = rooms.get(data.roomId);
  
  if (!room) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'ルームが見つかりません'
    }));
    return;
  }

  if (room.gameStarted) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'ゲームは既に開始しています'
    }));
    return;
  }

  if (room.password && room.password !== data.password) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'パスワードが正しくありません'
    }));
    return;
  }

  const clientInfo = clients.get(ws);
  if (!room.addPlayer(clientInfo.id, ws, data.username || 'Player')) {
    ws.send(JSON.stringify({
      type: 'error',
      message: 'ルームが満員です'
    }));
    return;
  }

  clientInfo.roomId = data.roomId;

  ws.send(JSON.stringify({
    type: 'roomJoined',
    roomId: data.roomId,
    players: room.getAllPlayers()
  }));

  broadcastToRoom(data.roomId, {
    type: 'playerJoined',
    players: room.getAllPlayers()
  }, ws);

  console.log(`Player joined room ${data.roomId}`);
}

function handleLeaveRoom(ws) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (room) {
    room.removePlayer(clientInfo.id);
    
    broadcastToRoom(clientInfo.roomId, {
      type: 'playerLeft',
      playerId: clientInfo.id,
      players: room.getAllPlayers()
    });

    if (room.players.size === 0) {
      room.cpuPlayers.forEach(cpu => cpu.stop());
      rooms.delete(clientInfo.roomId);
    }
  }

  clientInfo.roomId = null;
}

function handleStartGame(ws) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (room) {
    room.startGame();
  }
}

function handleForceStart(ws) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (room && !room.gameStarted) {
    console.log(`Force starting game in room ${room.id}`);
    room.startGame();
  }
}

function handleGameUpdate(ws, data) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (!room) return;

  const player = room.players.get(clientInfo.id);
  if (player) {
    player.score = data.score || 0;
    player.linesCleared = data.linesCleared || 0;
    player.field = data.field || player.field;
  }

  broadcastToRoom(clientInfo.roomId, {
    type: 'playerUpdate',
    playerId: clientInfo.id,
    score: data.score,
    linesCleared: data.linesCleared,
    field: data.field,
    currentPiece: data.currentPiece
  }, ws);
}

function handleGameOver(ws, data) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (!room) return;

  const player = room.players.get(clientInfo.id);
  if (player) {
    player.isAlive = false;
    player.score = data.score || 0;
  }

  broadcastToRoom(clientInfo.roomId, {
    type: 'playerDied',
    playerId: clientInfo.id,
    score: data.score
  });

  checkGameEnd(room);
}

function handleRequestGameEnd(ws) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (room) {
    checkGameEnd(room);
  }
}

function handleAttack(ws, data) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  const room = rooms.get(clientInfo.roomId);
  if (!room) return;

  // ランダムなターゲット選択
  const alivePlayers = Array.from(room.players.values())
    .filter(p => p.isAlive && p.id !== clientInfo.id);

  if (alivePlayers.length > 0) {
    const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    
    if (target.ws && target.ws.readyState === WebSocket.OPEN) {
      target.ws.send(JSON.stringify({
        type: 'attacked',
        fromPlayerId: clientInfo.id,
        lines: data.lines || 1
      }));
    }
  }
}

function handleChat(ws, data) {
  const clientInfo = clients.get(ws);
  if (!clientInfo.roomId) return;

  broadcastToRoom(clientInfo.roomId, {
    type: 'chat',
    username: clientInfo.username,
    message: data.message
  });
}

// ヘルスチェック
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    players: clients.size,
    queues: Object.entries(rankQueues).reduce((acc, [rank, queue]) => {
      acc[rank] = queue.length;
      return acc;
    }, {})
  });
});

// サーバー起動
server.listen(PORT, () => {
  console.log(`Tetris server running on port ${PORT}`);
  console.log(`Config:`, CONFIG);
});
