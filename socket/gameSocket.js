const Room = require('../models/Room');
const { generateSubstring, isValidWord } = require('../utils/wordUtils');

const activeTimers = {}; // roomCode -> timer interval

function clearRoomTimer(roomCode) {
  if (activeTimers[roomCode]) {
    clearTimeout(activeTimers[roomCode]);
    delete activeTimers[roomCode];
  }
}

function startTurnTimer(io, roomCode, duration) {
  clearRoomTimer(roomCode);
  activeTimers[roomCode] = setTimeout(async () => {
    try {
      const room = await Room.findOne({ roomCode });
      if (!room || room.status !== 'playing') return;

      const currentPlayer = room.players[room.currentPlayerIndex];
      if (!currentPlayer || !currentPlayer.isAlive) return;

      // Deduct a life
      currentPlayer.lives -= 1;
      if (currentPlayer.lives <= 0) {
        currentPlayer.isAlive = false;
        currentPlayer.lives = 0;
      }

      io.to(roomCode).emit('time_up', {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        livesLeft: currentPlayer.lives,
        isEliminated: !currentPlayer.isAlive,
      });

      // Check if game over
      const alivePlayers = room.players.filter(p => p.isAlive);
      if (alivePlayers.length <= 1) {
        room.status = 'finished';
        await room.save();
        io.to(roomCode).emit('game_over', {
          winner: alivePlayers[0] || null,
          players: room.players,
        });
        return;
      }

      // Move to next alive player
      await advanceTurn(io, room);
    } catch (err) {
      console.error('Timer error:', err);
    }
  }, duration * 1000);
}

async function advanceTurn(io, room) {
  const alivePlayers = room.players.filter(p => p.isAlive);
  if (alivePlayers.length === 0) return;

  // Find next alive player
  let nextIndex = (room.currentPlayerIndex + 1) % room.players.length;
  let attempts = 0;
  while (!room.players[nextIndex].isAlive && attempts < room.players.length) {
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
  }

  room.currentPlayerIndex = nextIndex;
  room.currentSubstring = generateSubstring();
  await room.save();

  const currentPlayer = room.players[nextIndex];
  io.to(room.roomCode).emit('next_turn', {
    currentPlayer: currentPlayer,
    substring: room.currentSubstring,
    players: room.players,
    timerDuration: room.settings.turnTimer,
  });

  startTurnTimer(io, room.roomCode, room.settings.turnTimer);
}

