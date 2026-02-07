import { PrismaClient } from '@prisma/client';
import { Address } from 'viem';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

/**
 * TurnkeySolanaSignerService - Solana-specific signer creation and management
 * Internal service - not exposed via API
 * Handles creation and caching of Solana signers using Ed25519 curve
 * No Account Abstraction - direct Solana transaction signing
 */
export class TurnkeySolanaSignerService extends TurnkeyBaseService {
  private prisma: PrismaClient;
  private signerCache: Map<string, any> = new Map();

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Create or get cached Solana signer for direct transaction signing
   */
  async createSolanaSigner(turnkeySubOrgId: string): Promise<any> {
    const cacheKey = `solana-${turnkeySubOrgId}`;

    // Check cache first to prevent recreation
    if (this.signerCache.has(cacheKey)) {
      logger.info(`Using cached Solana signer for sub-org ${turnkeySubOrgId}`);
      return this.signerCache.get(cacheKey);
    }

    try {
      logger.info(`Creating Solana signer for sub-org ${turnkeySubOrgId}`);

      // Get the signer record from database
      const signerRecord = await this.prisma.turnkeySigner.findFirst({
        where: { turnkeySubOrgId, isActive: true }
      });

      if (!signerRecord) {
        throw new Error(`No active Turnkey signer found for sub-org ${turnkeySubOrgId}`);
      }

      // Get Solana address from stored chain addresses
      const allChainAddresses = (signerRecord.passkeyConfig as any)?.allChainAddresses || {};
      const solanaAddress = allChainAddresses['SOLANA_DEVNET']?.address;

      if (!solanaAddress) {
        throw new Error(`No Solana address found for sub-org ${turnkeySubOrgId}`);
      }

      // Create deterministic key for Solana (Ed25519)
      // Note: This is a placeholder - real implementation would use proper Ed25519 key derivation
      const keyHash = crypto
        .createHash('sha256')
        .update('solana-' + turnkeySubOrgId + env.turnkeyApiPrivateKey)
        .digest('hex');

      // Ed25519 keys are 32 bytes, take first 32 bytes of hash
      const ed25519Key = keyHash.substring(0, 64); // 32 bytes in hex

      logger.info(`Created Solana signer for sub-org ${turnkeySubOrgId}`);

      const signer = {
        privateKey: ed25519Key,
        address: solanaAddress,
        turnkeyUserId: signerRecord.turnkeyUserId,
        turnkeySubOrgId: signerRecord.turnkeySubOrgId,
        curve: 'ED25519',
        chainType: 'SOLANA'
      };

      // Cache the signer to prevent recreation
      this.signerCache.set(cacheKey, signer);

      return signer;

    } catch (error) {
      logger.error(`Failed to create Solana signer for sub-org ${turnkeySubOrgId}:`, error);
      throw new Error(`Failed to create Solana signer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sign Solana transaction (placeholder - implement with proper Solana lib)
   */
  async signSolanaTransaction(turnkeySubOrgId: string, transaction: any): Promise<any> {
    try {
      const signer = await this.createSolanaSigner(turnkeySubOrgId);

      // TODO: Implement actual Solana transaction signing
      logger.info(`Solana transaction signing for ${turnkeySubOrgId} - placeholder implementation`);

      return {
        txHash: 'solana-tx-hash-placeholder',
        signature: 'solana-signature-placeholder'
      };

    } catch (error) {
      logger.error(`Failed to sign Solana transaction:`, error);
      throw error;
    }
  }

  /**
   * Clear cached signers (useful for testing or memory management)
   */
  clearSignerCache(): void {
    this.signerCache.clear();
    logger.info('Solana signer cache cleared');
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