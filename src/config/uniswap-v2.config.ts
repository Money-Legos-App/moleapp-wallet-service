/**
 * Uniswap V2 Configuration for MOLE Token Swaps
 * Sepolia testnet addresses for MOLE/WETH pool
 *
 * IMPORTANT: Router and Pair addresses must be from the SAME Uniswap V2 deployment.
 * If you get "INVALID_PATH" errors:
 * 1. Verify the pair was created by the factory that the router points to
 * 2. Use the factory's getPair(WETH, MOLE) to find the correct pair address
 * 3. Or deploy your own Uniswap V2 pair using the same factory as the router
 *
 * Common Sepolia Uniswap V2 Router addresses:
 * - Official Uniswap V2 Router02: 0xC532a74256D3Db42D0Bf7a0400fEFDbad7694008
 * - Custom deployments may use different addresses
 */

import type { Address } from 'viem';

export const UNISWAP_V2_CONFIG = {
  /**
   * Uniswap V2 Router02 address on Sepolia
   *
   * NOTE: This must be the router whose factory created the MOLE/WETH pair.
   * If the pair was created on a different Uniswap V2 deployment, swaps will fail
   * with "INVALID_PATH" error.
   *
   * To verify: Call router.factory(), then factory.getPair(WETH, MOLE)
   * The result should match MOLE_WETH_PAIR below.
   */
  ROUTER_ADDRESS: '0xeE567Fe1712Faf6149d80dA1E6934E354124CfE3' as Address,

  /**
   * MOLE/WETH Uniswap V2 pair address
   *
   * This pair must have been created by the factory associated with ROUTER_ADDRESS.
   * Verify by calling: router.factory().getPair(WETH_ADDRESS, MOLE_ADDRESS)
   */
  MOLE_WETH_PAIR: '0xcD18FC622db7b2eD84E8e493191e637933c4Edf4' as Address,

  /** WETH address on Sepolia (canonical) */
  WETH_ADDRESS: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14' as Address,

  /** MOLE token address on Sepolia */
  MOLE_ADDRESS: '0x54b69c97e12e8680b4f27bb302d8def9117e8d29' as Address,

  /** Uniswap V2 fee in basis points (0.3%) */
  FEE_BPS: 30,

  /** Price impact warning threshold (warn users at 5% impact) */
  PRICE_IMPACT_WARNING_THRESHOLD: 5,

  /** Swap deadline in seconds (20 minutes) */
  SWAP_DEADLINE_SECONDS: 1200,

  /**
   * Minimum swap amount in wei (0.001 ETH)
   * Smaller amounts may fail due to precision loss or gas inefficiency
   */
  MIN_SWAP_AMOUNT_WEI: '1000000000000000',
} as const;
