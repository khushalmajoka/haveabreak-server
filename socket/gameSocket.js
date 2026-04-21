const Room = require("../models/Room");
const { generateSubstring, isValidWord } = require("../utils/wordUtils");
const logger = require("../utils/logger");
const validate = require("../utils/validate");
const { generateUniqueRoomCode } = require("../utils/roomUtils");

// ── Active timers — exported so index.js can clear them on graceful shutdown ──
const activeTimers = {}; // roomCode -> setTimeout handle
const processingSubmit = new Set(); // roomCode -> in-flight guard

// ── Timer helpers ─────────────────────────────────────────────────────────────

function clearRoomTimer(roomCode) {
  if (activeTimers[roomCode]) {
    clearTimeout(activeTimers[roomCode]);
    delete activeTimers[roomCode];
    logger.debug("Timer cleared", { roomCode });
  }
}

function startTurnTimer(io, roomCode, duration) {
  clearRoomTimer(roomCode);
  logger.debug("Timer started", { roomCode, duration });

  activeTimers[roomCode] = setTimeout(async () => {
    try {
      const room = await Room.findOne({ roomCode, game: "wordbomb" });
      if (!room || room.status !== "playing") return;

      const currentPlayer = room.players[room.currentPlayerIndex];
      if (!currentPlayer || !currentPlayer.isAlive) return;

      currentPlayer.lives -= 1;
      if (currentPlayer.lives <= 0) {
        currentPlayer.isAlive = false;
        currentPlayer.lives = 0;
      }

      logger.warn("Time up — life deducted", {
        roomCode,
        player: currentPlayer.name,
        livesLeft: currentPlayer.lives,
        isEliminated: !currentPlayer.isAlive,
      });

      io.to(roomCode).emit("time_up", {
        playerId: currentPlayer.id,
        playerName: currentPlayer.name,
        livesLeft: currentPlayer.lives,
        isEliminated: !currentPlayer.isAlive,
      });

      const alivePlayers = room.players.filter((p) => p.isAlive);
      if (alivePlayers.length <= 1) {
        room.status = "finished";
        await room.save();
        logger.info("Game over — last player standing", {
          roomCode,
          winner: alivePlayers[0]?.name || "none",
        });
        io.to(roomCode).emit("game_over", {
          winner: alivePlayers[0] || null,
          players: room.players,
        });
        return;
      }

      await advanceTurn(io, room);
    } catch (err) {
      logger.error("Timer callback error", {
        roomCode,
        error: err.message,
        stack: err.stack,
      });
    }
  }, duration * 1000);
}

async function advanceTurn(io, room) {
  const alivePlayers = room.players.filter((p) => p.isAlive);
  if (alivePlayers.length === 0) return;

  let nextIndex = (room.currentPlayerIndex + 1) % room.players.length;
  let attempts = 0;
  while (!room.players[nextIndex].isAlive && attempts < room.players.length) {
    nextIndex = (nextIndex + 1) % room.players.length;
    attempts++;
  }

  room.currentPlayerIndex = nextIndex;
  room.currentSubstring = generateSubstring();
  room.turnStartedAt = new Date();
  await room.save();

  const currentPlayer = room.players[nextIndex];
  logger.info("Turn advanced", {
    roomCode: room.roomCode,
    player: currentPlayer.name,
    substring: room.currentSubstring,
    timerDuration: room.settings.turnTimer,
  });

  io.to(room.roomCode).emit("next_turn", {
    currentPlayer,
    substring: room.currentSubstring,
    players: room.players,
    timerDuration: room.settings.turnTimer,
  });

  startTurnTimer(io, room.roomCode, room.settings.turnTimer);
}

// ── Room code generator with retry on duplicate key ───────────────────────────
async function generateRoomCode(maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const roomCode = await generateUniqueRoomCode("wordbomb");
    const existing = await Room.findOne({
      roomCode: roomCode,
      game: "wordbomb",
    });
    if (!existing) return roomCode;
  }
  throw new Error(
    "Could not generate a unique room code after several attempts",
  );
}

