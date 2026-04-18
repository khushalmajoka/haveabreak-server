// ── Input Validation Utility ─────────────────────────────────────────────────
// All socket/HTTP input validation lives here.
// Import this in any socket handler or route that accepts user input.

const ROOM_CODE_REGEX = /^[A-Z0-9]{5}$/;

// ── Individual field validators ───────────────────────────────────────────────

function isValidRoomCode(code) {
  return typeof code === 'string' && ROOM_CODE_REGEX.test(code.toUpperCase());
}

function isValidPlayerName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 20;
}

function isValidWord(word) {
  // Only the LENGTH/TYPE check — actual dictionary check is in wordUtils
  return typeof word === 'string' && word.trim().length >= 1 && word.trim().length <= 64;
}

function isValidSettings(settings) {
  if (!settings || typeof settings !== 'object') return false;
  const { maxLives, turnTimer, maxPlayers, startingCards } = settings;
  if (maxLives     !== undefined && (typeof maxLives !== 'number'     || maxLives < 1     || maxLives > 10))    return false;
  if (turnTimer    !== undefined && (typeof turnTimer !== 'number'    || turnTimer < 5    || turnTimer > 60))   return false;
  if (maxPlayers   !== undefined && (typeof maxPlayers !== 'number'   || maxPlayers < 2   || maxPlayers > 12))  return false;
  if (startingCards !== undefined && startingCards !== null &&
      (typeof startingCards !== 'number' || startingCards < 1 || startingCards > 52))                          return false;
  return true;
}

function isValidCardIds(cardIds) {
  if (!Array.isArray(cardIds)) return false;
  if (cardIds.length === 0 || cardIds.length > 13) return false;
  // Each card ID is like "A♠", "10♥" — max ~4 chars
  return cardIds.every(id => typeof id === 'string' && id.length <= 5);
}

// ── Socket event validator ────────────────────────────────────────────────────
// Returns { ok: true } or { ok: false, reason: string }
// Use like: const v = validate.createRoom(data); if (!v.ok) return socket.emit('error', { message: v.reason });

const validate = {
  createRoom({ playerName, settings } = {}) {
    if (!isValidPlayerName(playerName)) return { ok: false, reason: 'Player name must be 1–20 characters.' };
    if (settings !== undefined && !isValidSettings(settings)) return { ok: false, reason: 'Invalid settings values.' };
    return { ok: true };
  },

  joinRoom({ roomCode, playerName } = {}) {
    if (!isValidRoomCode(roomCode))   return { ok: false, reason: 'Invalid room code.' };
    if (!isValidPlayerName(playerName)) return { ok: false, reason: 'Player name must be 1–20 characters.' };
    return { ok: true };
  },

  spectateRoom({ roomCode } = {}) {
    if (!isValidRoomCode(roomCode)) return { ok: false, reason: 'Invalid room code.' };
    return { ok: true };
  },

  updateSettings({ roomCode, settings } = {}) {
    if (!isValidRoomCode(roomCode))     return { ok: false, reason: 'Invalid room code.' };
    if (!isValidSettings(settings))     return { ok: false, reason: 'Invalid settings values.' };
    return { ok: true };
  },

  startGame({ roomCode } = {}) {
    if (!isValidRoomCode(roomCode)) return { ok: false, reason: 'Invalid room code.' };
    return { ok: true };
  },

  submitWord({ roomCode, word } = {}) {
    if (!isValidRoomCode(roomCode)) return { ok: false, reason: 'Invalid room code.' };
    if (!isValidWord(word))         return { ok: false, reason: 'Word must be 1–64 characters.' };
    return { ok: true };
  },

  playCards({ roomCode, cardIds, claimedRank } = {}) {
    if (!isValidRoomCode(roomCode))   return { ok: false, reason: 'Invalid room code.' };
    if (!isValidCardIds(cardIds))     return { ok: false, reason: 'Invalid card selection.' };
    if (typeof claimedRank !== 'string' || claimedRank.length > 3) return { ok: false, reason: 'Invalid rank.' };
    return { ok: true };
  },

  roomAction({ roomCode } = {}) {
    // Generic validator for challenge / pass / start — just needs a valid room code
    if (!isValidRoomCode(roomCode)) return { ok: false, reason: 'Invalid room code.' };
    return { ok: true };
  },
};

module.exports = validate;