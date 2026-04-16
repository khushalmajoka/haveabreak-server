const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  id: String,
  name: String,
  lives: { type: Number, default: 3 },
  isAlive: { type: Boolean, default: true },
  isHost: { type: Boolean, default: false },
  socketId: String,
});

const RoomSchema = new mongoose.Schema({
  roomCode: { type: String, unique: true, required: true },
  game: { type: String, default: 'wordbomb' },
  players: [PlayerSchema],
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
  settings: {
    maxLives: { type: Number, default: 3 },
    turnTimer: { type: Number, default: 15 }, // seconds
    maxPlayers: { type: Number, default: 8 },
  },
  currentPlayerIndex: { type: Number, default: 0 },
  currentSubstring: { type: String, default: '' },
  usedWords: [String],
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // auto-delete after 24h
});

module.exports = mongoose.model('Room', RoomSchema);