// ── Startup recovery — restores timers for games active before a crash/restart
async function recoverActiveGames(io) {
  try {
    const activeRooms = await Room.find({
      status: "playing",
      game: "wordbomb",
    });

    if (activeRooms.length === 0) {
      logger.info("[Recovery] No active Word Bomb games to recover");
      return;
    }

    logger.info(
      `[Recovery] Found ${activeRooms.length} active game(s) — restoring timers`,
    );

    for (const room of activeRooms) {
      const turnDuration = room.settings.turnTimer; // seconds
      const startedAt = room.turnStartedAt
        ? new Date(room.turnStartedAt)
        : null;
      const now = Date.now();

      let remainingMs;

      if (!startedAt) {
        // turnStartedAt not set (game created before this fix was deployed)
        // Play it safe: give the current player a full fresh turn
        remainingMs = turnDuration * 1000;
        logger.warn("[Recovery] No turnStartedAt found — giving full turn", {
          roomCode: room.roomCode,
          player: room.players[room.currentPlayerIndex]?.name,
        });
      } else {
        const elapsedMs = now - startedAt.getTime();
        remainingMs = turnDuration * 1000 - elapsedMs;
      }

      if (remainingMs <= 0) {
        // Time already expired while server was down — advance turn immediately
        logger.info("[Recovery] Turn already expired — advancing immediately", {
          roomCode: room.roomCode,
          expiredMs: Math.abs(remainingMs),
        });
        await advanceTurn(io, room);
      } else {
        // Time still remaining — restart timer with the remaining duration
        const remainingSec = Math.ceil(remainingMs / 1000);
        logger.info("[Recovery] Restarting timer with remaining time", {
          roomCode: room.roomCode,
          remainingSec,
          player: room.players[room.currentPlayerIndex]?.name,
        });
        startTurnTimer(io, room.roomCode, remainingSec);
      }
    }
  } catch (err) {
    logger.error("[Recovery] Failed to recover active games", {
      error: err.message,
      stack: err.stack,
    });
  }
}

// ── Socket handlers ───────────────────────────────────────────────────────────

