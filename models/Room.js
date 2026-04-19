const mongoose = require('mongoose');

const PlayerSchema = new mongoose.Schema({
  id: String,
  name: String,
  lives: { type: Number, default: 3 },
  isAlive: { type: Boolean, default: true },
  isHost: { type: Boolean, default: false },
  socketId: String,
  hand: { type: [mongoose.Schema.Types.Mixed], default: [] },
  cardCount: { type: Number, default: 0 },
});

const RoomSchema = new mongoose.Schema({
  roomCode: { type: String, required: true },
  game: { type: String, enum: ['wordbomb', 'cardsbluff'], default: 'wordbomb' },
  players: [PlayerSchema],
  status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
  settings: {
    maxLives: { type: Number, default: 3 },
    turnTimer: { type: Number, default: 15 }, // seconds
    maxPlayers: { type: Number, default: 8 },
    startingCards: { type: Number, default: null },
  },
  currentPlayerIndex: { type: Number, default: 0 },
  currentSubstring: { type: String, default: '' },
  turnStartedAt:      { type: Date, default: null },
  usedWords: [String],
  pile: { type: [mongoose.Schema.Types.Mixed], default: [] },
  lastClaim: { type: mongoose.Schema.Types.Mixed, default: null },
  lastPlayedCards: { type: [mongoose.Schema.Types.Mixed], default: [] },
  passCount: { type: Number, default: 0 },
  winner: { type: mongoose.Schema.Types.Mixed, default: null },
  log: {
    type: [{
      type: { type: String },
      msg: String,
      ts: { type: Number, default: Date.now },
    }],
    default: [],
  },
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // auto-delete after 24h
});

RoomSchema.index({ roomCode: 1, game: 1 }, { unique: true });

module.exports = mongoose.model('Room', RoomSchema);
