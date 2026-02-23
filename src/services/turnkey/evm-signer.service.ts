import { PrismaClient } from '../../lib/prisma';
import { Address, Hex } from 'viem';
import { privateKeyToAccount, signTypedData as viemSignTypedData, signMessage as viemSignMessage } from 'viem/accounts';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import { createAccount } from '@turnkey/viem';
import { TurnkeyServerClient } from '@turnkey/sdk-server';
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import crypto from 'crypto';

/**
 * TurnkeyEVMSignerService - EVM-specific signer creation and management
 * Internal service - not exposed via API
 * Handles creation and caching of ZeroDev-compatible signers for EVM chains only
 *
 * When USE_TURNKEY_VIEM_SIGNER=true (default), signing is proxied to Turnkey's API
 * using the actual HD-derived key (m/44'/60'/0'/0/0). When false, falls back to
 * legacy SHA256-derived local key (for emergency rollback only).
 */
export class TurnkeyEVMSignerService extends TurnkeyBaseService {
  private prisma: PrismaClient;
  private signerCache: Map<string, any> = new Map();

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Create or get cached ZeroDev-compatible signer for EVM chains.
   * Uses @turnkey/viem to create a Turnkey-backed viem account that proxies
   * all signing operations to Turnkey's server-side API.
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

      // Get the signer record from database (has the real Turnkey ETH address)
      let signerRecord = await this.prisma.turnkeySigner.findFirst({
        where: { turnkeySubOrgId, isActive: true }
      });