module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log('Socket connected:', socket.id);

    // Create Room
    socket.on('create_room', async ({ playerName, settings, playerId }) => {
      try {
        const roomCode = Math.random().toString(36).substring(2, 7).toUpperCase();
        const stableId = playerId || socket.id; // use client-provided stable ID
        const room = new Room({
          roomCode,
          settings: {
            maxLives: settings?.maxLives || 3,
            turnTimer: settings?.turnTimer || 15,
            maxPlayers: settings?.maxPlayers || 8,
          },
          players: [{
            id: stableId,
            name: playerName || 'Player 1',
            lives: settings?.maxLives || 3,
            isAlive: true,
            isHost: true,
            socketId: socket.id,
          }],
        });
        await room.save();
        socket.join(roomCode);
        socket.emit('room_created', { roomCode, room, playerId: stableId });
      } catch (err) {
        socket.emit('error', { message: 'Failed to create room' });
      }
    });

    // Join Room
    socket.on('join_room', async ({ roomCode, playerName, playerId }) => {
      try {
        const room = await Room.findOne({ roomCode: roomCode.toUpperCase() });
        if (!room) return socket.emit('error', { message: 'Room not found' });
        if (room.status !== 'waiting') return socket.emit('error', { message: 'Game already in progress' });
        if (room.players.length >= room.settings.maxPlayers) return socket.emit('error', { message: 'Room is full' });

        const stableId = playerId || socket.id;
        const newPlayer = {
          id: stableId,
          name: playerName || `Player ${room.players.length + 1}`,
          lives: room.settings.maxLives,
          isAlive: true,
          isHost: false,
          socketId: socket.id,
        };
        room.players.push(newPlayer);
        await room.save();
        socket.join(roomCode.toUpperCase());
        socket.emit('room_joined', { roomCode: room.roomCode, room, playerId: stableId });
        io.to(room.roomCode).emit('player_joined', { player: newPlayer, players: room.players });
      } catch (err) {
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    // Update Settings (host only)
    socket.on('update_settings', async ({ roomCode, settings }) => {
      try {
        const room = await Room.findOne({ roomCode });
        if (!room) return;
        const host = room.players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return socket.emit('error', { message: 'Only host can change settings' });

        room.settings = { ...room.settings.toObject(), ...settings };
        room.players = room.players.map(p => ({ ...p.toObject(), lives: room.settings.maxLives }));
        await room.save();
        io.to(roomCode).emit('settings_updated', { settings: room.settings, players: room.players });
      } catch (err) {
        socket.emit('error', { message: 'Failed to update settings' });
      }
    });

    // Start Game (host only)
    socket.on('start_game', async ({ roomCode }) => {
      try {
        const room = await Room.findOne({ roomCode });
        if (!room) return;
        const host = room.players.find(p => p.socketId === socket.id && p.isHost);
        if (!host) return socket.emit('error', { message: 'Only host can start the game' });
        if (room.players.length < 2) return socket.emit('error', { message: 'Need at least 2 players to start' });

        room.status = 'playing';
        room.currentPlayerIndex = 0;
        room.currentSubstring = generateSubstring();
        room.usedWords = [];
        await room.save();

        io.to(roomCode).emit('game_started', {
          currentPlayer: room.players[0],
          substring: room.currentSubstring,
          players: room.players,
          timerDuration: room.settings.turnTimer,
        });

        startTurnTimer(io, roomCode, room.settings.turnTimer);
      } catch (err) {
        socket.emit('error', { message: 'Failed to start game' });
      }
    });

    // Submit Word
    socket.on('submit_word', async ({ roomCode, word }) => {
      try {
        const room = await Room.findOne({ roomCode });
        if (!room || room.status !== 'playing') return;

        const currentPlayer = room.players[room.currentPlayerIndex];
        if (!currentPlayer || currentPlayer.socketId !== socket.id) {
          return socket.emit('error', { message: "It's not your turn!" });
        }

        const w = word.toLowerCase().trim();

        // Check if word was already used
        if (room.usedWords.includes(w)) {
          return socket.emit('word_result', { success: false, reason: 'Word already used!' });
        }

        // Validate word
        if (!isValidWord(w, room.currentSubstring)) {
          return socket.emit('word_result', { success: false, reason: `"${w}" doesn't contain "${room.currentSubstring}" or isn't a valid word` });
        }

        clearRoomTimer(roomCode);
        room.usedWords.push(w);
        await room.save();

        io.to(roomCode).emit('word_accepted', {
          playerId: currentPlayer.id,
          playerName: currentPlayer.name,
          word: w,
          substring: room.currentSubstring,
        });

        await advanceTurn(io, room);
      } catch (err) {
        socket.emit('error', { message: 'Failed to submit word' });
      }
    });

    // Disconnect
    socket.on('disconnect', async () => {
      try {
        const rooms = await Room.find({ 'players.socketId': socket.id });
        for (const room of rooms) {
          const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
          if (playerIdx === -1) continue;

          const wasHost = room.players[playerIdx].isHost;
          const playerName = room.players[playerIdx].name;
          room.players.splice(playerIdx, 1);

          if (room.players.length === 0) {
            clearRoomTimer(room.roomCode);
            await Room.deleteOne({ _id: room._id });
            continue;
          }

          // Assign new host if needed
          if (wasHost && room.players.length > 0) {
            room.players[0].isHost = true;
          }

          if (room.status === 'playing') {
            const alivePlayers = room.players.filter(p => p.isAlive);
            if (alivePlayers.length <= 1) {
              room.status = 'finished';
              await room.save();
              io.to(room.roomCode).emit('game_over', {
                winner: alivePlayers[0] || null,
                players: room.players,
              });
              clearRoomTimer(room.roomCode);
              continue;
            }
          }

          await room.save();
          io.to(room.roomCode).emit('player_left', { playerName, players: room.players });
        }
      } catch (err) {
        console.error('Disconnect error:', err);
      }
    });
  });
};
