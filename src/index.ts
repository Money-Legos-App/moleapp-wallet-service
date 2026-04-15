import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { prisma } from './lib/prisma';
import { env, developmentMode } from './config/environment.js';
import { logger, morganStream } from './utils/logger.js';
import walletRoutes from './routes/wallet.routes.js';
import swapRoutes from './routes/swap.routes.js';
import bridgeRoutes from './routes/bridge.routes.js';
import treasuryRoutes from './routes/treasury.routes.js';
import agentRoutes from './routes/agent.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import momoRoutes from './routes/momo.routes.js';
import { BridgePollerService } from './services/bridge/bridge-poller.service.js';
import { getQueueService } from './services/momo/queue/queueService.js';
import { registerCryptoMintWorker } from './services/momo/queue/workers/cryptoMintWorker.js';
import { registerRefundWorker } from './services/momo/queue/workers/refundWorker.js';

const app = express();

// Trust proxy (Render load balancer forwards X-Forwarded-For)
app.set('trust proxy', 1);

// Raw body parser for webhook signature validation (must be BEFORE express.json)
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }));
app.use('/api/v2/momo/webhook', express.raw({ type: 'application/json' }));

// Security and middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(cors({
  origin: env.nodeEnv === 'production'
    ? (process.env.CORS_ORIGINS?.split(',') || ['https://app.moleapp.africa', 'https://admin.moleapp.africa'])
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:8081'],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Turnkey-Session']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// HTTP logging
app.use(morgan('combined', { stream: morganStream }));

// Health check endpoint
app.get('/health', async (req, res) => {
  let dbOk = false;
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    dbOk = true;
  } catch {}

  const status = dbOk ? 'healthy' : 'degraded';
  res.status(dbOk ? 200 : 503).json({
    service: 'wallet-service',
    version: '2.0.0',
    status,
    database: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
    environment: env.nodeEnv
  });
});

// API routes
app.use('/api/v2/wallet', walletRoutes);
app.use('/api/v2/swap', swapRoutes);
app.use('/api/v2/bridge', bridgeRoutes);
app.use('/api/v2/treasury', treasuryRoutes);

// Internal agent routes (for agent-service only)
app.use('/internal/v1/agent', agentRoutes);

// V1 Compatibility routes for legacy services
app.use('/api/v1/wallets', walletRoutes);

// Momo routes (LocalRamp on/off-ramp)
app.use('/api/v2/momo', momoRoutes);

// Webhook routes (no auth - validated by HMAC signature)
app.use('/api/v1/webhooks', webhookRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'NOT_FOUND',
    message: `Route ${req.method} ${req.originalUrl} not found`
  });
});

// Global error handler — never leak stack traces or request bodies to clients
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Unhandled error:', {
    error: error.message,
    stack: error.stack,
    url: req.url,
    method: req.method,
  });

  res.status(error.status || 500).json({
    success: false,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'An unexpected error occurred',
  });
});

// Start bridge poller (cross-chain bridge status tracking)
const bridgePoller = new BridgePollerService(prisma);
bridgePoller.start();

// Initialize momo queue (BullMQ) and register workers
(async () => {
  try {
    const queueService = getQueueService();
    await queueService.initialize();
    registerCryptoMintWorker();
    registerRefundWorker();
    logger.info('Momo queue service initialized with workers');
  } catch (error) {
    logger.warn('Momo queue init failed (Redis may not be available)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
})();

// Graceful shutdown handling
const gracefulShutdown = async (signal: string) => {
  logger.info(`Received ${signal}. Starting graceful shutdown...`);

  try {
    bridgePoller.stop();
    // Shutdown momo queue
    try { await getQueueService().shutdown(); } catch {}
    // Close database connection
    await prisma.$disconnect();
    logger.info('Database connection closed');
    
    // Exit process
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown:', error);
    process.exit(1);
  }
};

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  gracefulShutdown('UNCAUGHT_EXCEPTION');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  gracefulShutdown('UNHANDLED_REJECTION');
});

// Start server
const server = app.listen(env.port, () => {
  logger.info(`🚀 Wallet Service v2.0.0 started successfully`);
  logger.info(`📡 Server running on port ${env.port}`);
  logger.info(`🌍 Environment: ${env.nodeEnv}`);
  logger.info(`🔐 Turnkey Organization: ${env.turnkeyOrganizationId}`);
  logger.info(`⚡ Account Abstraction: Kernel v3.1 + EntryPoint v0.7`);
  logger.info(`🛡️  Bundler: Pimlico`);
  logger.info(`💳 Paymaster: Sponsored transactions enabled`);
  logger.info(`🔄 Swap: 0x API integration (${developmentMode ? 'Testnet' : 'Mainnet'})`);
  logger.info(`💰 Treasury: On/off-ramp settlements enabled`);
  logger.info(`📱 Momo: LocalRamp mobile money integration enabled`);
  
  // Test database connection
  prisma.$connect()
    .then(() => {
      logger.info('✅ Database connected successfully');
    })
    .catch((error) => {
      logger.error('❌ Database connection failed:', error);
    });
});

export default app;