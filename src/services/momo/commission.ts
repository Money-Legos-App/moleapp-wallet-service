import { logger } from '../../utils/logger';
import { prisma } from '../../lib/prisma';

export class CommissionService {
  private get onRampRate(): number {
    return parseFloat(process.env.ON_RAMP_FEE_PERCENT || '0.0075');
  }

  private get offRampRate(): number {
    return parseFloat(process.env.OFF_RAMP_FEE_PERCENT || '0.01');
  }

  calculateFiatOnrampCommission(grossAmount: number): {
    commission: number;
    netAmount: number;
    commissionRate: number;
  } {
    const commission = grossAmount * this.onRampRate;
    const netAmount = grossAmount - commission;
    logger.info('Calculated fiat onramp commission', { grossAmount, commission, netAmount, commissionRate: this.onRampRate });
    return { commission, netAmount, commissionRate: this.onRampRate };
  }

  calculateFiatOfframpCommission(grossAmount: number): {
    commission: number;
    netAmount: number;
    commissionRate: number;
  } {
    const commission = grossAmount * this.offRampRate;
    const netAmount = grossAmount - commission;
    logger.info('Calculated fiat offramp commission', { grossAmount, commission, netAmount, commissionRate: this.offRampRate });
    return { commission, netAmount, commissionRate: this.offRampRate };
  }

  async recordCommission(data: {
    userId: string;
    transactionId: string;
    type: 'FIAT_ONRAMP' | 'FIAT_OFFRAMP';
    grossAmount: number;
    commission: number;
    netAmount: number;
    currency: string;
    provider?: string;
    blockchainTxHash?: string;
    metadata?: any;
  }): Promise<void> {
    try {
      await prisma.commissionRecord.create({
        data: {
          userId: data.userId,
          transactionId: data.transactionId,
          type: data.type,
          grossAmount: data.grossAmount,
          commission: data.commission,
          netAmount: data.netAmount,
          currency: data.currency,
          provider: data.provider,
          blockchainTxHash: data.blockchainTxHash,
          metadata: data.metadata,
        },
      });
      logger.info('Commission recorded', { userId: data.userId, type: data.type, commission: data.commission, transactionId: data.transactionId });
    } catch (error) {
      logger.error('Failed to record commission', { error: error instanceof Error ? error.message : String(error), data });
    }
  }

  async getCommissionStats(timeframe: 'daily' | 'weekly' | 'monthly' | 'yearly'): Promise<{
    totalCommission: number;
    onRampCommission: number;
    offRampCommission: number;
    totalTransactions: number;
    averageCommissionPerTransaction: number;
    timeframe: string;
  }> {
    const now = new Date();
    const startDate = new Date();
    switch (timeframe) {
      case 'daily': startDate.setDate(now.getDate() - 1); break;
      case 'weekly': startDate.setDate(now.getDate() - 7); break;
      case 'monthly': startDate.setMonth(now.getMonth() - 1); break;
      case 'yearly': startDate.setFullYear(now.getFullYear() - 1); break;
    }
    const records = await prisma.commissionRecord.findMany({ where: { createdAt: { gte: startDate } } });
    const totalCommission = records.reduce((sum, r) => sum + r.commission, 0);
    const onRampCommission = records.filter(r => r.type === 'FIAT_ONRAMP').reduce((sum, r) => sum + r.commission, 0);
    const offRampCommission = records.filter(r => r.type === 'FIAT_OFFRAMP').reduce((sum, r) => sum + r.commission, 0);
    return {
      totalCommission, onRampCommission, offRampCommission,
      totalTransactions: records.length,
      averageCommissionPerTransaction: records.length > 0 ? totalCommission / records.length : 0,
      timeframe,
    };
  }

  async getUserCommissionPaid(userId: string): Promise<{
    totalCommissionPaid: number;
    onRampCommissionPaid: number;
    offRampCommissionPaid: number;
    transactionCount: number;
  }> {
    const records = await prisma.commissionRecord.findMany({ where: { userId } });
    return {
      totalCommissionPaid: records.reduce((sum, r) => sum + r.commission, 0),
      onRampCommissionPaid: records.filter(r => r.type === 'FIAT_ONRAMP').reduce((sum, r) => sum + r.commission, 0),
      offRampCommissionPaid: records.filter(r => r.type === 'FIAT_OFFRAMP').reduce((sum, r) => sum + r.commission, 0),
      transactionCount: records.length,
    };
  }
}

export default CommissionService;
