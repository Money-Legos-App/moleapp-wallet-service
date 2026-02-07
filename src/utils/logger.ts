import winston from 'winston';
import { env } from '../config/environment.js';

const logLevel = env.nodeEnv === 'production' ? 'info' : 'debug';

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
  winston.format.colorize({ all: true })
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    level: logLevel,
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  })
];

// Add file transports in production
if (env.nodeEnv === 'production') {
  transports.push(
    new winston.transports.File({
      filename: 'logs/wallet-service-error.log',
      level: 'error',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    }),
    new winston.transports.File({
      filename: 'logs/wallet-service.log',
      level: 'info',
      format: logFormat,
      maxsize: 5242880, // 5MB
      maxFiles: 5
    })
  );
}

export const logger = winston.createLogger({
  level: logLevel,
  format: logFormat,
  defaultMeta: { 
    service: 'wallet-service',
    version: '2.0.0'
  },
  transports,
  exceptionHandlers: [
    new winston.transports.Console(),
    ...(env.nodeEnv === 'production' ? [
      new winston.transports.File({ 
        filename: 'logs/wallet-service-exceptions.log',
        maxsize: 5242880,
        maxFiles: 3
      })
    ] : [])
  ]
});

// Stream for Morgan HTTP logging
export const morganStream = {
  write: (message: string) => {
    logger.http(message.substring(0, message.lastIndexOf('\n')));
  }
};