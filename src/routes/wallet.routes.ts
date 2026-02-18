import { Router, Request, Response, NextFunction } from 'express';
import { body, param } from 'express-validator';
import { walletController } from '../controllers/walletController.js';
import { validateRequest } from '../middleware/validateRequest.js';
import { authenticate, authenticateWithUserId, AuthenticatedRequest } from '../middleware/authenticate.js';

const router = Router();

// Middleware to enforce that authenticated users can only access their own resources.
// Service-to-service calls (client credentials with no sub claim) are allowed through.
const enforceOwnership = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const requestedUserId = req.params.userId || req.body?.userId;
  const authenticatedUserId = req.userId;

  if (authenticatedUserId && requestedUserId && requestedUserId !== authenticatedUserId) {
    return res.status(403).json({
      success: false,
      error: 'FORBIDDEN',
      message: 'You do not have permission to access this resource',
    });
  }
  next();
};

// Health check endpoint (no auth required)
router.get('/health', walletController.healthCheck);

// Validate multiple wallet IDs (for storage sync) - no auth required for mobile startup
router.post('/validate',
  [
    body('walletIds')
      .isArray({ min: 1, max: 50 })
      .withMessage('walletIds must be an array with 1-50 items'),
    body('walletIds.*')
      .isUUID()
      .withMessage('Each walletId must be a valid UUID')
  ],
  validateRequest,
  walletController.validateWallets
);

// All wallet endpoints require Keycloak authentication
router.use(authenticate);

// Multi-chain wallet creation (unified endpoint for both service-to-service and user calls)
router.post('/create',
  [
    body('userId')
      .isUUID()
      .withMessage('Valid user ID is required')
  ],
  validateRequest,
  enforceOwnership,
  walletController.createMultiChainWallets
);

// Legacy route removed - use /create endpoint

// Submit user operation (gasless transaction)
router.post('/user-operation',
  [
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('calls')
      .isArray({ min: 1 })
      .withMessage('At least one call is required'),
    body('calls.*.to')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid address is required for call.to'),
    body('calls.*.value')
      .optional()
      .isString()
      .withMessage('Value must be a string'),
    body('calls.*.data')
      .optional()
      .matches(/^0x[a-fA-F0-9]*$/)
      .withMessage('Data must be valid hex'),
    body('sponsorUserOperation')
      .optional()
      .isBoolean()
      .withMessage('sponsorUserOperation must be boolean')
  ],
  validateRequest,
  walletController.submitUserOperation
);

// Sign transaction (legacy endpoint, converts to user operation)
router.post('/sign',
  [
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('to')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid recipient address is required'),
    body('value')
      .optional()
      .isString()
      .withMessage('Value must be a string'),
    body('data')
      .optional()
      .matches(/^0x[a-fA-F0-9]*$/)
      .withMessage('Data must be valid hex'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required')
  ],
  validateRequest,
  walletController.signTransaction
);

// Recover wallet
router.post('/recover',
  [
    body('userId')
      .isUUID()
      .withMessage('Valid user ID is required'),
    body('phoneNumber')
      .matches(/^\+[1-9]\d{1,14}$/)
      .withMessage('Valid international phone number is required (E.164 format)'),
    body('recoveryCode')
      .optional()
      .isString()
      .withMessage('Recovery code must be a string'),
    body('passkey')
      .optional()
      .isBoolean()
      .withMessage('Passkey flag must be boolean')
  ],
  validateRequest,
  enforceOwnership,
  walletController.recoverWallet
);

// Get multi-chain wallets for a user (default endpoint)
router.get('/user/:userId',
  [
    param('userId')
      .isUUID()
      .withMessage('Valid user ID is required')
  ],
  validateRequest,
  enforceOwnership,
  walletController.getUserMultiChainWallets
);

// Get wallet details by ID
router.get('/:walletId',
  [
    param('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required')
  ],
  validateRequest,
  walletController.getWalletById
);

// Deploy wallet to blockchain
router.post('/:walletId/deploy',
  [
    param('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required')
  ],
  validateRequest,
  walletController.deployWallet
);

// Validate and reconcile wallet addresses with Turnkey
router.post('/user/:userId/reconcile',
  [
    param('userId')
      .isUUID()
      .withMessage('Valid user ID is required')
  ],
  validateRequest,
  enforceOwnership,
  walletController.validateAndReconcileWallets
);

// Initialize kernel account for wallet (for legacy wallets without smart accounts)
router.post('/:walletId/initialize-kernel',
  [
    param('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required')
  ],
  validateRequest,
  walletController.initializeKernelAccount
);

// ================================
// DEFI BUNDLING ROUTES
// ================================

// Bundle Morpho operations
router.post('/defi/bundle/morpho',
  [
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('operations')
      .isArray({ min: 1 })
      .withMessage('At least one Morpho operation is required'),
    body('operations.*.type')
      .isIn(['SUPPLY', 'BORROW', 'WITHDRAW', 'REPAY', 'SUPPLY_COLLATERAL', 'WITHDRAW_COLLATERAL'])
      .withMessage('Invalid Morpho operation type'),
    body('operations.*.marketId')
      .isString()
      .notEmpty()
      .withMessage('Market ID is required'),
    body('operations.*.amount')
      .isString()
      .notEmpty()
      .withMessage('Amount is required'),
    body('operations.*.asset')
      .isString()
      .notEmpty()
      .withMessage('Asset is required'),
    body('operations.*.tokenAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid token address is required'),
    body('operations.*.morphoContract')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid Morpho contract address is required'),
    body('operations.*.userAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid user address is required')
  ],
  validateRequest,
  walletController.bundleMorphoOperations
);

// Bundle swap + DeFi operations
router.post('/defi/bundle/swap-and-defi',
  [
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('swapOperation')
      .isObject()
      .withMessage('Swap operation is required'),
    body('swapOperation.tokenIn')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid input token address is required'),
    body('swapOperation.tokenOut')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid output token address is required'),
    body('swapOperation.amountIn')
      .isString()
      .notEmpty()
      .withMessage('Input amount is required'),
    body('defiOperations')
      .isArray({ min: 1 })
      .withMessage('At least one DeFi operation is required')
  ],
  validateRequest,
  walletController.bundleSwapAndDeFi
);

// Bundle yield optimization operations
router.post('/defi/bundle/yield-optimization',
  [
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required'),
    body('chainId')
      .isInt({ min: 1 })
      .withMessage('Valid chain ID is required'),
    body('optimizationStrategy')
      .isObject()
      .withMessage('Optimization strategy is required'),
    body('optimizationStrategy.harvestOperations')
      .isArray()
      .withMessage('Harvest operations must be an array'),
    body('optimizationStrategy.compoundOperations')
      .isArray()
      .withMessage('Compound operations must be an array'),
    body('optimizationStrategy.reinvestOperations')
      .isArray()
      .withMessage('Reinvest operations must be an array')
  ],
  validateRequest,
  walletController.bundleYieldOptimization
);

// Get DeFi bundled operations for a wallet
router.get('/:walletId/defi/operations',
  [
    param('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required')
  ],
  validateRequest,
  walletController.getDeFiBundledOperations
);

export default router;