      if (!signerRecord) {
        // Wait briefly and retry once - TurnkeySigner may be created during registration flow
        logger.warn(`TurnkeySigner not found for sub-org ${turnkeySubOrgId}, retrying once...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        signerRecord = await this.prisma.turnkeySigner.findFirst({
          where: { turnkeySubOrgId, isActive: true }
        });

        if (!signerRecord) {
          throw new Error(`No active Turnkey signer found for sub-org ${turnkeySubOrgId}`);
        }

        logger.info(`TurnkeySigner found on retry for sub-org ${turnkeySubOrgId}`);
      }

      let viemAccount: any;

      if (env.useTurnkeyViemSigner) {
        // NEW: Turnkey-backed viem account — signing proxied to Turnkey API
        // The kernel account owner will be the REAL Turnkey HD-derived address
        // Use the HTTP TurnkeyClient (not TurnkeyServerClient) so that
        // organizationId is passed per-request, allowing parent-org API keys
        // to sign for sub-orgs without org mismatch errors.
        const httpClient = this.getTurnkeyClient();

        viemAccount = await createAccount({
          client: httpClient,
          organizationId: turnkeySubOrgId,      // User's sub-org (NOT root org)
          signWith: signerRecord.address,        // Real Turnkey ETH address
          ethereumAddress: signerRecord.address,  // Skip extra API call to fetch address
        });

        // Verify the address matches what's in the database
        if (viemAccount.address.toLowerCase() !== signerRecord.address.toLowerCase()) {
          logger.error(`Address mismatch! Turnkey account: ${viemAccount.address}, DB record: ${signerRecord.address}`);
          throw new Error('Turnkey account address does not match database record');
        }

        logger.info(`Created Turnkey-backed signer for sub-org ${turnkeySubOrgId}, address: ${viemAccount.address}`);
      } else {
        // LEGACY: SHA256-derived local key (emergency rollback only)
        logger.warn(`Using legacy SHA256 signer for sub-org ${turnkeySubOrgId} (USE_TURNKEY_VIEM_SIGNER=false)`);
        const privateKeyHash = crypto
          .createHash('sha256')
          .update(turnkeySubOrgId + env.turnkeyApiPrivateKey)
          .digest('hex');
        viemAccount = privateKeyToAccount(('0x' + privateKeyHash) as `0x${string}`);
      }

      // Cache the signer to prevent recreation
      this.signerCache.set(cacheKey, viemAccount);

      return viemAccount;

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
   * Sign a message via Turnkey API (used for Hyperliquid legacy signing)
   */
  async signMessage(
    turnkeySubOrgId: string,
    message: string | Hex
  ): Promise<string> {
    try {
      // Get the Turnkey-backed account (proxies signing to Turnkey API)
      const account = await this.createZeroDevSigner(turnkeySubOrgId);

      const signature = await account.signMessage({
        message: typeof message === 'string' && !message.startsWith('0x')
          ? message
          : { raw: message as Hex }
      });

      logger.info('Message signed successfully via Turnkey', { subOrgId: turnkeySubOrgId });
      return signature;

    } catch (error) {
      logger.error('Failed to sign message', { subOrgId: turnkeySubOrgId, error });
      throw new Error(`Failed to sign message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sign EIP-712 typed data via Turnkey API
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
      // Get the Turnkey-backed account (proxies signing to Turnkey API)
      const account = await this.createZeroDevSigner(turnkeySubOrgId);

      const primaryType = Object.keys(types).find(k => k !== 'EIP712Domain') || 'Message';

      const signature = await account.signTypedData({
        domain,
        types,
        primaryType,
        message
      });

      logger.info('EIP-712 typed data signed successfully via Turnkey', {
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
}

/**
 * Standalone EvmSignerService for use without Prisma constructor dependency.
 * Used by agentController for signing operations.
 *
 * Initializes its own TurnkeyClient and looks up signer records from the
 * shared Prisma instance to create Turnkey-backed signing accounts.
 */
export class EvmSignerService {
  private signerCache: Map<string, any> = new Map();
  private serverClient: TurnkeyServerClient;

  constructor() {
    this.serverClient = new TurnkeyServerClient({
      apiBaseUrl: env.turnkeyBaseUrl,
      organizationId: env.turnkeyOrganizationId,
      stamper: new ApiKeyStamper({
        apiPublicKey: env.turnkeyApiPublicKey,
        apiPrivateKey: env.turnkeyApiPrivateKey,
      }),
    });
  }

  /**
   * Get or create a Turnkey-backed viem account for a sub-org
   */
  private async getTurnkeyAccount(turnkeySubOrgId: string): Promise<any> {
    const cacheKey = `account-${turnkeySubOrgId}`;
    if (this.signerCache.has(cacheKey)) {
      return this.signerCache.get(cacheKey);
    }

    // Import the shared prisma singleton
    const { prisma } = await import('../../lib/prisma.js');
    const signerRecord = await prisma.turnkeySigner.findFirst({
      where: { turnkeySubOrgId, isActive: true }
    });

    if (!signerRecord) {
      throw new Error(`No active Turnkey signer found for sub-org ${turnkeySubOrgId}`);
    }

    let account: any;

    if (env.useTurnkeyViemSigner) {
      // Turnkey-backed viem account — signing proxied to Turnkey API
      account = await createAccount({
        client: this.serverClient,
        organizationId: turnkeySubOrgId,
        signWith: signerRecord.address,
        ethereumAddress: signerRecord.address,
      });
    } else {
      // Legacy SHA256 fallback
      const privateKeyHash = crypto
        .createHash('sha256')
        .update(turnkeySubOrgId + env.turnkeyApiPrivateKey)
        .digest('hex');
      account = privateKeyToAccount(('0x' + privateKeyHash) as `0x${string}`);
    }

    this.signerCache.set(cacheKey, account);
    return account;
  }

  /**
   * Sign a message via Turnkey API
   */
  async signMessage(
    turnkeySubOrgId: string,
    message: string | Hex
  ): Promise<string> {
    try {
      const account = await this.getTurnkeyAccount(turnkeySubOrgId);

      const signature = await account.signMessage({
        message: typeof message === 'string' && !message.startsWith('0x')
          ? message
          : { raw: message as Hex }
      });

      logger.info('Message signed successfully via Turnkey', { subOrgId: turnkeySubOrgId });
      return signature;

    } catch (error) {
      logger.error('Failed to sign message', { subOrgId: turnkeySubOrgId, error });
      throw new Error(`Failed to sign message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Sign EIP-712 typed data via Turnkey API
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
      const account = await this.getTurnkeyAccount(turnkeySubOrgId);

      const primaryType = Object.keys(types).find(k => k !== 'EIP712Domain') || 'Message';

      const signature = await account.signTypedData({
        domain,
        types,
        primaryType,
        message
      });

      logger.info('EIP-712 typed data signed successfully via Turnkey', {
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
}
