const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════════
//  YARDIMCILAR
// ═══════════════════════════════════════════════════════════════════
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

const rooms = {}; // code -> room

// ═══════════════════════════════════════════════════════════════════
//  LIARS BAR
// ═══════════════════════════════════════════════════════════════════
const LB_RANKS = ['A', 'K', 'Q', 'J'];
const LB_SUITS = ['♠', '♥', '♦', '♣'];
const LB_MAX = 6, LB_MIN = 2, CYLINDER_SIZE = 6;

function lb_createDeck() {
  const deck = [];
  for (const r of LB_RANKS) for (const s of LB_SUITS) deck.push({ rank: r, suit: s });
  return shuffle(deck);
}
function lb_dealCards(room) {
  const deck = lb_createDeck();
  const alive = room.players.filter(p => !p.eliminated);
  const per = Math.floor(deck.length / alive.length);
  let idx = 0;
  alive.forEach(p => { p.hand = deck.slice(idx, idx + per); idx += per; });
}
function lb_pickRank(room) { room.requiredRank = LB_RANKS[Math.floor(Math.random() * LB_RANKS.length)]; }
function lb_initGun() {
  const cyl = Array(CYLINDER_SIZE).fill(false);
  cyl[Math.floor(Math.random() * CYLINDER_SIZE)] = true;
  return { cylinder: cyl, position: 0 };
}
function lb_pullTrigger(gun) {
  const fired = gun.cylinder[gun.position];
  gun.position = (gun.position + 1) % CYLINDER_SIZE;
  if (gun.position === 0) {
    const nc = Array(CYLINDER_SIZE).fill(false);
    nc[Math.floor(Math.random() * CYLINDER_SIZE)] = true;
    gun.cylinder = nc;
  }
  return fired;
}
function lb_gunState(gun) { return { position: gun.position, cylinderSize: CYLINDER_SIZE, shotsFired: gun.position }; }

function lb_startGame(room) {
  room.state = 'playing';
  room.pile = []; room.lastPlay = null; room.round = 1;
  lb_pickRank(room);
  room.players.forEach(p => { p.eliminated = false; p.gun = lb_initGun(); p.shotHistory = []; });
  lb_dealCards(room);
  room.currentTurn = 0;
  lb_broadcastState(room);
  lb_log(room, `🎮 Oyun başladı! ${room.players.length} oyuncu.`, 'info');
  lb_log(room, `🔫 Her oyuncunun silahında 6 oda, 1 gerçek mermi var.`, 'info');
  lb_log(room, `🃏 Bu turun kozu: ${room.requiredRank}`, 'important');
}

function lb_buildState(room, pidx) {
  return {
    game: 'liarsbar',
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
      name: p.name, eliminated: p.eliminated,
      cardCount: p.hand ? p.hand.length : 0,
      isYou: i === pidx,
      gun: p.gun ? lb_gunState(p.gun) : null,
      shotHistory: p.shotHistory || [],
    })),
    myHand: pidx !== -1 && room.players[pidx] ? room.players[pidx].hand || [] : [],
    myIndex: pidx,
  };
}

function lb_broadcastState(room) {
  room.players.forEach((p, i) => { if (p.socketId) io.to(p.socketId).emit('gameState', lb_buildState(room, i)); });
}
function lb_log(room, msg, type = '') { io.to(room.code).emit('log', { msg, type }); }

