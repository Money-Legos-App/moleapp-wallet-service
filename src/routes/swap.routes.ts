/**
 * Swap Routes
 * REST API endpoints for gasless token swaps
 * Uses 0x API for quotes and ZeroDev Kernel for execution
 */

import { Router } from 'express';
import { query, body, param } from 'express-validator';
import { swapController } from '../controllers/swapController.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { authenticate } from '../middleware/authenticate.js';
import { SWAP_CONFIG } from '../config/tokens.js';

const router = Router();

// Health check endpoint (no auth required)
router.get('/health', swapController.healthCheck);

// Pool diagnostic endpoint (no auth required for debugging)
// GET /api/v2/swap/pool-diagnostic
// Returns diagnostic info about MOLE/WETH pool configuration
router.get('/pool-diagnostic', swapController.poolDiagnostic);

// All swap endpoints require Keycloak authentication
router.use(authenticate);

/**
 * GET /api/v2/swap/tokens
 * Get list of supported tokens for swaps
 */
router.get('/tokens', swapController.getSupportedTokens);

/**
 * GET /api/v2/swap/quote
 * Get swap quote for given parameters
 *
 * Query params:
 * - walletId: UUID - User's wallet ID
 * - sellToken: string - Token symbol (ETH, USDC) or address
 * - buyToken: string - Token symbol or address
 * - sellAmount: string - Amount in smallest unit (wei)
 * - slippageBps: number (optional) - Slippage in basis points (default 100 = 1%)
 */
router.get(
  '/quote',
  [
    query('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    query('sellToken')
      .isString()
      .notEmpty()
      .withMessage('Sell token symbol or address is required'),
    query('buyToken')
      .isString()
      .notEmpty()
      .withMessage('Buy token symbol or address is required'),
    query('sellAmount')
      .isString()
      .notEmpty()
      .matches(/^\d+$/)
      .withMessage('Sell amount must be a positive integer string (smallest unit)'),
    query('slippageBps')
      .optional()
      .isInt({ min: 1, max: SWAP_CONFIG.MAX_SLIPPAGE_BPS })
      .withMessage(`Slippage must be between 1 and ${SWAP_CONFIG.MAX_SLIPPAGE_BPS} basis points`),
  ],
  validateRequest,
  swapController.getQuote
);

/**
 * GET /api/v2/swap/quote-reverse
 * Get reverse swap quote (by buy amount)
 * Calculates required sell amount for desired buy amount
 *
 * Query params:
 * - walletId: UUID - User's wallet ID
 * - sellToken: string - Token symbol or address
 * - buyToken: string - Token symbol or address
 * - buyAmount: string - Desired amount to receive in smallest unit
 * - slippageBps: number (optional) - Slippage in basis points (default 100 = 1%)
 */
router.get(
  '/quote-reverse',
  [
    query('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    query('sellToken')
      .isString()
      .notEmpty()
      .withMessage('Sell token symbol or address is required'),
    query('buyToken')
      .isString()
      .notEmpty()
      .withMessage('Buy token symbol or address is required'),
    query('buyAmount')
      .isString()
      .notEmpty()
      .matches(/^\d+$/)
      .withMessage('Buy amount must be a positive integer string (smallest unit)'),
    query('slippageBps')
      .optional()
      .isInt({ min: 1, max: SWAP_CONFIG.MAX_SLIPPAGE_BPS })
      .withMessage(`Slippage must be between 1 and ${SWAP_CONFIG.MAX_SLIPPAGE_BPS} basis points`),
  ],
  validateRequest,
  swapController.getQuoteReverse
);

/**
 * POST /api/v2/swap/execute
 * Execute swap using cached quote
 *
 * Body:
 * - walletId: UUID - User's wallet ID
 * - quoteId: UUID - Quote ID from getQuote response
 * - sellToken: string - Must match quote's sell token
 * - buyToken: string - Must match quote's buy token
 * - sellAmount: string - Must match quote's sell amount
 * - minBuyAmount: string - Minimum acceptable output with slippage applied
 */
router.post(
  '/execute',
  [
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('quoteId')
      .isUUID()
      .withMessage('Valid quote ID is required'),
    body('sellToken')
      .isString()
      .notEmpty()
      .withMessage('Sell token is required'),
    body('buyToken')
      .isString()
      .notEmpty()
      .withMessage('Buy token is required'),
    body('sellAmount')
      .isString()
      .notEmpty()
      .matches(/^\d+$/)
      .withMessage('Sell amount must be a positive integer string'),
    body('minBuyAmount')
      .isString()
      .notEmpty()
      .matches(/^\d+$/)
      .withMessage('Minimum buy amount must be a positive integer string'),
  ],
  validateRequest,
  swapController.executeSwap
);

/**
 * GET /api/v2/swap/status/:userOpHash
 * Get swap transaction status by UserOperation hash
 */
router.get(
  '/status/:userOpHash',
  [
    param('userOpHash')
      .isString()
      .matches(/^0x[a-fA-F0-9]{64}$/)
      .withMessage('Valid UserOperation hash is required (0x-prefixed, 64 hex chars)'),
  ],
  validateRequest,
  swapController.getSwapStatus
);

export default router;
