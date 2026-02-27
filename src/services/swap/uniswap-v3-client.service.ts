/**
 * Uniswap V3 Direct Integration
 *
 * Provides fallback swap quotes for testnets when 0x API fails
 * Uses viem to query Uniswap V3 pools directly
 */

import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { sepolia, arbitrum } from 'viem/chains';
import { developmentMode } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';

// Uniswap V3 Pool ABI (minimal - just what we need)
const POOL_ABI = parseAbi([
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() external view returns (uint128)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
]);

// Uniswap V3 Factory ABI
const FACTORY_ABI = parseAbi([
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
]);

// Common fee tiers on Uniswap V3
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

// Contract addresses on Sepolia
const SEPOLIA_FACTORY = '0x0227628f3F023bb0B980b67D528571c95c6DaC1c' as Address;

// RPC URL (environment-aware)
const CHAIN_RPC = process.env.ETH_RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org';

export interface UniswapQuoteParams {
  chainId: number;
  sellToken: Address;
  buyToken: Address;
  sellAmount: string;
  slippageBps: number;
}

export interface UniswapQuoteResponse {
  buyAmount: string;
  sellAmount: string;
  price: string;
  priceImpact: string;
  route: {
    path: Address[];
    pools: string[];
  };
  estimatedGas: string;
}

