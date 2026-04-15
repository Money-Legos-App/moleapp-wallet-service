/**
 * BullMQ Queue Service
 *
 * Centralized queue management for async job processing.
 * Uses Redis-backed BullMQ for reliable job scheduling and retries.
 *
 * Queue Types:
 * - on_ramp: On-ramp transaction processing (crypto minting after fiat received)
 * - off_ramp: Off-ramp transaction processing (payout after crypto confirmed)
 * - polling: Status polling jobs
 * - refund: Auto-refund for failed payouts
 * - webhook_retry: Webhook delivery retries
 */

import { Queue, Worker, Job, QueueEvents, JobsOptions } from 'bullmq';
import Redis from 'ioredis';
import { prisma } from '../../../lib/prisma';
import { logger } from '../../../utils/logger';

// ================================
// CONFIGURATION
// ================================

const QUEUE_CONFIG = {
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  REDIS_PASSWORD: process.env.REDIS_PASSWORD,
  /** Default job options */
  DEFAULT_JOB_OPTIONS: {
    attempts: 3,
    backoff: {
      type: 'exponential' as const,
      delay: 5000, // 5 seconds initial delay
    },
    removeOnComplete: {
      count: 100, // Keep last 100 completed jobs
    },
    removeOnFail: {
      count: 500, // Keep last 500 failed jobs
    },
  },
};

// ================================
// QUEUE NAMES
// ================================

export const QUEUE_NAMES = {
  ON_RAMP: 'momo-on-ramp',
  OFF_RAMP: 'momo-off-ramp',
  PAYOUT: 'momo-payout',
  POLLING: 'momo-polling',
  REFUND: 'momo-refund',
  WEBHOOK_RETRY: 'momo-webhook-retry',
  CRYPTO_MINT: 'momo-crypto-mint',
  CONFIRMATION: 'momo-confirmation',
} as const;

export type QueueName = typeof QUEUE_NAMES[keyof typeof QUEUE_NAMES];

// ================================
// JOB TYPES
// ================================

export interface OnRampJobData {
  transactionId: string;
  userId: string;
  amount: number;
  currency: string;
  cryptoAmount: number;
  cryptoCurrency: string;
}

export interface OffRampJobData {
  transactionId: string;
  userId: string;
  cryptoAmount: number;
  cryptoCurrency: string;
  fiatAmount: number;
  currency: string;
  phoneNumber: string;
}

export interface PollingJobData {
  transactionId: string;
  providerCode: string;
  pollType: 'payment' | 'payout';
  maxAttempts: number;
  intervalMs: number;
  attempt?: number;
  startedAt?: string;
}

export interface PayoutJobData {
  transactionId: string;
  userId: string;
  phoneNumber: string;
  fiatAmount: number;
  currency: string;
  providerCode: string;
  cryptoTxHash: string;
  walletAddress: string;
  cryptoAmount: number;
  cryptoCurrency: string;
}

export interface RefundJobData {
  transactionId: string;
  userId: string;
  amount: number;
  cryptoCurrency: string;
  reason: string;
}

export interface CryptoMintJobData {
  transactionId: string;
  userId: string;
  usdtAmount: number;
  walletAddress: string;
  chainId: number;
}

export interface ConfirmationJobData {
  transactionId: string;
  txHash: string;
  chainId: number;
  requiredConfirmations: number;
}

export type JobData =
  | OnRampJobData
  | OffRampJobData
  | PayoutJobData
  | PollingJobData
  | RefundJobData
  | CryptoMintJobData
  | ConfirmationJobData;

// ================================
// QUEUE SERVICE
// ================================

export class QueueService {
  private static instance: QueueService;
  private connection: Redis;
  private queues: Map<QueueName, Queue> = new Map();
  private workers: Map<QueueName, Worker> = new Map();
  private queueEvents: Map<QueueName, QueueEvents> = new Map();
  private isInitialized: boolean = false;

  private constructor() {
    this.connection = new Redis(QUEUE_CONFIG.REDIS_URL, {
      password: QUEUE_CONFIG.REDIS_PASSWORD,
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
    });

    this.connection.on('error', (error) => {
      logger.error('Redis connection error', { error: error.message });
    });

    this.connection.on('connect', () => {
      logger.info('Redis connected for queue service');
    });
  }

