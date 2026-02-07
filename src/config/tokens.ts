/**
 * Token Configuration for Gasless Swaps
 * Sepolia Testnet tokens supported for 0x API swaps
 */

import type { Address } from 'viem';

export interface TokenConfig {
  symbol: string;
  name: string;
  address: Address;
  decimals: number;
  isNative: boolean;
  coingeckoId?: string;
}

/**
 * Supported tokens on Sepolia testnet
 * Native ETH uses 0x API's special address representation
 */
export const SEPOLIA_TOKENS: Record<string, TokenConfig> = {
  ETH: {
    symbol: 'ETH',
    name: 'Ethereum',
    address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address, // 0x native ETH representation
    decimals: 18,
    isNative: true,
    coingeckoId: 'ethereum',
  },
  WETH: {
    symbol: 'WETH',
    name: 'Wrapped Ether',
    address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as Address, // Sepolia WETH
    decimals: 18,
    isNative: false,
    coingeckoId: 'weth',
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Address, // Circle's testnet USDC
    decimals: 6,
    isNative: false,
    coingeckoId: 'usd-coin',
  },
  USDT: {
    symbol: 'USDT',
    name: 'Tether USD',
    address: '0x7169D38820dfd117C3FA1f22a697dBA58d90BA06' as Address, // Mock USDT on Sepolia
    decimals: 6,
    isNative: false,
    coingeckoId: 'tether',
  },
  DAI: {
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    address: '0x68194a729C2450ad26072b3D33ADaCbcef39D574' as Address, // Sepolia DAI
    decimals: 18,
    isNative: false,
    coingeckoId: 'dai',
  },
  MOLE: {
    symbol: 'MOLE',
    name: 'Mole Token',
    address: '0x54b69c97e12e8680b4f27bb302d8def9117e8d29' as Address, // Sepolia MOLE
    decimals: 18,
    isNative: false,
    coingeckoId: undefined, // Custom token, no CoinGecko listing
  },
} as const;

/**
 * Swap configuration constants
 */
export const SWAP_CONFIG = {
  /** Default slippage tolerance in basis points (100 = 1%) */
  DEFAULT_SLIPPAGE_BPS: 100,
  /** Maximum allowed slippage in basis points (500 = 5%) */
  MAX_SLIPPAGE_BPS: 500,
  /** Quote validity period in milliseconds (30 seconds) */
  QUOTE_EXPIRY_MS: 30000,
  /** Sepolia chain ID */
  CHAIN_ID: 11155111,
  /** 0x API base URL for Sepolia */
  ZEROX_BASE_URL: 'https://sepolia.api.0x.org',
} as const;

/**
 * Resolve token by symbol or address
 * @param tokenIdentifier - Token symbol (e.g., 'ETH') or address
 * @returns TokenConfig or null if not found
 */
export function resolveToken(tokenIdentifier: string): TokenConfig | null {
  // Check if it's a symbol (case-insensitive)
  const symbolUpper = tokenIdentifier.toUpperCase();
  if (symbolUpper in SEPOLIA_TOKENS) {
    return SEPOLIA_TOKENS[symbolUpper];
  }

  // Check if it's an address (case-insensitive)
  const tokenByAddress = Object.values(SEPOLIA_TOKENS).find(
    (t) => t.address.toLowerCase() === tokenIdentifier.toLowerCase()
  );

  return tokenByAddress || null;
}

/**
 * Get all supported token symbols
 */
export function getSupportedTokenSymbols(): string[] {
  return Object.keys(SEPOLIA_TOKENS);
}

/**
 * Check if a token is supported
 */
export function isTokenSupported(tokenIdentifier: string): boolean {
  return resolveToken(tokenIdentifier) !== null;
}

/**
 * Get token list for API response
 */
export function getTokenListForApi(): Array<{
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
