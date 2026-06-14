const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const RANKS = ['A', 'K', 'Q', 'J'];
const SUITS = ['♠', '♥', '♦', '♣'];
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const CYLINDER_SIZE = 6; // 6 oda, 1 gerçek mermi

const rooms = {};

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createDeck() {
  const deck = [];
  for (const rank of RANKS)
    for (const suit of SUITS)
      deck.push({ rank, suit });
  return shuffle(deck);
}

function dealCards(room) {
  const deck = createDeck();
  const alive = room.players.filter(p => !p.eliminated);
  const perPlayer = Math.floor(deck.length / alive.length);
  let idx = 0;
  alive.forEach(p => {
    p.hand = deck.slice(idx, idx + perPlayer);
    idx += perPlayer;
  });
}

function pickRequiredRank(room) {
  room.requiredRank = RANKS[Math.floor(Math.random() * RANKS.length)];
}

// ── Silah / Silindir ──────────────────────────────────────────────────────────
// Her oyuncunun kendi silindiri var: 6 oda, 1 gerçek mermi (rastgele pozisyon)
// Her ateşlemede sıradaki oda kullanılır. Gerçek mermiye gelince → elenir.
// Silahı yeniden yüklemek (reload) için silindiri yeniden karıştır.

function initGun() {
  // cylinder: [false, false, false, false, false, true] gibi karıştırılmış dizi
  // true = gerçek mermi
  const cylinder = Array(CYLINDER_SIZE).fill(false);
  cylinder[Math.floor(Math.random() * CYLINDER_SIZE)] = true;
  return { cylinder, position: 0 };
}

// Bir ateşleme yap; true dönerse gerçek mermi çaktı
function pullTrigger(gun) {
  const fired = gun.cylinder[gun.position];
  gun.position = (gun.position + 1) % CYLINDER_SIZE;
  // Tüm odalar geçildiyse otomatik yeniden yükle
  if (gun.position === 0) {
    const newCylinder = Array(CYLINDER_SIZE).fill(false);
    newCylinder[Math.floor(Math.random() * CYLINDER_SIZE)] = true;
    gun.cylinder = newCylinder;
  }
  return fired;
}

// Oyuncunun silindir durumunu istemciye gönder (hangi odalar boş/dolu gösterilmez — sadece konum ve toplam)
function gunStateFor(gun) {
  return {
    position: gun.position,           // şu an kaçıncı odadayız (0-5)
    cylinderSize: CYLINDER_SIZE,
    // Kaç ateşlemeden sonra kesin ölüm? Sadece sunucu bilir, istemci bilmez
    // Ama geçmiş ateşlemeleri gönderelim
    shotsFired: gun.position,         // bu reload'dan kaç ateş edildi
  };
}

// ── Oyun başlatma ─────────────────────────────────────────────────────────────

function startGame(room) {
  room.state = 'playing';
  room.pile = [];
  room.lastPlay = null;
  room.round = 1;
  pickRequiredRank(room);

  // Her oyuncuya silah ver
  room.players.forEach(p => {
    p.eliminated = false;
    p.gun = initGun();
    p.shotHistory = []; // true/false geçmişi
  });

  dealCards(room);

  room.currentTurn = 0;
  while (room.players[room.currentTurn].eliminated) {
    room.currentTurn = (room.currentTurn + 1) % room.players.length;
  }

  broadcastState(room);
  broadcastLog(room, `🎮 Oyun başladı! ${room.players.length} oyuncu — Rus ruleti aktif.`, 'info');
  broadcastLog(room, `🔫 Her oyuncunun silahında 6 oda, 1 gerçek mermi var.`, 'info');
  broadcastLog(room, `🃏 Bu turun kozu: ${room.requiredRank}`, 'important');
}

// ── State yayını ──────────────────────────────────────────────────────────────