  /**
   * Get singleton instance
   */
  static getInstance(): QueueService {
    if (!QueueService.instance) {
      QueueService.instance = new QueueService();
    }
    return QueueService.instance;
  }

  /**
   * Initialize all queues
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // Create queues for each queue name
    for (const queueName of Object.values(QUEUE_NAMES)) {
      const queue = new Queue(queueName, {
        connection: this.connection,
        defaultJobOptions: QUEUE_CONFIG.DEFAULT_JOB_OPTIONS,
      });

      this.queues.set(queueName, queue);

      // Create queue events for monitoring
      const events = new QueueEvents(queueName, {
        connection: this.connection,
      });

      this.setupQueueEvents(queueName, events);
      this.queueEvents.set(queueName, events);
    }

    this.isInitialized = true;
    logger.info('Queue service initialized', {
      queues: Object.values(QUEUE_NAMES),
    });
  }

  /**
   * Set up queue event listeners for monitoring
   */
  private setupQueueEvents(queueName: QueueName, events: QueueEvents): void {
    events.on('completed', ({ jobId }) => {
      logger.debug('Job completed', { queueName, jobId });
    });

    events.on('failed', ({ jobId, failedReason }) => {
      logger.error('Job failed', { queueName, jobId, failedReason });
    });

    events.on('stalled', ({ jobId }) => {
      logger.warn('Job stalled', { queueName, jobId });
    });
  }