function lb_nextTurn(room) {
  let next = (room.currentTurn + 1) % room.players.length, loops = 0;
  while (room.players[next].eliminated && loops < room.players.length) { next = (next + 1) % room.players.length; loops++; }
  room.currentTurn = next;
}
function lb_checkWinner(room) {
  const alive = room.players.filter(p => !p.eliminated);
  if (alive.length === 1) {
    room.state = 'ended';
    lb_broadcastState(room);
    io.to(room.code).emit('gameOver', { winner: alive[0].name });
    lb_log(room, `🏆 ${alive[0].name} kazandı!`, 'success');
    return true;
  }
  return false;
}
function lb_resolveAccusation(room, accuserIdx) {
  if (!room.lastPlay) return;
  const { playerIdx: accusedIdx, cards: playedCards, claimCount } = room.lastPlay;
  const accused = room.players[accusedIdx], accuser = room.players[accuserIdx];
  const realCount = playedCards.filter(c => c.rank === room.requiredRank).length;
  const wasBluff = realCount < claimCount;
  const loser = wasBluff ? accused : accuser;
  const realBullet = lb_pullTrigger(loser.gun);
  loser.shotHistory.push(realBullet);
  lb_log(room, wasBluff ? `🎯 ${accused.name} BLÖF YAPTI!` : `😅 ${accuser.name} haksız suçladı!`, wasBluff ? 'success' : 'danger');
  lb_log(room, `🔫 ${loser.name} tetiği çekiyor...`, 'important');
  if (realBullet) { loser.eliminated = true; lb_log(room, `💀 BANG! ${loser.name} elendi!`, 'danger'); }
  else lb_log(room, `😮‍💨 *tık* — ${loser.name} şanslıydı!`, 'success');
  io.to(room.code).emit('revealPile', {
    cards: playedCards, accuserName: accuser.name, accusedName: accused.name,
    claimCount, realCount, wasBluff, loserName: loser.name,
    realBullet, shotHistory: loser.shotHistory,
  });
  room.pile = []; room.lastPlay = null; lb_pickRank(room); room.round++;
  if (lb_checkWinner(room)) return;
  lb_dealCards(room);
  lb_log(room, `🔄 Yeni tur! Koz: ${room.requiredRank}`, 'important');
  room.currentTurn = room.players.indexOf(loser);
  if (loser.eliminated) lb_nextTurn(room);
  lb_broadcastState(room);
}

// ═══════════════════════════════════════════════════════════════════
//  OKEY
// ═══════════════════════════════════════════════════════════════════
// Taşlar: 1-13, 4 renk (Sarı=1,Yeşil=2,Kırmızı=3,Siyah=4), 2'şer set + 2 joker (sahte okey)
// Gösterge taşının bir üstü = Okey taşı
// Tam kurallar: 14 taş → gösterge açılır → sırayla çek/at → el aç (seriler+üçlüler, min 51 puan)

const OK_COLORS = [1, 2, 3, 4]; // 1=Sarı,2=Yeşil,3=Kırmızı,4=Siyah
const OK_COLOR_NAMES = { 1: 'sarı', 2: 'yeşil', 3: 'kırmızı', 4: 'siyah' };
const OK_COLOR_HEX = { 1: '#f0b429', 2: '#22c97a', 3: '#e8504a', 4: '#aaaaaa' };
const OK_MAX = 4, OK_MIN = 2;

function ok_createDeck() {
  const deck = [];
  let id = 0;
  for (let set = 0; set < 2; set++)
    for (const color of OK_COLORS)
      for (let num = 1; num <= 13; num++)
        deck.push({ id: id++, num, color, isJoker: false, isOkey: false });
  // 2 sahte okey (joker)
  deck.push({ id: id++, num: 0, color: 0, isJoker: true, isOkey: false });
  deck.push({ id: id++, num: 0, color: 0, isJoker: true, isOkey: false });
  return shuffle(deck);
}

function ok_startGame(room) {
  const deck = ok_createDeck();
  // Gösterge: rastgele bir taş aç (joker olamaz)
  let gostergeIdx = Math.floor(Math.random() * (deck.length - 2)); // son 2 joker'ı alma
  // Joker olmayan bir tane bul
  while (deck[gostergeIdx].isJoker) gostergeIdx = (gostergeIdx + 1) % (deck.length - 2);
  const gosterge = deck.splice(gostergeIdx, 1)[0];

  // Okey taşı = göstergenin bir üstü (aynı renk, sayı+1; 13'ün üstü 1)
  const okeyNum = gosterge.num === 13 ? 1 : gosterge.num + 1;
  const okeyColor = gosterge.color;

  // Desteden taşları dağıt: ilk oyuncu 15, diğerleri 14
  let deckIdx = 0;
  const hands = room.players.map((p, i) => {
    const count = i === 0 ? 15 : 14;
    const hand = deck.slice(deckIdx, deckIdx + count).map(t => {
      return { ...t, isOkey: !t.isJoker && t.num === okeyNum && t.color === okeyColor };
    });
    deckIdx += count;
    return hand;
  });

  // Kalan taşlar çekme destesi
  const drawPile = deck.slice(deckIdx).map(t => ({
    ...t, isOkey: !t.isJoker && t.num === okeyNum && t.color === okeyColor
  }));

  room.state = 'playing';
  room.ok = {
    gosterge,
    okeyNum,
    okeyColor,
    drawPile,
    discardPile: [], // üstteki açık
    currentTurn: 0,
    round: 1,
    drawnThisTurn: false, // bu tur taş çekildi mi
    winner: null,
    scores: room.players.map(() => 0), // toplam puanlar
    lastDiscard: null,
    lastDiscardBy: -1,
    lastDiscardByPlayer: {}, // pidx -> tile (her oyuncunun son attığı)
  };
  room.players.forEach((p, i) => { p.hand = hands[i]; p.eliminated = false; p.okScore = 0; });
  room.currentTurn = 0;

  ok_broadcastState(room);
  ok_log(room, `🀄 Okey başladı! Gösterge: ${gosterge.num} ${OK_COLOR_NAMES[gosterge.color]}`, 'important');
  ok_log(room, `🎯 Okey taşı: ${okeyNum} ${OK_COLOR_NAMES[okeyColor]}`, 'important');
  ok_log(room, `${room.players[0].name} 15 taşla başlıyor ve atacak.`, 'info');
}

