/**
 * Bridge Routes
 * Cross-chain bridge via Across Protocol v4.
 */

import { Router } from 'express';
import { query, body, param } from 'express-validator';
import { bridgeController } from '../controllers/bridgeController.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// All bridge endpoints require authentication
router.use(authenticate);

/**
 * GET /api/v2/bridge/quote
 */
router.get(
  '/quote',
  [
    query('walletId').isUUID().withMessage('Valid wallet ID required'),
    query('inputToken').isString().notEmpty().withMessage('Input token required'),
    query('amount').isString().matches(/^\d+$/).withMessage('Amount must be a positive integer string (wei)'),
    query('originChainId').isInt({ min: 1 }).withMessage('Valid origin chain ID required'),
    query('outputToken').optional().isString(),
    query('slippage').optional().isFloat({ min: 0.001, max: 0.05 }).withMessage('Slippage must be between 0.001 and 0.05'),
  ],
  validateRequest,
  bridgeController.getQuote,
);

/**
 * POST /api/v2/bridge/execute
 */
router.post(
  '/execute',
  [
    body('walletId').isUUID().withMessage('Valid wallet ID required'),
    body('quoteId').isUUID().withMessage('Valid quote ID required'),
    body('amount').isString().matches(/^\d+$/).withMessage('Amount must be a positive integer string'),
    body('originChainId').isInt({ min: 1 }).withMessage('Valid origin chain ID required'),
  ],
  validateRequest,
  bridgeController.executeBridge,
);

/**
 * GET /api/v2/bridge/status/:bridgeOperationId
 */
router.get(
  '/status/:bridgeOperationId',
  [
    param('bridgeOperationId').isUUID().withMessage('Valid bridge operation ID required'),
    query('walletId').isUUID().withMessage('Valid wallet ID required'),
  ],
  validateRequest,
  bridgeController.getBridgeStatus,
);

/**
 * GET /api/v2/bridge/history
 */
router.get(
  '/history',
  [
    query('walletId').isUUID().withMessage('Valid wallet ID required'),
    query('limit').optional().isInt({ min: 1, max: 100 }),
  ],
  validateRequest,
  bridgeController.listBridgeHistory,
);

export default router;
