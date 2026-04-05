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
  BridgeForSavingsRequest,
  CachedBridgeQuoteData,
} from './across-bridge.types.js';

// Chains where Pimlico paymaster is funded — only these are allowed as source chains
const SUPPORTED_SOURCE_CHAINS = developmentMode
  ? [421614, 11155111, 84532]                        // Arbitrum Sepolia, Sepolia, Base Sepolia
  : [42161, 1, 8453, 10, 137];                       // Arbitrum, Ethereum, Base, Optimism, Polygon

// Mission bridge destination: Arbitrum (NOT HyperEVM).
// USDC lands on Master EOA on Arbitrum, then agent-service deposits
// to HyperCore via the HL Arbitrum bridge contract (approve + sendUsd).
// NEVER bridge to HyperEVM (999) — ERC-20 tokens sent to precompiles are lost.
const DESTINATION_CHAIN_ID = developmentMode ? 421614 : 42161;

// All chains valid as bridge destinations (source chains only — no HyperEVM)
const SUPPORTED_DESTINATION_CHAINS = developmentMode
  ? [421614, 11155111, 84532]                                 // Testnet source chains
  : [42161, 1, 8453, 10, 137];                                // Mainnet source chains

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
  999:  { USDC: '0xb88339CB7199b77E23DB6E890353E22632Ba630f' },  // HyperEVM mainnet (from Across available-routes)
  998:  { USDC: '0x3abb5A4FC0Cb006D1Ec2bEfaB6E01C2f4C4FC278' },  // HyperEVM testnet (mock USDC)
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

    if (!request.destinationChainId) {
      throw new Error('BRIDGE_ROUTE_UNAVAILABLE: destinationChainId is required.');
    }
    const destChainId = request.destinationChainId;

    // Validate destination chain
    if (!SUPPORTED_DESTINATION_CHAINS.includes(destChainId)) {
      throw new Error(`BRIDGE_ROUTE_UNAVAILABLE: Destination chain ${destChainId} not supported. Supported: ${SUPPORTED_DESTINATION_CHAINS.join(', ')}`);
    }

    // Can't bridge to same chain
    if (request.originChainId === destChainId) {
      throw new Error('BRIDGE_ROUTE_UNAVAILABLE: Origin and destination chains must be different.');
    }

    // Validate wallet
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: request.walletId },
      select: { id: true, isActive: true },
    });
    if (!wallet) throw new Error('WALLET_NOT_FOUND');
    if (!wallet.isActive) throw new Error('WALLET_INACTIVE');

    // Resolve Kernel account on origin (always needed for depositor)
    const kernelOrigin = await this.kernelService.getOrCreateKernelAccount(
      request.walletId,
      request.originChainId,
    );

    // Resolve recipient: custom address or own Kernel account on destination
    let recipientAddress: string;
    if (request.recipient) {
      // Validate custom recipient is a valid Ethereum address
      if (!/^0x[a-fA-F0-9]{40}$/.test(request.recipient)) {
        throw new Error('BRIDGE_ROUTE_UNAVAILABLE: Invalid recipient address.');
      }
      recipientAddress = request.recipient;
    } else {
      const kernelDestination = await this.kernelService.getOrCreateKernelAccount(
        request.walletId,
        destChainId,
      );
      recipientAddress = kernelDestination.address;
    }

    // Resolve token addresses
    const inputTokenAddress = this.resolveTokenAddress(request.inputToken, request.originChainId);
    const outputTokenAddress = this.resolveTokenAddress(request.outputToken, destChainId);

    // Call Across /swap/approval
    const acrossResponse = await this.acrossClient.getSwapApproval({
      tradeType: 'exactInput',
      amount: request.amount,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      originChainId: request.originChainId,
      destinationChainId: destChainId,
      depositor: kernelOrigin.address,
      recipient: recipientAddress,
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
      recipientAddress,
      originChainId: request.originChainId,
      destinationChainId: destChainId,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      amount: request.amount,
      expiresAt,
    };

    await this.cacheQuote(quoteId, cachedData);

    // Parse fee info from v4 response
    const approvalTxns = acrossResponse.approvalTxns ?? [];
    const outputAmount = acrossResponse.steps?.bridge?.outputAmount
      ?? acrossResponse.expectedOutputAmount
      ?? request.amount;
    const inputAmountNum = parseFloat(request.amount);
    const outputAmountNum = parseFloat(outputAmount);
    const totalFeeWei = acrossResponse.fees?.total;
    const feePctFloat = inputAmountNum > 0 ? (inputAmountNum - outputAmountNum) / inputAmountNum : 0;

    logger.info('Bridge quote generated', {
      quoteId,
      outputAmount,
      totalFee: totalFeeWei,
      expectedFillTime: acrossResponse.expectedFillTime,
      requiresApproval: approvalTxns.length > 0,
      recipientAddress,
    });

    return {
      quoteId,
      originChainId: request.originChainId,
      destinationChainId: destChainId,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      inputAmount: request.amount,
      expectedOutputAmount: outputAmount,
      minOutputAmount: outputAmount, // v4 uses exactInput, output is guaranteed
      bridgeFeeUsd: this.estimateBridgeFeeUsd(request.amount, feePctFloat),
      relayerFeePercent: (feePctFloat * 100).toFixed(4),
      estimatedFillTime: acrossResponse.expectedFillTime ?? this.estimateFillTime(request.originChainId),
      expiresAt,
      requiresApproval: approvalTxns.length > 0,
      recipientAddress,
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
    for (const approval of (acrossResponse.approvalTxns ?? [])) {
      calls.push({
        to: approval.to as Address,
        value: BigInt(approval.value || '0'),
        data: approval.data as Hex,
      });
    }

    // Main bridge deposit call (uses `transaction` field from Across response)
    calls.push({
      to: acrossResponse.swapTx.to as Address,
      value: BigInt(acrossResponse.swapTx.value || '0'),
      data: acrossResponse.swapTx.data as Hex,
    });

    logger.info('Bridge calls prepared', {
      approvalCalls: (acrossResponse.approvalTxns ?? []).length,
      totalCalls: calls.length,
      txTo: acrossResponse.swapTx.to,
      txValue: acrossResponse.swapTx.value,
    });

    // Create DB records FIRST so we have a tracking record even if UserOp submission fails mid-flight
    const bridgeOp = await this.prisma.bridgeOperation.create({
      data: {
        walletId: request.walletId,
        originChainId,
        destinationChainId: cached.destinationChainId,
        userOpHash: `pending-${randomUUID()}`, // unique placeholder until UserOp is submitted
        inputToken: cached.inputToken,
        outputToken: cached.outputToken,
        inputAmount: request.amount,
        expectedOutputAmount: (acrossResponse.steps?.bridge?.outputAmount ?? acrossResponse.expectedOutputAmount ?? '0'),
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

    try {
      // Submit gasless UserOp on origin chain
      const userOpResult = await this.kernelService.submitUserOperation(
        request.walletId,
        originChainId,
        calls,
        true, // sponsor gas
      );

      // Update bridge operation with actual UserOp hash
      await this.prisma.bridgeOperation.update({
        where: { id: bridgeOp.id },
        data: { userOpHash: userOpResult.userOpHash },
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
            expectedOutput: (acrossResponse.steps?.bridge?.outputAmount ?? acrossResponse.expectedOutputAmount),
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
        expectedOutputAmount: (acrossResponse.steps?.bridge?.outputAmount ?? acrossResponse.expectedOutputAmount ?? '0'),
        sponsored: true,
      };
    } catch (error) {
      // Mark the bridge operation as failed so user isn't stuck
      await this.prisma.bridgeOperation.update({
        where: { id: bridgeOp.id },
        data: { status: 'FAILED' },
      }).catch(() => {}); // don't mask original error
      throw error;
    }
  }

  /**
   * Simplified bridge for mission activation.
   */
  async bridgeForMission(request: BridgeForMissionRequest): Promise<BridgeExecuteResponse> {
    logger.info('Bridging for mission activation', {
      missionId: request.missionId,
      sourceChainId: request.sourceChainId,
      amount: request.amount,
    });

    return this.executeInternalBridge({
      walletId: request.walletId,
      sourceChainId: request.sourceChainId,
      amount: request.amount,
      inputToken: request.inputToken,
      recipientAddress: request.recipientAddress,
      missionId: request.missionId,
      operationType: 'MISSION_BRIDGE',
      metadata: { missionId: request.missionId },
    });
  }

  /**
   * Simplified bridge for savings (HLP Vault).
   */
  async bridgeForSavings(request: BridgeForSavingsRequest): Promise<BridgeExecuteResponse> {
    logger.info('Bridging for savings deposit', {
      walletId: request.walletId,
      sourceChainId: request.sourceChainId,
      amount: request.amount,
    });

    return this.executeInternalBridge({
      walletId: request.walletId,
      sourceChainId: request.sourceChainId,
      amount: request.amount,
      inputToken: 'USDC',
      recipientAddress: request.recipientAddress,
      operationType: 'SAVINGS_BRIDGE',
      metadata: { savingsDeposit: true },
    });
  }

  /**
   * Shared internal bridge logic for mission and savings flows.
   */
  private async executeInternalBridge(params: {
    walletId: string;
    sourceChainId: number;
    amount: string;
    inputToken: string;
    recipientAddress: string;
    missionId?: string;
    operationType: string;
    metadata: Record<string, any>;
  }): Promise<BridgeExecuteResponse> {
    if (!SUPPORTED_SOURCE_CHAINS.includes(params.sourceChainId)) {
      throw new Error(`BRIDGE_ROUTE_UNAVAILABLE: Chain ${params.sourceChainId} not supported`);
    }

    // Same-chain: source = destination (e.g., both Arbitrum).
    // No Across bridge needed — just transfer USDC directly to the recipient.
    if (params.sourceChainId === DESTINATION_CHAIN_ID) {
      logger.info('Same-chain transfer — skipping Across bridge', {
        sourceChainId: params.sourceChainId,
        recipient: params.recipientAddress,
        amount: params.amount,
      });

      const kernelOrigin = await this.kernelService.getOrCreateKernelAccount(
        params.walletId,
        params.sourceChainId,
      );

      const amountWei = /^\d+$/.test(params.amount)
        ? params.amount
        : BigInt(Math.round(parseFloat(params.amount) * 1e6)).toString();

      const inputTokenAddress = this.resolveTokenAddress(params.inputToken, params.sourceChainId);

      // Build ERC-20 transfer call
      const { encodeFunctionData, parseAbi } = await import('viem');
      const transferData = encodeFunctionData({
        abi: parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
        functionName: 'transfer',
        args: [params.recipientAddress as `0x${string}`, BigInt(amountWei)],
      });

      const userOpResult = await this.kernelService.submitUserOperation(
        params.walletId,
        params.sourceChainId,
        [{
          to: inputTokenAddress as `0x${string}`,
          value: 0n,
          data: transferData,
        }],
      );

      const { randomUUID } = await import('crypto');
      const bridgeOp = await this.prisma.bridgeOperation.create({
        data: {
          walletId: params.walletId,
          missionId: params.missionId,
          originChainId: params.sourceChainId,
          destinationChainId: params.sourceChainId,
          userOpHash: userOpResult.userOpHash,
          inputToken: inputTokenAddress,
          outputToken: inputTokenAddress,
          inputAmount: amountWei,
          expectedOutputAmount: amountWei,
          status: 'FILLED', // Same-chain = instant
          kernelAccountAddress: kernelOrigin.address,
          recipientAddress: params.recipientAddress,
          metadata: { ...params.metadata, sameChain: true },
        },
      });

      return {
        bridgeOperationId: bridgeOp.id,
        userOpHash: userOpResult.userOpHash,
        status: 'submitted',
        originChainId: params.sourceChainId,
        destinationChainId: params.sourceChainId,
        inputAmount: amountWei,
        expectedOutputAmount: amountWei,
        sponsored: true,
      };
    }

    const kernelOrigin = await this.kernelService.getOrCreateKernelAccount(
      params.walletId,
      params.sourceChainId,
    );

    const inputTokenAddress = this.resolveTokenAddress(params.inputToken, params.sourceChainId);
    const outputTokenAddress = this.resolveTokenAddress('USDC', DESTINATION_CHAIN_ID);

    // Convert decimal amount to wei if needed (Across expects integer wei string)
    const amountWei = /^\d+$/.test(params.amount)
      ? params.amount
      : BigInt(Math.round(parseFloat(params.amount) * 1e6)).toString();

    const acrossResponse = await this.acrossClient.getSwapApproval({
      tradeType: 'exactInput',
      amount: amountWei,
      inputToken: inputTokenAddress,
      outputToken: outputTokenAddress,
      originChainId: params.sourceChainId,
      destinationChainId: DESTINATION_CHAIN_ID,
      depositor: kernelOrigin.address,
      recipient: params.recipientAddress,
      integratorId: process.env.ACROSS_INTEGRATOR_ID || '0x0000',
      slippage: 0.005,
    });

    // SAFETY: Reject if slippage exceeds 2% (protects against MEV/high fees)
    const outputAmount = BigInt(acrossResponse.steps?.bridge?.outputAmount ?? acrossResponse.expectedOutputAmount ?? '0');
    const inputAmountBn = BigInt(amountWei);
    if (inputAmountBn > 0n && outputAmount > 0n) {
      const slippageBps = Number((inputAmountBn - outputAmount) * 10000n / inputAmountBn);
      if (slippageBps > 200) { // 2% max
        throw new Error(
          `BRIDGE_SLIPPAGE_TOO_HIGH: ${slippageBps / 100}% value loss (input: ${amountWei}, output: ${outputAmount.toString()}). Max allowed: 2%. Try again later.`
        );
      }
      logger.info('Bridge slippage check passed', {
        slippageBps,
        inputAmount: amountWei,
        outputAmount: outputAmount.toString(),
      });
    }

    const calls: { to: Address; value: bigint; data: Hex }[] = [];
    for (const approval of (acrossResponse.approvalTxns ?? [])) {
      calls.push({
        to: approval.to as Address,
        value: BigInt(approval.value || '0'),
        data: approval.data as Hex,
      });
    }
    calls.push({
      to: acrossResponse.swapTx.to as Address,
      value: BigInt(acrossResponse.swapTx.value || '0'),
      data: acrossResponse.swapTx.data as Hex,
    });

    // Create DB record first for tracking
    const bridgeOp = await this.prisma.bridgeOperation.create({
      data: {
        walletId: params.walletId,
        missionId: params.missionId,
        originChainId: params.sourceChainId,
        destinationChainId: DESTINATION_CHAIN_ID,
        userOpHash: `pending-${randomUUID()}`,
        inputToken: inputTokenAddress,
        outputToken: outputTokenAddress,
        inputAmount: amountWei,
        expectedOutputAmount: (acrossResponse.steps?.bridge?.outputAmount ?? acrossResponse.expectedOutputAmount ?? '0'),
        status: 'PENDING',
        kernelAccountAddress: kernelOrigin.address,
        recipientAddress: params.recipientAddress,
        metadata: {
          ...params.metadata,
          sponsoredGas: true,
          acrossIntegratorId: process.env.ACROSS_INTEGRATOR_ID || '0x0000',
        },
      },
    });

    try {
      const userOpResult = await this.kernelService.submitUserOperation(
        params.walletId,
        params.sourceChainId,
        calls,
        true,
      );

      await this.prisma.bridgeOperation.update({
        where: { id: bridgeOp.id },
        data: { userOpHash: userOpResult.userOpHash },
      });

      await this.prisma.deFiBundledOperation.create({
        data: {
          walletId: params.walletId,
          chainId: params.sourceChainId,
          userOpHash: userOpResult.userOpHash,
          protocol: 'ACROSS_BRIDGE',
          operations: [{
            type: params.operationType,
            bridgeOperationId: bridgeOp.id,
            amount: params.amount,
            ...(params.missionId ? { missionId: params.missionId } : {}),
          }] as any,
          callsCount: calls.length,
          status: 'PENDING',
          metadata: { sponsoredGas: true, bundlingStrategy: 'ACROSS_BRIDGE' },
        },
      });

      logger.info(`${params.operationType} bridge submitted`, {
        bridgeOperationId: bridgeOp.id,
        userOpHash: userOpResult.userOpHash,
      });

      return {
        bridgeOperationId: bridgeOp.id,
        userOpHash: userOpResult.userOpHash,
        status: 'submitted',
        originChainId: params.sourceChainId,
        destinationChainId: DESTINATION_CHAIN_ID,
        inputAmount: params.amount,
        expectedOutputAmount: (acrossResponse.steps?.bridge?.outputAmount ?? acrossResponse.expectedOutputAmount ?? '0'),
        sponsored: true,
      };
    } catch (error) {
      await this.prisma.bridgeOperation.update({
        where: { id: bridgeOp.id },
        data: { status: 'FAILED' },
      }).catch(() => {});
      throw error;
    }
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
    // Parse amount: if already integer wei string use directly, otherwise convert from decimal USDC
    const requestedWei = /^\d+$/.test(amount)
      ? BigInt(amount)
      : BigInt(Math.round(parseFloat(amount) * 1e6)); // USDC 6 decimals

    // Resolve the deterministic kernel address for this wallet.
    // ZeroDev kernel addresses are identical across all EVM chains,
    // so we only need one known address to check all chains.
    const anyKernel = await this.prisma.kernelAccount.findFirst({
      where: { walletId },
      select: { address: true },
    });

    if (!anyKernel) {
      throw new Error('No kernel account found for wallet');
    }

    const kernelAddress = anyKernel.address;

    // Check HyperEVM first (no bridge needed — funds already at destination)
    try {
      const destBalance = await this.checkUsdcBalance(kernelAddress, DESTINATION_CHAIN_ID, token);
      if (destBalance >= requestedWei) {
        return {
          chains: [{ chainId: DESTINATION_CHAIN_ID, balance: destBalance.toString(), amount: amount }],
          needsBridge: false,
          needsSweep: false,
        };
      }
    } catch {
      // HyperEVM balance check may fail if no USDC contract — skip
    }

    // Query ALL supported source chains by RPC in parallel.
    // Don't rely on DB records — the kernel address is deterministic and
    // identical across all EVM chains. Users may deposit on any chain
    // without the backend knowing about it.
    const balanceResults = await Promise.all(
      SUPPORTED_SOURCE_CHAINS.map(async (chainId) => {
        try {
          const balance = await this.checkUsdcBalance(kernelAddress, chainId, token);
          if (balance > 0n) {
            logger.info('Found USDC balance on chain', {
              chainId, address: kernelAddress, balance: balance.toString(),
            });
          }
          return { chainId, balance };
        } catch (err) {
          logger.warn('Balance check failed for chain', { chainId, error: String(err) });
          return { chainId, balance: 0n };
        }
      })
    );

    // Auto-insert DB records for chains where we found balances but no DB row exists.
    // This keeps the DB in sync without requiring manual chain registration.
    const existingChains = await this.prisma.kernelAccount.findMany({
      where: { walletId },
      select: { chainId: true },
    });
    const existingChainIds = new Set(existingChains.map(k => k.chainId));

    for (const result of balanceResults) {
      if (result.balance > 0n && !existingChainIds.has(result.chainId)) {
        try {
          await this.kernelService.getOrCreateKernelAccount(walletId, result.chainId);
          logger.info('Auto-created kernel account DB record', {
            walletId, chainId: result.chainId, address: kernelAddress,
          });
        } catch (err) {
          logger.warn('Failed to auto-create kernel account record', {
            chainId: result.chainId, error: String(err),
          });
        }
      }
    }

    // --- Pick cheapest/fastest chain that has enough ---
    const sufficient = balanceResults
      .filter(b => b.balance >= requestedWei)
      .sort((a, b) => this.estimateFillTime(a.chainId) - this.estimateFillTime(b.chainId));

    if (sufficient.length > 0) {
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

    // --- Knapsack sweep across multiple chains ---
    const sorted = balanceResults
      .filter(b => b.balance > 0n)
      .sort((a, b) => (a.balance > b.balance ? -1 : a.balance < b.balance ? 1 : 0));

    const sweepChains: Array<{ chainId: number; balance: string; amount: string }> = [];
    let remaining = requestedWei;

    for (const chain of sorted) {
      if (remaining <= 0n) break;

      const pullAmount = chain.balance < remaining ? chain.balance : remaining;

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
        amount: pullAmount.toString(),
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

      if (acrossStatus.status === 'filled' && acrossStatus.fillTx) {
        await this.prisma.bridgeOperation.update({
          where: { id: op.id },
          data: {
            status: 'FILLED',
            fillTxHash: acrossStatus.fillTx,
            outputAmount: acrossStatus.outputAmount,
          },
        });
        logger.info('Bridge operation filled', { bridgeOperationId: op.id, fillTxHash: acrossStatus.fillTx });
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
    const chainTokens = TOKEN_ADDRESSES[chainId];
    if (!chainTokens) throw new Error(`Unsupported chain: ${chainId}`);

    // If an address is passed, validate it's in our allowlist for this chain
    if (tokenSymbolOrAddress.startsWith('0x')) {
      const normalized = tokenSymbolOrAddress.toLowerCase();
      const isAllowed = Object.values(chainTokens).some(
        addr => addr.toLowerCase() === normalized,
      );
      if (!isAllowed) {
        throw new Error(`Token address ${tokenSymbolOrAddress} not in allowlist for chain ${chainId}`);
      }
      return tokenSymbolOrAddress;
    }

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
    // Amount is in USDC 6-decimal wei; USDC is dollar-denominated so no ETH price needed
    const usdcAmount = Number(BigInt(amount)) / 1e6;
    const feeUsd = usdcAmount * feePct;
    return feeUsd.toFixed(4);
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