function registerGameSocket(io) {
  io.on("connection", (socket) => {
    logger.info("Socket connected", { socketId: socket.id });

    // ── Create Room ───────────────────────────────────────────────────────────
    socket.on("create_room", async (data = {}) => {
      try {
        // Validate input first — reject bad data immediately
        const v = validate.createRoom(data);
        if (!v.ok) {
          logger.warn("create_room rejected — invalid input", {
            reason: v.reason,
            socketId: socket.id,
          });
          return socket.emit("error", { message: v.reason });
        }

        const { playerName, settings, playerId } = data;
        const stableId =
          typeof playerId === "string" && playerId.length <= 64
            ? playerId
            : socket.id;
        const cleanName = playerName.trim();

        const roomCode = await generateRoomCode();
        logger.info("Creating room", {
          roomCode,
          host: cleanName,
          stableId,
          settings,
        });

        const room = new Room({
          roomCode,
          game: "wordbomb",
          settings: {
            maxLives: settings?.maxLives || 3,
            turnTimer: settings?.turnTimer || 15,
            maxPlayers: settings?.maxPlayers || 8,
          },
          players: [
            {
              id: stableId,
              name: cleanName,
              lives: settings?.maxLives || 3,
              isAlive: true,
              isHost: true,
              socketId: socket.id,
            },
          ],
        });

        await room.save();
        socket.join(roomCode);
        logger.info("Room created and saved", { roomCode, host: cleanName });
        socket.emit("room_created", { roomCode, room, playerId: stableId });
      } catch (err) {
        logger.error("create_room failed", {
          error: err.message,
          stack: err.stack,
        });
        socket.emit("error", { message: "Failed to create room" });
      }
    });

    // ── Join Room ─────────────────────────────────────────────────────────────
    socket.on("join_room", async (data = {}) => {
      try {
        const v = validate.joinRoom(data);
        if (!v.ok) {
          logger.warn("join_room rejected — invalid input", {
            reason: v.reason,
            socketId: socket.id,
          });
          return socket.emit("error", { message: v.reason });
        }

        const { playerName, playerId } = data;
        const roomCode = data.roomCode.toUpperCase();
        const stableId =
          typeof playerId === "string" && playerId.length <= 64
            ? playerId
            : socket.id;
        const cleanName = playerName.trim();

        logger.info("Join room attempt", {
          roomCode,
          playerName: cleanName,
          stableId,
        });

        const room = await Room.findOne({ roomCode, game: "wordbomb" });

        if (!room) {
          logger.warn("Join failed — room not found", { roomCode });
          return socket.emit("error", { message: "Room not found" });
        }

        // Reconnect: player already exists — refresh their socketId and re-subscribe
        const existingPlayer = room.players.find((p) => p.id === stableId);
        if (existingPlayer) {
          existingPlayer.socketId = socket.id;
          await room.save();
          socket.join(roomCode);
          logger.info("Player reconnected to room", {
            roomCode,
            player: existingPlayer.name,
            status: room.status,
          });
          return socket.emit("room_joined", {
            roomCode: room.roomCode,
            room,
            playerId: stableId,
          });
        }

        if (room.status !== "waiting") {
          logger.warn("Join failed — game in progress", {
            roomCode,
            status: room.status,
          });
          return socket.emit("error", { message: "Game already in progress" });
        }
        if (room.players.length >= room.settings.maxPlayers) {
          logger.warn("Join failed — room full", {
            roomCode,
            count: room.players.length,
          });
          return socket.emit("error", { message: "Room is full" });
        }

        const newPlayer = {
          id: stableId,
          name: cleanName,
          lives: room.settings.maxLives,
          isAlive: true,
          isHost: false,
          socketId: socket.id,
        };

        room.players.push(newPlayer);
        await room.save();
        socket.join(roomCode);

        logger.info("Player joined room", {
          roomCode,
          player: cleanName,
          totalPlayers: room.players.length,
        });
        socket.emit("room_joined", {
          roomCode: room.roomCode,
          room,
          playerId: stableId,
        });
        io.to(room.roomCode).emit("player_joined", {
          player: newPlayer,
          players: room.players,
        });
      } catch (err) {
        logger.error("join_room failed", {
          error: err.message,
          stack: err.stack,
        });
        socket.emit("error", { message: "Failed to join room" });
      }
    });

    // ── Spectate Room ─────────────────────────────────────────────────────────
    socket.on("spectate_room", async (data = {}) => {
      try {
        const v = validate.spectateRoom(data);
        if (!v.ok) {
          return socket.emit("error", { message: v.reason });
        }

        const roomCode = data.roomCode.toUpperCase();
        logger.info("Spectate room attempt", { roomCode, socketId: socket.id });

        const room = await Room.findOne({ roomCode, game: "wordbomb" });
        if (!room) {
          logger.warn("Spectate failed — room not found", { roomCode });
          return socket.emit("error", { message: "Room not found" });
        }

        socket.join(roomCode);
        socket.spectating = roomCode;
        logger.info("Spectator joined", { roomCode, roomStatus: room.status });
        socket.emit("spectate_joined", {
          roomCode: room.roomCode,
          status: room.status,
          players: room.players,
          currentSubstring: room.currentSubstring,
          currentPlayerIndex: room.currentPlayerIndex,
          settings: room.settings,
        });
      } catch (err) {
        logger.error("spectate_room failed", { error: err.message });
        socket.emit("error", { message: "Failed to spectate room" });
      }
    });

    // ── Update Settings (host only) ───────────────────────────────────────────
    socket.on("update_settings", async (data = {}) => {
      try {
        const v = validate.updateSettings(data);
        if (!v.ok) {
          return socket.emit("error", { message: v.reason });
        }

        const roomCode = data.roomCode.toUpperCase();
        const { settings } = data;

        const room = await Room.findOne({ roomCode, game: "wordbomb" });
        if (!room) return;

        const host = room.players.find(
          (p) => p.socketId === socket.id && p.isHost,
        );
        if (!host) {
          logger.warn("update_settings rejected — not host", {
            roomCode,
            socketId: socket.id,
          });
          return socket.emit("error", {
            message: "Only host can change settings",
          });
        }

        logger.info("Settings updated", {
          roomCode,
          newSettings: settings,
          by: host.name,
        });
        room.settings = { ...room.settings.toObject(), ...settings };
        room.players = room.players.map((p) => ({
          ...p.toObject(),
          lives: room.settings.maxLives,
        }));
        await room.save();
        io.to(roomCode).emit("settings_updated", {
          settings: room.settings,
          players: room.players,
        });
      } catch (err) {
        logger.error("update_settings failed", { error: err.message });
        socket.emit("error", { message: "Failed to update settings" });
      }
    });

    // ── Start Game (host only) ────────────────────────────────────────────────
    socket.on("start_game", async (data = {}) => {
      try {
        const v = validate.startGame(data);
        if (!v.ok) {
          return socket.emit("error", { message: v.reason });
        }

        const roomCode = data.roomCode.toUpperCase();
        const room = await Room.findOne({ roomCode, game: "wordbomb" });
        if (!room) return;

        const host = room.players.find(
          (p) => p.socketId === socket.id && p.isHost,
        );
        if (!host) {
          logger.warn("start_game rejected — not host", {
            roomCode,
            socketId: socket.id,
          });
          return socket.emit("error", {
            message: "Only host can start the game",
          });
        }
        if (room.players.length < 2) {
          logger.warn("start_game rejected — not enough players", {
            roomCode,
            count: room.players.length,
          });
          return socket.emit("error", {
            message: "Need at least 2 players to start",
          });
        }

        room.status = "playing";
        room.currentPlayerIndex = 0;
        room.currentSubstring = generateSubstring();
        room.usedWords = [];
        room.turnStartedAt = new Date();
        await room.save();

        logger.info("Game started", {
          roomCode,
          players: room.players.map((p) => p.name),
          firstSubstring: room.currentSubstring,
          settings: room.settings,
        });

        io.to(roomCode).emit("game_started", {
          currentPlayer: room.players[0],
          substring: room.currentSubstring,
          players: room.players,
          timerDuration: room.settings.turnTimer,
        });

        startTurnTimer(io, roomCode, room.settings.turnTimer);
      } catch (err) {
        logger.error("start_game failed", {
          error: err.message,
          stack: err.stack,
        });
        socket.emit("error", { message: "Failed to start game" });
      }
    });

    // ── Submit Word ───────────────────────────────────────────────────────────
    socket.on("submit_word", async (data = {}) => {
      try {
        // Input validation — catches 100,000-char words and garbage data
        const v = validate.submitWord(data);
        if (!v.ok) {
          logger.warn("submit_word rejected — invalid input", {
            reason: v.reason,
            socketId: socket.id,
          });
          return socket.emit("word_result", {
            success: false,
            reason: v.reason,
          });
        }

        const roomCode = data.roomCode.toUpperCase();
        const room = await Room.findOne({ roomCode, game: "wordbomb" });
        if (!room || room.status !== "playing") return;

        const currentPlayer = room.players[room.currentPlayerIndex];
        if (!currentPlayer || currentPlayer.socketId !== socket.id) {
          logger.warn("submit_word — not your turn", {
            roomCode,
            submittedBy: socket.id,
            expectedSocketId: currentPlayer?.socketId,
          });
          return socket.emit("error", { message: "It's not your turn!" });
        }

        const w = data.word.toLowerCase().trim();

        const usedSet = new Set(room.usedWords);
        if (usedSet.has(w)) {
          logger.debug("Word already used", {
            roomCode,
            word: w,
            player: currentPlayer.name,
          });
          return socket.emit("word_result", {
            success: false,
            reason: "Word already used!",
          });
        }

        if (!isValidWord(w, room.currentSubstring)) {
          logger.debug("Word invalid", {
            roomCode,
            word: w,
            substring: room.currentSubstring,
            player: currentPlayer.name,
          });
          return socket.emit("word_result", {
            success: false,
            reason: `"${w}" doesn't contain "${room.currentSubstring}" or isn't a valid word`,
          });
        }

        // Guard against double-submission race condition
        if (processingSubmit.has(roomCode)) {
          return socket.emit("word_result", {
            success: false,
            reason: "Please wait, processing your last word…",
          });
        }
        processingSubmit.add(roomCode);

        try {
          clearRoomTimer(roomCode);
          room.usedWords.push(w);
          await room.save();

          logger.info("Word accepted", {
            roomCode,
            player: currentPlayer.name,
            word: w,
            substring: room.currentSubstring,
            totalUsedWords: room.usedWords.length,
          });

          io.to(roomCode).emit("word_accepted", {
            playerId: currentPlayer.id,
            playerName: currentPlayer.name,
            word: w,
            substring: room.currentSubstring,
          });

          await advanceTurn(io, room);
        } finally {
          processingSubmit.delete(roomCode);
        }
      } catch (err) {
        logger.error("submit_word failed", {
          error: err.message,
          stack: err.stack,
        });
        socket.emit("error", { message: "Failed to submit word" });
      }
    });

    // Replaces the REST fetch in RoomPage — single source of truth for lobby state
    socket.on("get_room_state", async (data = {}) => {
      try {
        const v = validate.spectateRoom(data); // reuses roomCode validation
        if (!v.ok) return socket.emit("error", { message: v.reason });

        const roomCode = data.roomCode.toUpperCase();
        const room = await Room.findOne({ roomCode, game: "wordbomb" });
        if (!room) return socket.emit("error", { message: "Room not found" });

        socket.emit("room_state", { room });
      } catch (err) {
        logger.error("get_room_state failed", { error: err.message });
        socket.emit("error", { message: "Failed to fetch room state" });
      }
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
    // FIXED: Added game: 'wordbomb' filter so this handler only processes
    // Word Bomb rooms, not Cards Bluff rooms (which bluffSocket handles).
    socket.on("disconnect", async () => {
      logger.info("Socket disconnected", { socketId: socket.id });
      try {
        // KEY FIX: game filter added here
        const rooms = await Room.find({
          game: "wordbomb",
          "players.socketId": socket.id,
        });
        for (const room of rooms) {
          const playerIdx = room.players.findIndex(
            (p) => p.socketId === socket.id,
          );
          if (playerIdx === -1) continue;

          const wasHost = room.players[playerIdx].isHost;
          const playerName = room.players[playerIdx].name;
          const leavingPlayer = room.players[playerIdx];

          // During an active game: mark disconnected rather than splice,
          // so the player can reconnect and resume (socketId is refreshed on rejoin).
          // During waiting: remove them fully (they haven't started yet).
          if (room.status === "playing") {
            leavingPlayer.isAlive = false;
            leavingPlayer.socketId = null;
          } else {
            room.players.splice(playerIdx, 1);
          }

          logger.info("Player removed from room on disconnect", {
            roomCode: room.roomCode,
            player: playerName,
            wasHost,
            remainingPlayers: room.players.length,
          });

          if (room.players.length === 0) {
            clearRoomTimer(room.roomCode);
            await Room.deleteOne({ _id: room._id });
            logger.info("Empty room deleted", { roomCode: room.roomCode });
            continue;
          }

          if (wasHost && room.players.length > 0) {
            room.players[0].isHost = true;
            logger.info("New host assigned", {
              roomCode: room.roomCode,
              newHost: room.players[0].name,
            });
          }

          if (room.status === "playing") {
            const alivePlayers = room.players.filter((p) => p.isAlive);
            if (alivePlayers.length <= 1) {
              room.status = "finished";
              await room.save();
              logger.info("Game ended due to disconnect", {
                roomCode: room.roomCode,
                winner: alivePlayers[0]?.name || "none",
              });
              io.to(room.roomCode).emit("game_over", {
                winner: alivePlayers[0] || null,
                players: room.players,
              });
              clearRoomTimer(room.roomCode);
              continue;
            }
          }

          await room.save();
          io.to(room.roomCode).emit("player_left", {
            playerName,
            players: room.players,
          });
        }
      } catch (err) {
        logger.error("Disconnect handler failed", {
          socketId: socket.id,
          error: err.message,
          stack: err.stack,
        });
      }
    });
  });
}

module.exports = registerGameSocket;
module.exports.activeTimers = activeTimers;
module.exports.recoverActiveGames = recoverActiveGames;
