import { PrismaClient } from '../../lib/prisma';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';

export type ExportChain = 'ethereum' | 'bitcoin' | 'solana';

const CHAIN_TO_USER_ADDRESS_TYPE: Record<Exclude<ExportChain, 'ethereum'>, string> = {
  bitcoin: 'BITCOIN',
  solana: 'SOLANA',
};

/**
 * TurnkeyExportService - Handles wallet export via Turnkey API.
 *
 * Uses Turnkey's exportWallet (full mnemonic) and exportWalletAccount
 * (per-chain private key) activities. Both return an HPKE-encrypted bundle
 * that can only be decrypted by the client using their ephemeral P256 key.
 * The backend never sees plaintext key material.
 */
export class TurnkeyExportService extends TurnkeyBaseService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Export the master wallet mnemonic — recovers all chains (ETH, BTC, SOL).
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

    const signer = await this.prisma.turnkeySigner.findFirst({
      where: { userId, isActive: true },
    });

    if (!signer) {
      throw new Error('No active wallet found for this user');
    }

    const wallets = await this.getWallets(signer.turnkeySubOrgId);

    if (!wallets || wallets.length === 0) {
      throw new Error('No Turnkey wallet found for this user');
    }

    const walletId = wallets[0].walletId;

    logger.info(`Initiating mnemonic export for user ${userId}, wallet ${walletId}`);

    const serverClient = this.getServerClient();
    const result = await serverClient.exportWallet({
      organizationId: signer.turnkeySubOrgId,
      walletId,
      targetPublicKey,
    });

    const exportBundle = (result as any)?.exportBundle;

    if (!exportBundle) {
      throw new Error('Export failed - no bundle returned from Turnkey');
    }

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

    logger.info(`Mnemonic export bundle generated for user ${userId}`);

    return { exportBundle };
  }

  /**
   * Export the raw private key for a single chain (ETH / BTC / SOL).
   * Resolves the user's address for that chain, then asks Turnkey to
   * export just that wallet account.
   */
  async exportWalletPrivateKey(
    userId: string,
    chain: ExportChain,
    targetPublicKey: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ exportBundle: string; address: string; chain: ExportChain }> {
    if (!env.enableWalletExport) {
      throw new Error('Wallet export is not enabled');
    }

    const signer = await this.prisma.turnkeySigner.findFirst({
      where: { userId, isActive: true },
    });

    if (!signer) {
      throw new Error('No active wallet found for this user');
    }

    const address = await this.resolveChainAddress(userId, signer.address, chain);

    logger.info(`Initiating ${chain} private-key export for user ${userId}, address ${address}`);

    const serverClient = this.getServerClient();
    const result = await serverClient.exportWalletAccount({
      organizationId: signer.turnkeySubOrgId,
      address,
      targetPublicKey,
    });

    const exportBundle = (result as any)?.exportBundle;

    if (!exportBundle) {
      throw new Error('Export failed - no bundle returned from Turnkey');
    }

    await this.prisma.auditLog.create({
      data: {
        userId,
        action: `EXPORT_WALLET_PRIVATE_KEY_${chain.toUpperCase()}`,
        entityType: 'TurnkeySigner',
        entityId: signer.id,
        ipAddress: ipAddress || null,
        userAgent: userAgent || null,
      },
    });

    logger.info(`${chain} private-key export bundle generated for user ${userId}`);

    return { exportBundle, address, chain };
  }

  private async resolveChainAddress(
    userId: string,
    signerAddress: string,
    chain: ExportChain
  ): Promise<string> {
    if (chain === 'ethereum') {
      // The Turnkey signer's primary EOA address is the EVM account.
      if (!signerAddress) {
        throw new Error('No Ethereum address found for this user');
      }
      return signerAddress;
    }

    const chainType = CHAIN_TO_USER_ADDRESS_TYPE[chain];
    const userAddress = await this.prisma.userAddress.findFirst({
      where: { userId, chainType, isActive: true },
      orderBy: { isPrimary: 'desc' },
    });

    if (!userAddress?.address) {
      throw new Error(`No ${chain} address found for this user`);
    }

    return userAddress.address;
  }
}