function buildStateFor(room, playerIdx) {
  return {
    state: room.state,
    round: room.round,
    requiredRank: room.requiredRank,
    pileCount: room.pile.length,
    lastPlay: room.lastPlay ? {
      playerName: room.players[room.lastPlay.playerIdx].name,
      playerIdx: room.lastPlay.playerIdx,
      claimCount: room.lastPlay.claimCount,
    } : null,
    currentTurn: room.currentTurn,
    players: room.players.map((p, i) => ({
      name: p.name,
      eliminated: p.eliminated,
      cardCount: p.hand ? p.hand.length : 0,
      isYou: i === playerIdx,
      gun: p.gun ? gunStateFor(p.gun) : null,
      shotHistory: p.shotHistory || [],
    })),
    myHand: playerIdx !== -1 && room.players[playerIdx]
      ? room.players[playerIdx].hand || []
      : [],
    myIndex: playerIdx,
  };
}

function broadcastState(room) {
  room.players.forEach((p, i) => {
    if (p.socketId) io.to(p.socketId).emit('gameState', buildStateFor(room, i));
  });
}

function broadcastLog(room, msg, type = '') {
  io.to(room.code).emit('log', { msg, type });
}

function nextTurn(room) {
  let next = (room.currentTurn + 1) % room.players.length;
  let loops = 0;
  while (room.players[next].eliminated && loops < room.players.length) {
    next = (next + 1) % room.players.length;
    loops++;
  }
  room.currentTurn = next;
}

function checkWinner(room) {
  const alive = room.players.filter(p => !p.eliminated);
  if (alive.length === 1) {
    room.state = 'ended';
    broadcastState(room);
    io.to(room.code).emit('gameOver', { winner: alive[0].name });
    broadcastLog(room, `🏆 ${alive[0].name} kazandı!`, 'success');
    return true;
  }
  return false;
}

// ── Suçlama çözümü ────────────────────────────────────────────────────────────

function resolveAccusation(room, accuserIdx) {
  if (!room.lastPlay) return;
  const { playerIdx: accusedIdx, cards: playedCards, claimCount } = room.lastPlay;
  const accused = room.players[accusedIdx];
  const accuser = room.players[accuserIdx];

  const realCount = playedCards.filter(c => c.rank === room.requiredRank).length;
  const wasBluff = realCount < claimCount;
  const loser = wasBluff ? accused : accuser;

  // Kaybeden tetik çekiyor
  const realBullet = pullTrigger(loser.gun);
  loser.shotHistory.push(realBullet);

  broadcastLog(room,
    wasBluff
      ? `🎯 ${accused.name} BLÖF YAPTI! (${claimCount} iddia, ${realCount} gerçek ${room.requiredRank})`
      : `😅 ${accuser.name} haksız suçladı! (${accused.name} doğru söylüyordu)`,
    wasBluff ? 'success' : 'danger'
  );

  broadcastLog(room, `🔫 ${loser.name} silahını başına dayayıp tetiği çekiyor...`, 'important');

  if (realBullet) {
    loser.eliminated = true;
    broadcastLog(room, `💀 BANG! ${loser.name} elendi!`, 'danger');
  } else {
    broadcastLog(room, `😮‍💨 *tık* — ${loser.name} bu sefer şanslıydı! (${loser.gun.position}/6 oda geçildi)`, 'success');
  }

  // İstemcilere reveal + silah animasyonu gönder
  io.to(room.code).emit('revealPile', {
    cards: playedCards,
    accuserName: accuser.name,
    accusedName: accused.name,
    claimCount,
    realCount,
    wasBluff,
    loserName: loser.name,
    realBullet,
    shotPosition: loser.gun.position === 0 ? CYLINDER_SIZE : loser.gun.position, // ateşlenen konum
    gunState: gunStateFor(loser.gun),
    shotHistory: loser.shotHistory,
  });

  // Yeni tur hazırlığı
  room.pile = [];
  room.lastPlay = null;
  pickRequiredRank(room);
  room.round++;

  if (checkWinner(room)) return;

  dealCards(room);
  broadcastLog(room, `🔄 Yeni tur! Koz: ${room.requiredRank}`, 'important');

  room.currentTurn = room.players.indexOf(loser);
  if (loser.eliminated) nextTurn(room);

  broadcastState(room);
}

