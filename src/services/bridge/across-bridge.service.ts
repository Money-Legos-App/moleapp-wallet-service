/**
 * Across Bridge Service
 * Cross-chain bridge to Hyperliquid via Across Protocol v4.
 * Routes USDC from any supported chain directly to HyperEVM (chain 999),
 * which auto-settles on HyperCore as USDH for instant trading.
 *
 * Supports both on-demand bridge and mission activation flows.
 */

import { PrismaClient } from '../../lib/prisma';
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

// HyperEVM: chain 999 (mainnet), 998 (testnet)
// Across fills on HyperEVM → auto-routed to HyperCore as USDH
const DESTINATION_CHAIN_ID = developmentMode ? 998 : 999;

// Across enforces minimum bridge amounts (~$1-5 depending on relayer conditions)
const ACROSS_MIN_BRIDGE_AMOUNT = 5_000_000n; // 5 USDC in 6-decimal wei

// Token addresses per chain (native ETH uses sentinel address)
const TOKEN_ADDRESSES: Record<number, Record<string, string>> = {
  // Mainnet
  1:     { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  42161: { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1' },
  8453:  { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
  10:    { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
  137:   { ETH: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  // HyperEVM (destination chains — Across resolves USDC→USDH automatically)
  999:  { USDC: '0x078d782b760474a361dda0af3839290b0EF57AD6' },  // HyperEVM mainnet
  998:  { USDC: '0x078d782b760474a361dda0af3839290b0EF57AD6' },  // HyperEVM testnet
  // Testnet (source chains)
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
   * Get bridge quote for cross-chain transfer to Hyperliquid (via HyperEVM).
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
   * Prefers: HyperEVM (no bridge) → cheapest/fastest valid chain → highest balance fallback.
   * Backward-compatible wrapper around findSourceChains().
   */
  async findBestSourceChain(
    walletId: string,
    amount: string,
    token: string = 'USDC',
  ): Promise<{ chainId: number; balance: string; needsBridge: boolean }> {
    const result = await this.findSourceChains(walletId, amount, token);
    if (result.chains.length === 0) {
      return { chainId: SUPPORTED_SOURCE_CHAINS[0], balance: '0', needsBridge: true };
    }
    return {
      chainId: result.chains[0].chainId,
      balance: result.chains[0].balance,
      needsBridge: result.needsBridge,
    };
  }

  /**
   * Find optimal source chain(s) for bridging.
   * Returns single chain when possible (cheapest/fastest that satisfies amount).
   * Returns multiple chains with exact pull amounts when sweep is needed.
   *
   * Knapsack routing: pulls exact amounts per chain, minimizes dust.
   * Respects Across minimum bridge amount (~$5 USDC).
   */
  async findSourceChains(
    walletId: string,
    amount: string,
    token: string = 'USDC',
  ): Promise<{
    chains: Array<{ chainId: number; balance: string; amount: string }>;
    needsBridge: boolean;
    needsSweep: boolean;
  }> {
    const requestedWei = BigInt(Math.floor(parseFloat(amount) * 1e6)); // USDC 6 decimals

    // Get all kernel accounts for this wallet
    const kernelAccounts = await this.prisma.kernelAccount.findMany({
      where: { walletId },
      select: { chainId: true, address: true },
    });

    const supported = kernelAccounts.filter(ka => SUPPORTED_SOURCE_CHAINS.includes(ka.chainId));

    // Check HyperEVM first (no bridge needed — funds already at destination)
    const destAccount = kernelAccounts.find(ka => ka.chainId === DESTINATION_CHAIN_ID);
    if (destAccount) {
      const balance = await this.checkUsdcBalance(destAccount.address, DESTINATION_CHAIN_ID, token);
      if (balance >= requestedWei) {
        return {
          chains: [{ chainId: DESTINATION_CHAIN_ID, balance: balance.toString(), amount: amount }],
          needsBridge: false,
          needsSweep: false,
        };
      }
    }

    // Query all chain balances in parallel
    const balanceResults = await Promise.all(
      supported.map(async (ka) => ({
        chainId: ka.chainId,
        balance: await this.checkUsdcBalance(ka.address, ka.chainId, token),
      }))
    );

    // --- Fix 1: Pick cheapest/fastest chain that has enough ---
    const sufficient = balanceResults
      .filter(b => b.balance >= requestedWei)
      .sort((a, b) => this.estimateFillTime(a.chainId) - this.estimateFillTime(b.chainId));

    if (sufficient.length > 0) {
      // Single cheapest valid chain
      return {
        chains: [{
          chainId: sufficient[0].chainId,
          balance: sufficient[0].balance.toString(),
          amount: amount,
        }],
        needsBridge: true,
        needsSweep: false,
      };
    }

    // --- Fix 2: Knapsack sweep across multiple chains ---
    // Sort by balance descending to pull from largest first (minimizes dust)
    const sorted = balanceResults
      .filter(b => b.balance > 0n)
      .sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));

    const sweepChains: Array<{ chainId: number; balance: string; amount: string }> = [];
    let remaining = requestedWei;

    for (const chain of sorted) {
      if (remaining <= 0n) break;

      const pullAmount = chain.balance < remaining ? chain.balance : remaining;

      // Skip if pull amount is below Across minimum bridge amount
      if (pullAmount < ACROSS_MIN_BRIDGE_AMOUNT) {
        logger.info('Skipping chain below minimum bridge amount', {
          chainId: chain.chainId,
          pullAmount: pullAmount.toString(),
          minimum: ACROSS_MIN_BRIDGE_AMOUNT.toString(),
        });
        continue;
      }

      sweepChains.push({
        chainId: chain.chainId,
        balance: chain.balance.toString(),
        amount: (Number(pullAmount) / 1e6).toString(), // Convert back to USDC string
      });
      remaining -= pullAmount;
    }

    if (remaining > 0n) {
      const shortfall = Number(remaining) / 1e6;
      throw new Error(
        `Insufficient consolidatable balance. Please deposit $${shortfall.toFixed(2)} more USDC on any supported chain.`
      );
    }

    return {
      chains: sweepChains,
      needsBridge: true,
      needsSweep: sweepChains.length > 1,
    };
  }

  /**
   * Check on-chain ERC-20 balance via RPC.
   */
  private async checkUsdcBalance(address: string, chainId: number, token: string = 'USDC'): Promise<bigint> {
    try {
      const { createPublicClient, http, parseAbi } = await import('viem');
      const networkConfig = (await import('../../config/networks.js')).getNetworkConfigByChainId(chainId);
      const tokenAddress = this.resolveTokenAddress(token, chainId);

      const client = createPublicClient({ chain: networkConfig.chain, transport: http(networkConfig.rpcUrl) });
      const balance = await client.readContract({
        address: tokenAddress as `0x${string}`,
        abi: parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args: [address as `0x${string}`],
      });
      return balance as bigint;
    } catch (err) {
      logger.warn('Failed to check on-chain balance', { chainId, address, error: String(err) });
      return 0n;
    }
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
    // Across → HyperEVM fill times (seconds): 8-20s typical
    const fillTimes: Record<number, number> = {
      42161: 15, 1: 20, 8453: 15, 10: 15, 137: 20, 56: 30,
      421614: 15, 11155111: 30, 84532: 20,
    };
    return fillTimes[originChainId] ?? 20;
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
