/**
 * Type definitions for Gasless Swap Service
 * 0x API integration with ZeroDev Kernel accounts
 */

import type { Address, Hex } from 'viem';
import type { TokenConfig } from '../../config/tokens.js';

// ============ REQUEST TYPES ============

/**
 * Request parameters for getting a swap quote
 */
export interface SwapQuoteRequest {
  /** User's wallet ID (UUID) */
  walletId: string;
  /** Token to sell (symbol or address) */
  sellToken: string;
  /** Token to buy (symbol or address) */
  buyToken: string;
  /** Amount to sell in smallest unit (wei for ETH, 6 decimals for USDC, etc.) */
  sellAmount: string;
  /** Slippage tolerance in basis points (100 = 1%), optional */
  slippageBps?: number;
}

/**
 * Request parameters for reverse quote (by buy amount)
 * Calculates required sell amount for desired buy amount
 */
export interface SwapQuoteReverseRequest {
  /** User's wallet ID (UUID) */
  walletId: string;
  /** Token to sell (symbol or address) */
  sellToken: string;
  /** Token to buy (symbol or address) */
  buyToken: string;
  /** Desired amount to receive in smallest unit */
  buyAmount: string;
  /** Slippage tolerance in basis points (100 = 1%), optional */
  slippageBps?: number;
}

/**
 * Request parameters for executing a swap
 */
export interface SwapExecuteRequest {
  /** User's wallet ID (UUID) */
  walletId: string;
  /** Quote ID from getQuote response */
  quoteId: string;
  /** Token to sell (must match quote) */
  sellToken: string;
  /** Token to buy (must match quote) */
  buyToken: string;
  /** Amount to sell (must match quote) */
  sellAmount: string;
  /** Minimum acceptable output amount (with slippage applied) */
  minBuyAmount: string;
}

// ============ RESPONSE TYPES ============

/**
 * Response from getQuote endpoint
 */
export interface SwapQuoteResponse {
  /** Sell token address */
  sellToken: Address;
  /** Buy token address */
  buyToken: Address;
  /** Amount being sold (in smallest unit) */
  sellAmount: string;
  /** Expected output amount (in smallest unit) */
  buyAmount: string;
  /** Output before any fees */
  buyAmountBeforeFee: string;
  /** Exchange rate (buyAmount / sellAmount adjusted for decimals) */
  price: string;
  /** Minimum guaranteed price after slippage */
  guaranteedPrice: string;
  /** Estimated gas cost in USD (sponsored, shown for transparency) */
  estimatedGasUsd: string;
  /** Price impact as percentage string */
  priceImpactPercent: string;
  /** Liquidity sources used */
  sources: Array<{ name: string; proportion: string }>;
  /** Address to approve for token spending */
  allowanceTarget: Address;
  /** Unique quote identifier for execution */
  quoteId: string;
  /** Quote expiration timestamp (ms) */
  expiresAt: number;
  /** Chain ID */
  chainId: number;
}

/**
 * Response from executeSwap endpoint
 */
export interface SwapExecuteResponse {
  /** UserOperation hash (for tracking) */
  userOpHash: Hex;
  /** Transaction hash (available after mining) */
  transactionHash?: Hex;
  /** Current status */
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  /** Amount sold */
  sellAmount: string;
  /** Expected output amount */
  expectedBuyAmount: string;
  /** Whether gas was sponsored */
  sponsored: boolean;
}

/**
 * Response from getSwapStatus endpoint
 */
export interface SwapStatusResponse {
  /** Current status */
  status: string;
  /** Transaction hash if mined */
  transactionHash?: string;
  /** Block number if confirmed */
  blockNumber?: number;
}

// ============ 0X API TYPES ============

/**
 * Parameters for 0x API quote request
 */
export interface ZeroXQuoteParams {
  /** Chain ID (11155111 for Sepolia) */
  chainId: number;
  /** Token address to sell */
  sellToken: Address;
  /** Token address to buy */
  buyToken: Address;
  /** Amount to sell in smallest unit */
  sellAmount: string;
  /** Taker address (MUST be smart account address) */
  taker: Address;
  /** Slippage in basis points */
  slippageBps?: number;
  /** Skip on-chain validation (required for AA wallets) */
  skipValidation?: boolean;
}

/**
 * Response from 0x API /swap/v1/quote
 */
