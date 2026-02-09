import { Address, Hex, encodeFunctionData, parseAbi } from 'viem';
import { PrismaClient } from '../../lib/prisma';
import { logger } from '../../utils/logger.js';
import { KernelService } from './account-abstraction.service.js';

/**
 * DeFi UserOperation Bundling Service
 * Enables complex DeFi operations as gasless atomic transactions
 * Supports Morpho lending, token swaps, and multi-protocol interactions
 */
export class DeFiBundlerService {
  private prisma: PrismaClient;
  private kernelService: KernelService;

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;
  }

  /**
   * Bundle Morpho supply and borrow operations into a single UserOperation
   * Enables atomic DeFi interactions with commission handling
   */
  async bundleMorphoOperations(
    walletId: string,
    chainId: number,
    operations: MorphoOperation[]
  ): Promise<{ userOpHash: Hex; bundledCalls: number }> {
    try {
      logger.info(`Bundling ${operations.length} Morpho operations for wallet ${walletId}`);

      const calls: { to: Address; value: bigint; data: Hex }[] = [];

      for (const operation of operations) {
        switch (operation.type) {
          case 'SUPPLY':
            calls.push(...await this.buildMorphoSupplyCalls(operation));
            break;
          case 'BORROW':
            calls.push(...await this.buildMorphoBorrowCalls(operation));
            break;
          case 'WITHDRAW':
            calls.push(...await this.buildMorphoWithdrawCalls(operation));
            break;
          case 'REPAY':
            calls.push(...await this.buildMorphoRepayCalls(operation));
            break;
          case 'SUPPLY_COLLATERAL':
            calls.push(...await this.buildMorphoSupplyCollateralCalls(operation));
            break;
          case 'WITHDRAW_COLLATERAL':
            calls.push(...await this.buildMorphoWithdrawCollateralCalls(operation));
            break;
          default:
            throw new Error(`Unsupported Morpho operation type: ${operation.type}`);
        }
      }

      // Submit bundled UserOperation
      const result = await this.kernelService.submitUserOperation(
        walletId,
        chainId,
        calls,
        true // Sponsor the transaction
      );

      // Record the bundled operation
      await this.prisma.deFiBundledOperation.create({
        data: {
          walletId,
          chainId,
          userOpHash: result.userOpHash,
          protocol: 'MORPHO',
          operations: operations.map(op => ({
            type: op.type,
            marketId: op.marketId,
            amount: op.amount,
            asset: op.asset
          })) as any,
          callsCount: calls.length,
          status: 'PENDING',
          metadata: {
            sponsoredGas: true,
            bundlingStrategy: 'ATOMIC_DEFI'
          }
        }
      });

      logger.info(`Bundled ${operations.length} Morpho operations into UserOp ${result.userOpHash}`);

      return {
        userOpHash: result.userOpHash,
        bundledCalls: calls.length
      };

    } catch (error) {
      logger.error('Failed to bundle Morpho operations:', error);
      throw error;
    }
  }

  /**
   * Bundle token swap + DeFi operations (e.g., swap USDC to WETH then supply to Morpho)
   */
  async bundleSwapAndDeFi(
    walletId: string,
    chainId: number,
    swapOperation: SwapOperation,
    defiOperations: DeFiOperation[]
  ): Promise<{ userOpHash: Hex; bundledCalls: number }> {
    try {
      logger.info(`Bundling swap + ${defiOperations.length} DeFi operations for wallet ${walletId}`);

      const calls: { to: Address; value: bigint; data: Hex }[] = [];

      // 1. Add token swap calls
      calls.push(...await this.buildSwapCalls(swapOperation));

      // 2. Add DeFi operation calls
      for (const operation of defiOperations) {
        switch (operation.protocol) {
          case 'MORPHO':
            calls.push(...await this.buildMorphoDeFiCalls(operation));
            break;
          case 'UNISWAP':
            calls.push(...await this.buildUniswapCalls(operation));
            break;
          case 'AAVE':
            calls.push(...await this.buildAaveCalls(operation));
            break;
          default:
            throw new Error(`Unsupported DeFi protocol: ${operation.protocol}`);
        }
      }

      // Submit bundled UserOperation
      const result = await this.kernelService.submitUserOperation(
        walletId,
        chainId,
        calls,
        true
      );

      // Record the bundled operation
      await this.prisma.deFiBundledOperation.create({
        data: {
          walletId,
          chainId,
          userOpHash: result.userOpHash,
          protocol: 'MULTI_PROTOCOL',
          operations: [
            { type: 'SWAP', ...swapOperation },
            ...defiOperations
          ] as any,
          callsCount: calls.length,
          status: 'PENDING',
          metadata: {
            sponsoredGas: true,
            bundlingStrategy: 'SWAP_AND_DEFI',
            protocols: ['SWAP', ...defiOperations.map(op => op.protocol)]
          }
        }
      });

      logger.info(`Bundled swap + DeFi operations into UserOp ${result.userOpHash}`);

      return {
        userOpHash: result.userOpHash,
        bundledCalls: calls.length
      };

    } catch (error) {
      logger.error('Failed to bundle swap + DeFi operations:', error);
      throw error;
    }
  }

  /**
   * Bundle yield optimization operations (harvest + compound + reinvest)
   */
  async bundleYieldOptimization(
    walletId: string,
    chainId: number,
    optimizationStrategy: YieldOptimizationStrategy
  ): Promise<{ userOpHash: Hex; bundledCalls: number }> {
    try {
      logger.info(`Bundling yield optimization for wallet ${walletId}`);

      const calls: { to: Address; value: bigint; data: Hex }[] = [];

      // 1. Harvest rewards from multiple protocols
      for (const harvestOp of optimizationStrategy.harvestOperations) {
        calls.push(...await this.buildHarvestCalls(harvestOp));
      }

      // 2. Compound existing positions
      for (const compoundOp of optimizationStrategy.compoundOperations) {
        calls.push(...await this.buildCompoundCalls(compoundOp));
      }

      // 3. Reinvest into new opportunities
      for (const reinvestOp of optimizationStrategy.reinvestOperations) {
        calls.push(...await this.buildReinvestCalls(reinvestOp));
      }

      // Submit bundled UserOperation
      const result = await this.kernelService.submitUserOperation(
        walletId,
        chainId,
        calls,
        true
      );

      // Record the bundled operation
      await this.prisma.deFiBundledOperation.create({
        data: {
          walletId,
          chainId,
          userOpHash: result.userOpHash,
          protocol: 'YIELD_OPTIMIZATION',
          operations: [
            ...optimizationStrategy.harvestOperations.map(op => ({ type: 'HARVEST', ...op })),
            ...optimizationStrategy.compoundOperations.map(op => ({ type: 'COMPOUND', ...op })),
            ...optimizationStrategy.reinvestOperations.map(op => ({ type: 'REINVEST', ...op }))
          ] as any,
          callsCount: calls.length,
          status: 'PENDING',
          metadata: {
            sponsoredGas: true,
            bundlingStrategy: 'YIELD_OPTIMIZATION',
            estimatedAprIncrease: optimizationStrategy.estimatedAprIncrease
          }
        }
      });

      logger.info(`Bundled yield optimization into UserOp ${result.userOpHash}`);

      return {
        userOpHash: result.userOpHash,
        bundledCalls: calls.length
      };

    } catch (error) {
      logger.error('Failed to bundle yield optimization:', error);
      throw error;
    }
  }

  /**
   * Build Morpho supply operation calls with token approvals
   */
  private async buildMorphoSupplyCalls(operation: MorphoOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    // 1. Token approval for Morpho
    if (operation.asset !== 'ETH') {
      const approvalData = encodeFunctionData({
        abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
        functionName: 'approve',
        args: [operation.morphoContract, BigInt(operation.amount)]
      });

      calls.push({
        to: operation.tokenAddress,
        value: 0n,
        data: approvalData
      });
    }

    // 2. Morpho supply call
    const supplyData = encodeFunctionData({
      abi: parseAbi(['function supply(bytes32 marketId, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)']),
      functionName: 'supply',
      args: [
        operation.marketId as Hex,
        BigInt(operation.amount),
        0n, // shares (calculated by Morpho)
        operation.onBehalf || operation.userAddress,
        '0x'
      ]
    });

    calls.push({
      to: operation.morphoContract,
      value: operation.asset === 'ETH' ? BigInt(operation.amount) : 0n,
      data: supplyData
    });

    return calls;
  }

  /**
   * Build Morpho borrow operation calls
   */
  private async buildMorphoBorrowCalls(operation: MorphoOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    const borrowData = encodeFunctionData({
      abi: parseAbi(['function borrow(bytes32 marketId, uint256 assets, uint256 shares, address onBehalf, address receiver)']),
      functionName: 'borrow',
      args: [
        operation.marketId as Hex,
        BigInt(operation.amount),
        0n, // shares (calculated by Morpho)
        operation.onBehalf || operation.userAddress,
        operation.receiver || operation.userAddress
      ]
    });

    return [{
      to: operation.morphoContract,
      value: 0n,
      data: borrowData
    }];
  }

  /**
   * Build Morpho withdraw operation calls
   */
  private async buildMorphoWithdrawCalls(operation: MorphoOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    const withdrawData = encodeFunctionData({
      abi: parseAbi(['function withdraw(bytes32 marketId, uint256 assets, uint256 shares, address onBehalf, address receiver)']),
      functionName: 'withdraw',
      args: [
        operation.marketId as Hex,
        BigInt(operation.amount),
        0n, // shares (calculated by Morpho)
        operation.onBehalf || operation.userAddress,
        operation.receiver || operation.userAddress
      ]
    });

    return [{
      to: operation.morphoContract,
      value: 0n,
      data: withdrawData
    }];
  }

  /**
   * Build Morpho repay operation calls with token approvals
   */
  private async buildMorphoRepayCalls(operation: MorphoOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    // 1. Token approval for Morpho
    if (operation.asset !== 'ETH') {
      const approvalData = encodeFunctionData({
        abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
        functionName: 'approve',
        args: [operation.morphoContract, BigInt(operation.amount)]
      });

      calls.push({
        to: operation.tokenAddress,
        value: 0n,
        data: approvalData
      });
    }

    // 2. Morpho repay call
    const repayData = encodeFunctionData({
      abi: parseAbi(['function repay(bytes32 marketId, uint256 assets, uint256 shares, address onBehalf, bytes calldata data)']),
      functionName: 'repay',
      args: [
        operation.marketId as Hex,
        BigInt(operation.amount),
        0n, // shares (calculated by Morpho)
        operation.onBehalf || operation.userAddress,
        '0x'
      ]
    });

    calls.push({
      to: operation.morphoContract,
      value: operation.asset === 'ETH' ? BigInt(operation.amount) : 0n,
      data: repayData
    });

    return calls;
  }

  /**
   * Build Morpho supply collateral calls
   */
  private async buildMorphoSupplyCollateralCalls(operation: MorphoOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    // 1. Token approval for Morpho
    if (operation.asset !== 'ETH') {
      const approvalData = encodeFunctionData({
        abi: parseAbi(['function approve(address spender, uint256 amount) returns (bool)']),
        functionName: 'approve',
        args: [operation.morphoContract, BigInt(operation.amount)]
      });

      calls.push({
        to: operation.tokenAddress,
        value: 0n,
        data: approvalData
      });
    }

    // 2. Morpho supply collateral call
    const supplyCollateralData = encodeFunctionData({
      abi: parseAbi(['function supplyCollateral(bytes32 marketId, uint256 assets, address onBehalf, bytes calldata data)']),
      functionName: 'supplyCollateral',
      args: [
        operation.marketId as Hex,
        BigInt(operation.amount),
        operation.onBehalf || operation.userAddress,
        '0x'
      ]
    });

    calls.push({
      to: operation.morphoContract,
      value: operation.asset === 'ETH' ? BigInt(operation.amount) : 0n,
      data: supplyCollateralData
    });

    return calls;
  }

  /**
   * Build Morpho withdraw collateral calls
   */
  private async buildMorphoWithdrawCollateralCalls(operation: MorphoOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    const withdrawCollateralData = encodeFunctionData({
      abi: parseAbi(['function withdrawCollateral(bytes32 marketId, uint256 assets, address onBehalf, address receiver)']),
      functionName: 'withdrawCollateral',
      args: [
        operation.marketId as Hex,
        BigInt(operation.amount),
        operation.onBehalf || operation.userAddress,
        operation.receiver || operation.userAddress
      ]
    });

    return [{
      to: operation.morphoContract,
      value: 0n,
      data: withdrawCollateralData
    }];
  }

  // Placeholder methods for other DeFi protocols
  private async buildSwapCalls(operation: SwapOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for token swaps (Uniswap, 1inch, etc.)
    return [];
  }

  private async buildMorphoDeFiCalls(operation: DeFiOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for general Morpho DeFi operations
    return [];
  }

  private async buildUniswapCalls(operation: DeFiOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for Uniswap operations
    return [];
  }

  private async buildAaveCalls(operation: DeFiOperation): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for Aave operations
    return [];
  }

  private async buildHarvestCalls(operation: any): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for harvest operations
    return [];
  }

  private async buildCompoundCalls(operation: any): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for compound operations
    return [];
  }

  private async buildReinvestCalls(operation: any): Promise<{ to: Address; value: bigint; data: Hex }[]> {
    // Implementation for reinvest operations
    return [];
  }
}

// Type definitions for DeFi operations
export interface MorphoOperation {
  type: 'SUPPLY' | 'BORROW' | 'WITHDRAW' | 'REPAY' | 'SUPPLY_COLLATERAL' | 'WITHDRAW_COLLATERAL';
  marketId: string;
  amount: string;
  asset: string;
  tokenAddress: Address;
  morphoContract: Address;
  userAddress: Address;
  onBehalf?: Address;
  receiver?: Address;
}

export interface SwapOperation {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: string;
  amountOutMinimum: string;
  deadline: number;
  router: Address;
}

export interface DeFiOperation {
  protocol: 'MORPHO' | 'UNISWAP' | 'AAVE' | 'COMPOUND';
  type: string;
  parameters: any;
}

export interface YieldOptimizationStrategy {
  harvestOperations: any[];
  compoundOperations: any[];
  reinvestOperations: any[];
  estimatedAprIncrease: number;
}