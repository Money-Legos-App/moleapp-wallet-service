import { PrismaClient } from '../../lib/prisma';
import { Address } from 'viem';
import { TurnkeyBaseService } from './base.service.js';
import { TurnkeyEVMSignerService } from './evm-signer.service.js';
import { TurnkeyBitcoinSignerService } from './bitcoin-signer.service.js';
import { TurnkeySolanaSignerService } from './solana-signer.service.js';
import { TurnkeyOrganizationService } from './organization.service.js';
// WebAuthn removed - authentication handled by user-service
import { logger } from '../../utils/logger.js';

/**
 * TurnkeyService - Main orchestrator for Turnkey operations
 * Coordinates between modular turnkey services
 * This replaces the monolithic TurnkeyService
 */
export class TurnkeyService {
  private prisma: PrismaClient;
  private baseService: TurnkeyBaseService;
  private evmSignerService: TurnkeyEVMSignerService;
  private bitcoinSignerService: TurnkeyBitcoinSignerService;
  private solanaSignerService: TurnkeySolanaSignerService;
  private organizationService: TurnkeyOrganizationService;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
    this.baseService = new TurnkeyBaseService();
    this.evmSignerService = new TurnkeyEVMSignerService(prisma);
    this.bitcoinSignerService = new TurnkeyBitcoinSignerService(prisma);
    this.solanaSignerService = new TurnkeySolanaSignerService(prisma);
    this.organizationService = new TurnkeyOrganizationService(prisma);

