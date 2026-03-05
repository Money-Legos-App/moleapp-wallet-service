/**
 * Across Bridge Service
 * Cross-chain bridge to Arbitrum via Across Protocol v4.
 * Supports both on-demand bridge and mission activation flows.
 */

import { PrismaClient } from '@prisma/client';
import { Address, Hex } from 'viem';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { KernelService } from '../kernel/account-abstraction.service.js';
import { AcrossClientService } from './across-client.service.js';
import { developmentMode } from '../../config/environment.js';
import redis from '../../config/redis.js';
import type {
  BridgeQuoteRequest,
  BridgeQuoteResponse,
  BridgeExecuteRequest,
  BridgeExecuteResponse,
  BridgeStatusResponse,
  BridgeForMissionRequest,
  CachedBridgeQuoteData,
} from './across-bridge.types.js';

// Chains where Pimlico paymaster is funded — only these are allowed as source chains
const SUPPORTED_SOURCE_CHAINS = developmentMode
  ? [421614, 11155111, 84532]                        // Arbitrum Sepolia, Sepolia, Base Sepolia
  : [42161, 1, 8453, 10, 137];                       // Arbitrum, Ethereum, Base, Optimism, Polygon

const DESTINATION_CHAIN_ID = developmentMode ? 421614 : 42161;