export class UniswapV3ClientService {
  private client: ReturnType<typeof createPublicClient>;
  private chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
    this.client = createPublicClient({
      chain: developmentMode ? sepolia : arbitrum,
      transport: http(CHAIN_RPC),
    });
  }

  /**
   * Get swap quote from Uniswap V3
   * Tries different fee tiers to find the best route
   */
  async getQuote(params: UniswapQuoteParams): Promise<UniswapQuoteResponse> {
    logger.info('Fetching Uniswap V3 quote', {
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount,
    });

    try {
      // Find best pool across fee tiers
      const bestPool = await this.findBestPool(params.sellToken, params.buyToken);

      if (!bestPool) {
        throw new Error('NO_UNISWAP_POOL: No Uniswap V3 pool found for this token pair on Sepolia');
      }

      // Get quote from the pool
      const quote = await this.getQuoteFromPool(
        bestPool.poolAddress,
        bestPool.fee,
        params.sellToken,
        params.buyToken,
        params.sellAmount
      );

      logger.info('Uniswap V3 quote fetched successfully', {
        buyAmount: quote.buyAmount,
        fee: bestPool.fee,
        pool: bestPool.poolAddress,
      });

      return quote;
    } catch (error) {
      logger.error('Failed to fetch Uniswap V3 quote', { error });
      throw error;
    }
  }

  /**
   * Find the pool with best liquidity across fee tiers
   */
  private async findBestPool(
    tokenA: Address,
    tokenB: Address
  ): Promise<{ poolAddress: Address; fee: number } | null> {
    logger.debug('Finding best Uniswap V3 pool', { tokenA, tokenB });

    let bestPool: { poolAddress: Address; fee: number; liquidity: bigint } | null = null;

    for (const fee of FEE_TIERS) {
      try {
        const poolAddress = await this.client.readContract({
          address: SEPOLIA_FACTORY,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [tokenA, tokenB, fee],
        }) as Address;

        if (poolAddress === '0x0000000000000000000000000000000000000000') {
          continue; // Pool doesn't exist for this fee tier
        }

        const liquidity = await this.client.readContract({
          address: poolAddress,
          abi: POOL_ABI,
          functionName: 'liquidity',
        }) as bigint;

        logger.debug(`Pool found for fee tier ${fee / 10000}%`, {
          pool: poolAddress,
          liquidity: liquidity.toString(),
        });

        // Track the pool with highest liquidity
        if (!bestPool || liquidity > bestPool.liquidity) {
          bestPool = { poolAddress, fee, liquidity };
        }
      } catch (error) {
        logger.debug(`No pool found for fee tier ${fee / 10000}%`);
      }
    }

    if (bestPool && bestPool.liquidity > 0n) {
      logger.info('Best Uniswap V3 pool found', {
        pool: bestPool.poolAddress,
        fee: bestPool.fee,
        liquidity: bestPool.liquidity.toString(),
      });
      return { poolAddress: bestPool.poolAddress, fee: bestPool.fee };
    }

    return null;
  }

  /**
   * Get quote from a specific pool
   */
  private async getQuoteFromPool(
    poolAddress: Address,
    fee: number,
    sellToken: Address,
    buyToken: Address,
    sellAmount: string
  ): Promise<UniswapQuoteResponse> {
    // Fetch pool state
    const [slot0Result, liquidity, token0Address, token1Address] = await Promise.all([
      this.client.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'slot0',
      }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
      this.client.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'liquidity',
      }) as Promise<bigint>,
      this.client.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'token0',
      }) as Promise<Address>,
      this.client.readContract({
        address: poolAddress,
        abi: POOL_ABI,
        functionName: 'token1',
      }) as Promise<Address>,
    ]);

    const sqrtPriceX96 = slot0Result[0];

    // Determine token order
    const token0IsSell = sellToken.toLowerCase() === token0Address.toLowerCase();

    // Get token decimals
    const sellDecimals = this.getTokenDecimals(sellToken);
    const buyDecimals = this.getTokenDecimals(buyToken);

    // Calculate output amount using the constant product formula
    const sellAmountBigInt = BigInt(sellAmount);

    // Simple price calculation (approximate - for production use Quoter contract)
    let buyAmountEstimate: bigint;

    if (token0IsSell) {
      // Selling token0 for token1
      // price = (sqrtPriceX96 / 2^96) ^ 2
      const price = (sqrtPriceX96 * sqrtPriceX96) / (2n ** 192n);
      const decimalAdjustment = 10n ** BigInt(Math.abs(sellDecimals - buyDecimals));
      buyAmountEstimate = sellDecimals > buyDecimals
        ? (sellAmountBigInt * price) / decimalAdjustment
        : (sellAmountBigInt * price) * decimalAdjustment;
    } else {
      // Selling token1 for token0
      const price = (2n ** 192n) / (sqrtPriceX96 * sqrtPriceX96);
      const decimalAdjustment = 10n ** BigInt(Math.abs(sellDecimals - buyDecimals));
      buyAmountEstimate = sellDecimals > buyDecimals
        ? (sellAmountBigInt * price) / decimalAdjustment
        : (sellAmountBigInt * price) * decimalAdjustment;
    }

    // Apply fee (reduce output by fee amount)
    const feeMultiplier = 10000n - BigInt(Math.floor(fee / 100));
    const buyAmountAfterFee = (buyAmountEstimate * feeMultiplier) / 10000n;

    // Calculate price
    const priceValue = (Number(buyAmountAfterFee) / Number(sellAmountBigInt)).toString();

    return {
      buyAmount: buyAmountAfterFee.toString(),
      sellAmount: sellAmount,
      price: priceValue,
      priceImpact: '0.5', // Rough estimate
      route: {
        path: [sellToken, buyToken],
        pools: [poolAddress],
      },
      estimatedGas: '200000', // Estimate
    };
  }

  /**
   * Get token decimals (hardcoded for common tokens)
   */
  private getTokenDecimals(tokenAddress: Address): number {
    const addr = tokenAddress.toLowerCase();

    // ETH/WETH
    if (addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') return 18;

    // Common Sepolia addresses
    if (addr === '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238') return 6; // USDC
    if (addr === '0x7169d38820dfd117c3fa1f22a697dba58d90ba06') return 6; // USDT
    if (addr === '0x68194a729c2450ad26072b3d33adacbcef39d574') return 18; // DAI

    // Default to 18 decimals
    return 18;
  }
}
