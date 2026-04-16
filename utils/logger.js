const winston = require('winston');
const path = require('path');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
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
    // Console mein color ke saath
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
    // Error logs file mein
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/error.log'),
      level: 'error',
    }),
    // Sab logs file mein
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/combined.log'),
    }),
  ],
});

module.exports = logger;