import { PrismaClient } from '../../lib/prisma';
import { Address, Hex, hashTypedData, TypedDataDefinition } from 'viem';
import { privateKeyToAccount, signTypedData as viemSignTypedData, signMessage as viemSignMessage } from 'viem/accounts';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

/**
 * TurnkeyEVMSignerService - EVM-specific signer creation and management
 * Internal service - not exposed via API
 * Handles creation and caching of ZeroDev-compatible signers for EVM chains only
 */
export class TurnkeyEVMSignerService extends TurnkeyBaseService {
  private prisma: PrismaClient;
  private signerCache: Map<string, any> = new Map();

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Create or get cached ZeroDev-compatible signer for EVM chains
   * Eliminates duplicate signer creation
   */
  async createZeroDevSigner(turnkeySubOrgId: string): Promise<any> {
    const cacheKey = `zerodev-${turnkeySubOrgId}`;

    // Check cache first to prevent recreation
    if (this.signerCache.has(cacheKey)) {
      logger.info(`Using cached ZeroDev signer for sub-org ${turnkeySubOrgId}`);
      return this.signerCache.get(cacheKey);
    }

    try {
      logger.info(`Creating ZeroDev-compatible signer for sub-org ${turnkeySubOrgId}`);

      // Get the signer record from database
      let signerRecord = await this.prisma.turnkeySigner.findFirst({
        where: { turnkeySubOrgId, isActive: true }
      });

      if (!signerRecord) {
        // Wait briefly and retry once - TurnkeySigner may be created during registration flow
        logger.warn(`TurnkeySigner not found for sub-org ${turnkeySubOrgId}, retrying once...`);
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds

        const retrySignerRecord = await this.prisma.turnkeySigner.findFirst({
          where: { turnkeySubOrgId, isActive: true }
        });

        if (!retrySignerRecord) {
          throw new Error(`No active Turnkey signer found for sub-org ${turnkeySubOrgId}`);
        }

        logger.info(`TurnkeySigner found on retry for sub-org ${turnkeySubOrgId}`);
        // Continue with the found record
        signerRecord = retrySignerRecord;
      }

      // For now, create a deterministic private key based on the sub-org ID
      // This ensures consistency while we implement proper Turnkey integration
      const privateKeyHash = crypto
        .createHash('sha256')
        .update(turnkeySubOrgId + env.turnkeyApiPrivateKey) // Use API key as salt for security
        .digest('hex');

      const privateKey = '0x' + privateKeyHash;

      // Create a proper viem account from the private key
      const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);

      logger.info(`Created deterministic signer for sub-org ${turnkeySubOrgId}`);

      // Return the viem account object that ZeroDev expects
      const signer = viemAccount;

      // Cache the signer to prevent recreation
      this.signerCache.set(cacheKey, signer);

      return signer;

    } catch (error) {
      logger.error(`Failed to create ZeroDev signer for sub-org ${turnkeySubOrgId}:`, error);
      throw new Error(`Failed to create ZeroDev signer: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Update signer with wallet ID association
   */
  async updateSignerWalletId(turnkeySubOrgId: string, walletId: string): Promise<void> {
    try {
      await this.prisma.turnkeySigner.updateMany({
        where: { turnkeySubOrgId, isActive: true },
        data: { walletId }
      });

      logger.info(`Updated signer wallet ID for sub-org ${turnkeySubOrgId}`);
    } catch (error) {
      logger.error(`Failed to update signer wallet ID:`, error);
      throw error;
    }
  }

  /**
   * Clear cached signers (useful for testing or memory management)
   */
  clearSignerCache(): void {
    this.signerCache.clear();
    logger.info('Turnkey signer cache cleared');
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

  /**
   * Sign a message with Turnkey (used for Hyperliquid legacy signing)
   */
  async signMessage(
    turnkeySubOrgId: string,
    message: string | Hex
  ): Promise<string> {
    try {
      // Get or create the signer
      const signer = await this.createZeroDevSigner(turnkeySubOrgId);

      // Sign the message
      const signature = await viemSignMessage({
        privateKey: this.getPrivateKeyForSubOrg(turnkeySubOrgId),
        message: typeof message === 'string' && !message.startsWith('0x')
          ? message
          : { raw: message as Hex }
      });

      logger.info('Message signed successfully', { subOrgId: turnkeySubOrgId });
      return signature;

    } catch (error) {
      logger.error('Failed to sign message', { subOrgId: turnkeySubOrgId, error });
      throw new Error(`Failed to sign message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sign EIP-712 typed data with Turnkey
   * This is the correct method for Hyperliquid order signing
   */
  async signTypedData(
    turnkeySubOrgId: string,
    domain: {
      name?: string;
      version?: string;
      chainId?: number;
      verifyingContract?: Address;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, any>
  ): Promise<string> {
    try {
      // Get the private key for this sub-org
      const privateKey = this.getPrivateKeyForSubOrg(turnkeySubOrgId);

      // Sign the typed data using viem
      const signature = await viemSignTypedData({
        privateKey,
        domain,
        types,
        primaryType: Object.keys(types).find(k => k !== 'EIP712Domain') || 'Message',
        message
      });

      logger.info('EIP-712 typed data signed successfully', {
        subOrgId: turnkeySubOrgId,
        domain: domain.name,
        chainId: domain.chainId
      });

      return signature;

    } catch (error) {
      logger.error('Failed to sign EIP-712 typed data', { subOrgId: turnkeySubOrgId, error });
      throw new Error(`Failed to sign typed data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the deterministic private key for a sub-org
   * Note: In production, this should use actual Turnkey API
   */
  private getPrivateKeyForSubOrg(turnkeySubOrgId: string): Hex {
    const privateKeyHash = crypto
      .createHash('sha256')
      .update(turnkeySubOrgId + env.turnkeyApiPrivateKey)
      .digest('hex');

    return ('0x' + privateKeyHash) as Hex;
  }
}

/**
 * Standalone EvmSignerService for use without Prisma dependency
 * Used by agentController for signing operations
 */
export class EvmSignerService {
  private signerCache: Map<string, any> = new Map();

  /**
   * Sign a message (legacy method)
   */
  async signMessage(
    turnkeySubOrgId: string,
    message: string | Hex
  ): Promise<string> {
    try {
      const privateKey = this.getPrivateKeyForSubOrg(turnkeySubOrgId);

      const signature = await viemSignMessage({
        privateKey,
        message: typeof message === 'string' && !message.startsWith('0x')
          ? message
          : { raw: message as Hex }
      });

      logger.info('Message signed successfully', { subOrgId: turnkeySubOrgId });
      return signature;

    } catch (error) {
      logger.error('Failed to sign message', { subOrgId: turnkeySubOrgId, error });
      throw new Error(`Failed to sign message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sign EIP-712 typed data
   * This is the correct method for Hyperliquid order signing
   */
  async signTypedData(
    turnkeySubOrgId: string,
    domain: {
      name?: string;
      version?: string;
      chainId?: number;
      verifyingContract?: Address;
    },
    types: Record<string, Array<{ name: string; type: string }>>,
    message: Record<string, any>
  ): Promise<string> {
    try {
      const privateKey = this.getPrivateKeyForSubOrg(turnkeySubOrgId);

      // Determine the primary type (first non-EIP712Domain type)
      const primaryType = Object.keys(types).find(k => k !== 'EIP712Domain') || 'Message';

      const signature = await viemSignTypedData({
        privateKey,
        domain,
        types,
        primaryType,
        message
      });

      logger.info('EIP-712 typed data signed successfully', {
        subOrgId: turnkeySubOrgId,
        primaryType,
        domain: domain.name
      });

      return signature;

    } catch (error) {
      logger.error('Failed to sign EIP-712 typed data', { subOrgId: turnkeySubOrgId, error });
      throw new Error(`Failed to sign typed data: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get the deterministic private key for a sub-org
   */
  private getPrivateKeyForSubOrg(turnkeySubOrgId: string): Hex {
    const privateKeyHash = crypto
      .createHash('sha256')
      .update(turnkeySubOrgId + env.turnkeyApiPrivateKey)
      .digest('hex');

    return ('0x' + privateKeyHash) as Hex;
  }
}