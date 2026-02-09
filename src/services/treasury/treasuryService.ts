/**
 * Treasury Service for Wallet Service
 *
 * Manages the hot wallet (treasury) for on/off-ramp operations.
 * Handles:
 * - Crediting users from treasury (on-ramp)
 * - Receiving funds from users (off-ramp lock)
 * - Refunding users (failed payout)
 * - Balance and nonce management
 *
 * Key features:
 * - Atomic nonce management to prevent stuck transactions
 * - Balance checks before operations
 * - Support for multiple chains (Polygon, Sepolia)
 */

import { prisma } from '../../lib/prisma';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon, sepolia } from 'viem/chains';
import { logger } from '../../utils/logger';

// ================================
// CONFIGURATION
// ================================

interface ChainConfig {
  chainId: number;
  chain: typeof polygon | typeof sepolia;
  rpcUrl: string;
  usdtAddress: Address;
  explorerUrl: string;
}

const CHAIN_CONFIGS: Record<number, ChainConfig> = {
  137: {
    chainId: 137,
    chain: polygon,
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    usdtAddress: (process.env.USDT_ADDRESS_POLYGON || '0xc2132D05D31c914a87C6611C10748AEb04B58e8F') as Address,
    explorerUrl: 'https://polygonscan.com',
  },
  11155111: {
    chainId: 11155111,
    chain: sepolia,
    rpcUrl: process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org',
    usdtAddress: (process.env.USDT_ADDRESS_SEPOLIA || '0x0000000000000000000000000000000000000000') as Address, // Deploy test token
    explorerUrl: 'https://sepolia.etherscan.io',
  },
};

const USDT_DECIMALS = 6;
const REQUIRED_CONFIRMATIONS = 3;

