/**
 * Uniswap V2 Client Service
 * Direct integration with MOLE/WETH Uniswap V2 pool on Sepolia
 *
 * This service bypasses 0x API for MOLE swaps since 0x doesn't discover
 * custom/new liquidity pools. It directly queries the Uniswap V2 pair contract
 * and generates swap calldata for the Uniswap V2 Router.
 */

import { createPublicClient, http, parseAbi, encodeFunctionData, type Address, type Hex } from 'viem';
import { sepolia, arbitrum } from 'viem/chains';
import { developmentMode } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import { UNISWAP_V2_CONFIG } from '../../config/uniswap-v2.config.js';
import type { UniswapV2QuoteParams, UniswapV2QuoteResponse } from './swap.types.js';

// Uniswap V2 Router02 ABI (minimal - only functions we need)
const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function factory() view returns (address)',
]);

// Uniswap V2 Factory ABI
const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address)',
]);

// Minimum swap amount in wei (0.001 ETH = 1e15 wei)
// Smaller amounts may fail due to precision issues or gas inefficiency
const MIN_SWAP_AMOUNT_WEI = 1000000000000000n; // 0.001 ETH

// Uniswap V2 Pair ABI
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]);

// Sepolia RPC URL
const CHAIN_RPC = process.env.ETH_RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org';

export class UniswapV2ClientService {
  private client: ReturnType<typeof createPublicClient>;

  constructor(chainId: number) {
    this.client = createPublicClient({
      chain: developmentMode ? sepolia : arbitrum,
      transport: http(CHAIN_RPC),
    });

    logger.info(`UniswapV2Client initialized for chain ${chainId}`, {
      router: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
      pair: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
    });
  }

  /**
   * Validate that the liquidity pool exists and has sufficient reserves
   * This helps catch INVALID_PATH errors before they hit the router
   */
  async validatePoolLiquidity(): Promise<{
    isValid: boolean;
    reserveMole: bigint;
    reserveWeth: bigint;
    pairAddress: Address;
    factoryPairAddress: Address | null;
  }> {
    try {
      // 1. Check if the configured pair contract exists and has reserves
      const [reserve0, reserve1] = await this.client.readContract({
        address: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        abi: PAIR_ABI,
        functionName: 'getReserves',
      }) as [bigint, bigint, number];

      // 2. Get token order to determine which reserve is which
      const token0 = await this.client.readContract({
        address: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        abi: PAIR_ABI,
        functionName: 'token0',
      }) as Address;

      const isToken0Mole = token0.toLowerCase() === UNISWAP_V2_CONFIG.MOLE_ADDRESS.toLowerCase();
      const [reserveMole, reserveWeth] = isToken0Mole
        ? [reserve0, reserve1]
        : [reserve1, reserve0];

      // 3. Try to verify pair via router's factory (if available)
      let factoryPairAddress: Address | null = null;
      try {
        const factory = await this.client.readContract({
          address: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
          abi: ROUTER_ABI,
          functionName: 'factory',
        }) as Address;

        factoryPairAddress = await this.client.readContract({
          address: factory,
          abi: FACTORY_ABI,
          functionName: 'getPair',
          args: [UNISWAP_V2_CONFIG.WETH_ADDRESS, UNISWAP_V2_CONFIG.MOLE_ADDRESS],
        }) as Address;

        logger.debug('Factory pair lookup result', {
          factory,
          factoryPairAddress,
          configuredPair: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
          pairsMatch: factoryPairAddress.toLowerCase() === UNISWAP_V2_CONFIG.MOLE_WETH_PAIR.toLowerCase(),
        });
      } catch (factoryError) {
        logger.warn('Could not verify pair via factory', { error: factoryError });
      }

      const hasLiquidity = reserveMole > 0n && reserveWeth > 0n;

      logger.info('Pool liquidity validation', {
        reserveMole: reserveMole.toString(),
        reserveWeth: reserveWeth.toString(),
        hasLiquidity,
        factoryPairAddress,
        configuredPair: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
      });

      return {
        isValid: hasLiquidity,
        reserveMole,
        reserveWeth,
        pairAddress: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        factoryPairAddress,
      };
    } catch (error) {
      logger.error('Pool liquidity validation failed', { error });
      return {
        isValid: false,
        reserveMole: 0n,
        reserveWeth: 0n,
        pairAddress: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        factoryPairAddress: null,
      };
    }
  }

