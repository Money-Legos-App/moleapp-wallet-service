import { PrismaClient } from '@prisma/client';
import { Address } from 'viem';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

/**
 * TurnkeyBitcoinSignerService - Bitcoin-specific signer creation and management
 * Internal service - not exposed via API
 * Handles creation and caching of Bitcoin signers using SECP256K1 curve
 * No Account Abstraction - direct Bitcoin transaction signing
 */
export class TurnkeyBitcoinSignerService extends TurnkeyBaseService {
  private prisma: PrismaClient;
  private signerCache: Map<string, any> = new Map();

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Create or get cached Bitcoin signer for direct transaction signing
   */
  async createBitcoinSigner(turnkeySubOrgId: string): Promise<any> {
    const cacheKey = `bitcoin-${turnkeySubOrgId}`;

    // Check cache first to prevent recreation
    if (this.signerCache.has(cacheKey)) {
      logger.info(`Using cached Bitcoin signer for sub-org ${turnkeySubOrgId}`);
      return this.signerCache.get(cacheKey);
    }

    try {
      logger.info(`Creating Bitcoin signer for sub-org ${turnkeySubOrgId}`);

      // Get the signer record from database
      const signerRecord = await this.prisma.turnkeySigner.findFirst({
        where: { turnkeySubOrgId, isActive: true }
      });

      if (!signerRecord) {
        throw new Error(`No active Turnkey signer found for sub-org ${turnkeySubOrgId}`);
      }

      // Get Bitcoin address from stored chain addresses
      const allChainAddresses = (signerRecord.passkeyConfig as any)?.allChainAddresses || {};
      const bitcoinAddress = allChainAddresses['BITCOIN_TESTNET']?.address;

      if (!bitcoinAddress) {
        throw new Error(`No Bitcoin address found for sub-org ${turnkeySubOrgId}`);
      }

      // Create deterministic private key for Bitcoin (SECP256K1)
      const privateKeyHash = crypto
        .createHash('sha256')
        .update('bitcoin-' + turnkeySubOrgId + env.turnkeyApiPrivateKey)
        .digest('hex');

      const privateKey = '0x' + privateKeyHash;

      logger.info(`Created Bitcoin signer for sub-org ${turnkeySubOrgId}`);

      const signer = {
        privateKey,
        address: bitcoinAddress,
        turnkeyUserId: signerRecord.turnkeyUserId,
        turnkeySubOrgId: signerRecord.turnkeySubOrgId,
        curve: 'SECP256K1',
        chainType: 'BITCOIN'
      };

      // Cache the signer to prevent recreation
      this.signerCache.set(cacheKey, signer);

      return signer;

    } catch (error) {
      logger.error(`Failed to create Bitcoin signer for sub-org ${turnkeySubOrgId}:`, error);
      throw new Error(`Failed to create Bitcoin signer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sign Bitcoin transaction (placeholder - implement with proper Bitcoin lib)
   */
  async signBitcoinTransaction(turnkeySubOrgId: string, transaction: any): Promise<any> {
    try {
      const signer = await this.createBitcoinSigner(turnkeySubOrgId);

      // TODO: Implement actual Bitcoin transaction signing
      logger.info(`Bitcoin transaction signing for ${turnkeySubOrgId} - placeholder implementation`);

      return {
        txHash: 'bitcoin-tx-hash-placeholder',
        signature: 'bitcoin-signature-placeholder'
      };

    } catch (error) {
      logger.error(`Failed to sign Bitcoin transaction:`, error);
      throw error;
    }
  }

  /**
   * Clear cached signers (useful for testing or memory management)
   */
  clearSignerCache(): void {
    this.signerCache.clear();
    logger.info('Bitcoin signer cache cleared');
  }

  /**
   * Get signer cache statistics
   */
  getSignerCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.signerCache.size,
      keys: Array.from(this.signerCache.keys())
    };
  }
}