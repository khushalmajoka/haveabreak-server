const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Create logs directory if it doesn't exist
// Without this, Winston crashes on first write on a fresh deployment
fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });

const isProduction = process.env.NODE_ENV === 'production';

// In production: warn and above only — no player names, room codes, game state
// In development: debug and above — full verbose output for local debugging
const LOG_LEVEL = process.env.LOG_LEVEL || (isProduction ? 'warn' : 'debug');

const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
      let log = `[${timestamp}] ${level.toUpperCase().padEnd(5)} — ${message}`;
      if (Object.keys(meta).length) log += ` | ${JSON.stringify(meta)}`;
      if (stack) log += `\n${stack}`;
      return log;
    })
  ),
  transports: [
    // Console — colorized, always on
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: 'HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          let log = `[${timestamp}] ${level} — ${message}`;
          if (Object.keys(meta).length) log += ` | ${JSON.stringify(meta)}`;
          return log;
        })
      ),
    }),

    // Errors only — kept for 30 days, max 20MB per file
    new DailyRotateFile({
      filename:     path.join(__dirname, '../logs/error-%DATE%.log'),
      datePattern:  'YYYY-MM-DD',
      level:        'error',
      maxSize:      '20m',
      maxFiles:     '30d',   // auto-delete files older than 30 days
      zippedArchive: true,   // gzip old files to save space
    }),

    // All logs — kept for 14 days, max 50MB per file
    // In production this only contains warn + error anyway (LOG_LEVEL=warn)
    new DailyRotateFile({
      filename:     path.join(__dirname, '../logs/combined-%DATE%.log'),
      datePattern:  'YYYY-MM-DD',
      maxSize:      '50m',
      maxFiles:     '14d',
      zippedArchive: true,
    }),
  ],
});

module.exports = logger;