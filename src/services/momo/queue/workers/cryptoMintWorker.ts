/**
 * Crypto Transfer Worker — credits user wallet from treasury after fiat confirmed.
 * Now uses TreasuryService DIRECTLY (no HTTP call to self).
 */

import { Job } from 'bullmq';
import { prisma } from '../../../../lib/prisma';
import { logger } from '../../../../utils/logger';
import { TransactionStateMachine, ON_RAMP_STATES } from '../../fsm';
import { CommissionService } from '../../commission';
import { sendTransactionNotification } from '../../notificationClient';
import { treasuryService } from '../../../treasury/treasuryService';
import { Address } from 'viem';
import { CryptoMintJobData, getQueueService, QUEUE_NAMES } from '../queueService';

const commissionService = new CommissionService();

const DEFAULT_CHAIN_ID = parseInt(process.env.DEFAULT_CHAIN_ID || '42161');

async function getUserWalletAddress(userId: string): Promise<string | null> {
  const wallet = await prisma.wallet.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return wallet?.address || null;
}

export async function processCryptoMintJob(job: Job<CryptoMintJobData>): Promise<any> {
  const { transactionId, userId, usdtAmount, walletAddress, chainId } = job.data;

  logger.info('Processing crypto transfer job (on-ramp)', {
    jobId: job.id, transactionId, userId, usdtAmount, walletAddress, chainId,
  });

  const transaction = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
  if (!transaction) throw new Error(`Transaction not found: ${transactionId}`);

  if (transaction.currentState !== ON_RAMP_STATES.FIAT_RECEIVED) {
    logger.warn('Transaction not in FIAT_RECEIVED state', { transactionId, currentState: transaction.currentState });
    return { success: false, error: `Invalid state: ${transaction.currentState}` };
  }

  const fsm = new TransactionStateMachine(transaction);

  const mintingTransition = await fsm.transition(ON_RAMP_STATES.CRYPTO_MINTING, {
    trigger: 'CRYPTO_TRANSFER_STARTED',
    verificationData: { treasuryBalanceChecked: true, usdtAmount, walletAddress, chainId },
  });
  if (!mintingTransition.success) throw new Error(`Failed to transition to CRYPTO_MINTING: ${mintingTransition.error}`);

  await prisma.momoTransaction.update({ where: { id: transactionId }, data: { lifecycleStage: 'CRYPTO_QUEUED' } });

  try {
    const targetAddress = walletAddress || await getUserWalletAddress(userId);
    if (!targetAddress) throw new Error(`No wallet found for user ${userId}`);

    // DIRECT treasury call (no HTTP)
    const creditResult = await treasuryService.creditUserFromTreasury(
      targetAddress as Address,
      usdtAmount,
      chainId || DEFAULT_CHAIN_ID,
      transactionId,
    );

    if (!creditResult.success) throw new Error(`Treasury credit failed: ${creditResult.error}`);

    const completedTransition = await fsm.transition(ON_RAMP_STATES.COMPLETED, {
      trigger: 'CRYPTO_TRANSFER_SUCCESS',
      verificationData: {
        blockchainTxHash: creditResult.txHash,
        walletAddress: targetAddress,
        creditedAmount: usdtAmount,
        blockNumber: creditResult.blockNumber,
      },
    });

    if (!completedTransition.success) {
      logger.error('Failed to transition to COMPLETED after successful credit', { transactionId, error: completedTransition.error });
    }

    await prisma.momoTransaction.update({
      where: { id: transactionId },
      data: { blockchainTxHash: creditResult.txHash, lifecycleStage: 'COMPLETED' },
    });

    logger.info('Crypto transfer completed successfully', { transactionId, blockchainTxHash: creditResult.txHash });

    // Record commission
    const { commission, netAmount } = commissionService.calculateFiatOnrampCommission(usdtAmount);
    await commissionService.recordCommission({
      userId, transactionId, type: 'FIAT_ONRAMP',
      grossAmount: usdtAmount, commission, netAmount,
      currency: transaction.currency,
      provider: transaction.providerCode || 'localramp',
      blockchainTxHash: creditResult.txHash || undefined,
    });

    // Send push notification
    await sendTransactionNotification(userId, {
      title: 'Deposit Complete',
      message: `Your deposit of ${Number(transaction.amount).toLocaleString()} ${transaction.currency} has been credited as ${netAmount.toFixed(2)} USDC.`,
      type: 'TRANSACTION',
      data: { transactionId, status: 'COMPLETED', txHash: creditResult.txHash },
    });

    return { success: true, blockchainTxHash: creditResult.txHash };

  } catch (error) {
    await fsm.transition(ON_RAMP_STATES.FAILED, {
      trigger: 'CRYPTO_TRANSFER_FAILED',
      errorMessage: error instanceof Error ? error.message : 'Crypto transfer failed',
      verificationData: { failedAt: new Date().toISOString(), attempt: job.attemptsMade + 1 },
    });
    await prisma.momoTransaction.update({
      where: { id: transactionId },
      data: { lifecycleStage: 'FAILED', failureReason: error instanceof Error ? error.message : 'Crypto transfer failed' },
    });
    throw error;
  }
}

export function registerCryptoMintWorker(): void {
  const queueService = getQueueService();
  queueService.registerWorker(QUEUE_NAMES.CRYPTO_MINT, processCryptoMintJob);
  logger.info('Crypto transfer worker registered');
}
