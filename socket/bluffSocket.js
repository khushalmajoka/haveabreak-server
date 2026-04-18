const { dealCards, wasBluff, createBluffRoom, RANKS } = require('../utils/cardUtils');
const logger = require('../utils/logger');

// In-memory store — no MongoDB needed for this game
const bluffRooms = new Map(); // roomCode → roomState

function addLog(room, type, msg) {
  room.log.push({ type, msg, ts: Date.now() });
  if (room.log.length > 60) room.log.shift(); // keep last 60 entries
}

function nextAliveIndex(room, fromIndex) {
  const n = room.players.length;
  let idx = (fromIndex + 1) % n;
  let attempts = 0;
  while (!room.players[idx].isAlive && attempts < n) {
    idx = (idx + 1) % n;
    attempts++;
  }
  return idx;
}

function checkWinner(room) {
  const alive = room.players.filter(p => p.isAlive);
  if (alive.length === 1) return alive[0];
  // Also win if you emptied your hand
  const empty = room.players.find(p => p.isAlive && p.hand.length === 0);
  return empty || null;
}

function emitRoomState(io, room) {
  // Send each player their own hand, others get card counts only
  room.players.forEach(player => {
    const socketId = player.socketId;
    if (!socketId) return;

    const playersView = room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isAlive: p.isAlive,
      cardCount: p.hand.length,
      // Only send own hand
      hand: p.id === player.id ? p.hand : [],
    }));

    io.to(socketId).emit('bluff_state', {
      roomCode: room.roomCode,
      status: room.status,
      players: playersView,
      currentPlayerIndex: room.currentPlayerIndex,
      currentPlayer: room.players[room.currentPlayerIndex],
      lastClaim: room.lastClaim,
      pileCount: room.pile.length,
      settings: room.settings,
      winner: room.winner,
      log: room.log.slice(-20),
    });
  });

  // Also emit to spectators (they get no hand info)
  io.to(`spectate:${room.roomCode}`).emit('bluff_state', {
    roomCode: room.roomCode,
    status: room.status,
    players: room.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost,
      isAlive: p.isAlive, cardCount: p.hand.length, hand: [],
    })),
    currentPlayerIndex: room.currentPlayerIndex,
    currentPlayer: room.players[room.currentPlayerIndex],
    lastClaim: room.lastClaim,
    pileCount: room.pile.length,
    settings: room.settings,
    winner: room.winner,
    log: room.log.slice(-20),
  });
}

