const express = require('express');
const router = express.Router();
const Room = require('../models/Room');

// Get room info
router.get('/:roomCode', async (req, res) => {
  try {
    const room = await Room.findOne({ roomCode: req.params.roomCode.toUpperCase() });
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ room });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Check room exists (before joining)
router.post('/check', async (req, res) => {
  try {
    const { roomCode } = req.body;
    const room = await Room.findOne({ roomCode: roomCode.toUpperCase() });
    if (!room) return res.status(404).json({ exists: false, error: 'Room not found' });
    if (room.status !== 'waiting') return res.json({ exists: true, joinable: false, error: 'Game in progress' });
    if (room.players.length >= room.settings.maxPlayers) return res.json({ exists: true, joinable: false, error: 'Room full' });
    res.json({ exists: true, joinable: true, playerCount: room.players.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