function ok_tileStr(t) {
  if (!t) return '?';
  if (t.isJoker) return 'JKR';
  return `${t.num}${OK_COLOR_NAMES[t.color][0].toUpperCase()}`;
}

function ok_buildState(room, pidx) {
  const ok = room.ok;
  return {
    game: 'okey',
    state: room.state,
    round: ok ? ok.round : 1,
    currentTurn: room.currentTurn,
    drawnThisTurn: ok ? ok.drawnThisTurn : false,
    gosterge: ok ? ok.gosterge : null,
    okeyNum: ok ? ok.okeyNum : null,
    okeyColor: ok ? ok.okeyColor : null,
    drawPileCount: ok ? ok.drawPile.length : 0,
    discardTop: ok && ok.discardPile.length > 0 ? ok.discardPile[ok.discardPile.length - 1] : null,
    lastDiscardBy: ok ? (ok.lastDiscardBy !== undefined ? ok.lastDiscardBy : -1) : -1,
    lastDiscardByPlayer: ok ? ok.lastDiscardByPlayer || {} : {},
    scores: ok ? ok.scores : [],
    players: room.players.map((p, i) => ({
      name: p.name,
      isYou: i === pidx,
      tileCount: p.hand ? p.hand.length : 0,
      okScore: p.okScore || 0,
      eliminated: p.eliminated || false,
    })),
    myHand: pidx !== -1 && room.players[pidx] ? room.players[pidx].hand || [] : [],
    myIndex: pidx,
  };
}

function ok_broadcastState(room) {
  room.players.forEach((p, i) => { if (p.socketId) io.to(p.socketId).emit('gameState', ok_buildState(room, i)); });
}
function ok_log(room, msg, type = '') { io.to(room.code).emit('log', { msg, type }); }

function ok_nextTurn(room) {
  room.currentTurn = (room.currentTurn + 1) % room.players.length;
  room.ok.drawnThisTurn = false;
}

// Taş değeri (puan hesabı için)
function ok_tileValue(t, okeyNum, okeyColor) {
  if (t.isJoker) return 30;
  if (t.isOkey || (!t.isJoker && t.num === okeyNum && t.color === okeyColor)) return 30;
  if (t.num >= 10) return 10;
  return t.num;
}

// El geçerli mi kontrol (seriler + üçlüler/dörtlüler)
// Dizi: aynı renk ardışık sayılar (min 3), Üçlü/Dörtlü: farklı renkler aynı sayı
function ok_isValidSet(tiles, okeyNum, okeyColor) {
  // Joker/okey sayısı
  const jokers = tiles.filter(t => t.isJoker || t.isOkey).length;
  const reals = tiles.filter(t => !t.isJoker && !t.isOkey);
  if (tiles.length < 3) return false;

  // Üçlü/dörtlü mü? Aynı sayı, farklı renk
  const nums = [...new Set(reals.map(t => t.num))];
  const colors = reals.map(t => t.color);
  const uniqueColors = new Set(colors);
  if (nums.length === 1 && uniqueColors.size === reals.length && tiles.length <= 4) return true;

  // Seri mi? Aynı renk, ardışık
  const rcolors = [...new Set(reals.map(t => t.color))];
  if (rcolors.length === 1) {
    const sorted = [...reals].sort((a, b) => a.num - b.num);
    let gaps = 0;
    for (let i = 1; i < sorted.length; i++) {
      const diff = sorted[i].num - sorted[i - 1].num;
      if (diff === 1) continue;
      if (diff === 2) { gaps++; continue; } // joker doldurur
      return false;
    }
    if (gaps <= jokers) return true;
  }
  return false;
}

