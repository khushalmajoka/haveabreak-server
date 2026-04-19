const Room = require('../models/Room');

// Generates a random 5-character alphanumeric room code
function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Retries up to maxAttempts times on duplicate key collision (MongoDB error 11000)
// Throws if all attempts fail — caller should catch and return a friendly error
async function generateUniqueRoomCode(game, maxAttempts = 5) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = generateCode();
    const existing = await Room.findOne({ roomCode: code, game });
    if (!existing) return code;
  }
  throw new Error(`Could not generate a unique room code for game "${game}" after ${maxAttempts} attempts`);
}

module.exports = { generateUniqueRoomCode };