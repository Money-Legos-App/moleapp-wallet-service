/**
 * Bridge Poller Service
 * Background poller for bridge operations:
 *   1. PENDING → DEPOSIT_CONFIRMED (UserOp mined on origin)
 *   2. DEPOSIT_CONFIRMED → FILLED (Across relayer fills on Arbitrum)
 *   3. DEPOSIT_CONFIRMED → REFUNDED (Across refund/expiry)
 */

import { PrismaClient } from '../../lib/prisma';
import { AcrossClientService } from './across-client.service.js';
import { logger } from '../../utils/logger.js';

export class BridgePollerService {
  private prisma: PrismaClient;
  private acrossClient: AcrossClientService;
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(prisma: PrismaClient, pollIntervalMs = 15_000) {
    this.prisma = prisma;
    this.acrossClient = new AcrossClientService();
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    logger.info('BridgePoller started', { intervalMs: this.pollIntervalMs });
    this.timer = setInterval(() => {
      this.poll().catch(err => {
        logger.error('BridgePoller cycle failed', { error: err.message });
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('BridgePoller stopped');
  }

  private async poll(): Promise<void> {
    await this.promotePendingToDeposited();
    await this.promoteDepositedToFilled();
  }

  /**
   * Phase 1: PENDING → DEPOSIT_CONFIRMED
   * Check if UserOp has been mined (confirmed in UserOperation table).
   */
  private async promotePendingToDeposited(): Promise<void> {
    const pendingOps = await this.prisma.bridgeOperation.findMany({
      where: { status: 'PENDING' },
      take: 50,
    });

    for (const op of pendingOps) {
      try {
        const userOp = await this.prisma.userOperation.findUnique({
          where: { userOpHash: op.userOpHash },
          select: { status: true, transactionHash: true },
        });

        if (userOp?.status === 'confirmed' && userOp.transactionHash) {
          await this.prisma.bridgeOperation.update({
            where: { id: op.id },
            data: {
              status: 'DEPOSIT_CONFIRMED',
              depositTxHash: userOp.transactionHash,
            },
          });
          logger.info('Bridge op: PENDING → DEPOSIT_CONFIRMED', {
            bridgeOperationId: op.id,
            depositTxHash: userOp.transactionHash,
          });
        } else if (userOp?.status === 'reverted' || userOp?.status === 'failed') {
          await this.prisma.bridgeOperation.update({
            where: { id: op.id },
            data: { status: 'FAILED' },
          });
          logger.warn('Bridge op: PENDING → FAILED (UserOp reverted)', {
            bridgeOperationId: op.id,
          });
        }
      } catch (err: any) {
        logger.warn('Error checking pending bridge op', {
          bridgeOperationId: op.id,
          error: err.message,
        });
      }
    }
  }

  /**
   * Phase 2: DEPOSIT_CONFIRMED → FILLED or REFUNDED
   * Poll Across /deposit/status for fill or refund.
   */
  private async promoteDepositedToFilled(): Promise<void> {
    const depositedOps = await this.prisma.bridgeOperation.findMany({
      where: {
        status: 'DEPOSIT_CONFIRMED',
        depositTxHash: { not: null },
      },
      take: 20,
    });

    for (const op of depositedOps) {
      try {
        const acrossStatus = await this.acrossClient.getDepositStatus(
          op.depositTxHash!,
          op.originChainId,
        );

        if (acrossStatus.status === 'filled' && acrossStatus.fillTxHash) {
          await this.prisma.bridgeOperation.update({
            where: { id: op.id },
            data: {
              status: 'FILLED',
              fillTxHash: acrossStatus.fillTxHash,
              outputAmount: acrossStatus.outputAmount,
            },
          });
          logger.info('Bridge op: DEPOSIT_CONFIRMED → FILLED', {
            bridgeOperationId: op.id,
            fillTxHash: acrossStatus.fillTxHash,
            missionId: op.missionId,
          });
        } else if (acrossStatus.status === 'expired') {
          await this.prisma.bridgeOperation.update({
            where: { id: op.id },
            data: { status: 'REFUNDED' },
          });
          logger.warn('Bridge op: DEPOSIT_CONFIRMED → REFUNDED', {
            bridgeOperationId: op.id,
            missionId: op.missionId,
          });
        }
      } catch (err: any) {
        logger.warn('Error checking Across fill status', {
          bridgeOperationId: op.id,
          error: err.message,
        });
      }
    }
  }
}
