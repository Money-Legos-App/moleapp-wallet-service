import { PrismaClient } from '../../lib/prisma';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';

/**
 * TurnkeyExportService - Handles wallet export (mnemonic) via Turnkey API
 *
 * Uses Turnkey's exportWallet activity to return an HPKE-encrypted bundle
 * that can only be decrypted by the client using their ephemeral P256 key.
 * The backend never sees the plaintext mnemonic.
 */
export class TurnkeyExportService extends TurnkeyBaseService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Export wallet mnemonic (seed phrase) as an encrypted bundle.
   *
   * @param userId - The user requesting the export
   * @param targetPublicKey - P256 uncompressed public key (hex, starts with 04)
   * @param ipAddress - Request IP for audit logging
   * @param userAgent - Request user-agent for audit logging
   * @returns Encrypted export bundle string
   */
  async exportWalletMnemonic(
    userId: string,
    targetPublicKey: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ exportBundle: string }> {
    if (!env.enableWalletExport) {
      throw new Error('Wallet export is not enabled');
    }

    // 1. Look up the user's TurnkeySigner to get sub-org ID
    const signer = await this.prisma.turnkeySigner.findFirst({
      where: { userId, isActive: true },
    });

    if (!signer) {
      throw new Error('No active wallet found for this user');
    }

    // 2. Fetch wallets from Turnkey to get the wallet ID
    const wallets = await this.getWallets(signer.turnkeySubOrgId);

    if (!wallets || wallets.length === 0) {
      throw new Error('No Turnkey wallet found for this user');
    }

    const walletId = wallets[0].walletId;

    logger.info(`Initiating wallet export for user ${userId}, wallet ${walletId}`);

    // 3. Call Turnkey exportWallet activity
    const serverClient = this.getServerClient();
    const result = await serverClient.exportWallet({
      walletId,
      targetPublicKey,
    });

    const exportBundle = (result as any)?.exportBundle;

    if (!exportBundle) {
      throw new Error('Export failed - no bundle returned from Turnkey');
    }

    // 4. Write audit log entry
    await this.prisma.auditLog.create({
      data: {
        userId,
        action: 'EXPORT_WALLET_MNEMONIC',
        entityType: 'TurnkeySigner',
        entityId: signer.id,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
      },
    });

    logger.info(`Wallet export bundle generated for user ${userId}`);

    return { exportBundle };
  }
}
