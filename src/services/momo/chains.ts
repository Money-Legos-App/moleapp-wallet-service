/**
 * USDC chain registry for Fonbnk on/off-ramp.
 *
 * Single source of truth that maps a short slug ('base', 'ethereum', …) to:
 *  - the on-chain USDC contract address (canonical native USDC, not bridged)
 *  - the chainId mobile uses to build the batched UserOp
 *  - the Fonbnk currencyCode that names this asset in their API
 *
 * Add a chain here and it becomes available everywhere — quote endpoint,
 * on-ramp initiate, off-ramp initiate, mobile picker.
 */

export type UsdcChainSlug = 'base' | 'ethereum' | 'polygon' | 'arbitrum' | 'optimism';

export interface UsdcChainConfig {
  slug: UsdcChainSlug;
  displayName: string;
  chainId: number;
  contract: `0x${string}`;
  decimals: number;
  fonbnkCode: string;
}

export const USDC_CHAINS: Record<UsdcChainSlug, UsdcChainConfig> = {
  base: {
    slug: 'base',
    displayName: 'Base',
    chainId: 8453,
    contract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    decimals: 6,
    fonbnkCode: 'BASE_USDC',
  },
  ethereum: {
    slug: 'ethereum',
    displayName: 'Ethereum',
    chainId: 1,
    contract: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    decimals: 6,
    fonbnkCode: 'ETHEREUM_USDC',
  },
  polygon: {
    slug: 'polygon',
    displayName: 'Polygon',
    chainId: 137,
    contract: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    decimals: 6,
    fonbnkCode: 'POLYGON_USDC',
  },
  arbitrum: {
    slug: 'arbitrum',
    displayName: 'Arbitrum',
    chainId: 42161,
    contract: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    decimals: 6,
    fonbnkCode: 'ARBITRUM_USDC',
  },
  optimism: {
    slug: 'optimism',
    displayName: 'Optimism',
    chainId: 10,
    contract: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    decimals: 6,
    fonbnkCode: 'OPTIMISM_USDC',
  },
};

/**
 * Resolve a chain by slug, chainId, or Fonbnk currencyCode. Falls back
 * to Base USDC when nothing matches — preserves legacy behaviour for
 * mobile builds that don't pass a chain hint.
 */
export function resolveUsdcChain(input?: string | number | null): UsdcChainConfig {
  if (input === undefined || input === null || input === '') return USDC_CHAINS.base;

  if (typeof input === 'number') {
    const byChainId = Object.values(USDC_CHAINS).find((c) => c.chainId === input);
    if (byChainId) return byChainId;
  }

  const str = String(input).trim();

  // slug ('base', 'ethereum', …)
  const lower = str.toLowerCase();
  if (lower in USDC_CHAINS) return USDC_CHAINS[lower as UsdcChainSlug];

  // chainId-as-string ('8453')
  const asNum = Number(str);
  if (!Number.isNaN(asNum)) {
    const byChainId = Object.values(USDC_CHAINS).find((c) => c.chainId === asNum);
    if (byChainId) return byChainId;
  }

  // Fonbnk code ('BASE_USDC', 'ETHEREUM_USDC')
  const upper = str.toUpperCase();
  const byFonbnk = Object.values(USDC_CHAINS).find((c) => c.fonbnkCode === upper);
  if (byFonbnk) return byFonbnk;

  return USDC_CHAINS.base;
}

export function listUsdcChains(): UsdcChainConfig[] {
  return Object.values(USDC_CHAINS);
}
