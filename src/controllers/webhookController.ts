import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/environment.js';
import {
  validateAlchemySignature,
  AlchemyWebhookPayload,
  AlchemyActivity,
} from '../utils/alchemyWebhook.js';

import { DEFAULT_EVM_CHAIN_ID } from '../config/networks.js';
const DEFAULT_CHAIN_ID = DEFAULT_EVM_CHAIN_ID;

/**
 * Format wei value to human-readable ETH string
 */
function formatValue(activity: AlchemyActivity): { amount: string; currency: string } {
  if (activity.category === 'erc20' && activity.rawContract.decimals) {
    const decimals = activity.rawContract.decimals;
    const raw = BigInt(activity.rawContract.rawValue);
    const divisor = BigInt(10 ** decimals);
    const whole = raw / divisor;
    const fraction = raw % divisor;
    const fractionStr = fraction.toString().padStart(decimals, '0').slice(0, 6);
    return {
      amount: `${whole}.${fractionStr}`.replace(/\.?0+$/, '') || '0',
      currency: activity.asset,
    };
  }

  // Native ETH: value is already in ETH units from Alchemy
  return {
    amount: activity.value.toString(),
    currency: 'ETH',
  };
}

/**
 * Look up a wallet by address (checking both Wallet and KernelAccount tables)
 */
async function findWalletByAddress(address: string) {
  const normalizedAddress = address.toLowerCase();

  // Check Wallet table first
  const wallet = await prisma.wallet.findFirst({
    where: {
      address: { equals: normalizedAddress, mode: 'insensitive' },
      chainId: DEFAULT_CHAIN_ID,
    },
    select: { id: true, userId: true, address: true },
  });

  if (wallet) return wallet;

  // Check KernelAccount table (AA smart accounts)
  const kernelAccount = await prisma.kernelAccount.findFirst({
    where: {
      address: { equals: normalizedAddress, mode: 'insensitive' },
      chainId: DEFAULT_CHAIN_ID,
    },
    select: { id: true, userId: true, address: true, walletId: true },
  });

  if (kernelAccount) {
    return {
      id: kernelAccount.walletId || kernelAccount.id,
      userId: kernelAccount.userId,
      address: kernelAccount.address,
    };
  }

  return null;
}

/**
 * Send notification to notification-service (fire-and-forget)
 */
async function notifyUser(
  userId: string,
  title: string,
  message: string,
  data: Record<string, any>
) {
  const notificationUrl = `${env.notificationServiceUrl}/api/v1/notifications/internal`;
  try {
    const response = await fetch(notificationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        title,
        message,
        type: 'TRANSACTION',
        data,
        sendPush: true,
      }),
    });

    if (!response.ok) {
      logger.warn('Notification service returned non-200', {
        status: response.status,
        userId,
      });
    }
  } catch (error) {
    logger.warn('Failed to send notification (non-blocking)', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
  }
}

export const webhookController = {
  /**
   * POST /webhooks/alchemy
   * Receives Alchemy Address Activity webhooks for deposit detection
   */
  async handleAlchemyWebhook(req: Request, res: Response): Promise<void> {
    const signingKey = env.alchemyWebhookSigningKey;

    // Get raw body for HMAC validation
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf-8') : JSON.stringify(req.body);
    const signature = req.headers['x-alchemy-signature'] as string;

    // Validate signature (skip in development if no key configured)
    if (signingKey) {
      if (!validateAlchemySignature(rawBody, signature, signingKey)) {
        logger.warn('Alchemy webhook signature validation failed');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    } else if (env.nodeEnv === 'production') {
      logger.error('ALCHEMY_WEBHOOK_SIGNING_KEY not configured in production');
      res.status(500).json({ error: 'Webhook not configured' });
      return;
    } else {
      logger.warn('Alchemy webhook signature validation skipped (no signing key configured)');
    }

    // Parse payload
    let payload: AlchemyWebhookPayload;
    try {
      payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody) : req.body;
    } catch {
      logger.error('Failed to parse Alchemy webhook payload');
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    if (payload.type !== 'ADDRESS_ACTIVITY') {
      logger.info('Ignoring non-address-activity webhook', { type: payload.type });
      res.status(200).json({ ok: true });
      return;
    }

    logger.info('Processing Alchemy webhook', {
      webhookId: payload.webhookId,
      network: payload.event.network,
      activityCount: payload.event.activity.length,
    });

    let processedCount = 0;

    for (const activity of payload.event.activity) {
      try {
        // Find if toAddress belongs to one of our wallets
        const wallet = await findWalletByAddress(activity.toAddress);
        if (!wallet) continue;

        const { amount, currency } = formatValue(activity);
        const blockNumber = parseInt(activity.blockNum, 16);

        // Upsert transaction (idempotent for Alchemy retries)
        await prisma.transaction.upsert({
          where: { hash: activity.hash },
          create: {
            walletId: wallet.id,
            hash: activity.hash,
            fromAddress: activity.fromAddress.toLowerCase(),
            toAddress: activity.toAddress.toLowerCase(),
            value: activity.rawContract.rawValue,
            status: 'confirmed',
            chainId: DEFAULT_CHAIN_ID,
            transactionType: 'deposit',
            blockNumber: BigInt(blockNumber),
            tokenAddress: activity.category === 'erc20' ? activity.rawContract.address || null : null,
            tokenAmount: activity.category === 'erc20' ? activity.rawContract.rawValue : null,
            metadata: {
              source: 'alchemy_webhook',
              category: activity.category,
              asset: activity.asset,
            },
          },
          update: {
            status: 'confirmed',
            blockNumber: BigInt(blockNumber),
          },
        });

        // Send notification (fire-and-forget)
        await notifyUser(
          wallet.userId,
          'Deposit Received',
          `You received ${amount} ${currency}`,
          {
            txHash: activity.hash,
            amount,
            currency,
            type: 'received',
            fromAddress: activity.fromAddress,
          }
        );

        processedCount++;
        logger.info('Deposit processed', {
          userId: wallet.userId,
          txHash: activity.hash,
          amount,
          currency,
        });
      } catch (error) {
        logger.error('Error processing activity', {
          hash: activity.hash,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('Webhook processing complete', {
      total: payload.event.activity.length,
      processed: processedCount,
    });

    // Always return 200 to prevent Alchemy retries
    res.status(200).json({ ok: true, processed: processedCount });
  },
};