  /**
   * Add a job to a queue
   *
   * @param queueName - Name of the queue
   * @param jobName - Name/type of the job
   * @param data - Job data
   * @param options - Optional job options
   */
  async addJob<T extends JobData>(
    queueName: QueueName,
    jobName: string,
    data: T,
    options?: JobsOptions
  ): Promise<Job<T>> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue not found: ${queueName}`);
    }

    const job = await queue.add(jobName, data, options);

    // Record job in database for tracking
    await this.recordJob(queueName, job.id!, jobName, data);

    logger.info('Job added to queue', {
      queueName,
      jobName,
      jobId: job.id,
      transactionId: (data as any).transactionId,
    });

    return job;
  }

  /**
   * Add a delayed job
   */
  async addDelayedJob<T extends JobData>(
    queueName: QueueName,
    jobName: string,
    data: T,
    delayMs: number,
    options?: JobsOptions
  ): Promise<Job<T>> {
    return this.addJob(queueName, jobName, data, {
      ...options,
      delay: delayMs,
    });
  }

  /**
   * Add a polling job with automatic retries
   */
  async addPollingJob(data: PollingJobData): Promise<Job<PollingJobData>> {
    const intervalMs = data.intervalMs || parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10) * 1000;

    return this.addDelayedJob(
      QUEUE_NAMES.POLLING,
      'poll_status',
      {
        ...data,
        attempt: data.attempt || 0,
        startedAt: data.startedAt || new Date().toISOString(),
      },
      intervalMs,
      {
        attempts: data.maxAttempts || 4,
        backoff: {
          type: 'fixed',
          delay: intervalMs,
        },
      }
    );
  }

  /**
   * Add a payout job (off-ramp cash-out to mobile money)
   */
  async addPayoutJob(data: PayoutJobData): Promise<Job<PayoutJobData>> {
    return this.addJob(QUEUE_NAMES.PAYOUT, 'process_payout', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10 second initial delay
      },
    });
  }

  /**
   * Add a crypto minting job
   */
  async addCryptoMintJob(data: CryptoMintJobData): Promise<Job<CryptoMintJobData>> {
    return this.addJob(QUEUE_NAMES.CRYPTO_MINT, 'mint_crypto', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10000, // 10 second initial delay
      },
    });
  }

  /**
   * Add a refund job
   */
  async addRefundJob(data: RefundJobData): Promise<Job<RefundJobData>> {
    return this.addJob(QUEUE_NAMES.REFUND, 'process_refund', data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
    });
  }

  /**
   * Add a block confirmation monitoring job
   */
  async addConfirmationJob(data: ConfirmationJobData): Promise<Job<ConfirmationJobData>> {
    return this.addJob(QUEUE_NAMES.CONFIRMATION, 'monitor_confirmation', data, {
      attempts: 60, // Check for 5 minutes (60 * 5s)
      backoff: {
        type: 'fixed',
        delay: 5000, // 5 seconds
      },
    });
  }

  /**
   * Register a worker for a queue
   */
  registerWorker(
    queueName: QueueName,
    processor: (job: Job) => Promise<any>,
    options?: {
      concurrency?: number;
      limiter?: { max: number; duration: number };
    }
  ): Worker {
    const worker = new Worker(
      queueName,
      async (job) => {
        logger.info('Processing job', {
          queueName,
          jobId: job.id,
          jobName: job.name,
          attempt: job.attemptsMade + 1,
        });

        try {
          const result = await processor(job);

          // Update job status in database
          await this.updateJobStatus(job.id!, 'COMPLETED', result);

          return result;
        } catch (error) {
          logger.error('Job processing error', {
            queueName,
            jobId: job.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });

          // Update job status in database
          await this.updateJobStatus(
            job.id!,
            job.attemptsMade >= (job.opts.attempts || 3) - 1 ? 'FAILED' : 'RETRYING',
            null,
            error instanceof Error ? error.message : 'Unknown error'
          );

          throw error;
        }
      },
      {
        connection: this.connection,
        concurrency: options?.concurrency || 5,
        limiter: options?.limiter,
      }
    );

    worker.on('error', (error) => {
      logger.error('Worker error', { queueName, error: error.message });
    });

    this.workers.set(queueName, worker);
    logger.info('Worker registered', { queueName });

    return worker;
  }

  /**
   * Record job in database for tracking
   */
  private async recordJob(
    queueName: string,
    jobId: string,
    jobType: string,
    data: any
  ): Promise<void> {
    try {
      await prisma.queueJob.create({
        data: {
          jobId,
          queueName,
          transactionId: data.transactionId || null,
          jobType,
          status: 'PENDING',
          maxAttempts: 3,
        },
      });
    } catch (error) {
      logger.warn('Failed to record job in database', {
        jobId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Update job status in database
   */
  private async updateJobStatus(
    jobId: string,
    status: 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'RETRYING',
    result?: any,
    errorMessage?: string
  ): Promise<void> {
    try {
      await prisma.queueJob.update({
        where: { jobId },
        data: {
          status,
          resultData: result,
          errorMessage,
          lastAttemptAt: new Date(),
          attempts: { increment: 1 },
        },
      });
    } catch (error) {
      logger.warn('Failed to update job status in database', {
        jobId,
        status,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: QueueName): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue not found: ${queueName}`);
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  /**
   * Get all queue statistics
   */
  async getAllQueueStats(): Promise<Record<QueueName, any>> {
    const stats: Record<string, any> = {};

    for (const queueName of Object.values(QUEUE_NAMES)) {
      stats[queueName] = await this.getQueueStats(queueName);
    }

    return stats as Record<QueueName, any>;
  }

  /**
   * Pause a queue
   */
  async pauseQueue(queueName: QueueName): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) {
      await queue.pause();
      logger.info('Queue paused', { queueName });
    }
  }

  /**
   * Resume a queue
   */
  async resumeQueue(queueName: QueueName): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) {
      await queue.resume();
      logger.info('Queue resumed', { queueName });
    }
  }

  /**
   * Clean up completed/failed jobs older than specified time
   */
  async cleanOldJobs(queueName: QueueName, olderThanMs: number): Promise<void> {
    const queue = this.queues.get(queueName);
    if (queue) {
      await queue.clean(olderThanMs, 1000, 'completed');
      await queue.clean(olderThanMs, 1000, 'failed');
      logger.info('Old jobs cleaned', { queueName, olderThanMs });
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down queue service...');

    // Close all workers
    for (const [name, worker] of this.workers) {
      await worker.close();
      logger.debug('Worker closed', { queueName: name });
    }

    // Close all queue events
    for (const [name, events] of this.queueEvents) {
      await events.close();
      logger.debug('Queue events closed', { queueName: name });
    }

    // Close all queues
    for (const [name, queue] of this.queues) {
      await queue.close();
      logger.debug('Queue closed', { queueName: name });
    }

    // Close Redis connection
    await this.connection.quit();

    this.isInitialized = false;
    logger.info('Queue service shut down');
  }
}

// Export singleton getter
export const getQueueService = () => QueueService.getInstance();