export interface ZeroXQuoteResponse {
  /** Block number at quote time */
  blockNumber: string;
  /** Expected output amount */
  buyAmount: string;
  /** Buy token address */
  buyToken: Address;
  /** Input amount */
  sellAmount: string;
  /** Sell token address */
  sellToken: Address;
  /** Address to approve for spending */
  allowanceTarget: Address;
  /** Transaction data to execute swap */
  transaction: {
    to: Address;
    data: Hex;
    value: string;
    gas: string;
    gasPrice: string;
  };
  /** Routing information */
  route?: {
    fills: Array<{
      from: Address;
      to: Address;
      source: string;
      proportionBps: string;
    }>;
  };
  /** Fee information */
  fees?: {
    zeroExFee: {
      amount: string;
      token: Address;
    } | null;
  };
}

/**
 * Response from 0x API /swap/v1/price (indicative only)
 */
export interface ZeroXPriceResponse {
  /** Expected output amount */
  buyAmount: string;
  /** Input amount */
  sellAmount: string;
  /** Exchange rate */
  price: string;
  /** Liquidity sources */
  sources?: Array<{
    name: string;
    proportion: string;
  }>;
}

// ============ INTERNAL TYPES ============

// NOTE: CachedQuoteData moved to end of file to include Uniswap V2 support

/**
 * Call structure for UserOperation batching
 */
export interface SwapCall {
  to: Address;
  value: bigint;
  data: Hex;
}

// ============ ERROR TYPES ============

export type SwapErrorCode =
  | 'E030' // SWAP_QUOTE_FAILED
  | 'E031' // SWAP_EXECUTION_FAILED
  | 'E032' // SWAP_STATUS_FAILED
  | 'E033' // QUOTE_EXPIRED
  | 'E034' // INSUFFICIENT_BALANCE
  | 'E035' // INVALID_TOKEN
  | 'E036' // QUOTE_MISMATCH
  | 'E037'; // NO_LIQUIDITY

export interface SwapError {
  code: SwapErrorCode;
  error: string;
  message: string;
}

export const SWAP_ERRORS: Record<SwapErrorCode, Omit<SwapError, 'message'>> = {
  E030: { code: 'E030', error: 'SWAP_QUOTE_FAILED' },
  E031: { code: 'E031', error: 'SWAP_EXECUTION_FAILED' },
  E032: { code: 'E032', error: 'SWAP_STATUS_FAILED' },
  E033: { code: 'E033', error: 'QUOTE_EXPIRED' },
  E034: { code: 'E034', error: 'INSUFFICIENT_BALANCE' },
  E035: { code: 'E035', error: 'INVALID_TOKEN' },
  E036: { code: 'E036', error: 'QUOTE_MISMATCH' },
  E037: { code: 'E037', error: 'NO_LIQUIDITY' },
};

// ============ UNISWAP V2 TYPES ============

/**
 * Parameters for Uniswap V2 quote request
 */
export interface UniswapV2QuoteParams {
  /** Token address to sell */
  sellToken: Address;
  /** Token address to buy */
  buyToken: Address;
  /** Amount to sell in smallest unit */
  sellAmount: string;
  /** Slippage in basis points */
  slippageBps: number;
}

/**
 * Response from Uniswap V2 quote
 */
export interface UniswapV2QuoteResponse {
  /** Amount being sold (in smallest unit) */
  sellAmount: string;
  /** Expected output amount (in smallest unit) */
  buyAmount: string;
  /** Minimum output amount after slippage */
  minBuyAmount: string;
  /** Exchange rate */
  price: string;
  /** Price impact as percentage string */
  priceImpact: string;
  /** Swap route information */
  route: {
    /** Token addresses in swap path */
    path: Address[];
    /** Uniswap V2 pair address */
    pair: Address;
  };
  /** Estimated gas for the swap */
  estimatedGas: string;
}

/**
 * Cached quote data (supports both 0x and Uniswap V2)
 */
export interface CachedQuoteData {
  /** 0x API quote (null for V2 swaps) */
  zeroxQuote: ZeroXQuoteResponse | null;
  /** Uniswap V2 quote (only for MOLE swaps) */
  v2Quote?: UniswapV2QuoteResponse;
  /** Sell token configuration */
  sellTokenConfig: TokenConfig;
  /** Buy token configuration */
  buyTokenConfig: TokenConfig;
  /** Kernel smart account address (taker) */
  kernelAccountAddress: Address;
  /** User's wallet ID */
  walletId: string;
  /** Sell amount in smallest unit */
  sellAmount: string;
  /** Quote expiration timestamp */
  expiresAt: number;
  /** Quote source to determine execution path */
  source: 'zerox' | 'uniswap_v2' | 'uniswap_v3';
}
