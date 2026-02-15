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
    this.currentPiece = null;
    this.nextPiece = null;
    this.bag = [];
    this.pieceTypes = ['I', 'J', 'L', 'O', 'S', 'T', 'Z'];
    this.colors = {
      'I': '#0ff', 'J': '#00f', 'L': '#f80', 
      'O': '#ff0', 'S': '#0f0', 'T': '#a0f', 'Z': '#f00'
    };
    this.shapes = {
      'I': [[1,1,1,1]],
      'J': [[1,0,0],[1,1,1]],
      'L': [[0,0,1],[1,1,1]],
      'O': [[1,1],[1,1]],
      'S': [[0,1,1],[1,1,0]],
      'T': [[0,1,0],[1,1,1]],
      'Z': [[1,1,0],[0,1,1]]
    };
  }

  refillBag() {
    this.bag = [...this.pieceTypes].sort(() => Math.random() - 0.5);
  }

  getNextPiece() {
    if (this.bag.length === 0) this.refillBag();
    const type = this.bag.pop();
    return {
      type: type,
      shape: JSON.parse(JSON.stringify(this.shapes[type])),
      color: this.colors[type],
      x: 3,
      y: 0
    };
  }

  checkCollision(x, y, shape) {
    for (let row = 0; row < shape.length; row++) {
      for (let col = 0; col < shape[row].length; col++) {
        if (shape[row][col]) {
          const newY = y + row;
          const newX = x + col;
          
          if (newX < 0 || newX >= 10 || newY >= 20) return true;
          if (newY >= 0 && this.field[newY][newX]) return true;
        }
      }
    }
    return false;
  }

  mergePiece() {
    if (!this.currentPiece) return;
    
    for (let row = 0; row < this.currentPiece.shape.length; row++) {
      for (let col = 0; col < this.currentPiece.shape[row].length; col++) {
        if (this.currentPiece.shape[row][col]) {
          const y = this.currentPiece.y + row;
          const x = this.currentPiece.x + col;
          if (y >= 0 && y < 20 && x >= 0 && x < 10) {
            this.field[y][x] = this.currentPiece.color;
          }
        }
      }
    }
  }

  clearLines() {
    let linesCleared = 0;
    
    for (let y = 19; y >= 0; y--) {
      if (this.field[y].every(cell => cell !== "")) {
        this.field.splice(y, 1);
        this.field.unshift(Array(10).fill(""));
        linesCleared++;
        y++; // 同じ行を再チェック
      }
    }
    
    if (linesCleared > 0) {
      this.linesCleared += linesCleared;
      const points = [0, 100, 300, 500, 800][linesCleared];
      this.score += points;
    }
    
    return linesCleared;
  }

  findBestMove() {
    if (!this.currentPiece) return null;
    
    let bestScore = -Infinity;
    let bestMove = null;
    
    // すべての回転とX位置を試す
    for (let rotation = 0; rotation < 4; rotation++) {
      let testShape = JSON.parse(JSON.stringify(this.currentPiece.shape));
      
      // 回転
      for (let r = 0; r < rotation; r++) {
        testShape = this.rotateShape(testShape);
      }
      
      // すべてのX位置を試す
      for (let x = -2; x < 10; x++) {
        // ハードドロップ
        let y = 0;
        while (!this.checkCollision(x, y + 1, testShape)) {
          y++;
        }
        
        if (this.checkCollision(x, y, testShape)) continue;
        
        // この位置の評価
        const score = this.evaluatePosition(x, y, testShape);
        
        if (score > bestScore) {
          bestScore = score;
          bestMove = { x, y, shape: testShape };
        }
      }
    }
    
    return bestMove;
  }

  rotateShape(shape) {
    const rows = shape.length;
    const cols = shape[0].length;
    const rotated = Array.from({length: cols}, () => Array(rows).fill(0));
    
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        rotated[c][rows - 1 - r] = shape[r][c];
      }
    }
    
    return rotated;
  }

  evaluatePosition(x, y, shape) {
    // 簡易評価関数
    let score = 0;
    
    // 高さペナルティ（低いほど良い）
    score -= y * 10;
    
    // 穴のペナルティ
    const testField = JSON.parse(JSON.stringify(this.field));
    
    // シミュレーション配置
    for (let row = 0; row < shape.length; row++) {
      for (let col = 0; col < shape[row].length; col++) {
        if (shape[row][col]) {
          const newY = y + row;
          const newX = x + col;
          if (newY >= 0 && newY < 20 && newX >= 0 && newX < 10) {
            testField[newY][newX] = 'X';
          }
        }
      }
    }
    
    // 穴の数をカウント
    let holes = 0;
    for (let col = 0; col < 10; col++) {
      let blockFound = false;
      for (let row = 0; row < 20; row++) {
        if (testField[row][col]) {
          blockFound = true;
        } else if (blockFound) {
          holes++;
        }
      }
    }
    
    score -= holes * 50;
    
    // ラインクリアボーナス
    let completeLines = 0;
    for (let row = 0; row < 20; row++) {
      if (testField[row].every(cell => cell)) {
        completeLines++;
      }
    }
    score += completeLines * 100;
    
    return score;
  }

  playMove() {
    if (!this.currentPiece) {
      this.currentPiece = this.getNextPiece();
      this.nextPiece = this.getNextPiece();
      
      // ゲームオーバーチェック
      if (this.checkCollision(this.currentPiece.x, this.currentPiece.y, this.currentPiece.shape)) {
        return false; // Game Over
      }
    }
    
    // 最適な手を探す
    const bestMove = this.findBestMove();
    
    if (bestMove) {
      this.currentPiece.x = bestMove.x;
      this.currentPiece.y = bestMove.y;
      this.currentPiece.shape = bestMove.shape;
    }
    
    // ピースを配置
    this.mergePiece();
    const lines = this.clearLines();
    
    // 次のピース
    this.currentPiece = this.nextPiece;
    this.nextPiece = this.getNextPiece();
    
    // ゲームオーバーチェック
    if (this.checkCollision(this.currentPiece.x, this.currentPiece.y, this.currentPiece.shape)) {
      return false;
    }
    
    return true;
  }

  start(room) {
    // 難易度とルームランクによる速度調整
    let baseSpeed = this.difficulty === 'easy' ? 2000 : 
                    this.difficulty === 'hard' ? 500 : 1000;
    
    // ルームランクによる速度補正（高ランクほど速い）
    const rankMultipliers = {
      'F': 1.5,   // 遅い
      'E': 1.3,
      'D': 1.1,
      'C': 1.0,   // 標準
      'B': 0.9,
      'A': 0.8,
      'S': 0.7,
      'S+': 0.6,
      'S++': 0.5  // 速い
    };
    
    const multiplier = rankMultipliers[room.rank] || 1.0;
    const speed = Math.floor(baseSpeed * multiplier);
    
    console.log(`CPU ${this.name} starting with speed ${speed}ms (difficulty: ${this.difficulty}, rank: ${room.rank})`);
    
    // 初期化
    this.currentPiece = this.getNextPiece();
    this.nextPiece = this.getNextPiece();
    
    this.updateInterval = setInterval(() => {
      if (!this.isAlive || !room.gameStarted) {
        this.stop();
        return;
      }

      // テトリスをプレイ
      const alive = this.playMove();
      
      if (!alive) {
        this.die(room);
        return;
      }

      // 他のプレイヤーに更新を送信
      this.broadcastUpdate(room);
      
      // ランクに応じた攻撃頻度
      const attackRates = {
        'F': 0.15,
        'E': 0.20,
        'D': 0.25,
        'C': 0.30,
        'B': 0.35,
        'A': 0.40,
        'S': 0.45,
        'S+': 0.50,
        'S++': 0.55
      };
      
      const attackRate = attackRates[room.rank] || 0.30;
      
      if (Math.random() < attackRate) {
        this.sendAttack(room);
      }
    }, speed);
  }

  sendAttack(room) {
    const lines = Math.floor(Math.random() * 3) + 1; // 1-3ライン
    
    // ランダムなターゲットを選択
    const alivePlayers = Array.from(room.players.values())
      .filter(p => p.isAlive);
    
    if (alivePlayers.length > 0) {
      const target = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
      
      if (target.ws && target.ws.readyState === 1) { // WebSocket.OPEN
        target.ws.send(JSON.stringify({
          type: 'attacked',
          fromPlayerId: this.id,
          lines: lines
        }));
      }
    }
  }

  receiveAttack(lines) {
    // ゴミラインを追加
    for (let i = 0; i < lines; i++) {
      this.field.pop(); // 上の行を削除
      
      // 下にゴミラインを追加（ランダムな穴）
      const garbageLine = Array(10).fill('#808080');
      const holePos = Math.floor(Math.random() * 10);
      garbageLine[holePos] = "";
      
      this.field.push(garbageLine);
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
  constructor(id, name, password = null, maxPlayers = 99, isQuickMatch = false, rank = 'C') {
    this.id = id;
    this.name = name;
    this.password = password;
    this.maxPlayers = maxPlayers;
    this.isQuickMatch = isQuickMatch; // クイックマッチかどうか
    this.rank = rank; // マッチのランク
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

  getCPUDifficultyDistribution(rank) {
    // ランクに応じたCPU難易度分布
    const distributions = {
      'F': { easy: 0.70, normal: 0.25, hard: 0.05 },  // F: 初心者向け
      'E': { easy: 0.60, normal: 0.30, hard: 0.10 },
      'D': { easy: 0.50, normal: 0.35, hard: 0.15 },
      'C': { easy: 0.30, normal: 0.50, hard: 0.20 },  // C: バランス
      'B': { easy: 0.20, normal: 0.50, hard: 0.30 },
      'A': { easy: 0.10, normal: 0.45, hard: 0.45 },
      'S': { easy: 0.05, normal: 0.35, hard: 0.60 },
      'S+': { easy: 0.02, normal: 0.28, hard: 0.70 },
      'S++': { easy: 0.00, normal: 0.20, hard: 0.80 }  // S++: 上級者向け
    };
    
    return distributions[rank] || distributions['C']; // デフォルトはC
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
        console.log(`Adding ${needed} CPU players to reach ${targetTotal} total (Rank: ${this.rank})`);
        
        // ランクに応じた難易度分布
        const difficultyDistribution = this.getCPUDifficultyDistribution(this.rank);
        
        for (let i = 0; i < needed; i++) {
          const rand = Math.random();
          let difficulty = 'normal';
          
          if (rand < difficultyDistribution.easy) {
            difficulty = 'easy';
          } else if (rand < difficultyDistribution.easy + difficultyDistribution.normal) {
            difficulty = 'normal';
          } else {
            difficulty = 'hard';
          }
          
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

function generateRoomCode() {
  // 6桁の大文字英数字コード
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字を除外
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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
  const room = new Room(roomId, `Rank ${rank} Match`, null, CONFIG.MAX_PLAYERS, true, rank); // isQuickMatch = true, ランクも渡す
  rooms.set(roomId, room);

  console.log(`Created match ${roomId} for ${players.length} players (Rank: ${rank})`);

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
  const roomId = generateRoomCode(); // 短い6桁コード
  const room = new Room(
    roomId,
    `Room ${roomId}`, // 名前はコードと同じ
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

  // 生存プレイヤー（人間＋CPU）からランダム選択
  const aliveHumans = Array.from(room.players.values())
    .filter(p => p.isAlive && p.id !== clientInfo.id);
  
  const aliveCPUs = Array.from(room.cpuPlayers.values())
    .filter(cpu => cpu.isAlive);
  
  const allTargets = [...aliveHumans, ...aliveCPUs];

  if (allTargets.length > 0) {
    const target = allTargets[Math.floor(Math.random() * allTargets.length)];
    
    if (target.isCPU) {
      // CPUへの攻撃
      target.receiveAttack(data.lines || 1);
    } else {
      // 人間プレイヤーへの攻撃
      if (target.ws && target.ws.readyState === 1) { // WebSocket.OPEN
        target.ws.send(JSON.stringify({
          type: 'attacked',
          fromPlayerId: clientInfo.id,
          lines: data.lines || 1
        }));
      }
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