module.exports = (io) => {
  // ── Create Room ────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {

    socket.on('bluff_create_room', ({ playerName, playerId, settings }) => {
      try {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        const stableId = playerId || socket.id;
        const room = createBluffRoom(roomCode, stableId, playerName || 'Player 1', settings);
        room.players[0].socketId = socket.id;

        bluffRooms.set(roomCode, room);
        socket.join(roomCode);

        logger.info('[Bluff] Room created', { roomCode, host: playerName });
        socket.emit('bluff_room_created', { roomCode, playerId: stableId });
        emitRoomState(io, room);
      } catch (err) {
        logger.error('[Bluff] create_room error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to create room' });
      }
    });

    // ── Join Room ────────────────────────────────────────────────────────────
    socket.on('bluff_join_room', ({ roomCode, playerName, playerId }) => {
      try {
        const room = bluffRooms.get(roomCode?.toUpperCase());
        if (!room) return socket.emit('bluff_error', { message: 'Room not found' });
        if (room.status !== 'waiting') return socket.emit('bluff_error', { message: 'Game already in progress' });
        if (room.players.length >= room.settings.maxPlayers) return socket.emit('bluff_error', { message: 'Room is full' });

        const stableId = playerId || socket.id;
        // Prevent duplicate join
        if (room.players.find(p => p.id === stableId)) {
          // Reconnect — update socketId
          const p = room.players.find(p => p.id === stableId);
          p.socketId = socket.id;
          socket.join(roomCode.toUpperCase());
          socket.emit('bluff_room_joined', { roomCode: room.roomCode, playerId: stableId });
          emitRoomState(io, room);
          return;
        }

        room.players.push({
          id: stableId,
          name: playerName || `Player ${room.players.length + 1}`,
          isHost: false,
          socketId: socket.id,
          hand: [],
          cardCount: 0,
          isAlive: true,
        });

        socket.join(roomCode.toUpperCase());
        addLog(room, 'join', `${playerName} joined`);
        logger.info('[Bluff] Player joined', { roomCode, player: playerName, total: room.players.length });

        socket.emit('bluff_room_joined', { roomCode: room.roomCode, playerId: stableId });
        emitRoomState(io, room);
        io.to(room.roomCode).emit('bluff_player_joined', { playerName, playerCount: room.players.length });
      } catch (err) {
        logger.error('[Bluff] join_room error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to join room' });
      }
    });

    // ── Check Room (for JoinPage) ────────────────────────────────────────────
    socket.on('bluff_check_room', ({ roomCode }) => {
      const room = bluffRooms.get(roomCode?.toUpperCase());
      if (!room) return socket.emit('bluff_check_result', { exists: false });
      socket.emit('bluff_check_result', {
        exists: true,
        joinable: room.status === 'waiting' && room.players.length < room.settings.maxPlayers,
        status: room.status,
        playerCount: room.players.length,
      });
    });

    // ── Spectate ─────────────────────────────────────────────────────────────
    socket.on('bluff_spectate', ({ roomCode }) => {
      const room = bluffRooms.get(roomCode?.toUpperCase());
      if (!room) return socket.emit('bluff_error', { message: 'Room not found' });
      socket.join(`spectate:${roomCode.toUpperCase()}`);
      socket.emit('bluff_spectate_joined', { roomCode: room.roomCode, status: room.status });
      emitRoomState(io, room);
    });

    // ── Update Settings ──────────────────────────────────────────────────────
    socket.on('bluff_update_settings', ({ roomCode, settings }) => {
      const room = bluffRooms.get(roomCode);
      if (!room) return;
      const host = room.players.find(p => p.socketId === socket.id && p.isHost);
      if (!host) return socket.emit('bluff_error', { message: 'Only host can change settings' });
      room.settings = { ...room.settings, ...settings };
      emitRoomState(io, room);
    });

    // ── Start Game ───────────────────────────────────────────────────────────
    socket.on('bluff_start_game', ({ roomCode }) => {
      try {
        const room = bluffRooms.get(roomCode);
        if (!room) return socket.emit('bluff_error', { message: 'Room not found' });
        const host = room.players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return socket.emit('bluff_error', { message: 'Only host can start' });
        if (room.players.length < 2) return socket.emit('bluff_error', { message: 'Need at least 2 players' });

        // Deal cards
        const hands = dealCards(room.players.length);
        room.players.forEach((p, i) => {
          p.hand = hands[i];
          p.isAlive = true;
        });

        room.status = 'playing';
        room.currentPlayerIndex = 0;
        room.pile = [];
        room.lastClaim = null;
        room.lastPlayedCards = [];
        room.passCount = 0;
        room.winner = null;
        room.log = [];
        addLog(room, 'start', 'Game started! Cards have been dealt.');

        logger.info('[Bluff] Game started', { roomCode, players: room.players.map(p => p.name) });
        emitRoomState(io, room);
        io.to(roomCode).emit('bluff_game_started', { firstPlayer: room.players[0].name });
      } catch (err) {
        logger.error('[Bluff] start_game error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to start game' });
      }
    });

    // ── Play Cards ───────────────────────────────────────────────────────────
    // Player places cards face-down and claims they are all of a certain rank
    socket.on('bluff_play_cards', ({ roomCode, cardIds, claimedRank }) => {
      try {
        const room = bluffRooms.get(roomCode);
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentPlayerIndex];
        if (currentPlayer.socketId !== socket.id) {
          return socket.emit('bluff_error', { message: "It's not your turn!" });
        }
        if (!cardIds?.length) return socket.emit('bluff_error', { message: 'Select at least 1 card' });
        if (!RANKS.includes(claimedRank)) return socket.emit('bluff_error', { message: 'Invalid rank claimed' });

        // Enforce rank must be >= last claimed rank (if pile not empty)
        if (room.lastClaim) {
          const RANK_ORDER = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
          if (RANK_ORDER[claimedRank] < RANK_ORDER[room.lastClaim.rank]) {
            return socket.emit('bluff_error', { message: `Must claim rank ≥ ${room.lastClaim.rank}` });
          }
        }

        // Find cards in player's hand
        const playedCards = cardIds.map(id => currentPlayer.hand.find(c => c.id === id)).filter(Boolean);
        if (playedCards.length !== cardIds.length) {
          return socket.emit('bluff_error', { message: 'Invalid cards selected' });
        }

        // Remove from hand
        currentPlayer.hand = currentPlayer.hand.filter(c => !cardIds.includes(c.id));

        // Add to pile (face down)
        room.pile.push(...playedCards);
        room.lastPlayedCards = playedCards;
        room.lastClaim = {
          playerId: currentPlayer.id,
          playerName: currentPlayer.name,
          count: playedCards.length,
          rank: claimedRank,
        };
        room.passCount = 0;

        addLog(room, 'play', `${currentPlayer.name} played ${playedCards.length} card${playedCards.length > 1 ? 's' : ''}, claiming ${playedCards.length}× ${claimedRank}`);
        logger.info('[Bluff] Cards played', { roomCode, player: currentPlayer.name, count: playedCards.length, claimed: claimedRank });

        // Check win condition — empty hand
        if (currentPlayer.hand.length === 0) {
          room.winner = currentPlayer;
          room.status = 'finished';
          addLog(room, 'win', `🏆 ${currentPlayer.name} played their last card and wins!`);
          logger.info('[Bluff] Game over — hand empty', { roomCode, winner: currentPlayer.name });
          emitRoomState(io, room);
          io.to(roomCode).emit('bluff_game_over', { winner: currentPlayer, players: room.players });
          return;
        }

        // Advance turn
        room.currentPlayerIndex = nextAliveIndex(room, room.currentPlayerIndex);
        emitRoomState(io, room);
        io.to(roomCode).emit('bluff_cards_played', {
          playerName: currentPlayer.name,
          count: playedCards.length,
          claimedRank,
        });
      } catch (err) {
        logger.error('[Bluff] play_cards error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to play cards' });
      }
    });

    // ── Challenge ────────────────────────────────────────────────────────────
    socket.on('bluff_challenge', ({ roomCode }) => {
      try {
        const room = bluffRooms.get(roomCode);
        if (!room || room.status !== 'playing') return;
        if (!room.lastClaim) return socket.emit('bluff_error', { message: 'Nothing to challenge' });

        const challenger = room.players.find(p => p.socketId === socket.id);
        if (!challenger) return;
        if (challenger.id === room.lastClaim.playerId) {
          return socket.emit('bluff_error', { message: "You can't challenge your own play" });
        }

        const claimedPlayer = room.players.find(p => p.id === room.lastClaim.playerId);
        const bluff = wasBluff(room.lastPlayedCards, room.lastClaim.rank);
        const loser = bluff ? claimedPlayer : challenger;

        // Loser picks up the whole pile
        loser.hand.push(...room.pile);

        const revealInfo = room.lastPlayedCards.map(c => c.id).join(', ');
        addLog(room, bluff ? 'caught' : 'safe',
          bluff
            ? `🎯 ${challenger.name} challenged! ${claimedPlayer.name} was BLUFFING (played ${revealInfo}). ${claimedPlayer.name} picks up ${room.pile.length} cards!`
            : `😤 ${challenger.name} challenged but ${claimedPlayer.name} was HONEST. ${challenger.name} picks up ${room.pile.length} cards!`
        );

        logger.info('[Bluff] Challenge resolved', { roomCode, challenger: challenger.name, bluff, loser: loser.name });

        // Emit reveal event to everyone
        io.to(roomCode).emit('bluff_challenge_result', {
          challengerName: challenger.name,
          claimedPlayerName: claimedPlayer.name,
          claimedRank: room.lastClaim.rank,
          actualCards: room.lastPlayedCards,
          wasBluff: bluff,
          loserName: loser.name,
          pileCount: room.pile.length,
        });

        // Reset pile
        room.pile = [];
        room.lastClaim = null;
        room.lastPlayedCards = [];
        room.passCount = 0;

        // Loser goes next
        room.currentPlayerIndex = room.players.findIndex(p => p.id === loser.id);

        // Check win condition after challenge (loser might have just emptied)
        const winner = checkWinner(room);
        if (winner) {
          room.winner = winner;
          room.status = 'finished';
          addLog(room, 'win', `🏆 ${winner.name} wins!`);
          emitRoomState(io, room);
          io.to(roomCode).emit('bluff_game_over', { winner, players: room.players });
          return;
        }

        emitRoomState(io, room);
      } catch (err) {
        logger.error('[Bluff] challenge error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to process challenge' });
      }
    });

    // ── Pass ─────────────────────────────────────────────────────────────────
    socket.on('bluff_pass', ({ roomCode }) => {
      try {
        const room = bluffRooms.get(roomCode);
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentPlayerIndex];
        if (currentPlayer.socketId !== socket.id) {
          return socket.emit('bluff_error', { message: "It's not your turn!" });
        }
        if (!room.lastClaim) {
          return socket.emit('bluff_error', { message: "Can't pass on the first turn — you must play cards" });
        }

        room.passCount++;
        addLog(room, 'pass', `${currentPlayer.name} passed`);

        // If everyone alive has passed (except the last player who played), clear the pile
        const alivePlayers = room.players.filter(p => p.isAlive).length;
        if (room.passCount >= alivePlayers - 1) {
          addLog(room, 'clear', 'All players passed — pile cleared! New round starts.');
          room.pile = [];
          room.lastClaim = null;
          room.lastPlayedCards = [];
          room.passCount = 0;
          io.to(roomCode).emit('bluff_pile_cleared', {});
        }

        room.currentPlayerIndex = nextAliveIndex(room, room.currentPlayerIndex);
        emitRoomState(io, room);
        io.to(roomCode).emit('bluff_passed', { playerName: currentPlayer.name });
      } catch (err) {
        logger.error('[Bluff] pass error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to pass' });
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      bluffRooms.forEach((room, roomCode) => {
        const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
        if (playerIdx === -1) return;

        const player = room.players[playerIdx];
        const wasHost = player.isHost;
        logger.info('[Bluff] Player disconnected', { roomCode, player: player.name });

        if (room.status === 'waiting') {
          // Remove from room entirely
          room.players.splice(playerIdx, 1);
          if (room.players.length === 0) { bluffRooms.delete(roomCode); return; }
          if (wasHost) room.players[0].isHost = true;
          addLog(room, 'leave', `${player.name} left`);
          io.to(roomCode).emit('bluff_player_left', { playerName: player.name, players: room.players });
        } else if (room.status === 'playing') {
          // Mark as disconnected / out but keep in game state for continuity
          player.isAlive = false;
          player.hand = []; // cards go to void (house rule — keeps game moving)
          addLog(room, 'leave', `${player.name} disconnected and is out`);

          const winner = checkWinner(room);
          if (winner) {
            room.winner = winner;
            room.status = 'finished';
            addLog(room, 'win', `🏆 ${winner.name} wins!`);
            io.to(roomCode).emit('bluff_game_over', { winner, players: room.players });
          } else {
            // If it was their turn, advance
            if (room.currentPlayerIndex === playerIdx) {
              room.currentPlayerIndex = nextAliveIndex(room, playerIdx);
            }
          }
        }
        emitRoomState(io, room);
      });
    });
  });

  // Cleanup empty rooms every 30 minutes
  setInterval(() => {
    const now = Date.now();
    bluffRooms.forEach((room, code) => {
      const old = room.log[0]?.ts || now;
      if (now - old > 2 * 60 * 60 * 1000) { // 2 hours
        bluffRooms.delete(code);
        logger.info('[Bluff] Room auto-cleaned', { roomCode: code });
      }
    });
  }, 30 * 60 * 1000);
};
