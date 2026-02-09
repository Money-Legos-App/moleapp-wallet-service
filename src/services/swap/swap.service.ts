/**
 * Swap Service
 * Handles gasless token swaps using 0x API and ZeroDev Kernel accounts
 *
 * Key features:
 * - 0x API integration for quotes and routing
 * - Batched UserOperation execution (approval + swap)
 * - Atomic approvals (exact amount, not unlimited)
 * - Native ETH handling
 * - Quote caching with validation
 */

import { PrismaClient } from '../../lib/prisma';
import {
  Address,
  Hex,
  encodeFunctionData,
  parseAbi,
  formatUnits,
} from 'viem';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger.js';
import { KernelService } from '../kernel/account-abstraction.service.js';
import { ZeroXClientService } from './zerox-client.service.js';
import { UniswapV3ClientService } from './uniswap-v3-client.service.js';
import { UniswapV2ClientService } from './uniswap-v2-client.service.js';
import redis from '../../config/redis.js';
import {
  SEPOLIA_TOKENS,
  SWAP_CONFIG,
  resolveToken,
  type TokenConfig,
} from '../../config/tokens.js';
import { UNISWAP_V2_CONFIG } from '../../config/uniswap-v2.config.js';
import type {
  SwapQuoteRequest,
  SwapQuoteReverseRequest,
  SwapQuoteResponse,
  SwapExecuteRequest,
  SwapExecuteResponse,
  SwapStatusResponse,
  CachedQuoteData,
  SwapCall,
  SWAP_ERRORS,
} from './swap.types.js';

// ERC-20 approval ABI
const ERC20_APPROVE_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
]);

export class SwapService {
  private prisma: PrismaClient;
  private kernelService: KernelService;
  private zeroxClient: ZeroXClientService;
  private uniswapClient: UniswapV3ClientService;
  private uniswapV2Client: UniswapV2ClientService;

  // Fallback in-memory cache (used if Redis unavailable)
  private memoryCache: Map<string, CachedQuoteData> = new Map();
  private readonly QUOTE_CACHE_PREFIX = 'swap:quote:';
  private readonly QUOTE_EXPIRY_SECONDS = 30;

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;
    this.zeroxClient = new ZeroXClientService(SWAP_CONFIG.CHAIN_ID);
    this.uniswapClient = new UniswapV3ClientService(SWAP_CONFIG.CHAIN_ID);
    this.uniswapV2Client = new UniswapV2ClientService(SWAP_CONFIG.CHAIN_ID);

