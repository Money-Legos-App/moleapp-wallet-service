import { Address, Hex, encodeFunctionData, parseAbi } from 'viem';
import { PrismaClient } from '../../lib/prisma';
import { logger } from '../../utils/logger.js';
import { KernelService } from './account-abstraction.service.js';

/**
 * Hyperliquid Bridge Service
 *
 * Handles USDC deposits and withdrawals to/from the Hyperliquid bridge
 * on Arbitrum Sepolia using Account Abstraction (gasless UserOperations).
 *
 * Capital Flow:
 *   Deposit:  User's Kernel Smart Wallet → USDC.approve → HLBridge.deposit
 *   Withdraw: HLBridge.withdraw → USDC back to Smart Wallet
 *
 * All operations are gasless via Pimlico paymaster.
 */
export class HyperliquidBridgeService {
  private prisma: PrismaClient;
  private kernelService: KernelService;

  // Contract addresses (configurable via env)
  private hlBridgeAddress: Address;
  private usdcAddress: Address;
  private chainId: number;

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;

    this.hlBridgeAddress = (process.env.HL_BRIDGE_ADDRESS || '0x0000000000000000000000000000000000000000') as Address;
    this.usdcAddress = (process.env.USDC_ADDRESS_ARBITRUM_SEPOLIA || '0x0000000000000000000000000000000000000000') as Address;
    this.chainId = 421614; // Arbitrum Sepolia
  }

  /**
   * Build call data for depositing USDC to Hyperliquid bridge.
   *
   * Produces two calls bundled into a single UserOperation:
   * 1. USDC.approve(HL_BRIDGE, amount)
   * 2. HLBridge.sendUsd(destination, amount)
   *
   * @param usdcAmount - Amount in USDC atomic units (6 decimals)
   * @param userAddress - User's address on Hyperliquid L1 (receives the deposit)
   */
  buildDepositCalls(
    usdcAmount: bigint,
    userAddress: Address,
  ): { to: Address; value: bigint; data: Hex }[] {
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    // 1. Approve USDC spending by bridge contract
    const approveData = encodeFunctionData({
      abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
      functionName: 'approve',
      args: [this.hlBridgeAddress, usdcAmount],
    });

    calls.push({
      to: this.usdcAddress,
      value: 0n,
      data: approveData,
    });

    // 2. Deposit USDC to Hyperliquid bridge
    // Hyperliquid bridge uses sendUsd(destination, amount) where destination
    // is the address that will receive funds on HL L1
    const depositData = encodeFunctionData({
      abi: parseAbi(['function sendUsd(address destination, uint64 amount)']),
      functionName: 'sendUsd',
      args: [userAddress, usdcAmount],
    });

    calls.push({
      to: this.hlBridgeAddress,
      value: 0n,
      data: depositData,
    });

    return calls;
  }

  /**
   * Execute a USDC deposit to Hyperliquid bridge as a gasless UserOperation.
   *
   * @param walletId - User's wallet ID (for Kernel account lookup)
   * @param missionId - Mission ID for tracking
   * @param usdcAmount - Amount in USDC atomic units (6 decimals)
   * @param userAddress - User's EOA address on Hyperliquid L1
   */
  async depositToHyperliquid(
    walletId: string,
    missionId: string,
    usdcAmount: bigint,
    userAddress: Address,
  ): Promise<{ userOpHash: Hex; success: boolean }> {
    try {
      logger.info('Building HL bridge deposit UserOp', {
        walletId,
        missionId,
        amount: usdcAmount.toString(),
        userAddress,
      });

      const calls = this.buildDepositCalls(usdcAmount, userAddress);

      // Submit as gasless UserOperation via Pimlico paymaster
      const result = await this.kernelService.submitUserOperation(
        walletId,
        this.chainId,
        calls,
        true, // sponsor gas
      );

      // Record the bridge operation
      await this.prisma.deFiBundledOperation.create({
        data: {
          walletId,
          chainId: this.chainId,
          userOpHash: result.userOpHash,
          protocol: 'HYPERLIQUID_BRIDGE',
          operations: [{
            type: 'DEPOSIT',
            missionId,
            amount: usdcAmount.toString(),
            destination: userAddress,
          }] as any,
          callsCount: calls.length,
          status: 'PENDING',
          metadata: {
            sponsoredGas: true,
            bundlingStrategy: 'HL_BRIDGE_DEPOSIT',
            missionId,
          },
        },
      });

      logger.info('HL bridge deposit UserOp submitted', {
        missionId,
        userOpHash: result.userOpHash,
      });

      return {
        userOpHash: result.userOpHash,
        success: true,
      };

    } catch (error) {
      logger.error('HL bridge deposit failed', {
        missionId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Build call data for withdrawing USDC from Hyperliquid bridge.
   *
   * Note: On Hyperliquid, only the MASTER address can initiate withdrawals.
   * This builds the L1 withdrawal request that must be signed by the master EOA.
   * The actual bridge withdrawal is initiated on Hyperliquid L1, not via a
   * smart contract call. This method handles the Arbitrum-side claim if needed.
   *
   * @param usdcAmount - Amount in USDC atomic units (6 decimals)
   * @param recipientAddress - Address to receive USDC on Arbitrum
   */
  buildWithdrawalClaimCalls(
    usdcAmount: bigint,
    recipientAddress: Address,
  ): { to: Address; value: bigint; data: Hex }[] {
    // Withdrawal from HL is a two-step process:
    // 1. User initiates withdrawal on HL L1 (signed by master EOA via Turnkey)
    // 2. After bridge processing, USDC arrives on Arbitrum
    // This method is for any Arbitrum-side claim operations if needed
    // For now, HL bridge withdrawals land directly in the user's L2 address
    return [];
  }

  /**
   * Get the configured bridge addresses for verification.
   */
  getBridgeConfig(): { hlBridgeAddress: Address; usdcAddress: Address; chainId: number } {
    return {
      hlBridgeAddress: this.hlBridgeAddress,
      usdcAddress: this.usdcAddress,
      chainId: this.chainId,
    };
  }
}
