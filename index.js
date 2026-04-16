require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const roomRoutes = require('./routes/rooms');
const gameSocket = require('./socket/gameSocket');

const app = express();
const server = http.createServer(app);

const morgan = require('morgan');
const logger = require('./utils/logger');

// Morgan ko winston ke saath wire karo
app.use(morgan('dev', {
  stream: { write: (msg) => logger.http(msg.trim()) },
}));

const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json());

// Routes
app.use('/api/rooms', roomRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Socket
gameSocket(io);

// MongoDB
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/wordbomb';
mongoose.connect(MONGO_URI)
  .then(() => logger.info('MongoDB connected', { uri: MONGO_URI.split('@').pop() }))
  .catch(err => logger.error('MongoDB connection failed', { error: err.message }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