    // Periodically clean expired quotes from memory cache (every 60 seconds)
    setInterval(() => this.cleanExpiredQuotes(), 60000);
  }

  /**
   * Store quote in Redis with automatic TTL expiration
   * Falls back to memory cache if Redis is unavailable
   */
  private async cacheQuote(quoteId: string, data: CachedQuoteData): Promise<void> {
    try {
      const cacheKey = `${this.QUOTE_CACHE_PREFIX}${quoteId}`;

      if (redis.status === 'ready') {
        await redis.setex(cacheKey, this.QUOTE_EXPIRY_SECONDS, JSON.stringify(data));
        logger.debug(`Quote cached in Redis: ${quoteId}`);
      } else {
        // Graceful fallback to memory cache
        this.memoryCache.set(quoteId, data);
        logger.warn(`Redis unavailable, using memory cache for quote: ${quoteId}`);
      }
    } catch (error) {
      logger.error('Failed to cache quote in Redis, using memory fallback', { error });
      this.memoryCache.set(quoteId, data);
    }
  }

  /**
   * Retrieve quote from Redis or memory fallback
   */
  private async getCachedQuote(quoteId: string): Promise<CachedQuoteData | null> {
    try {
      const cacheKey = `${this.QUOTE_CACHE_PREFIX}${quoteId}`;

      if (redis.status === 'ready') {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug(`Quote retrieved from Redis: ${quoteId}`);
          return JSON.parse(cached);
        }
      }

      // Fallback to memory cache
      const memCached = this.memoryCache.get(quoteId);
      if (memCached) {
        logger.debug(`Quote retrieved from memory cache: ${quoteId}`);
        return memCached;
      }

      return null;
    } catch (error) {
      logger.error('Failed to retrieve quote from Redis, checking memory', { error });
      return this.memoryCache.get(quoteId) || null;
    }
  }

  /**
   * Delete quote from cache after execution
   */
  private async deleteCachedQuote(quoteId: string): Promise<void> {
    try {
      const cacheKey = `${this.QUOTE_CACHE_PREFIX}${quoteId}`;

      if (redis.status === 'ready') {
        await redis.del(cacheKey);
      }

      this.memoryCache.delete(quoteId);
      logger.debug(`Quote deleted from cache: ${quoteId}`);
    } catch (error) {
      logger.error('Failed to delete quote from cache', { error });
    }
  }

  /**
   * Get swap quote for given parameters
   * Returns pricing info and caches the quote for execution
   */
  async getQuote(request: SwapQuoteRequest): Promise<SwapQuoteResponse> {
    try {
      logger.info(`Getting swap quote for wallet ${request.walletId}`, {
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        sellAmount: request.sellAmount,
      });

      // 1. CRITICAL: Validate wallet exists and is active
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: request.walletId },
        select: {
          id: true,
          isActive: true,
          userId: true,
          address: true
        }
      });

      if (!wallet) {
        logger.error('Wallet not found for swap quote', {
          walletId: request.walletId
        });
        throw new Error('WALLET_NOT_FOUND: Wallet not found. Please sync your account and try again.');
      }

      if (!wallet.isActive) {
        logger.error('Inactive wallet used for swap', {
          walletId: request.walletId
        });
        throw new Error('WALLET_INACTIVE: Wallet is inactive. Please contact support.');
      }

      // 2. Validate tokens
      const sellTokenConfig = resolveToken(request.sellToken);
      const buyTokenConfig = resolveToken(request.buyToken);

      if (!sellTokenConfig) {
        throw new Error(`Invalid sell token: ${request.sellToken}`);
      }
      if (!buyTokenConfig) {
        throw new Error(`Invalid buy token: ${request.buyToken}`);
      }
      if (sellTokenConfig.symbol === buyTokenConfig.symbol) {
        throw new Error('Cannot swap token to itself');
      }

      // 2. Get wallet's kernel account address (MUST use smart account, not EOA)
      // Auto-create if missing (backward compatibility for legacy wallets)
      const kernelAccountResult = await this.kernelService.getOrCreateKernelAccount(
        request.walletId,
        SWAP_CONFIG.CHAIN_ID
      );

      const kernelAccount = {
        address: kernelAccountResult.address,
        isDeployed: kernelAccountResult.isDeployed
      };

      // 3. Check if this is a MOLE swap - use Uniswap V2 directly
      const isMoleSwap =
        sellTokenConfig.symbol === 'MOLE' ||
        buyTokenConfig.symbol === 'MOLE';

      if (isMoleSwap) {
        logger.info('MOLE swap detected, using Uniswap V2 direct integration', {
          sellToken: sellTokenConfig.symbol,
          buyToken: buyTokenConfig.symbol,
        });
        return this.getMoleQuoteV2(request, sellTokenConfig, buyTokenConfig, kernelAccount);
      }

      // 4. Fetch quote from 0x API with Uniswap V3 fallback
      // CRITICAL: Use smart account address as taker
      let zeroxQuote: any;
      let usedUniswap = false;

      try {
        zeroxQuote = await this.zeroxClient.getQuote({
          chainId: SWAP_CONFIG.CHAIN_ID,
          sellToken: sellTokenConfig.address,
          buyToken: buyTokenConfig.address,
          sellAmount: request.sellAmount,
          taker: kernelAccount.address as Address, // Smart account address
          slippageBps: request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS,
        });
      } catch (error: any) {
        // If 0x fails with NO_LIQUIDITY on testnet, try Uniswap V3
        if (error.message?.includes('NO_LIQUIDITY') && SWAP_CONFIG.CHAIN_ID === 11155111) {
          logger.warn('0x API failed, trying Uniswap V3 fallback...', {
            error: error.message,
          });

          try {
            const uniswapQuote = await this.uniswapClient.getQuote({
              chainId: SWAP_CONFIG.CHAIN_ID,
              sellToken: sellTokenConfig.address as Address,
              buyToken: buyTokenConfig.address as Address,
              sellAmount: request.sellAmount,
              slippageBps: request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS,
            });

            // Convert Uniswap quote to 0x format
            zeroxQuote = {
              sellAmount: uniswapQuote.sellAmount,
              buyAmount: uniswapQuote.buyAmount,
              allowanceTarget: sellTokenConfig.address, // For native ETH, this won't be used
              transaction: {
                to: uniswapQuote.route.pools[0], // Pool address (placeholder)
                data: '0x', // Will be built during execution
                value: '0',
                gas: uniswapQuote.estimatedGas,
              },
            };
            usedUniswap = true;

            logger.info('Using Uniswap V3 quote as fallback', {
              buyAmount: uniswapQuote.buyAmount,
              route: uniswapQuote.route,
            });
          } catch (uniswapError: any) {
            // Both 0x and Uniswap failed - provide comprehensive error
            logger.error('Both 0x and Uniswap V3 failed for token pair', {
              sellToken: sellTokenConfig.symbol,
              buyToken: buyTokenConfig.symbol,
              zeroxError: error.message,
              uniswapError: uniswapError.message,
            });

            // Re-throw with the most informative error message
            throw new Error(
              `INSUFFICIENT_LIQUIDITY: The ${sellTokenConfig.symbol}/${buyTokenConfig.symbol} pair is not available on Sepolia testnet. ` +
              `Sepolia has very limited DEX liquidity and most token pairs cannot be swapped. ` +
              `For testing swap functionality, please use mainnet or consider using a mock swap mode.`
            );
          }
        } else {
          throw error; // Re-throw if not a liquidity error
        }
      }

      // 4. Calculate formatted amounts and price
      const sellAmountFormatted = formatUnits(
        BigInt(zeroxQuote.sellAmount),
        sellTokenConfig.decimals
      );
      const buyAmountFormatted = formatUnits(
        BigInt(zeroxQuote.buyAmount),
        buyTokenConfig.decimals
      );

      const price = parseFloat(buyAmountFormatted) / parseFloat(sellAmountFormatted);
      const guaranteedPrice = price * (1 - (request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS) / 10000);

      // 5. Generate quote ID and cache
      const quoteId = randomUUID();
      const expiresAt = Date.now() + SWAP_CONFIG.QUOTE_EXPIRY_MS;

      const cachedData: CachedQuoteData = {
        zeroxQuote,
        sellTokenConfig,
        buyTokenConfig,
        kernelAccountAddress: kernelAccount.address as Address,
        walletId: request.walletId,
        sellAmount: request.sellAmount,
        expiresAt,
        source: 'zerox',
      };

      // Store in Redis (with automatic fallback to memory cache)
      await this.cacheQuote(quoteId, cachedData);

      // 6. Estimate gas cost in USD (for display - gas is sponsored)
      const estimatedGasUsd = this.estimateGasCostUsd(zeroxQuote.transaction.gas);

      // 7. Build sources array
      const sources = zeroxQuote.route?.fills?.map((f: { source: string; proportionBps: string }) => ({
        name: f.source,
        proportion: `${(parseInt(f.proportionBps) / 100).toFixed(0)}%`,
      })) || [];

      // 8. Build response
      const response: SwapQuoteResponse = {
        sellToken: sellTokenConfig.address,
        buyToken: buyTokenConfig.address,
        sellAmount: zeroxQuote.sellAmount,
        buyAmount: zeroxQuote.buyAmount,
        buyAmountBeforeFee: zeroxQuote.buyAmount,
        price: price.toFixed(8),
        guaranteedPrice: guaranteedPrice.toFixed(8),
        estimatedGasUsd,
        priceImpactPercent: '0.1', // TODO: Calculate from oracle price
        sources,
        allowanceTarget: zeroxQuote.allowanceTarget,
        quoteId,
        expiresAt,
        chainId: SWAP_CONFIG.CHAIN_ID,
      };

      logger.info(`Quote generated: ${quoteId}`, {
        sellAmount: sellAmountFormatted,
        buyAmount: buyAmountFormatted,
        price: price.toFixed(6),
        expiresAt: new Date(expiresAt).toISOString(),
      });

      return response;
    } catch (error) {
      logger.error('Failed to get swap quote', { error, request });
      throw error;
    }
  }

  /**
   * Get quote for MOLE swaps using Uniswap V2 pool
   * Bypasses 0x API since it doesn't discover custom pools
   */
  private async getMoleQuoteV2(
    request: SwapQuoteRequest,
    sellTokenConfig: TokenConfig,
    buyTokenConfig: TokenConfig,
    kernelAccount: { address: Address; isDeployed: boolean }
  ): Promise<SwapQuoteResponse> {
    try {
      // 1. Get quote from Uniswap V2 pool
      const v2Quote = await this.uniswapV2Client.getQuote({
        sellToken: sellTokenConfig.address,
        buyToken: buyTokenConfig.address,
        sellAmount: request.sellAmount,
        slippageBps: request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS,
      });

      // 2. Calculate formatted amounts
      const sellAmountFormatted = formatUnits(
        BigInt(v2Quote.sellAmount),
        sellTokenConfig.decimals
      );
      const buyAmountFormatted = formatUnits(
        BigInt(v2Quote.buyAmount),
        buyTokenConfig.decimals
      );

      const price = parseFloat(v2Quote.price);
      const guaranteedPrice = price * (1 - (request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS) / 10000);

      // 3. Generate quote ID and cache
      const quoteId = randomUUID();
      const expiresAt = Date.now() + SWAP_CONFIG.QUOTE_EXPIRY_MS;

      // 4. Cache quote with V2-specific data
      const cachedData: CachedQuoteData = {
        zeroxQuote: null, // Not used for V2
        v2Quote: v2Quote,
        sellTokenConfig,
        buyTokenConfig,
        kernelAccountAddress: kernelAccount.address,
        walletId: request.walletId,
        sellAmount: request.sellAmount,
        expiresAt,
        source: 'uniswap_v2',
      };

      await this.cacheQuote(quoteId, cachedData);

      // 5. Build response
      const response: SwapQuoteResponse = {
        sellToken: sellTokenConfig.address,
        buyToken: buyTokenConfig.address,
        sellAmount: v2Quote.sellAmount,
        buyAmount: v2Quote.buyAmount,
        buyAmountBeforeFee: v2Quote.buyAmount,
        price: price.toFixed(8),
        guaranteedPrice: guaranteedPrice.toFixed(8),
        estimatedGasUsd: this.estimateGasCostUsd(v2Quote.estimatedGas),
        priceImpactPercent: v2Quote.priceImpact,
        sources: [{ name: 'Uniswap V2', proportion: '100%' }],
        allowanceTarget: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
        quoteId,
        expiresAt,
        chainId: SWAP_CONFIG.CHAIN_ID,
      };

      logger.info(`MOLE quote generated via Uniswap V2: ${quoteId}`, {
        sellAmount: sellAmountFormatted,
        buyAmount: buyAmountFormatted,
        price: price.toFixed(6),
        priceImpact: v2Quote.priceImpact,
      });

      return response;
    } catch (error) {
      logger.error('Failed to get MOLE quote from Uniswap V2', { error, request });
      throw new Error(
        `MOLE_SWAP_FAILED: Unable to get quote from MOLE/WETH pool. ${(error as Error).message}`
      );
    }
  }

  /**
   * Get reverse quote (by buy amount)
   * Calculates required sell amount for desired buy amount
   * Enables UX where user enters desired output and sees calculated input
   */
  async getQuoteReverse(request: SwapQuoteReverseRequest): Promise<SwapQuoteResponse> {
    try {
      logger.info(`Getting reverse swap quote for wallet ${request.walletId}`, {
        sellToken: request.sellToken,
        buyToken: request.buyToken,
        buyAmount: request.buyAmount,
      });

      // 1. CRITICAL: Validate wallet exists and is active
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: request.walletId },
        select: {
          id: true,
          isActive: true,
          userId: true,
          address: true
        }
      });

      if (!wallet) {
        logger.error('Wallet not found for reverse swap quote', {
          walletId: request.walletId
        });
        throw new Error('WALLET_NOT_FOUND: Wallet not found. Please sync your account and try again.');
      }

      if (!wallet.isActive) {
        logger.error('Inactive wallet used for reverse swap', {
          walletId: request.walletId
        });
        throw new Error('WALLET_INACTIVE: Wallet is inactive. Please contact support.');
      }

      // 2. Validate tokens
      const sellTokenConfig = resolveToken(request.sellToken);
      const buyTokenConfig = resolveToken(request.buyToken);

      if (!sellTokenConfig) {
        throw new Error(`Invalid sell token: ${request.sellToken}`);
      }
      if (!buyTokenConfig) {
        throw new Error(`Invalid buy token: ${request.buyToken}`);
      }
      if (sellTokenConfig.symbol === buyTokenConfig.symbol) {
        throw new Error('Cannot swap token to itself');
      }

      // 2. Get wallet's kernel account address (MUST use smart account, not EOA)
      // Auto-create if missing (backward compatibility for legacy wallets)
      const kernelAccountResult = await this.kernelService.getOrCreateKernelAccount(
        request.walletId,
        SWAP_CONFIG.CHAIN_ID
      );

      const kernelAccount = {
        address: kernelAccountResult.address,
        isDeployed: kernelAccountResult.isDeployed
      };

      // 3. Fetch reverse quote from 0x API (using buyAmount)
      const zeroxQuote = await this.zeroxClient.getQuoteByBuyAmount({
        chainId: SWAP_CONFIG.CHAIN_ID,
        sellToken: sellTokenConfig.address,
        buyToken: buyTokenConfig.address,
        buyAmount: request.buyAmount,
        taker: kernelAccount.address as Address,
        slippageBps: request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS,
      });

      // 4. Calculate formatted amounts and price
      const sellAmountFormatted = formatUnits(
        BigInt(zeroxQuote.sellAmount),
        sellTokenConfig.decimals
      );
      const buyAmountFormatted = formatUnits(
        BigInt(zeroxQuote.buyAmount),
        buyTokenConfig.decimals
      );

      const price = parseFloat(buyAmountFormatted) / parseFloat(sellAmountFormatted);
      const guaranteedPrice = price * (1 - (request.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS) / 10000);

      // 5. Generate quote ID and cache
      const quoteId = randomUUID();
      const expiresAt = Date.now() + SWAP_CONFIG.QUOTE_EXPIRY_MS;

      const cachedData: CachedQuoteData = {
        zeroxQuote,
        sellTokenConfig,
        buyTokenConfig,
        kernelAccountAddress: kernelAccount.address as Address,
        walletId: request.walletId,
        sellAmount: zeroxQuote.sellAmount, // Use calculated sellAmount
        expiresAt,
        source: 'zerox',
      };

      // Store in Redis (with automatic fallback to memory cache)
      await this.cacheQuote(quoteId, cachedData);

      // 6. Estimate gas cost in USD
      const estimatedGasUsd = this.estimateGasCostUsd(zeroxQuote.transaction.gas);

      // 7. Build sources array
      const sources = zeroxQuote.route?.fills?.map((f: { source: string; proportionBps: string }) => ({
        name: f.source,
        proportion: `${(parseInt(f.proportionBps) / 100).toFixed(0)}%`,
      })) || [];

      // 8. Build response
      const response: SwapQuoteResponse = {
        sellToken: sellTokenConfig.address,
        buyToken: buyTokenConfig.address,
        sellAmount: zeroxQuote.sellAmount, // Calculated by 0x
        buyAmount: zeroxQuote.buyAmount,
        buyAmountBeforeFee: zeroxQuote.buyAmount,
        price: price.toFixed(8),
        guaranteedPrice: guaranteedPrice.toFixed(8),
        estimatedGasUsd,
        priceImpactPercent: '0.1',
        sources,
        allowanceTarget: zeroxQuote.allowanceTarget,
        quoteId,
        expiresAt,
        chainId: SWAP_CONFIG.CHAIN_ID,
      };

      logger.info(`Reverse quote generated: ${quoteId}`, {
        sellAmount: sellAmountFormatted,
        buyAmount: buyAmountFormatted,
        price: price.toFixed(6),
        expiresAt: new Date(expiresAt).toISOString(),
      });

      return response;
    } catch (error) {
      logger.error('Failed to get reverse swap quote', { error, request });
      throw error;
    }
  }

  /**
   * Execute swap using cached quote
   * Builds approval + swap calls and submits as batched UserOperation
   *
   * Critical implementation details:
   * 1. Validates request params match cached quote
   * 2. Uses exact amount for approval (not unlimited)
   * 3. Handles native ETH differently (no approval needed)
   * 4. Submits as sponsored UserOperation
   */
  async executeSwap(request: SwapExecuteRequest): Promise<SwapExecuteResponse> {
    try {
      logger.info(`Executing swap for quote ${request.quoteId}`, {
        walletId: request.walletId,
        sellToken: request.sellToken,
        buyToken: request.buyToken,
      });

      // 1. Retrieve cached quote from Redis (with fallback to memory)
      const cachedData = await this.getCachedQuote(request.quoteId);
      if (!cachedData) {
        throw new Error('Quote not found or expired. Please request a new quote.');
      }

      // 2. Validate quote not expired
      if (Date.now() > cachedData.expiresAt) {
        await this.deleteCachedQuote(request.quoteId);
        throw new Error('Quote has expired (>30 seconds). Please request a new quote.');
      }

      // 3. Validate request params match cached quote
      const sellTokenConfig = resolveToken(request.sellToken);
      const buyTokenConfig = resolveToken(request.buyToken);

      if (!sellTokenConfig || !buyTokenConfig) {
        throw new Error('Invalid token in request');
      }

      // Normalize sellAmount to strings for comparison (handles number vs string types)
      const normalizedRequestSellAmount = String(request.sellAmount);
      const normalizedCachedSellAmount = String(cachedData.sellAmount);

      if (
        sellTokenConfig.address.toLowerCase() !== cachedData.sellTokenConfig.address.toLowerCase() ||
        buyTokenConfig.address.toLowerCase() !== cachedData.buyTokenConfig.address.toLowerCase() ||
        normalizedRequestSellAmount !== normalizedCachedSellAmount ||
        request.walletId !== cachedData.walletId
      ) {
        // Enhanced error logging for debugging
        logger.error('Quote parameter mismatch detected', {
          quoteId: request.quoteId,
          sellTokenMatch: sellTokenConfig.address.toLowerCase() === cachedData.sellTokenConfig.address.toLowerCase(),
          buyTokenMatch: buyTokenConfig.address.toLowerCase() === cachedData.buyTokenConfig.address.toLowerCase(),
          sellAmountMatch: normalizedRequestSellAmount === normalizedCachedSellAmount,
          walletIdMatch: request.walletId === cachedData.walletId,
          requestSellAmount: request.sellAmount,
          requestSellAmountType: typeof request.sellAmount,
          cachedSellAmount: cachedData.sellAmount,
          cachedSellAmountType: typeof cachedData.sellAmount,
        });
        throw new Error('Request parameters do not match cached quote. Please request a new quote.');
      }

      const { zeroxQuote, v2Quote, source, sellTokenConfig: cachedSellToken } = cachedData;

      // 4. Build transaction calls array
      const calls: SwapCall[] = [];

      // 5. Handle approval for ERC-20 tokens (not native ETH)
      if (!cachedSellToken.isNative) {
        // CRITICAL: Use exact amount for approval, not MaxUint256
        // This prevents leftover approvals that could be exploited
        const approvalTarget = source === 'uniswap_v2'
          ? UNISWAP_V2_CONFIG.ROUTER_ADDRESS
          : zeroxQuote!.allowanceTarget;

        const sellAmount = source === 'uniswap_v2'
          ? v2Quote!.sellAmount
          : zeroxQuote!.sellAmount;

        const approvalData = encodeFunctionData({
          abi: ERC20_APPROVE_ABI,
          functionName: 'approve',
          args: [approvalTarget, BigInt(sellAmount)],
        });

        calls.push({
          to: cachedSellToken.address,
          value: 0n,
          data: approvalData,
        });

        logger.info(`Added ERC-20 approval call`, {
          token: cachedSellToken.symbol,
          spender: approvalTarget,
          amount: sellAmount,
        });
      }

      // 6. Add swap call based on source
      if (source === 'uniswap_v2') {
        // Generate V2 swap calldata
        const swapCall = this.uniswapV2Client.generateSwapCalldata({
          sellToken: cachedData.sellTokenConfig.address,
          buyToken: cachedData.buyTokenConfig.address,
          sellAmount: request.sellAmount,
          minBuyAmount: request.minBuyAmount,
          recipient: cachedData.kernelAccountAddress,
        });

        calls.push(swapCall);

        logger.info('Added Uniswap V2 swap call', {
          to: swapCall.to,
          value: swapCall.value.toString(),
          isMoleSwap: true,
        });
      } else {
        // Add swap call from 0x quote
        // For native ETH sells, the value must be set to the sell amount
        const swapValue = cachedSellToken.isNative ? BigInt(zeroxQuote!.sellAmount) : 0n;

        calls.push({
          to: zeroxQuote!.transaction.to,
          value: swapValue,
          data: zeroxQuote!.transaction.data,
        });

        logger.info(`Added 0x swap call`, {
          to: zeroxQuote!.transaction.to,
          value: swapValue.toString(),
          isNativeETH: cachedSellToken.isNative,
          callsCount: calls.length,
        });
      }

      // 7. Submit batched UserOperation via Kernel service (sponsored)
      const userOpResult = await this.kernelService.submitUserOperation(
        request.walletId,
        SWAP_CONFIG.CHAIN_ID,
        calls,
        true // Sponsor gas
      );

      // 8. Record swap transaction in database
      const expectedBuyAmount = source === 'uniswap_v2'
        ? v2Quote!.buyAmount
        : zeroxQuote!.buyAmount;

      await this.recordSwapTransaction({
        walletId: request.walletId,
        userOpHash: userOpResult.userOpHash,
        sellToken: cachedData.sellTokenConfig.address,
        sellTokenSymbol: cachedData.sellTokenConfig.symbol,
        buyToken: cachedData.buyTokenConfig.address,
        buyTokenSymbol: cachedData.buyTokenConfig.symbol,
        sellAmount: request.sellAmount,
        expectedBuyAmount,
        minBuyAmount: request.minBuyAmount,
        quoteId: request.quoteId,
        chainId: SWAP_CONFIG.CHAIN_ID,
      });

      // 9. Clear used quote from cache (Redis + memory)
      await this.deleteCachedQuote(request.quoteId);

      logger.info(`Swap submitted successfully`, {
        userOpHash: userOpResult.userOpHash,
        sponsored: userOpResult.sponsored,
        callsCount: calls.length,
      });

      return {
        userOpHash: userOpResult.userOpHash,
        status: 'submitted',
        sellAmount: request.sellAmount,
        expectedBuyAmount,
        sponsored: userOpResult.sponsored,
      };
    } catch (error) {
      logger.error('Failed to execute swap', { error, request });
      throw error;
    }
  }

  /**
   * Get swap transaction status
   */
  async getSwapStatus(userOpHash: string): Promise<SwapStatusResponse> {
    const userOp = await this.prisma.userOperation.findUnique({
      where: { userOpHash },
    });

    if (!userOp) {
      throw new Error('UserOperation not found');
    }

    return {
      status: userOp.status,
      transactionHash: userOp.transactionHash || undefined,
      blockNumber: userOp.blockNumber || undefined,
    };
  }

  /**
   * Get list of supported tokens
   */
  getSupportedTokens(): Array<{
    symbol: string;
    name: string;
    address: string;
    decimals: number;
    isNative: boolean;
  }> {
    return Object.values(SEPOLIA_TOKENS).map((token) => ({
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      decimals: token.decimals,
      isNative: token.isNative,
    }));
  }

  // ============ PRIVATE HELPER METHODS ============

  /**
   * Estimate gas cost in USD (for display purposes)
   * Gas is sponsored so this is just for transparency
   */
  private estimateGasCostUsd(gasEstimate: string): string {
    // Simplified estimation
    // In production, fetch current gas price and ETH price
    const gasUnits = parseInt(gasEstimate) || 200000;
    const avgGasPrice = 30; // gwei
    const ethPrice = 2500; // USD
    const gasCostEth = gasUnits * avgGasPrice * 1e-9;
    return (gasCostEth * ethPrice).toFixed(4);
  }

  /**
   * Record swap transaction in database
   */
  private async recordSwapTransaction(params: {
    walletId: string;
    userOpHash: Hex;
    sellToken: string;
    sellTokenSymbol: string;
    buyToken: string;
    buyTokenSymbol: string;
    sellAmount: string;
    expectedBuyAmount: string;
    minBuyAmount: string;
    quoteId: string;
    chainId: number;
  }): Promise<void> {
    try {
      await this.prisma.transaction.create({
        data: {
          walletId: params.walletId,
          fromAddress: params.sellToken,
          toAddress: params.buyToken,
          value: params.sellAmount,
          status: 'pending',
          chainId: params.chainId,
          transactionType: 'swap',
          metadata: {
            type: 'gasless_swap',
            sellToken: params.sellToken,
            sellTokenSymbol: params.sellTokenSymbol,
            buyToken: params.buyToken,
            buyTokenSymbol: params.buyTokenSymbol,
            sellAmount: params.sellAmount,
            expectedBuyAmount: params.expectedBuyAmount,
            minBuyAmount: params.minBuyAmount,
            quoteId: params.quoteId,
            userOpHash: params.userOpHash,
            via: '0x_api',
          },
        },
      });

      logger.debug('Swap transaction recorded in database');
    } catch (error) {
      // Log but don't fail the swap if DB recording fails
      logger.error('Failed to record swap transaction', { error });
    }
  }

  /**
   * Clean expired quotes from memory cache
   * Note: Redis quotes auto-expire via TTL
   */
  private cleanExpiredQuotes(): void {
    const now = Date.now();
    let cleaned = 0;

    // Only clean memory cache (Redis has automatic TTL expiration)
    for (const [quoteId, data] of this.memoryCache.entries()) {
      if (now > data.expiresAt) {
        this.memoryCache.delete(quoteId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(`Cleaned ${cleaned} expired quotes from memory cache`);
    }
  }
}
