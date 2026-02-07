import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

// Redis configuration from environment
const REDIS_CONFIG = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  db: 0,
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  enableReadyCheck: true,
  maxRetriesPerRequest: 3,
};

// Create Redis client singleton
class RedisClient {
  private client: Redis;
  private isConnected: boolean = false;

  constructor() {
    this.client = new Redis(REDIS_CONFIG);

    this.client.on('connect', () => {
      logger.info('✅ Redis connected successfully');
      this.isConnected = true;
    });

    this.client.on('error', (error) => {
      logger.error('❌ Redis connection error:', error);
      this.isConnected = false;
    });

    this.client.on('close', () => {
      logger.warn('⚠️ Redis connection closed');
      this.isConnected = false;
    });
  }

  getClient(): Redis {
    return this.client;
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  isReady(): boolean {
    return this.isConnected && this.client.status === 'ready';
  }
}

// Export singleton instance
export const redisClient = new RedisClient();
export default redisClient.getClient();