function ok_calcHandScore(tiles, okeyNum, okeyColor) {
  // Kalan taşların ceza puanı
  return tiles.reduce((sum, t) => sum + ok_tileValue(t, okeyNum, okeyColor), 0);
}

// El açma doğrulaması: gruplar dizisi [[taş,taş,taş],[taş,taş,taş,taş],...]
function ok_validateOpen(groups, okeyNum, okeyColor) {
  for (const g of groups) {
    if (!ok_isValidSet(g, okeyNum, okeyColor)) return { ok: false, reason: 'Geçersiz grup: ' + g.map(t => ok_tileStr(t)).join(' ') };
  }
  const total = groups.flat().reduce((s, t) => s + ok_tileValue(t, okeyNum, okeyColor), 0);
  if (total < 51) return { ok: false, reason: `Toplam puan ${total} — en az 51 gerekli` };
  return { ok: true, score: total };
}

// ═══════════════════════════════════════════════════════════════════
//  SOCKET OLAYLARI
// ═══════════════════════════════════════════════════════════════════
io.on('connection', (socket) => {

  // ── Oda oluştur ──
  socket.on('createRoom', ({ name, gameType }) => {
    let code;
    do { code = generateCode(); } while (rooms[code]);
    const player = { name, socketId: socket.id, hand: [], eliminated: false, gun: null, shotHistory: [], okScore: 0 };
    rooms[code] = {
      code, gameType: gameType || 'liarsbar',
      state: 'lobby', players: [player],
      pile: [], lastPlay: null, requiredRank: 'A',
      currentTurn: 0, round: 1, ok: null,
    };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = 0;
    socket.emit('roomCreated', { code, gameType: rooms[code].gameType });
    if (rooms[code].gameType === 'liarsbar') lb_broadcastState(rooms[code]);
    else ok_broadcastState(rooms[code]);
  });

  // ── Odaya katıl ──
  socket.on('joinRoom', ({ code, name }) => {
    code = code.toUpperCase().trim();
    const room = rooms[code];
    if (!room) { socket.emit('error', 'Oda bulunamadı.'); return; }
    if (room.state !== 'lobby') { socket.emit('error', 'Oyun zaten başladı.'); return; }
    const maxP = room.gameType === 'liarsbar' ? LB_MAX : OK_MAX;
    if (room.players.length >= maxP) { socket.emit('error', `Oda dolu (max ${maxP} kişi).`); return; }
    const player = { name, socketId: socket.id, hand: [], eliminated: false, gun: null, shotHistory: [], okScore: 0 };
    room.players.push(player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerIdx = room.players.length - 1;
    socket.emit('roomJoined', { code, gameType: room.gameType });
    if (room.gameType === 'liarsbar') { lb_log(room, `👋 ${name} odaya katıldı.`, 'info'); lb_broadcastState(room); }
    else { ok_log(room, `👋 ${name} odaya katıldı.`, 'info'); ok_broadcastState(room); }
  });

  // ── Oyunu başlat ──
  socket.on('startGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.data.playerIdx !== 0) return;
    const minP = room.gameType === 'liarsbar' ? LB_MIN : OK_MIN;
    if (room.players.length < minP) { socket.emit('error', `En az ${minP} oyuncu gerekli.`); return; }
    const maxP = room.gameType === 'liarsbar' ? LB_MAX : OK_MAX;
    if (room.players.length > maxP) { socket.emit('error', `Max ${maxP} oyuncu.`); return; }
    if (room.gameType === 'liarsbar') lb_startGame(room);
    else ok_startGame(room);
  });

  // ─────────────── LIARS BAR OLAYLARI ───────────────
  socket.on('playCards', ({ cardIndices, claimCount }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || room.gameType !== 'liarsbar') return;
    const pIdx = socket.data.playerIdx;
    if (room.currentTurn !== pIdx) { socket.emit('error', 'Sıra sende değil!'); return; }
    const player = room.players[pIdx];
    const playedCards = cardIndices.map(i => player.hand[i]).filter(Boolean);
    if (!playedCards.length) { socket.emit('error', 'En az 1 kart seç.'); return; }
    [...cardIndices].sort((a, b) => b - a).forEach(i => player.hand.splice(i, 1));
    playedCards.forEach(c => { c._from = pIdx; room.pile.push(c); });
    room.lastPlay = { playerIdx: pIdx, cards: playedCards, claimCount };
    lb_log(room, `🃏 ${player.name} → ${claimCount} adet ${room.requiredRank} oynadığını iddia etti.`, 'play');
    lb_nextTurn(room);
    lb_broadcastState(room);
  });

  socket.on('accuse', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || room.gameType !== 'liarsbar') return;
    if (!room.lastPlay) { socket.emit('error', 'Henüz kart oynanmadı.'); return; }
    const accuserIdx = socket.data.playerIdx;
    if (room.lastPlay.playerIdx === accuserIdx) { socket.emit('error', 'Kendini suçlayamazsın.'); return; }
    lb_resolveAccusation(room, accuserIdx);
  });

  // ─────────────── OKEY OLAYLARI ───────────────

  // Desteden taş çek
  socket.on('ok_draw', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || room.gameType !== 'okey') return;
    const pIdx = socket.data.playerIdx;
    if (room.currentTurn !== pIdx) { socket.emit('error', 'Sıra sende değil!'); return; }
    if (room.ok.drawnThisTurn) { socket.emit('error', 'Bu tur zaten taş çektin.'); return; }
    if (room.ok.drawPile.length === 0) { socket.emit('error', 'Deste bitti!'); return; }
    const tile = room.ok.drawPile.pop();
    room.players[pIdx].hand.push(tile);
    room.ok.drawnThisTurn = true;
    ok_log(room, `${room.players[pIdx].name} desteden taş çekti.`, 'info');
    ok_broadcastState(room);
  });

  // Açık taşı al (discard pile'ın üstü)
  socket.on('ok_takeDiscard', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || room.gameType !== 'okey') return;
    const pIdx = socket.data.playerIdx;
    if (room.currentTurn !== pIdx) { socket.emit('error', 'Sıra sende değil!'); return; }
    if (room.ok.drawnThisTurn) { socket.emit('error', 'Bu tur zaten taş çektin.'); return; }
    if (room.ok.discardPile.length === 0) { socket.emit('error', 'Atılan taş yok.'); return; }
    const tile = room.ok.discardPile.pop();
    room.players[pIdx].hand.push(tile);
    room.ok.drawnThisTurn = true;
    room.ok.lastDiscardBy = -1; // atılan taş alındı, spot temizle
    ok_log(room, `${room.players[pIdx].name} atılan taşı aldı: ${ok_tileStr(tile)}`, 'info');
    ok_broadcastState(room);
  });

  // Taş at
  socket.on('ok_discard', ({ tileId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || room.gameType !== 'okey') return;
    const pIdx = socket.data.playerIdx;
    if (room.currentTurn !== pIdx) { socket.emit('error', 'Sıra sende değil!'); return; }
    if (!room.ok.drawnThisTurn) { socket.emit('error', 'Önce taş çekmelisin.'); return; }
    const hand = room.players[pIdx].hand;
    const tIdx = hand.findIndex(t => t.id === tileId);
    if (tIdx === -1) { socket.emit('error', 'Taş bulunamadı.'); return; }
    const [tile] = hand.splice(tIdx, 1);
    room.ok.discardPile.push(tile);
    room.ok.lastDiscard = tile;
    room.ok.lastDiscardBy = pIdx;
    if (!room.ok.lastDiscardByPlayer) room.ok.lastDiscardByPlayer = {};
    room.ok.lastDiscardByPlayer[pIdx] = tile;
    ok_log(room, `${room.players[pIdx].name} attı: ${ok_tileStr(tile)}`, '');
    ok_nextTurn(room);
    ok_broadcastState(room);
  });

  // El aç (kazanma hamlesi)
  // groups: [[{id,num,color,...}, ...], [...], ...]
  socket.on('ok_openHand', ({ groups }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.state !== 'playing' || room.gameType !== 'okey') return;
    const pIdx = socket.data.playerIdx;
    if (room.currentTurn !== pIdx) { socket.emit('error', 'Sıra sende değil!'); return; }
    if (!room.ok.drawnThisTurn) { socket.emit('error', 'Önce taş çekmelisin.'); return; }

    // Grupları doğrula
    const validation = ok_validateOpen(groups, room.ok.okeyNum, room.ok.okeyColor);
    if (!validation.ok) { socket.emit('error', validation.reason); return; }

    // Elde hepsi var mı?
    const hand = room.players[pIdx].hand;
    const usedIds = groups.flat().map(t => t.id);
    const remainingIds = usedIds.filter(id => !hand.find(t => t.id === id));
    if (remainingIds.length > 0) { socket.emit('error', 'Elinde olmayan taş kullanıyorsun.'); return; }

    // Kalan taşlar (gruplar dışında)
    const usedSet = new Set(usedIds);
    const leftover = hand.filter(t => !usedSet.has(t.id));

    // Kazanan: leftover 0 ise çift kazanır (normal); 1 taş ise son atmak gerekli
    if (leftover.length > 1) { socket.emit('error', `${leftover.length} taş elinizde kaldı — tümünü gruplara dahil edin.`); return; }
    if (leftover.length === 1) { socket.emit('error', '1 taş kaldı — önce onu atın, sonra açın veya gruba ekleyin.'); return; }

    // Kazandı!
    ok_log(room, `🏆 ${room.players[pIdx].name} eli açtı!`, 'success');

    // Diğer oyuncuların ceza puanlarını hesapla
    const penalties = room.players.map((p, i) => {
      if (i === pIdx) return 0;
      return ok_calcHandScore(p.hand, room.ok.okeyNum, room.ok.okeyColor);
    });
    const totalPenalty = penalties.reduce((a, b) => a + b, 0);
    room.ok.scores[pIdx] += totalPenalty;
    penalties.forEach((pen, i) => { if (i !== pIdx) room.players[i].okScore += pen; });

    ok_log(room, `Ceza puanları: ${room.players.map((p, i) => `${p.name}: ${penalties[i]}`).join(', ')}`, 'info');
    ok_log(room, `${room.players[pIdx].name} bu elden ${totalPenalty} puan kazandı!`, 'success');

    // 101+ puan olan elenir
    const eliminated = room.players.filter((p, i) => (room.ok.scores[i] || 0) >= 101);
    eliminated.forEach(p => { p.eliminated = true; ok_log(room, `💀 ${p.name} 101 puanı geçti — elendi!`, 'danger'); });

    io.to(room.code).emit('okeyRoundOver', {
      winnerName: room.players[pIdx].name,
      winnerIdx: pIdx,
      groups,
      penalties,
      scores: room.ok.scores,
    });

    // Hâlâ oynayan var mı?
    const alive = room.players.filter(p => !p.eliminated);
    if (alive.length === 1) {
      room.state = 'ended';
      ok_broadcastState(room);
      io.to(room.code).emit('gameOver', { winner: alive[0].name });
      ok_log(room, `🏆 ${alive[0].name} oyunu kazandı!`, 'success');
      return;
    }
    if (alive.length === 0) {
      room.state = 'ended';
      ok_broadcastState(room);
      io.to(room.code).emit('gameOver', { winner: 'Kimse' });
      return;
    }

    // Yeni el başlat (3 saniye sonra)
    setTimeout(() => {
      ok_startGame(room);
    }, 3000);
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const { roomCode, playerIdx } = socket.data;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    const player = room.players[playerIdx];
    if (!player) return;
    const logFn = room.gameType === 'liarsbar' ? lb_log : ok_log;
    const broadcastFn = room.gameType === 'liarsbar' ? lb_broadcastState : ok_broadcastState;
    logFn(room, `⚠️ ${player.name} bağlantısı kesildi.`, 'danger');
    if (room.state === 'lobby') {
      room.players.splice(playerIdx, 1);
      room.players.forEach((p, i) => { /* idx güncelle */ });
    } else {
      player.eliminated = true;
      const checkFn = room.gameType === 'liarsbar' ? lb_checkWinner : null;
      if (checkFn && !checkFn(room)) {
        if (room.currentTurn === playerIdx) {
          room.gameType === 'liarsbar' ? lb_nextTurn(room) : ok_nextTurn(room);
        }
        broadcastFn(room);
      }
    }
    if (room.players.every(p => !p.socketId)) delete rooms[roomCode];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎴 Liar's Bar sunucusu çalışıyor: http://localhost:${PORT}\n`);
});
