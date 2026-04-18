const Room = require('../models/Room');
const { dealCards, wasBluff, createBluffRoom, RANKS, RANK_ORDER } = require('../utils/cardUtils');
const logger = require('../utils/logger');

function normalizeCode(roomCode) {
  return roomCode?.toUpperCase();
}

function getHand(player) {
  return Array.isArray(player?.hand) ? player.hand : [];
}

function syncPlayerCardCounts(room) {
  room.players.forEach(player => {
    player.cardCount = getHand(player).length;
  });
}

function addLog(room, type, msg) {
  room.log.push({ type, msg, ts: Date.now() });
  if (room.log.length > 60) room.log.shift();
}

function markBluffStateModified(room) {
  room.markModified('players');
  room.markModified('pile');
  room.markModified('lastClaim');
  room.markModified('lastPlayedCards');
  room.markModified('winner');
  room.markModified('log');
  room.markModified('settings');
}

async function saveBluffRoom(room) {
  syncPlayerCardCounts(room);
  markBluffStateModified(room);
  await room.save();
}

function nextAliveIndex(room, fromIndex) {
  const n = room.players.length;
  let idx = (fromIndex + 1) % n;
  let attempts = 0;
  while (!room.players[idx]?.isAlive && attempts < n) {
    idx = (idx + 1) % n;
    attempts++;
  }
  return idx;
}

function checkWinner(room) {
  const alive = room.players.filter(p => p.isAlive);
  if (alive.length === 1) return alive[0];

  const empty = room.players.find(p => p.isAlive && getHand(p).length === 0);
  return empty || null;
}

async function findBluffRoom(roomCode) {
  return Room.findOne({ roomCode: normalizeCode(roomCode), game: 'cardsbluff' });
}

