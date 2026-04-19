require("dotenv").config();

// ── Env validation — fail fast if required vars are missing ──────────────────
function validateEnv() {
  const required = ["MONGO_URI", "CLIENT_URL"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `[FATAL] Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error("[FATAL] Copy .env.example to .env and fill in all values.");
    process.exit(1);
  }
}
validateEnv();

// Warn about optional vars that have meaningful production defaults
if (!process.env.NODE_ENV) {
  console.warn('[WARN] NODE_ENV is not set — defaulting to development');
}
if (!process.env.LOG_LEVEL) {
  console.warn('[WARN] LOG_LEVEL is not set — defaulting to info (set to warn in production)');
}

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const mongoose = require("mongoose");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");

const roomRoutes = require("./routes/rooms");
const gameSocket = require("./socket/gameSocket");
const bluffSocket = require("./socket/bluffSocket");
const logger = require("./utils/logger");

const app = express();
const server = http.createServer(app);

// ── Security headers ─────────────────────────────────────────────────────────
app.use(
  helmet({
    // Allow AdSense and Google Fonts if you enable ads later
    contentSecurityPolicy: false,
  }),
);

// ── HTTP request logging ─────────────────────────────────────────────────────
app.use(
  morgan("dev", {
    stream: { write: (msg) => logger.http(msg.trim()) },
  }),
);

// ── CORS ─────────────────────────────────────────────────────────────────────
const CLIENT_URL = process.env.CLIENT_URL;
app.use(cors({ origin: CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "10kb" })); // Reject absurdly large JSON bodies

// ── HTTP rate limiting — 100 requests per minute per IP on /api routes ───────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 100, // max 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please slow down." },
  handler: (req, res, next, options) => {
    logger.warn("Rate limit hit on HTTP", { ip: req.ip, path: req.path });
    res.status(429).json(options.message);
  },
});
app.use("/api", apiLimiter);

// ── Socket.io setup ───────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
  // Limit incoming message size to 64KB (default is no limit)
  maxHttpBufferSize: 64 * 1024,
});

// ── Per-socket rate limiter ───────────────────────────────────────────────────
// Tracks event count per socket in a sliding window.
// If a socket fires more than MAX_EVENTS events within WINDOW_MS, it gets a warning.
// After 3 warnings it gets disconnected.

const WINDOW_MS = 5000; // 5-second window
const MAX_EVENTS = 25; // max 25 socket events per 5 seconds (5/sec average)

function createSocketRateLimiter() {
  // socketId -> { count, windowStart, warnings }
  const state = new Map();

  return function socketRateLimitMiddleware(socket, next) {
    state.set(socket.id, { count: 0, windowStart: Date.now(), warnings: 0 });

    // Intercept every incoming event before it reaches the handler
    socket.use(([event, ...args], nextFn) => {
      const now = Date.now();
      const s = state.get(socket.id);
      if (!s) return nextFn();

      // Reset window if expired
      if (now - s.windowStart > WINDOW_MS) {
        s.count = 0;
        s.windowStart = now;
      }

      s.count++;

      if (s.count > MAX_EVENTS) {
        s.warnings++;
        logger.warn("Socket rate limit exceeded", {
          socketId: socket.id,
          event,
          count: s.count,
          warnings: s.warnings,
        });

        // Emit a warning back to the client
        socket.emit("rate_limit_warning", {
          message: `Slow down! Too many events. Warning ${s.warnings}/3.`,
        });

        // After 3 warnings, disconnect the socket
        if (s.warnings >= 3) {
          logger.warn("Socket disconnected — repeated rate limit abuse", {
            socketId: socket.id,
          });
          socket.disconnect(true);
          return; // Don't call nextFn — drop the event
        }

        return; // Drop this event but keep the connection
      }

      nextFn();
    });

    // Clean up tracking state when socket disconnects
    socket.on("disconnect", () => {
      state.delete(socket.id);
    });

    next();
  };
}

// Apply the rate limiter to ALL sockets
io.use(createSocketRateLimiter());

// ── Game socket handlers ──────────────────────────────────────────────────────
gameSocket(io); // Word Bomb
bluffSocket(io); // Cards Bluff

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/rooms", roomRoutes);

app.get("/health", async (req, res) => {
  const dbState = mongoose.connection.readyState;
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const dbStatus =
    ["disconnected", "connected", "connecting", "disconnecting"][dbState] ||
    "unknown";
  const isHealthy = dbState === 1;

  const status = {
    status: isHealthy ? "ok" : "degraded",
    db: dbStatus,
    uptime: Math.floor(process.uptime()),
    games: ["wordbomb", "cardsbluff"],
  };

  res.status(isHealthy ? 200 : 503).json(status);
});

// ── MongoDB ───────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
const { activeTimers, recoverActiveGames } = require('./socket/gameSocket');
mongoose
  .connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
  .then(async () => {
    logger.info('MongoDB connected', { uri: MONGO_URI.split('@').pop() });
    // Restore timers for any games that were running before the restart
    await recoverActiveGames(io);
  })
   .catch(err => logger.error('MongoDB connection failed', { error: err.message }));

mongoose.connection.on("error", (err) => {
  logger.error("MongoDB runtime error", { error: err.message });
});

mongoose.connection.on("disconnected", () => {
  logger.warn("MongoDB disconnected — will auto-reconnect");
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  // 1. Stop accepting new connections
  server.close(() => {
    logger.info("HTTP server closed");

    // 2. Clear all in-flight game timers
    const timerCount = Object.keys(activeTimers).length;
    Object.keys(activeTimers).forEach((roomCode) => {
      clearTimeout(activeTimers[roomCode]);
      delete activeTimers[roomCode];
    });
    if (timerCount > 0) logger.info(`Cleared ${timerCount} active game timers`);

    // 3. Close database connection
    mongoose.connection.close(false, () => {
      logger.info("MongoDB connection closed");
      process.exit(0);
    });
  });

  // Force-exit if graceful shutdown takes too long (10 seconds)
  setTimeout(() => {
    logger.error("Graceful shutdown timed out — forcing exit");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Catch any unhandled promise rejections so the server doesn't silently die
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled promise rejection", { reason: String(reason) });
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`, {
    env: process.env.NODE_ENV || "development",
    clientUrl: CLIENT_URL,
  });
});