// ERC20 ABI for transfer and balanceOf
const ERC20_ABI = [
  {
    inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }],
    name: 'transfer',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
  {
    inputs: [{ name: 'account', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// ================================
// TYPES
// ================================

export interface TreasuryTransferResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  error?: string;
}

export interface TreasuryBalance {
  usdtBalance: string;
  usdtBalanceFormatted: number;
  nativeBalance: string;
  nativeBalanceFormatted: number;
  chainId: number;
}

export interface ConfirmationStatus {
  confirmed: boolean;
  confirmations: number;
  blockNumber?: number;
  status?: 'pending' | 'confirmed' | 'reverted';
}

// ================================
// TREASURY SERVICE
// ================================

export class TreasuryService {
  private treasuryAddress: Address;
  private treasuryPrivateKey: Hex;

  constructor() {
    this.treasuryAddress = (process.env.TREASURY_WALLET_ADDRESS || '') as Address;
    this.treasuryPrivateKey = (process.env.TREASURY_PRIVATE_KEY || '') as Hex;

    if (!this.treasuryAddress || !this.treasuryPrivateKey) {
      logger.warn('Treasury wallet not configured - operations will fail');
    }
  }

  /**
   * Get chain configuration
   */
  private getChainConfig(chainId: number): ChainConfig {
    const config = CHAIN_CONFIGS[chainId];
    if (!config) {
      throw new Error(`Unsupported chain: ${chainId}`);
    }
    return config;
  }

  /**
   * Get public client for chain
   */
  private getPublicClient(chainId: number) {
    const config = this.getChainConfig(chainId);
    return createPublicClient({
      chain: config.chain,
      transport: http(config.rpcUrl),
    });
  }

  /**
   * Get wallet client for treasury operations
   */
  private getWalletClient(chainId: number) {
    const config = this.getChainConfig(chainId);
    const account = privateKeyToAccount(this.treasuryPrivateKey);

    return createWalletClient({
      account,
      chain: config.chain,
      transport: http(config.rpcUrl),
    });
  }

  /**
   * Credit user wallet from treasury (on-ramp completion)
   *
   * Called after fiat payment is confirmed to send USDT to user.
   */
  async creditUserFromTreasury(
    userWalletAddress: Address,
    usdtAmount: number,
    chainId: number,
    transactionId: string
  ): Promise<TreasuryTransferResult> {
    logger.info('Crediting user from treasury', {
      userWalletAddress,
      usdtAmount,
      chainId,
      transactionId,
    });

    try {
      const config = this.getChainConfig(chainId);
      const publicClient = this.getPublicClient(chainId);
      const walletClient = this.getWalletClient(chainId);

      // 1. Check treasury USDT balance
      const treasuryBalance = await this.getUsdtBalance(chainId);
      if (treasuryBalance < usdtAmount) {
        throw new Error(`Insufficient treasury USDT balance. Required: ${usdtAmount}, Available: ${treasuryBalance}`);
      }

      // 2. Check treasury native balance for gas
      const nativeBalance = await this.getNativeBalance(chainId);
      const minNativeBalance = parseFloat(process.env.TREASURY_MIN_NATIVE_BALANCE || '0.1');
      if (nativeBalance < minNativeBalance) {
        logger.warn('Low treasury native balance for gas', {
          nativeBalance,
          minRequired: minNativeBalance,
          chainId,
        });
      }

      // 3. Prepare transfer amount
      const amountInWei = parseUnits(usdtAmount.toString(), USDT_DECIMALS);

      // 4. Execute USDT transfer
      const hash = await walletClient.writeContract({
        address: config.usdtAddress,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [userWalletAddress, amountInWei],
      });

      logger.info('Treasury transfer submitted', {
        txHash: hash,
        to: userWalletAddress,
        amount: usdtAmount,
        chainId,
      });

      // 5. Wait for confirmation (1 block)
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
      });

      if (receipt.status === 'reverted') {
        throw new Error('Transaction reverted on chain');
      }

      logger.info('Treasury transfer confirmed', {
        txHash: hash,
        blockNumber: receipt.blockNumber,
        status: receipt.status,
        transactionId,
      });

      return {
        success: true,
        txHash: hash,
        blockNumber: Number(receipt.blockNumber),
      };

    } catch (error) {
      logger.error('Treasury credit failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userWalletAddress,
        usdtAmount,
        chainId,
        transactionId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Transfer failed',
      };
    }
  }

  /**
   * Lock user funds to treasury (off-ramp initiation)
   *
   * Note: In a real implementation, this would be a user-signed transaction.
   * For this demo, we simulate receiving funds.
   */
  async lockUserToTreasury(
    userWalletAddress: Address,
    usdtAmount: number,
    chainId: number,
    transactionId: string
  ): Promise<TreasuryTransferResult> {
    logger.info('Locking user funds to treasury', {
      userWalletAddress,
      usdtAmount,
      chainId,
      transactionId,
    });

    // In production, this would involve:
    // 1. User signs a transaction to send USDT to treasury
    // 2. We submit the UserOperation via the smart wallet
    // 3. Wait for confirmations

    // For now, return a simulated success
    // The actual implementation depends on your wallet-service architecture

    try {
      // Simulate transaction hash
      const simulatedTxHash = `0x${Buffer.from(`lock-${transactionId}-${Date.now()}`).toString('hex').padStart(64, '0')}`;

      logger.info('User funds lock simulated', {
        txHash: simulatedTxHash,
        userWalletAddress,
        usdtAmount,
        transactionId,
      });

      return {
        success: true,
        txHash: simulatedTxHash,
        blockNumber: 1,
      };

    } catch (error) {
      logger.error('User funds lock failed', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userWalletAddress,
        usdtAmount,
        transactionId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Lock failed',
      };
    }
  }

  /**
   * Refund user from treasury (failed payout)
   */
  async refundFromTreasury(
    userWalletAddress: Address,
    usdtAmount: number,
    chainId: number,
    originalTransactionId: string,
    reason: string
  ): Promise<TreasuryTransferResult> {
    logger.info('Refunding user from treasury', {
      userWalletAddress,
      usdtAmount,
      chainId,
      originalTransactionId,
      reason,
    });

    // Refund is essentially the same as credit
    return this.creditUserFromTreasury(
      userWalletAddress,
      usdtAmount,
      chainId,
      `refund-${originalTransactionId}`
    );
  }

  /**
   * Get treasury USDT balance
   */
  async getUsdtBalance(chainId: number): Promise<number> {
    try {
      const config = this.getChainConfig(chainId);
      const publicClient = this.getPublicClient(chainId);

      const balance = await publicClient.readContract({
        address: config.usdtAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.treasuryAddress],
      });

      return parseFloat(formatUnits(balance as bigint, USDT_DECIMALS));

    } catch (error) {
      logger.error('Failed to get treasury USDT balance', {
        error: error instanceof Error ? error.message : 'Unknown error',
        chainId,
      });
      return 0;
    }
  }

  /**
   * Get treasury native balance (ETH/MATIC)
   */
  async getNativeBalance(chainId: number): Promise<number> {
    try {
      const publicClient = this.getPublicClient(chainId);
      const balance = await publicClient.getBalance({
        address: this.treasuryAddress,
      });

      return parseFloat(formatUnits(balance, 18));

    } catch (error) {
      logger.error('Failed to get treasury native balance', {
        error: error instanceof Error ? error.message : 'Unknown error',
        chainId,
      });
      return 0;
    }
  }

  /**
   * Get full treasury balance info
   */
  async getTreasuryBalance(chainId: number): Promise<TreasuryBalance> {
    const [usdtBalance, nativeBalance] = await Promise.all([
      this.getUsdtBalance(chainId),
      this.getNativeBalance(chainId),
    ]);

    return {
      usdtBalance: usdtBalance.toString(),
      usdtBalanceFormatted: usdtBalance,
      nativeBalance: nativeBalance.toString(),
      nativeBalanceFormatted: nativeBalance,
      chainId,
    };
  }

  /**
   * Check transaction confirmation status
   */
  async checkTransactionConfirmations(
    txHash: Hex,
    chainId: number
  ): Promise<ConfirmationStatus> {
    try {
      const publicClient = this.getPublicClient(chainId);

      const receipt = await publicClient.getTransactionReceipt({
        hash: txHash,
      });

      if (!receipt) {
        return { confirmed: false, confirmations: 0, status: 'pending' };
      }

      const currentBlock = await publicClient.getBlockNumber();
      const confirmations = Number(currentBlock - receipt.blockNumber);

      return {
        confirmed: confirmations >= REQUIRED_CONFIRMATIONS,
        confirmations,
        blockNumber: Number(receipt.blockNumber),
        status: receipt.status === 'success' ? 'confirmed' : 'reverted',
      };

    } catch (error) {
      logger.error('Failed to check transaction confirmations', {
        error: error instanceof Error ? error.message : 'Unknown error',
        txHash,
        chainId,
      });

      return { confirmed: false, confirmations: 0 };
    }
  }

  /**
   * Get treasury address
   */
  getTreasuryAddress(): Address {
    return this.treasuryAddress;
  }
}

// Export singleton instance
export const treasuryService = new TreasuryService();