// Token addresses per chain (native ETH uses sentinel address)
const TOKEN_ADDRESSES: Record<number, Record<string, string>> = {
  // Mainnet
  1:     { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  42161: { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  8453:  { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  10:    { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  137:   { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  // Testnet
  11155111: { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  421614:   { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x1baAbB04529D43a73232B713C0FE471f7c7334d5' },
  84532:    { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
};

const QUOTE_CACHE_PREFIX = 'bridge:quote:';
const QUOTE_EXPIRY_SECONDS = 60;
const QUOTE_EXPIRY_MS = QUOTE_EXPIRY_SECONDS * 1000;

export class AcrossBridgeService {
  private prisma: PrismaClient;
  private kernelService: KernelService;
  private acrossClient: AcrossClientService;
  private memoryCache: Map<string, CachedBridgeQuoteData> = new Map();

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;
    this.acrossClient = new AcrossClientService();
    setInterval(() => this.cleanExpiredQuotes(), 120_000);
  }

  /**
   * Get bridge quote for cross-chain transfer to Arbitrum.
   */
  async getQuote(request: BridgeQuoteRequest): Promise<BridgeQuoteResponse> {
    logger.info('Getting bridge quote', {
      walletId: request.walletId,
      inputToken: request.inputToken,
      amount: request.amount,
      originChainId: request.originChainId,
    });

    // Validate source chain is supported (Pimlico-funded)
    if (!SUPPORTED_SOURCE_CHAINS.includes(request.originChainId)) {
      throw new Error(`BRIDGE_ROUTE_UNAVAILABLE: Chain ${request.originChainId} not supported. Supported: ${SUPPORTED_SOURCE_CHAINS.join(', ')}`);
    }

    const destChainId = request.destinationChainId || DESTINATION_CHAIN_ID;

    // Validate wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: request.walletId },
      select: { id: true, isActive: true },
    });
    if (!wallet) throw new Error('WALLET_NOT_FOUND');
    if (!wallet.isActive) throw new Error('WALLET_INACTIVE');

    // Resolve Kernel accounts on origin and destination
    const kernelOrigin = await this.kernelService.getOrCreateKernelAccount(
      request.walletId,
      request.originChainId,
    );
    const kernelDestination = await this.kernelService.getOrCreateKernelAccount(
      request.walletId,
      destChainId,
    );

    // Resolve token addresses
    const inputTokenAddress = this.resolveTokenAddress(request.inputToken, request.originChainId);
    const outputTokenAddress = this.resolveTokenAddress(request.outputToken, destChainId);

    // Call Across /swap/approval
    const acrossResponse = await this.acrossClient.getSwapApproval({
      tradeType: 'EXACT_INPUT',
      amount: request.amount,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      originChainId: request.originChainId,
      destinationChainId: destChainId,
      depositor: kernelOrigin.address,
      recipient: kernelDestination.address,  // Always explicit, never default
      integratorId: process.env.ACROSS_INTEGRATOR_ID || '0x0000',
      slippage: request.slippage ?? 0.005,
    });

    // Cache
    const quoteId = randomUUID();
    const expiresAt = Date.now() + QUOTE_EXPIRY_MS;

    const cachedData: CachedBridgeQuoteData = {
      acrossResponse,
      walletId: request.walletId,
      kernelAccountAddress: kernelOrigin.address,
      recipientAddress: kernelDestination.address,
      originChainId: request.originChainId,
      destinationChainId: destChainId,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      amount: request.amount,
      expiresAt,
    };

    await this.cacheQuote(quoteId, cachedData);

    // Parse fee info
    const totalFeePct = acrossResponse.fees?.totalRelayFee?.pct || '0';
    const feePctFloat = parseFloat(totalFeePct) / 1e18;

    logger.info('Bridge quote generated', {
      quoteId,
      expectedOutput: acrossResponse.expectedOutputAmount,
      requiresApproval: acrossResponse.approvalTxns.length > 0,
    });

    return {
      quoteId,
      originChainId: request.originChainId,
      destinationChainId: destChainId,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      inputAmount: request.amount,
      expectedOutputAmount: acrossResponse.expectedOutputAmount,
      minOutputAmount: acrossResponse.minExpectedOutputAmount,
      bridgeFeeUsd: this.estimateBridgeFeeUsd(request.amount, feePctFloat),
      relayerFeePercent: (feePctFloat * 100).toFixed(4),
      estimatedFillTime: this.estimateFillTime(request.originChainId),
      expiresAt,
      requiresApproval: acrossResponse.approvalTxns.length > 0,
    };
  }

  /**
   * Execute bridge using cached quote.
   * Builds calls[] from Across response and submits as batched UserOp.
   */
  async executeBridge(request: BridgeExecuteRequest): Promise<BridgeExecuteResponse> {
    logger.info('Executing bridge', { walletId: request.walletId, quoteId: request.quoteId });

    // Retrieve and validate cached quote
    const cached = await this.getCachedQuote(request.quoteId);
    if (!cached) throw new Error('BRIDGE_QUOTE_EXPIRED');
    if (Date.now() > cached.expiresAt) {
      await this.deleteCachedQuote(request.quoteId);
      throw new Error('BRIDGE_QUOTE_EXPIRED');
    }

    if (
      request.walletId !== cached.walletId ||
      String(request.amount) !== String(cached.amount) ||
      request.originChainId !== cached.originChainId
    ) {
      throw new Error('BRIDGE_QUOTE_MISMATCH');
    }

    const { acrossResponse, originChainId } = cached;

    // Build calls array from Across response
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    // ERC-20 approval calls (empty for native ETH)
    for (const approval of acrossResponse.approvalTxns) {
      calls.push({
        to: approval.to as Address,
        value: BigInt(approval.value || '0'),
        data: approval.data as Hex,
      });
    }

    // Main bridge deposit call (uses `transaction` field from Across response)
    calls.push({
      to: acrossResponse.transaction.to as Address,
      value: BigInt(acrossResponse.transaction.value || '0'),
      data: acrossResponse.transaction.data as Hex,
    });

    logger.info('Bridge calls prepared', {
      approvalCalls: acrossResponse.approvalTxns.length,
      totalCalls: calls.length,
      txTo: acrossResponse.transaction.to,
      txValue: acrossResponse.transaction.value,
    });

    // Submit gasless UserOp on origin chain
    const userOpResult = await this.kernelService.submitUserOperation(
      request.walletId,
      originChainId,
      calls,
      true, // sponsor gas
    );

    // Record in BridgeOperation table
    const bridgeOp = await this.prisma.bridgeOperation.create({
      data: {
        walletId: request.walletId,
        originChainId,
        destinationChainId: cached.destinationChainId,
        userOpHash: userOpResult.userOpHash,
        inputToken: cached.inputToken,
        outputToken: cached.outputToken,
        inputAmount: request.amount,
        expectedOutputAmount: acrossResponse.expectedOutputAmount,
        status: 'PENDING',
        kernelAccountAddress: cached.kernelAccountAddress,
        recipientAddress: cached.recipientAddress,
        metadata: {
          quoteId: request.quoteId,
          sponsoredGas: true,
          acrossIntegratorId: process.env.ACROSS_INTEGRATOR_ID || '0x0000',
        },
      },
    });

    // Also record in DeFiBundledOperation for consistency
    await this.prisma.deFiBundledOperation.create({
      data: {
        walletId: request.walletId,
        chainId: originChainId,
        userOpHash: userOpResult.userOpHash,
        protocol: 'ACROSS_BRIDGE',
        operations: [{
          type: 'BRIDGE_DEPOSIT',
          bridgeOperationId: bridgeOp.id,
          originChainId,
          destinationChainId: cached.destinationChainId,
          amount: request.amount,
          expectedOutput: acrossResponse.expectedOutputAmount,
        }] as any,
        callsCount: calls.length,
        status: 'PENDING',
        metadata: {
          sponsoredGas: true,
          bundlingStrategy: 'ACROSS_BRIDGE',
          bridgeOperationId: bridgeOp.id,
        },
      },
    });

    await this.deleteCachedQuote(request.quoteId);

    logger.info('Bridge operation submitted', {
      bridgeOperationId: bridgeOp.id,
      userOpHash: userOpResult.userOpHash,
    });

    return {
      bridgeOperationId: bridgeOp.id,
      userOpHash: userOpResult.userOpHash,
      status: 'submitted',
      originChainId,
      destinationChainId: cached.destinationChainId,
      inputAmount: request.amount,
      expectedOutputAmount: acrossResponse.expectedOutputAmount,
      sponsored: true,
    };
  }

  /**
   * Simplified bridge for mission activation.
   * Quotes, executes, and returns the bridge operation ID.
   */
  async bridgeForMission(request: BridgeForMissionRequest): Promise<BridgeExecuteResponse> {
    logger.info('Bridging for mission activation', {
      missionId: request.missionId,
      sourceChainId: request.sourceChainId,
      amount: request.amount,
    });

    if (!SUPPORTED_SOURCE_CHAINS.includes(request.sourceChainId)) {
      throw new Error(`BRIDGE_ROUTE_UNAVAILABLE: Chain ${request.sourceChainId} not supported`);
    }

    // Resolve kernel account on origin chain
    const kernelOrigin = await this.kernelService.getOrCreateKernelAccount(
      request.walletId,
      request.sourceChainId,
    );

    const inputTokenAddress = this.resolveTokenAddress(request.inputToken, request.sourceChainId);
    const outputTokenAddress = this.resolveTokenAddress('USDC', DESTINATION_CHAIN_ID);

    // Get Across quote
    const acrossResponse = await this.acrossClient.getSwapApproval({
      tradeType: 'EXACT_INPUT',
      amount: request.amount,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      originChainId: request.sourceChainId,
      destinationChainId: DESTINATION_CHAIN_ID,
      depositor: kernelOrigin.address,
      recipient: request.recipientAddress,  // Master EOA or Kernel on Arbitrum
      integratorId: process.env.ACROSS_INTEGRATOR_ID || '0x0000',
      slippage: 0.005,
    });

    // Build calls
    const calls: { to: Address; value: bigint; data: Hex }[] = [];

    for (const approval of acrossResponse.approvalTxns) {
      calls.push({
        to: approval.to as Address,
        value: BigInt(approval.value || '0'),
        data: approval.data as Hex,
      });
    }

    calls.push({
      to: acrossResponse.transaction.to as Address,
      value: BigInt(acrossResponse.transaction.value || '0'),
      data: acrossResponse.transaction.data as Hex,
    });

    // Submit UserOp
    const userOpResult = await this.kernelService.submitUserOperation(
      request.walletId,
      request.sourceChainId,
      calls,
      true,
    );

    // Record with missionId
    const bridgeOp = await this.prisma.bridgeOperation.create({
      data: {
        walletId: request.walletId,
        missionId: request.missionId,
        originChainId: request.sourceChainId,
        destinationChainId: DESTINATION_CHAIN_ID,
        userOpHash: userOpResult.userOpHash,
        inputToken: inputTokenAddress,
        outputToken: outputTokenAddress,
        inputAmount: request.amount,
        expectedOutputAmount: acrossResponse.expectedOutputAmount,
        status: 'PENDING',
        kernelAccountAddress: kernelOrigin.address,
        recipientAddress: request.recipientAddress,
        metadata: {
          missionId: request.missionId,
          sponsoredGas: true,
          acrossIntegratorId: process.env.ACROSS_INTEGRATOR_ID || '0x0000',
        },
      },
    });

    await this.prisma.deFiBundledOperation.create({
      data: {
        walletId: request.walletId,
        chainId: request.sourceChainId,
        userOpHash: userOpResult.userOpHash,
        protocol: 'ACROSS_BRIDGE',
        operations: [{
          type: 'MISSION_BRIDGE',
          missionId: request.missionId,
          bridgeOperationId: bridgeOp.id,
          amount: request.amount,
        }] as any,
        callsCount: calls.length,
        status: 'PENDING',
        metadata: { sponsoredGas: true, bundlingStrategy: 'ACROSS_BRIDGE' },
      },
    });

    logger.info('Mission bridge submitted', {
      bridgeOperationId: bridgeOp.id,
      missionId: request.missionId,
      userOpHash: userOpResult.userOpHash,
    });

    return {
      bridgeOperationId: bridgeOp.id,
      userOpHash: userOpResult.userOpHash,
      status: 'submitted',
      originChainId: request.sourceChainId,
      destinationChainId: DESTINATION_CHAIN_ID,
      inputAmount: request.amount,
      expectedOutputAmount: acrossResponse.expectedOutputAmount,
      sponsored: true,
    };
  }

  /**
   * Get bridge operation status. Lazily refreshes from Across if deposit is confirmed.
   */
  async getBridgeStatus(bridgeOperationId: string, walletId: string): Promise<BridgeStatusResponse> {
    const op = await this.prisma.bridgeOperation.findFirst({
      where: { id: bridgeOperationId, walletId },
    });
    if (!op) throw new Error('BRIDGE_OPERATION_NOT_FOUND');

    if (op.status === 'DEPOSIT_CONFIRMED' && op.depositTxHash) {
      await this.refreshBridgeStatus(op);
      const updated = await this.prisma.bridgeOperation.findUnique({ where: { id: bridgeOperationId } });
      return this.formatStatus(updated || op);
    }

    return this.formatStatus(op);
  }

  /**
   * List bridge operations for a wallet.
   */
  async listBridgeOperations(walletId: string, limit = 20): Promise<BridgeStatusResponse[]> {
    const ops = await this.prisma.bridgeOperation.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return ops.map((op: any) => this.formatStatus(op));
  }

  /**
   * Find best source chain for a given wallet + amount.
   * Returns Arbitrum first (no bridge needed), then by fill time.
   */
  async findBestSourceChain(
    walletId: string,
    amount: string,
    token: string = 'USDC',
  ): Promise<{ chainId: number; balance: string; needsBridge: boolean }> {
    // Get all kernel accounts for this wallet
    const kernelAccounts = await this.prisma.kernelAccount.findMany({
      where: { walletId },
      select: { chainId: true, address: true },
    });

    // Filter to supported chains only
    const supported = kernelAccounts.filter(ka => SUPPORTED_SOURCE_CHAINS.includes(ka.chainId));

    // Check Arbitrum first (no bridge needed)
    const arbAccount = supported.find(ka => ka.chainId === DESTINATION_CHAIN_ID);
    if (arbAccount) {
      // TODO: Check actual on-chain balance via RPC
      // For now, return Arbitrum as default if account exists
      return { chainId: DESTINATION_CHAIN_ID, balance: '0', needsBridge: false };
    }

    // Check other chains by fill time priority
    const chainsByPriority = [...supported].sort((a, b) => {
      return this.estimateFillTime(a.chainId) - this.estimateFillTime(b.chainId);
    });

    if (chainsByPriority.length > 0) {
      return {
        chainId: chainsByPriority[0].chainId,
        balance: '0',
        needsBridge: true,
      };
    }

    // Default to Arbitrum even if no account exists (will be created)
    return { chainId: DESTINATION_CHAIN_ID, balance: '0', needsBridge: false };
  }

  // ============ PRIVATE HELPERS ============

  private async refreshBridgeStatus(op: any): Promise<void> {
    try {
      const acrossStatus = await this.acrossClient.getDepositStatus(
        op.depositTxHash,
        op.originChainId,
      );

      if (acrossStatus.status === 'filled' && acrossStatus.fillTxHash) {
        await this.prisma.bridgeOperation.update({
          where: { id: op.id },
          data: {
            status: 'FILLED',
            fillTxHash: acrossStatus.fillTxHash,
            outputAmount: acrossStatus.outputAmount,
          },
        });
        logger.info('Bridge operation filled', { bridgeOperationId: op.id, fillTxHash: acrossStatus.fillTxHash });
      } else if (acrossStatus.status === 'expired') {
        await this.prisma.bridgeOperation.update({
          where: { id: op.id },
          data: { status: 'REFUNDED' },
        });
        logger.warn('Bridge operation refunded/expired', { bridgeOperationId: op.id });
      }
    } catch (error) {
      logger.warn('Failed to refresh bridge status', {
        bridgeOperationId: op.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private formatStatus(op: any): BridgeStatusResponse {
    return {
      bridgeOperationId: op.id,
      status: op.status,
      userOpHash: op.userOpHash || undefined,
      depositTxHash: op.depositTxHash || undefined,
      fillTxHash: op.fillTxHash || undefined,
      inputAmount: op.inputAmount,
      outputAmount: op.outputAmount || undefined,
      originChainId: op.originChainId,
      destinationChainId: op.destinationChainId,
      createdAt: op.createdAt.toISOString(),
      updatedAt: op.updatedAt.toISOString(),
    };
  }

  private resolveTokenAddress(tokenSymbolOrAddress: string, chainId: number): string {
    if (tokenSymbolOrAddress.startsWith('0x')) return tokenSymbolOrAddress;
    const chainTokens = TOKEN_ADDRESSES[chainId];
    if (!chainTokens) throw new Error(`Unsupported chain: ${chainId}`);
    const address = chainTokens[tokenSymbolOrAddress.toUpperCase()];
    if (!address) throw new Error(`Token ${tokenSymbolOrAddress} not supported on chain ${chainId}`);
    return address;
  }

  private estimateFillTime(originChainId: number): number {
    const fillTimes: Record<number, number> = {
      1: 120, 8453: 30, 10: 30, 137: 60, 56: 60,
      11155111: 300, 421614: 30, 84532: 60,
    };
    return fillTimes[originChainId] ?? 120;
  }

  private estimateBridgeFeeUsd(amount: string, feePct: number): string {
    const ethAmount = Number(BigInt(amount)) / 1e18;
    const feeEth = ethAmount * feePct;
    return (feeEth * 2500).toFixed(4);
  }

  // ============ REDIS CACHE (same pattern as SwapService) ============

  private async cacheQuote(quoteId: string, data: CachedBridgeQuoteData): Promise<void> {
    try {
      const key = `${QUOTE_CACHE_PREFIX}${quoteId}`;
      if (redis.status === 'ready') {
        await redis.setex(key, QUOTE_EXPIRY_SECONDS, JSON.stringify(data));
      } else {
        this.memoryCache.set(quoteId, data);
      }
    } catch {
      this.memoryCache.set(quoteId, data);
    }
  }

  private async getCachedQuote(quoteId: string): Promise<CachedBridgeQuoteData | null> {
    try {
      const key = `${QUOTE_CACHE_PREFIX}${quoteId}`;
      if (redis.status === 'ready') {
        const val = await redis.get(key);
        if (val) return JSON.parse(val);
      }
      return this.memoryCache.get(quoteId) || null;
    } catch {
      return this.memoryCache.get(quoteId) || null;
    }
  }

  private async deleteCachedQuote(quoteId: string): Promise<void> {
    try {
      if (redis.status === 'ready') {
        await redis.del(`${QUOTE_CACHE_PREFIX}${quoteId}`);
      }
      this.memoryCache.delete(quoteId);
    } catch { /* ignore */ }
  }

  private cleanExpiredQuotes(): void {
    const now = Date.now();
    for (const [id, data] of this.memoryCache) {
      if (now > data.expiresAt) this.memoryCache.delete(id);
    }
  }
}
