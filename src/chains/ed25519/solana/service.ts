import { PrismaClient } from '../../../lib/prisma';
import { Address } from 'viem';
import { logger } from '../../../utils/logger.js';
import { ChainService, CreateWalletResponse, TransactionRequest, TransactionResponse, BalanceResponse } from '../../types.js';

/**
 * Solana Chain Service
 * Handles Solana operations with Turnkey signer integration (Ed25519 curve)
 * No Account Abstraction - direct Solana transactions
 */
export class SolanaService implements ChainService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Create Solana wallet (Turnkey signer with Ed25519 curve)
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
      logger.info(`Creating Solana wallet for ${chainConfig.name}`);

      // Check if wallet with this address already exists on this chain
      // Solana uses chainId: 0 for non-EVM chains
      const existingSolanaWallet = await this.prisma.wallet.findUnique({
        where: {
          address_chainId: {
            address: walletAddress,
            chainId: 0
          }
        }
      });

      let wallet;
      if (existingSolanaWallet) {
        logger.warn(`⚠️ [SOLANA] Wallet ${walletAddress} already exists, updating...`);
        wallet = await this.prisma.wallet.update({
          where: { id: existingSolanaWallet.id },
          data: {
            userId,
            name: walletName,
            isActive: true,
            lastActivityAt: new Date(),
            metadata: {
              chainKey: 'SOLANA_DEVNET',
              chainType: 'SOLANA',
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
            chainId: 0, // Solana uses 0 for non-EVM chains
            walletType: 'solana_wallet',
            deploymentStatus: 'deployed', // Solana wallets are immediately "deployed"
            ownerAddress: walletAddress,
            isActive: true,
            metadata: {
              chainKey: 'SOLANA_DEVNET',
              chainType: 'SOLANA',
              turnkeySubOrgId: subOrgId,
              turnkeyUserId: turnkeyUserId,
              createdVia: 'multichain'
            }
          }
        });
      }

      // Solana doesn't use kernel accounts (no Account Abstraction)
      // Note: TurnkeySigner records are now managed by user-service during passkey registration

      const result: CreateWalletResponse = {
        walletId: wallet.id,
        address: walletAddress,
        chainId: 0, // Solana uses 0
        deploymentStatus: 'deployed',
        turnkeySubOrgId: subOrgId,
        turnkeyUserId: turnkeyUserId
      };

      logger.info(`Successfully created Solana wallet: ${result.address}`);
      return result;

    } catch (error) {
      logger.error(`Failed to create Solana wallet:`, error);
      throw new Error(`Failed to create Solana wallet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Submit Solana transaction (native Solana transaction)
   */
  async submitTransaction(request: TransactionRequest): Promise<TransactionResponse> {
    try {
      logger.info(`Submitting Solana transaction for wallet ${request.walletId}`);

      // Validate wallet exists and is Solana
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: request.walletId }
      });

      if (!wallet) {
        throw new Error('Solana wallet not found');
      }

      if (wallet.chainId !== 0 || (wallet.metadata as any)?.chainType !== 'SOLANA') {
        throw new Error('Invalid wallet type for Solana transaction');
      }

      // TODO: Implement actual Solana transaction submission
      // This would involve:
      // 1. Getting Turnkey signer for the wallet (Ed25519)
      // 2. Building Solana transaction
      // 3. Signing with Turnkey
      // 4. Broadcasting to Solana network

      throw new Error('Solana transaction submission not implemented - requires real Solana library integration and proper transaction building');

    } catch (error) {
      logger.error(`Failed to submit Solana transaction:`, error);
      throw error;
    }
  }

  /**
   * Get Solana wallet balance
   */
  async getBalance(address: Address): Promise<BalanceResponse> {
    try {
      logger.info(`Getting Solana balance for address ${address}`);

      throw new Error('Solana balance fetching not implemented - requires Solana RPC integration');

    } catch (error) {
      logger.error(`Failed to get Solana balance:`, error);
      throw error;
    }
  }

  /**
   * Ensure TurnkeySigner exists and is properly linked
   */
  // TurnkeySigner management removed - handled by user-service during passkey registration
}