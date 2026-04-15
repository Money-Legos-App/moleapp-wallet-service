/**
 * Refund Worker — refunds crypto to user when off-ramp payout fails.
 * Uses TreasuryService DIRECTLY.
 */

import { Job } from 'bullmq';
import { prisma } from '../../../../lib/prisma';
import { logger } from '../../../../utils/logger';
import { TransactionStateMachine, OFF_RAMP_STATES } from '../../fsm';
import { sendTransactionNotification } from '../../notificationClient';
import { treasuryService } from '../../../treasury/treasuryService';
import { Address } from 'viem';
import { RefundJobData, getQueueService, QUEUE_NAMES } from '../queueService';

const DEFAULT_CHAIN_ID = parseInt(process.env.DEFAULT_CHAIN_ID || '42161');

async function getUserWalletAddress(userId: string): Promise<string | null> {
  const wallet = await prisma.wallet.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return wallet?.address || null;
}

export async function processRefundJob(job: Job<RefundJobData>): Promise<any> {
  const { transactionId, userId, amount, cryptoCurrency, reason } = job.data;

  logger.info('Processing refund job', { jobId: job.id, transactionId, userId, amount, cryptoCurrency, reason });

  const transaction = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new Error(`Transaction not found: ${transactionId}`);

  if (transaction.currentState !== OFF_RAMP_STATES.REFUNDING) {
    if (transaction.currentState === OFF_RAMP_STATES.REFUNDED) {
      logger.info('Transaction already refunded', { transactionId });
      return { success: true, alreadyRefunded: true };
    }
    logger.warn('Transaction not in REFUNDING state', { transactionId, currentState: transaction.currentState });
    return { success: false, error: `Invalid state: ${transaction.currentState}` };
  }

  const fsm = new TransactionStateMachine(transaction);

  try {
    const walletAddress = await getUserWalletAddress(userId);
    if (!walletAddress) throw new Error(`No wallet found for user ${userId}`);

    // DIRECT treasury call
    const refundResult = await treasuryService.refundFromTreasury(
      walletAddress as Address,
      amount,
      DEFAULT_CHAIN_ID,
      transactionId,
      reason,
    );

    if (!refundResult.success) throw new Error(`Refund failed: ${refundResult.error}`);

    const refundedTransition = await fsm.transition(OFF_RAMP_STATES.REFUNDED, {
      trigger: 'REFUND_SUCCESS',
      verificationData: {
        refundTxHash: refundResult.txHash,
        refundedAt: new Date().toISOString(),
        refundReason: reason,
        refundedAmount: amount,
      },
    });

    if (!refundedTransition.success) {
      logger.error('Failed to transition to REFUNDED', { transactionId, error: refundedTransition.error });
    }

    logger.info('Refund completed successfully', { transactionId, refundTxHash: refundResult.txHash });

    await sendTransactionNotification(userId, {
      title: 'Refund Processed',
      message: `Your ${amount} ${cryptoCurrency} has been refunded to your wallet. Reason: ${reason}`,
      type: 'TRANSACTION',
      data: { transactionId, status: 'REFUNDED', txHash: refundResult.txHash },
    });

    return { success: true, refundTxHash: refundResult.txHash };

  } catch (error) {
    logger.error('Refund processing failed', {
      transactionId, error: error instanceof Error ? error.message : 'Unknown error', attempt: job.attemptsMade + 1,
    });

    if (job.attemptsMade >= (job.opts.attempts || 3) - 1) {
      await fsm.transition(OFF_RAMP_STATES.FAILED, {
        trigger: 'REFUND_FAILED',
        errorMessage: `Refund failed after ${job.attemptsMade + 1} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`,
        verificationData: { failedAt: new Date().toISOString(), attempts: job.attemptsMade + 1, originalReason: reason },
      });
    }
    throw error;
  }
}

export function registerRefundWorker(): void {
  const queueService = getQueueService();
  queueService.registerWorker(QUEUE_NAMES.REFUND, processRefundJob);
  logger.info('Refund worker registered');
}