    logger.info('TurnkeyService orchestrator initialized with chain-specific signers');
  }

  // ===== Organization Management =====

  /**
   * Create or get existing Turnkey sub-organization for user
   */
  async createSubOrganizationForUser(
    userId: string,
    phoneNumber: string,
    userEmail?: string
  ): Promise<{ subOrgId: string; turnkeyUserId: string; walletAddress: Address; allChainAddresses: any }> {
    return this.organizationService.createSubOrganizationForUser(userId, phoneNumber, userEmail);
  }

  // ===== Signer Management =====

  /**
   * Create or get cached ZeroDev-compatible signer for EVM chains only
   */
  async createZeroDevSigner(turnkeySubOrgId: string): Promise<any> {
    return this.evmSignerService.createZeroDevSigner(turnkeySubOrgId);
  }

  /**
   * Create or get cached Bitcoin signer for direct transaction signing
   */
  async createBitcoinSigner(turnkeySubOrgId: string): Promise<any> {
    return this.bitcoinSignerService.createBitcoinSigner(turnkeySubOrgId);
  }

  /**
   * Create or get cached Solana signer for direct transaction signing
   */
  async createSolanaSigner(turnkeySubOrgId: string): Promise<any> {
    return this.solanaSignerService.createSolanaSigner(turnkeySubOrgId);
  }

  /**
   * Get appropriate signer based on chain type
   */
  async getSignerByChainType(turnkeySubOrgId: string, chainType: 'EVM' | 'BITCOIN' | 'SOLANA'): Promise<any> {
    switch (chainType) {
      case 'EVM':
        return this.createZeroDevSigner(turnkeySubOrgId);
      case 'BITCOIN':
        return this.createBitcoinSigner(turnkeySubOrgId);
      case 'SOLANA':
        return this.createSolanaSigner(turnkeySubOrgId);
      default:
        throw new Error(`Unsupported chain type: ${chainType}`);
    }
  }

  /**
   * Update signer with wallet ID association
   */
  async updateSignerWalletId(turnkeySubOrgId: string, walletId: string): Promise<void> {
    return this.evmSignerService.updateSignerWalletId(turnkeySubOrgId, walletId);
  }

  // ===== WebAuthn Integration =====

  // WebAuthn methods removed - authentication handled by user-service

  // ===== Legacy Methods (to be implemented or removed based on usage) =====

  /**
   * Get all wallets from Turnkey by calling actual Turnkey API
   */
  async getAllWalletsFromTurnkey(subOrgId: string): Promise<{ ethereum?: string; solana?: string; bitcoin?: string; bnb?: string }> {
    try {
      logger.info(`🔄 Fetching real wallets from Turnkey API for sub-org: ${subOrgId}`);

      // Call actual Turnkey API to get wallets
      const turnkeyWallets = await this.baseService.getWallets(subOrgId);

      if (!turnkeyWallets || turnkeyWallets.length === 0) {
        logger.warn(`No wallets found in Turnkey API for sub-org: ${subOrgId}`);
        return {};
      }

      // Use the first wallet (Primary Wallet)
      const primaryWallet = turnkeyWallets[0];
      logger.info(`📱 Using primary wallet from Turnkey: ${primaryWallet.walletId}`);

      // Get wallet accounts (addresses) for the primary wallet
      const walletAccounts = await this.baseService.getWalletAccounts(subOrgId, primaryWallet.walletId);

      if (!walletAccounts || walletAccounts.length === 0) {
        logger.warn(`No accounts found in Turnkey API for wallet ${primaryWallet.walletId}`);
        return {};
      }

      logger.info(`🔍 Found ${walletAccounts.length} accounts in Turnkey API`);

      const result: { ethereum?: string; solana?: string; bitcoin?: string; bnb?: string } = {};

      // Extract real addresses from Turnkey API response
      for (const account of walletAccounts) {
        logger.info(`🔑 Processing Turnkey account: curve=${account.curve}, format=${account.addressFormat}, address=${account.address}`);

        if (account.curve === 'CURVE_SECP256K1' && account.addressFormat === 'ADDRESS_FORMAT_ETHEREUM') {
          result.ethereum = account.address;
          result.bnb = account.address; // BNB uses same address as Ethereum (both EVM)
          logger.info(`✅ Real Ethereum/BNB address from Turnkey API: ${account.address}`);
        } else if (account.curve === 'CURVE_ED25519' && account.addressFormat === 'ADDRESS_FORMAT_SOLANA') {
          result.solana = account.address;
          logger.info(`✅ Real Solana address from Turnkey API: ${account.address}`);
        } else if (account.curve === 'CURVE_SECP256K1' && (account.addressFormat === 'ADDRESS_FORMAT_COMPRESSED' || account.addressFormat === 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH')) {
          result.bitcoin = account.address;
          logger.info(`✅ Real Bitcoin address from Turnkey API: ${account.address}`);
        } else {
          logger.warn(`❓ Unknown account type from Turnkey: curve=${account.curve}, format=${account.addressFormat}`);
        }
      }

      logger.info(`🎯 Final real addresses from Turnkey API for sub-org ${subOrgId}:`, result);
      return result;

    } catch (error) {
      logger.error(`❌ Failed to fetch real wallets from Turnkey API for sub-org ${subOrgId}:`, error);
      return {};
    }
  }

  /**
   * Process embedded wallet request (placeholder - needs implementation)
   */
  async processEmbeddedWalletRequest(requestType: string, requestData: any): Promise<any> {
    logger.warn('processEmbeddedWalletRequest called - placeholder implementation');
    // TODO: Implement based on original implementation
    throw new Error('Method not implemented');
  }

  /**
   * Recover wallet (placeholder - needs implementation)
   */
  async recoverWallet(phoneNumber: string): Promise<any> {
    logger.warn('recoverWallet called - placeholder implementation');
    // TODO: Implement based on original implementation
    return null;
  }

  // ===== Cache Management =====

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.evmSignerService.clearSignerCache();
    this.bitcoinSignerService.clearSignerCache();
    this.solanaSignerService.clearSignerCache();
    logger.info('All Turnkey service caches cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): any {
    return {
      evmSigners: this.evmSignerService.getSignerCacheStats(),
      bitcoinSigners: this.bitcoinSignerService.getSignerCacheStats(),
      solanaSigners: this.solanaSignerService.getSignerCacheStats()
    };
  }
}