// ── Socket olayları ───────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('createRoom', ({ name }) => {
    let code;
    do { code = generateCode(); } while (rooms[code]);

    const player = { name, socketId: socket.id, hand: [], eliminated: false, gun: null, shotHistory: [] };
    rooms[code] = {
      code,
      state: 'lobby',
      players: [player],
      pile: [],
      lastPlay: null,
      requiredRank: 'A',
      currentTurn: 0,
      round: 1,
    };

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = 0;

    socket.emit('roomCreated', { code });
    broadcastState(rooms[code]);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = code.toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Oda bulunamadı.'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Oyun zaten başladı.'); return; }
    if (room.players.length >= MAX_PLAYERS) { socket.emit('error', 'Oda dolu (max 6 kişi).'); return; }

    const player = { name, socketId: socket.id, hand: [], eliminated: false, gun: null, shotHistory: [] };
    room.players.push(player);
    const playerIdx = room.players.length - 1;

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = playerIdx;

    socket.emit('roomJoined', { code });
    broadcastLog(room, `👋 ${name} odaya katıldı.`, 'info');
    broadcastState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (socket.data.playerIdx !== 0) { socket.emit('error', 'Sadece host başlatabilir.'); return; }
    if (room.players.length < MIN_PLAYERS) { socket.emit('error', `En az ${MIN_PLAYERS} oyuncu gerekli.`); return; }
    startGame(room);
  });

  socket.on('playCards', ({ cardIndices, claimCount }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing') return;
    const pIdx = socket.data.playerIdx;
    if (room.currentTurn !== pIdx) { socket.emit('error', 'Sıra sende değil!'); return; }

    const player = room.players[pIdx];
    if (!cardIndices || cardIndices.length === 0) { socket.emit('error', 'En az 1 kart seç.'); return; }

    const playedCards = cardIndices.map(i => player.hand[i]).filter(Boolean);
    if (playedCards.length !== cardIndices.length) { socket.emit('error', 'Geçersiz kart seçimi.'); return; }

    const sortedIndices = [...cardIndices].sort((a, b) => b - a);
    sortedIndices.forEach(i => player.hand.splice(i, 1));

    playedCards.forEach(c => { c._from = pIdx; room.pile.push(c); });
    room.lastPlay = { playerIdx: pIdx, cards: playedCards, claimCount };

    broadcastLog(room, `🃏 ${player.name} → ${claimCount} adet ${room.requiredRank} oynadığını iddia etti.`, 'play');

    nextTurn(room);
    broadcastState(room);
  });

  socket.on('accuse', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing') return;
    if (!room.lastPlay) { socket.emit('error', 'Henüz kart oynanmadı.'); return; }
    const accuserIdx = socket.data.playerIdx;
    if (room.lastPlay.playerIdx === accuserIdx) { socket.emit('error', 'Kendini suçlayamazsın.'); return; }
    resolveAccusation(room, accuserIdx);
  });

  socket.on('disconnect', () => {
    const { roomCode, playerIdx } = socket.data;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    const player = room.players[playerIdx];
    if (player) {
      broadcastLog(room, `⚠️ ${player.name} bağlantısı kesildi.`, 'danger');
      if (room.state === 'lobby') {
        room.players.splice(playerIdx, 1);
      } else {
        player.eliminated = true;
        if (!checkWinner(room)) {
          if (room.currentTurn === playerIdx) nextTurn(room);
          broadcastState(room);
        }
      }
    }
    if (room.players.filter(p => p.socketId).length === 0) delete rooms[roomCode];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎴 Liar's Bar sunucusu çalışıyor: http://localhost:${PORT}`);
  console.log(`   İnternet üzerinden: npx ngrok http ${PORT}\n`);
});