  /**
   * Validate swap path using router's getAmountsOut
   * This is the definitive check - if this fails, the swap will fail
   */
  async validateSwapPath(
    sellAmount: string,
    path: Address[]
  ): Promise<{ isValid: boolean; amountsOut: bigint[] | null; error?: string }> {
    try {
      const amountsOut = await this.client.readContract({
        address: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
        abi: ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [BigInt(sellAmount), path],
      }) as bigint[];

      logger.debug('Router getAmountsOut validation', {
        sellAmount,
        path,
        amountsOut: amountsOut.map(a => a.toString()),
      });

      return {
        isValid: true,
        amountsOut,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Parse common Uniswap V2 errors
      let friendlyError = 'Router path validation failed';
      if (errorMessage.includes('INVALID_PATH')) {
        friendlyError = 'INVALID_PATH: The liquidity pool is not registered with this router. ' +
          'The pair may exist on a different Uniswap V2 fork or factory.';
      } else if (errorMessage.includes('INSUFFICIENT_LIQUIDITY')) {
        friendlyError = 'INSUFFICIENT_LIQUIDITY: The pool does not have enough liquidity for this swap.';
      }

      logger.error('Router path validation failed', {
        sellAmount,
        path,
        error: errorMessage,
        friendlyError,
      });

      return {
        isValid: false,
        amountsOut: null,
        error: friendlyError,
      };
    }
  }

  /**
   * Get swap quote from MOLE/WETH Uniswap V2 pool
   * Calculates output amount using constant product formula (x * y = k)
   */
  async getQuote(params: UniswapV2QuoteParams): Promise<UniswapV2QuoteResponse> {
    try {
      logger.info('Fetching Uniswap V2 quote', {
        sellToken: params.sellToken,
        buyToken: params.buyToken,
        sellAmount: params.sellAmount,
      });

      // 1. Validate pair support
      if (!this.validatePairSupport(params.sellToken, params.buyToken)) {
        throw new Error('UNSUPPORTED_PAIR: Only MOLE/ETH pairs supported');
      }

      // 2. Check minimum swap amount
      const sellAmountBigInt = BigInt(params.sellAmount);
      if (sellAmountBigInt < MIN_SWAP_AMOUNT_WEI) {
        throw new Error(
          `AMOUNT_TOO_SMALL: Minimum swap amount is 0.001 ETH (${MIN_SWAP_AMOUNT_WEI.toString()} wei). ` +
          `You provided ${params.sellAmount} wei.`
        );
      }

      // 3. Determine swap direction
      const isMoleBuy = params.buyToken.toLowerCase() === UNISWAP_V2_CONFIG.MOLE_ADDRESS.toLowerCase();

      // 3. Query pool reserves
      const [reserve0, reserve1] = await this.client.readContract({
        address: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        abi: PAIR_ABI,
        functionName: 'getReserves',
      }) as [bigint, bigint, number];

      // 4. Determine token order in pair (token0 vs token1)
      const token0 = await this.client.readContract({
        address: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        abi: PAIR_ABI,
        functionName: 'token0',
      }) as Address;

      const isToken0Mole = token0.toLowerCase() === UNISWAP_V2_CONFIG.MOLE_ADDRESS.toLowerCase();
      const [reserveMole, reserveWeth] = isToken0Mole
        ? [reserve0, reserve1]
        : [reserve1, reserve0];

      logger.debug('Pool reserves', {
        reserveMole: reserveMole.toString(),
        reserveWeth: reserveWeth.toString(),
        token0,
        isToken0Mole,
      });

      // 5. Calculate output using constant product formula
      // Formula: amountOut = (amountIn * 997 * reserveOut) / (reserveIn * 1000 + amountIn * 997)
      // The 997/1000 accounts for 0.3% fee
      const amountIn = BigInt(params.sellAmount);
      const amountInWithFee = amountIn * 997n;

      const [reserveIn, reserveOut] = isMoleBuy
        ? [reserveWeth, reserveMole]
        : [reserveMole, reserveWeth];

      const numerator = amountInWithFee * reserveOut;
      const denominator = (reserveIn * 1000n) + amountInWithFee;
      const buyAmount = numerator / denominator;

      // 6. Apply slippage for minBuyAmount
      const minBuyAmount = (buyAmount * BigInt(10000 - params.slippageBps)) / 10000n;

      // 7. Calculate price
      const price = Number(buyAmount) / Number(amountIn);

      // 8. Calculate price impact
      const priceImpact = this.calculatePriceImpact(amountIn, reserveIn, reserveOut);

      // 9. Build the swap path
      const swapPath: Address[] = isMoleBuy
        ? [UNISWAP_V2_CONFIG.WETH_ADDRESS, UNISWAP_V2_CONFIG.MOLE_ADDRESS]
        : [UNISWAP_V2_CONFIG.MOLE_ADDRESS, UNISWAP_V2_CONFIG.WETH_ADDRESS];

      // 10. CRITICAL: Validate the path with the router before returning quote
      // This catches INVALID_PATH errors early, before the user tries to execute
      const pathValidation = await this.validateSwapPath(params.sellAmount, swapPath);
      if (!pathValidation.isValid) {
        logger.error('Router path validation failed during quote', {
          sellAmount: params.sellAmount,
          path: swapPath,
          error: pathValidation.error,
          routerAddress: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
          pairAddress: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        });

        throw new Error(
          pathValidation.error ||
          'INVALID_PATH: Unable to validate swap path with router. ' +
          'The liquidity pool may not be registered with this Uniswap V2 router.'
        );
      }

      logger.info('Uniswap V2 quote calculated', {
        sellAmount: params.sellAmount,
        buyAmount: buyAmount.toString(),
        minBuyAmount: minBuyAmount.toString(),
        price: price.toString(),
        priceImpact,
        routerValidated: true,
      });

      return {
        sellAmount: params.sellAmount,
        buyAmount: buyAmount.toString(),
        minBuyAmount: minBuyAmount.toString(),
        price: price.toString(),
        priceImpact,
        route: {
          path: swapPath,
          pair: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
        },
        estimatedGas: '150000', // Typical Uniswap V2 swap gas
      };
    } catch (error) {
      logger.error('Failed to fetch Uniswap V2 quote', { error });
      throw error;
    }
  }

  /**
   * Generate swap calldata for Uniswap V2 Router
   * Returns transaction data ready for UserOperation execution
   */
  generateSwapCalldata(params: {
    sellToken: Address;
    buyToken: Address;
    sellAmount: string;
    minBuyAmount: string;
    recipient: Address; // Kernel smart account
  }): { to: Address; data: Hex; value: bigint } {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + UNISWAP_V2_CONFIG.SWAP_DEADLINE_SECONDS);

    const isMoleBuy = params.buyToken.toLowerCase() === UNISWAP_V2_CONFIG.MOLE_ADDRESS.toLowerCase();
    const isNativeEth = params.sellToken.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

    if (isNativeEth && isMoleBuy) {
      // ETH → MOLE (swapExactETHForTokens)
      const data = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'swapExactETHForTokens',
        args: [
          BigInt(params.minBuyAmount),
          [UNISWAP_V2_CONFIG.WETH_ADDRESS, UNISWAP_V2_CONFIG.MOLE_ADDRESS],
          params.recipient,
          deadline,
        ],
      });

