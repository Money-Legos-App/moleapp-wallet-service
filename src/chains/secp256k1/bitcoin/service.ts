import { PrismaClient } from '@prisma/client';
import { Address } from 'viem';
import { logger } from '../../../utils/logger.js';
import { ChainService, CreateWalletResponse, TransactionRequest, TransactionResponse, BalanceResponse } from '../../types.js';

/**
 * Bitcoin Chain Service
 * Handles Bitcoin operations with Turnkey signer integration
 * No Account Abstraction - direct Bitcoin transactions
 */
export class BitcoinService implements ChainService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create Bitcoin wallet (Turnkey signer only)
   */
  async createWallet(params: {
    userId: string;
    subOrgId: string;
    turnkeyUserId: string;
    walletAddress: Address;
    chainConfig: any;
  }): Promise<CreateWalletResponse> {
    const { userId, subOrgId, turnkeyUserId, walletAddress, chainConfig } = params;
    const walletName = `${chainConfig.name} Wallet`;

    try {
      logger.info(`Creating Bitcoin wallet for ${chainConfig.name}`);

      // Check if wallet with this address already exists on this chain
      // Bitcoin uses chainId: 0 for non-EVM chains
      const existingBitcoinWallet = await this.prisma.wallet.findUnique({
        where: {
          address_chainId: {
            address: walletAddress,
            chainId: 0
          }
        }
      });

      let wallet;
      if (existingBitcoinWallet) {
        logger.warn(`⚠️ [BITCOIN] Wallet ${walletAddress} already exists, updating...`);
        wallet = await this.prisma.wallet.update({
          where: { id: existingBitcoinWallet.id },
          data: {
            userId,
            name: walletName,
            isActive: true,
            lastActivityAt: new Date(),
            metadata: {
              chainKey: 'BITCOIN_TESTNET',
              chainType: 'BITCOIN',
              turnkeySubOrgId: subOrgId,
              turnkeyUserId: turnkeyUserId,
              createdVia: 'multichain',
              updatedAt: new Date().toISOString()
            }
          }
        });
      } else {
        wallet = await this.prisma.wallet.create({
          data: {
            userId,
            address: walletAddress,
            name: walletName,
            chainId: 0, // Bitcoin uses 0 for non-EVM chains
            walletType: 'bitcoin_wallet',
            deploymentStatus: 'deployed', // Bitcoin wallets are immediately "deployed"
            ownerAddress: walletAddress,
            isActive: true,
            metadata: {
              chainKey: 'BITCOIN_TESTNET',
              chainType: 'BITCOIN',
              turnkeySubOrgId: subOrgId,
              turnkeyUserId: turnkeyUserId,
              createdVia: 'multichain'
            }
          }
        });
      }

      // Bitcoin doesn't use kernel accounts (no Account Abstraction)
      // Note: TurnkeySigner records are now managed by user-service during passkey registration

      const result: CreateWalletResponse = {
        walletId: wallet.id,
        address: walletAddress,
        chainId: 0, // Bitcoin uses 0
        deploymentStatus: 'deployed',
        turnkeySubOrgId: subOrgId,
        turnkeyUserId: turnkeyUserId
      };

      logger.info(`Successfully created Bitcoin wallet: ${result.address}`);
      return result;

    } catch (error) {
      logger.error(`Failed to create Bitcoin wallet:`, error);
      throw new Error(`Failed to create Bitcoin wallet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Submit Bitcoin transaction (native Bitcoin transaction)
   */
  async submitTransaction(request: TransactionRequest): Promise<TransactionResponse> {
    try {
      logger.info(`Submitting Bitcoin transaction for wallet ${request.walletId}`);

      // Validate wallet exists and is Bitcoin
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: request.walletId }
      });

      if (!wallet) {
        throw new Error('Bitcoin wallet not found');
      }

      if (wallet.chainId !== 0 || (wallet.metadata as any)?.chainType !== 'BITCOIN') {
        throw new Error('Invalid wallet type for Bitcoin transaction');
      }

      // TODO: Implement actual Bitcoin transaction submission
      // This would involve:
      // 1. Getting Turnkey signer for the wallet
      // 2. Building Bitcoin transaction
      // 3. Signing with Turnkey
      // 4. Broadcasting to Bitcoin network

      throw new Error('Bitcoin transaction submission not implemented - requires Bitcoin library integration and UTXO management');

    } catch (error) {
      logger.error(`Failed to submit Bitcoin transaction:`, error);
      throw error;
    }
  }

  /**
   * Get Bitcoin wallet balance
   */
  async getBalance(address: Address): Promise<BalanceResponse> {
    try {
      logger.info(`Getting Bitcoin balance for address ${address}`);

      throw new Error('Bitcoin balance fetching not implemented - requires Bitcoin blockchain API integration');

    } catch (error) {
      logger.error(`Failed to get Bitcoin balance:`, error);
      throw error;
    }
  }

  /**
   * Ensure TurnkeySigner exists and is properly linked
   */
  // TurnkeySigner management removed - handled by user-service during passkey registration
}