function emitRoomState(io, room) {
  syncPlayerCardCounts(room);

  room.players.forEach(player => {
    const socketId = player.socketId;
    if (!socketId) return;

    const playersView = room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isAlive: p.isAlive,
      cardCount: getHand(p).length,
      hand: p.id === player.id ? getHand(p) : [],
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

  io.to(`spectate:${room.roomCode}`).emit('bluff_state', {
    roomCode: room.roomCode,
    status: room.status,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      isAlive: p.isAlive,
      cardCount: getHand(p).length,
      hand: [],
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
  io.on('connection', (socket) => {
    socket.on('bluff_create_room', async ({ playerName, playerId, settings }) => {
      try {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        const stableId = playerId || socket.id;
        const roomData = createBluffRoom(roomCode, stableId, playerName || 'Player 1', settings);
        roomData.players[0].socketId = socket.id;
        roomData.settings = {
          maxLives: settings?.maxLives || 3,
          turnTimer: settings?.turnTimer || 15,
          maxPlayers: settings?.maxPlayers || roomData.settings.maxPlayers || 6,
          startingCards: settings?.startingCards || null,
        };

        const room = new Room(roomData);
        await saveBluffRoom(room);
        socket.join(roomCode);

        logger.info('[Bluff] Room created and saved', { roomCode, host: playerName });
        socket.emit('bluff_room_created', { roomCode, playerId: stableId });
        emitRoomState(io, room);
      } catch (err) {
        logger.error('[Bluff] create_room error', { error: err.message, stack: err.stack });
        socket.emit('bluff_error', { message: 'Failed to create room' });
      }
    });

    socket.on('bluff_join_room', async ({ roomCode, playerName, playerId }) => {
      try {
        const code = normalizeCode(roomCode);
        const room = await findBluffRoom(code);
        if (!room) return socket.emit('bluff_error', { message: 'Room not found' });

        const stableId = playerId || socket.id;
        const existingPlayer = room.players.find(p => p.id === stableId);
        if (existingPlayer) {
          existingPlayer.socketId = socket.id;
          socket.join(code);
          await saveBluffRoom(room);
          socket.emit('bluff_room_joined', { roomCode: room.roomCode, playerId: stableId });
          emitRoomState(io, room);
          return;
        }

        if (room.status !== 'waiting') return socket.emit('bluff_error', { message: 'Game already in progress' });
        if (room.players.length >= room.settings.maxPlayers) return socket.emit('bluff_error', { message: 'Room is full' });

        room.players.push({
          id: stableId,
          name: playerName || `Player ${room.players.length + 1}`,
          isHost: false,
          socketId: socket.id,
          hand: [],
          cardCount: 0,
          isAlive: true,
        });

        socket.join(code);
        addLog(room, 'join', `${playerName || 'A player'} joined`);
        await saveBluffRoom(room);

        logger.info('[Bluff] Player joined', { roomCode: code, player: playerName, total: room.players.length });
        socket.emit('bluff_room_joined', { roomCode: room.roomCode, playerId: stableId });
        emitRoomState(io, room);
        io.to(room.roomCode).emit('bluff_player_joined', { playerName, playerCount: room.players.length });
      } catch (err) {
        logger.error('[Bluff] join_room error', { error: err.message, stack: err.stack });
        socket.emit('bluff_error', { message: 'Failed to join room' });
      }
    });

    socket.on('bluff_check_room', async ({ roomCode }) => {
      try {
        const room = await findBluffRoom(roomCode);
        if (!room) return socket.emit('bluff_check_result', { exists: false });

        socket.emit('bluff_check_result', {
          exists: true,
          joinable: room.status === 'waiting' && room.players.length < room.settings.maxPlayers,
          status: room.status,
          playerCount: room.players.length,
        });
      } catch (err) {
        logger.error('[Bluff] check_room error', { error: err.message });
        socket.emit('bluff_check_result', { exists: false });
      }
    });

    socket.on('bluff_spectate', async ({ roomCode }) => {
      try {
        const code = normalizeCode(roomCode);
        const room = await findBluffRoom(code);
        if (!room) return socket.emit('bluff_error', { message: 'Room not found' });

        socket.join(`spectate:${code}`);
        socket.emit('bluff_spectate_joined', { roomCode: room.roomCode, status: room.status });
        emitRoomState(io, room);
      } catch (err) {
        logger.error('[Bluff] spectate error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to spectate room' });
      }
    });

    socket.on('bluff_update_settings', async ({ roomCode, settings }) => {
      try {
        const room = await findBluffRoom(roomCode);
        if (!room) return;

        const host = room.players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return socket.emit('bluff_error', { message: 'Only host can change settings' });

        room.settings = { ...room.settings.toObject(), ...settings };
        await saveBluffRoom(room);
        emitRoomState(io, room);
      } catch (err) {
        logger.error('[Bluff] update_settings error', { error: err.message });
        socket.emit('bluff_error', { message: 'Failed to update settings' });
      }
    });

    socket.on('bluff_start_game', async ({ roomCode }) => {
      try {
        const code = normalizeCode(roomCode);
        const room = await findBluffRoom(code);
        if (!room) return socket.emit('bluff_error', { message: 'Room not found' });

        const host = room.players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return socket.emit('bluff_error', { message: 'Only host can start' });
        if (room.players.length < 2) return socket.emit('bluff_error', { message: 'Need at least 2 players' });

        const hands = dealCards(room.players.length);
        room.players.forEach((p, i) => {
          p.hand = hands[i];
          p.cardCount = hands[i].length;
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

        await saveBluffRoom(room);
        logger.info('[Bluff] Game started', { roomCode: code, players: room.players.map(p => p.name) });
        emitRoomState(io, room);
        io.to(code).emit('bluff_game_started', { firstPlayer: room.players[0].name });
      } catch (err) {
        logger.error('[Bluff] start_game error', { error: err.message, stack: err.stack });
        socket.emit('bluff_error', { message: 'Failed to start game' });
      }
    });

    socket.on('bluff_play_cards', async ({ roomCode, cardIds, claimedRank }) => {
      try {
        const code = normalizeCode(roomCode);
        const room = await findBluffRoom(code);
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentPlayerIndex];
        if (currentPlayer.socketId !== socket.id) {
          return socket.emit('bluff_error', { message: "It's not your turn!" });
        }
        if (!cardIds?.length) return socket.emit('bluff_error', { message: 'Select at least 1 card' });
        if (!RANKS.includes(claimedRank)) return socket.emit('bluff_error', { message: 'Invalid rank claimed' });

        if (room.lastClaim && RANK_ORDER[claimedRank] < RANK_ORDER[room.lastClaim.rank]) {
          return socket.emit('bluff_error', { message: `Must claim rank >= ${room.lastClaim.rank}` });
        }

        const hand = getHand(currentPlayer);
        const playedCards = cardIds.map(id => hand.find(c => c.id === id)).filter(Boolean);
        if (playedCards.length !== cardIds.length) {
          return socket.emit('bluff_error', { message: 'Invalid cards selected' });
        }

        currentPlayer.hand = hand.filter(c => !cardIds.includes(c.id));
        room.pile.push(...playedCards);
        room.lastPlayedCards = playedCards;
        room.lastClaim = {
          playerId: currentPlayer.id,
          playerName: currentPlayer.name,
          count: playedCards.length,
          rank: claimedRank,
        };
        room.passCount = 0;

        addLog(room, 'play', `${currentPlayer.name} played ${playedCards.length} card${playedCards.length > 1 ? 's' : ''}, claiming ${playedCards.length}x ${claimedRank}`);
        logger.info('[Bluff] Cards played', { roomCode: code, player: currentPlayer.name, count: playedCards.length, claimed: claimedRank });

        if (getHand(currentPlayer).length === 0) {
          room.winner = currentPlayer.toObject ? currentPlayer.toObject() : currentPlayer;
          room.status = 'finished';
          addLog(room, 'win', `${currentPlayer.name} played their last card and wins!`);
          await saveBluffRoom(room);
          emitRoomState(io, room);
          io.to(code).emit('bluff_game_over', { winner: room.winner, players: room.players });
          return;
        }

        room.currentPlayerIndex = nextAliveIndex(room, room.currentPlayerIndex);
        await saveBluffRoom(room);
        emitRoomState(io, room);
        io.to(code).emit('bluff_cards_played', {
          playerName: currentPlayer.name,
          count: playedCards.length,
          claimedRank,
        });
      } catch (err) {
        logger.error('[Bluff] play_cards error', { error: err.message, stack: err.stack });
        socket.emit('bluff_error', { message: 'Failed to play cards' });
      }
    });

    socket.on('bluff_challenge', async ({ roomCode }) => {
      try {
        const code = normalizeCode(roomCode);
        const room = await findBluffRoom(code);
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

        loser.hand = [...getHand(loser), ...room.pile];

        const revealInfo = room.lastPlayedCards.map(c => c.id).join(', ');
        addLog(room, bluff ? 'caught' : 'safe',
          bluff
            ? `${challenger.name} challenged! ${claimedPlayer.name} was bluffing (played ${revealInfo}). ${claimedPlayer.name} picks up ${room.pile.length} cards!`
            : `${challenger.name} challenged but ${claimedPlayer.name} was honest. ${challenger.name} picks up ${room.pile.length} cards!`
        );

        logger.info('[Bluff] Challenge resolved', { roomCode: code, challenger: challenger.name, bluff, loser: loser.name });
        io.to(code).emit('bluff_challenge_result', {
          challengerName: challenger.name,
          claimedPlayerName: claimedPlayer.name,
          claimedRank: room.lastClaim.rank,
          actualCards: room.lastPlayedCards,
          wasBluff: bluff,
          loserName: loser.name,
          pileCount: room.pile.length,
        });

        room.pile = [];
        room.lastClaim = null;
        room.lastPlayedCards = [];
        room.passCount = 0;
        room.currentPlayerIndex = room.players.findIndex(p => p.id === loser.id);

        const winner = checkWinner(room);
        if (winner) {
          room.winner = winner.toObject ? winner.toObject() : winner;
          room.status = 'finished';
          addLog(room, 'win', `${winner.name} wins!`);
          await saveBluffRoom(room);
          emitRoomState(io, room);
          io.to(code).emit('bluff_game_over', { winner: room.winner, players: room.players });
          return;
        }

        await saveBluffRoom(room);
        emitRoomState(io, room);
      } catch (err) {
        logger.error('[Bluff] challenge error', { error: err.message, stack: err.stack });
        socket.emit('bluff_error', { message: 'Failed to process challenge' });
      }
    });

    socket.on('bluff_pass', async ({ roomCode }) => {
      try {
        const code = normalizeCode(roomCode);
        const room = await findBluffRoom(code);
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentPlayerIndex];
        if (currentPlayer.socketId !== socket.id) {
          return socket.emit('bluff_error', { message: "It's not your turn!" });
        }
        if (!room.lastClaim) {
          return socket.emit('bluff_error', { message: "Can't pass on the first turn - you must play cards" });
        }

        room.passCount++;
        addLog(room, 'pass', `${currentPlayer.name} passed`);

        const alivePlayers = room.players.filter(p => p.isAlive).length;
        if (room.passCount >= alivePlayers - 1) {
          addLog(room, 'clear', 'All players passed - pile cleared! New round starts.');
          room.pile = [];
          room.lastClaim = null;
          room.lastPlayedCards = [];
          room.passCount = 0;
          io.to(code).emit('bluff_pile_cleared', {});
        }

        room.currentPlayerIndex = nextAliveIndex(room, room.currentPlayerIndex);
        await saveBluffRoom(room);
        emitRoomState(io, room);
        io.to(code).emit('bluff_passed', { playerName: currentPlayer.name });
      } catch (err) {
        logger.error('[Bluff] pass error', { error: err.message, stack: err.stack });
        socket.emit('bluff_error', { message: 'Failed to pass' });
      }
    });

    socket.on('disconnect', async () => {
      try {
        const rooms = await Room.find({ game: 'cardsbluff', 'players.socketId': socket.id });
        for (const room of rooms) {
          const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
          if (playerIdx === -1) continue;

          const player = room.players[playerIdx];
          const wasHost = player.isHost;
          logger.info('[Bluff] Player disconnected', { roomCode: room.roomCode, player: player.name });

          if (room.status === 'waiting') {
            room.players.splice(playerIdx, 1);
            if (room.players.length === 0) {
              await Room.deleteOne({ _id: room._id });
              logger.info('[Bluff] Empty room deleted', { roomCode: room.roomCode });
              continue;
            }

            if (wasHost) room.players[0].isHost = true;
            addLog(room, 'leave', `${player.name} left`);
            await saveBluffRoom(room);
            io.to(room.roomCode).emit('bluff_player_left', { playerName: player.name, players: room.players });
          } else if (room.status === 'playing') {
            player.isAlive = false;
            player.hand = [];
            addLog(room, 'leave', `${player.name} disconnected and is out`);

            const winner = checkWinner(room);
            if (winner) {
              room.winner = winner.toObject ? winner.toObject() : winner;
              room.status = 'finished';
              addLog(room, 'win', `${winner.name} wins!`);
              await saveBluffRoom(room);
              io.to(room.roomCode).emit('bluff_game_over', { winner: room.winner, players: room.players });
            } else {
              if (room.currentPlayerIndex === playerIdx) {
                room.currentPlayerIndex = nextAliveIndex(room, playerIdx);
              }
              await saveBluffRoom(room);
            }
          } else {
            player.socketId = null;
            await saveBluffRoom(room);
          }

          emitRoomState(io, room);
        }
      } catch (err) {
        logger.error('[Bluff] disconnect error', { socketId: socket.id, error: err.message, stack: err.stack });
      }
    });
  });
};
