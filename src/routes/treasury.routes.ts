/**
 * Treasury Routes
 *
 * REST API routes for treasury operations.
 * Used by momo-service for on/off-ramp settlements.
 */

import { Router } from 'express';
import { body, param, query } from 'express-validator';
import { treasuryController } from '../controllers/treasuryController.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Health check for treasury (no auth)
router.get('/health', (req, res) => {
  res.status(200).json({
    service: 'treasury',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  });
});

// All treasury endpoints require service-to-service authentication
router.use(authenticate);

/**
 * POST /api/v2/treasury/credit
 * Credit user wallet from treasury (on-ramp completion)
 */
router.post('/credit',
  [
    body('userId')
      .optional()
      .isUUID()
      .withMessage('Valid user ID is required if provided'),
    body('walletAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid wallet address is required'),
    body('usdcAmount')
      .isFloat({ min: 0.01 })
      .withMessage('USDC amount must be at least 0.01'),
    body('chainId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('transactionId')
      .isString()
      .notEmpty()
      .withMessage('Transaction ID is required'),
    body('metadata')
      .optional()
      .isObject()
      .withMessage('Metadata must be an object'),
  ],
  validateRequest,
  treasuryController.creditUser.bind(treasuryController)
);

/**
 * POST /api/v2/treasury/lock
 * Lock user funds to treasury (off-ramp initiation)
 */
router.post('/lock',
  [
    body('userId')
      .optional()
      .isUUID()
      .withMessage('Valid user ID is required if provided'),
    body('walletAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid wallet address is required'),
    body('usdcAmount')
      .isFloat({ min: 0.01 })
      .withMessage('USDC amount must be at least 0.01'),
    body('chainId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('transactionId')
      .isString()
      .notEmpty()
      .withMessage('Transaction ID is required'),
    body('metadata')
      .optional()
      .isObject()
      .withMessage('Metadata must be an object'),
  ],
  validateRequest,
  treasuryController.lockFunds.bind(treasuryController)
);

/**
 * POST /api/v2/treasury/refund
 * Refund user from treasury (failed payout)
 */
router.post('/refund',
  [
    body('userId')
      .optional()
      .isUUID()
      .withMessage('Valid user ID is required if provided'),
    body('walletAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid wallet address is required'),
    body('usdcAmount')
      .isFloat({ min: 0.01 })
      .withMessage('USDC amount must be at least 0.01'),
    body('chainId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('transactionId')
      .isString()
      .notEmpty()
      .withMessage('Transaction ID is required'),
    body('reason')
      .optional()
      .isString()
      .withMessage('Reason must be a string'),
    body('metadata')
      .optional()
      .isObject()
      .withMessage('Metadata must be an object'),
  ],
  validateRequest,
  treasuryController.refundUser.bind(treasuryController)
);

/**
 * GET /api/v2/treasury/balance
 * Get treasury balance for a chain
 */
router.get('/balance',
  [
    query('chainId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
  ],
  validateRequest,
  treasuryController.getBalance.bind(treasuryController)
);

/**
 * GET /api/v2/treasury/tx-status/:txHash
 * Check transaction confirmation status
 */
router.get('/tx-status/:txHash',
  [
    param('txHash')
      .matches(/^0x[a-fA-F0-9]{64}$/)
      .withMessage('Valid transaction hash is required'),
    query('chainId')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
  ],
  validateRequest,
  treasuryController.getTransactionStatus.bind(treasuryController)
);

/**
 * GET /api/v2/treasury/address
 * Get treasury wallet address
 */
router.get('/address',
  treasuryController.getAddress.bind(treasuryController)
);

export default router;
