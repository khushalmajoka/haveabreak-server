const express = require('express');
const router  = express.Router();
const Room    = require('../models/Room');

// Get full room info (used by lobby page)
router.get('/:roomCode', async (req, res) => {
  try {
    const room = await Room.findOne({ roomCode: req.params.roomCode.toUpperCase(), game: 'wordbomb' });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

/**
 * Check room before joining (JoinPage).
 * Always returns `status` so the client can display the correct badge.
 */
router.post('/check', async (req, res) => {
  try {
    const { roomCode } = req.body;
    if (!roomCode) return res.status(400).json({ exists: false, error: 'roomCode required' });

    const room = await Room.findOne({ roomCode: roomCode.toUpperCase(), game: 'wordbomb' });
    if (!room) return res.status(404).json({ exists: false, error: 'Room not found' });

    const isFull      = room.players.length >= room.settings.maxPlayers;
    const isWaiting   = room.status === 'waiting';
    const isFinished  = room.status === 'finished';

    res.json({
      exists:      true,
      status:      room.status,                        // 'waiting' | 'playing' | 'finished'
      playerCount: room.players.length,
      maxPlayers:  room.settings.maxPlayers,
      joinable:    isWaiting && !isFull,               // can actively join
      spectatable: !isFinished,                        // can spectate if not finished
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