      logger.debug('Generated ETH→MOLE swap calldata', {
        minBuyAmount: params.minBuyAmount,
        recipient: params.recipient,
        value: params.sellAmount,
      });

      return {
        to: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
        data,
        value: BigInt(params.sellAmount), // Send ETH value
      };
    } else {
      // MOLE → ETH (swapExactTokensForETH)
      const data = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'swapExactTokensForETH',
        args: [
          BigInt(params.sellAmount),
          BigInt(params.minBuyAmount),
          [UNISWAP_V2_CONFIG.MOLE_ADDRESS, UNISWAP_V2_CONFIG.WETH_ADDRESS],
          params.recipient,
          deadline,
        ],
      });

      logger.debug('Generated MOLE→ETH swap calldata', {
        sellAmount: params.sellAmount,
        minBuyAmount: params.minBuyAmount,
        recipient: params.recipient,
      });

      return {
        to: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
        data,
        value: 0n, // No ETH value for ERC-20 swap
      };
    }
  }

  /**
   * Calculate price impact as percentage
   * Formula: (amountIn / reserveIn) * 100
   */
  private calculatePriceImpact(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): string {
    // Avoid division by zero
    if (reserveIn === 0n) {
      return '100.00';
    }

    // Price impact = (amountIn / reserveIn) * 100
    const impact = (Number(amountIn) / Number(reserveIn)) * 100;

    // Limit to 2 decimal places
    return impact.toFixed(2);
  }

  /**
   * Validate that the token pair is supported
   * Currently only supports MOLE/ETH pairs
   */
  private validatePairSupport(sellToken: Address, buyToken: Address): boolean {
    const tokens = [sellToken.toLowerCase(), buyToken.toLowerCase()];
    const hasMole = tokens.includes(UNISWAP_V2_CONFIG.MOLE_ADDRESS.toLowerCase());
    const hasEth =
      tokens.includes('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') ||
      tokens.includes(UNISWAP_V2_CONFIG.WETH_ADDRESS.toLowerCase());

    return hasMole && hasEth;
  }
}
