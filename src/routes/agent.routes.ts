import { Router, Request, Response, NextFunction } from 'express';
import { body, param } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { validateRequest } from '../middleware/validateRequest.js';
import { agentController } from '../controllers/agentController.js';
import { createKeycloakAuth } from '../utils/keycloakAuth.js';
import { env } from '../config/environment.js';
import { logger } from '../utils/logger.js';

const router = Router();

/**
 * Agent Service Internal Routes
 *
 * These routes are used internally by the agent-service (Python)
 * for Turnkey signing operations.
 *
 * Authentication: Keycloak service token (Bearer token from Client Credentials flow)
 */

// Initialize Keycloak auth for service token validation
const keycloakAuth = createKeycloakAuth({
  baseURL: env.keycloakUrl,
  realm: env.keycloakRealm,
  clientId: env.keycloakClientId,
  clientSecret: env.keycloakClientSecret,
});

// Service authentication middleware - Keycloak Bearer tokens only
const serviceAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Missing or invalid authorization header. Bearer token required.'
    });
  }

  try {
    const token = authHeader.substring(7);
    const tokenValidation = await keycloakAuth.validateToken(token);

    if (!tokenValidation.active) {
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Invalid or expired token'
      });
    }

    // Validate this is a service client (not a user token)
    // azp is Keycloak's authorized party claim but may not be in our interface
    const clientId = tokenValidation.client_id || (tokenValidation as any).azp;
    const allowedClients = ['agent-service', 'api-gateway', 'wallet-service'];

    if (!allowedClients.includes(clientId)) {
      logger.warn('Service token from unauthorized client', { clientId });
      return res.status(403).json({
        success: false,
        error: 'FORBIDDEN',
        message: 'Service client not authorized for this endpoint'
      });
    }

    logger.debug('Service authenticated via Keycloak', { clientId });
    (req as any).serviceClientId = clientId;
    return next();

  } catch (error) {
    logger.error('Keycloak token validation failed', {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(401).json({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Token validation failed'
    });
  }
};

// Apply service auth to all routes
router.use(serviceAuth);

// Rate limiting: prevent signing floods from compromised agent-service
const signingRateLimit = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 60,                // 60 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many signing requests. Please slow down.',
  },
});

const batchRateLimit = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max: 10,                // 10 batch requests per minute (up to 1000 orders)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'RATE_LIMIT_EXCEEDED',
    message: 'Too many batch signing requests.',
  },
});

/**
 * Create a new agent mission
 * Links to user's existing TurnkeySigner - no new wallet creation
 */
router.post('/create-mission',
  [
    body('userId')
      .isUUID()
      .withMessage('Valid user ID is required'),
    body('missionType')
      .isIn(['SHORT_TERM_30D', 'LONG_TERM_45D', 'CUSTOM'])
      .withMessage('Invalid mission type'),
    body('depositAmount')
      .isString()
      .notEmpty()
      .withMessage('Deposit amount is required'),
    body('walletId')
      .isUUID()
      .withMessage('Valid wallet ID is required')
  ],
  validateRequest,
  agentController.createMission
);

/**
 * Sign a Hyperliquid trade payload
 * Uses user's existing Turnkey wallet to sign the order
 */
router.post('/sign-trade',
  signingRateLimit,
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('payload')
      .isObject()
      .withMessage('Order payload is required')
  ],
  validateRequest,
  agentController.signTrade
);

/**
 * Batch sign multiple orders
 * Efficient batch signing for processing multiple missions
 */
router.post('/batch-sign',
  batchRateLimit,
  [
    body('orders')
      .isArray({ min: 1, max: 100 })
      .withMessage('Orders must be an array with 1-100 items'),
    body('orders.*.missionId')
      .isUUID()
      .withMessage('Each order requires a valid mission ID'),
    body('orders.*.payload')
      .isObject()
      .withMessage('Each order requires a payload')
  ],
  validateRequest,
  agentController.batchSign
);

/**
 * Sign agent approval transaction
 * Signs the Hyperliquid ApproveAgent transaction
 */
router.post('/sign-approval',
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('agentAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid agent address is required')
  ],
  validateRequest,
  agentController.signAgentApproval
);

/**
 * Validate mission and agent approval status
 */
router.get('/validate-mission/:missionId',
  [
    param('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required')
  ],
  validateRequest,
  agentController.validateMission
);

/**
 * Get full mission details including wallet info
 */
router.get('/mission/:missionId',
  [
    param('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required')
  ],
  validateRequest,
  agentController.getMissionDetails
);

/**
 * Update mission status
 */
router.patch('/mission/:missionId/status',
  [
    param('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('status')
      .isIn(['PENDING', 'DEPOSITING', 'APPROVING', 'ACTIVE', 'PAUSED', 'COMPLETED', 'LIQUIDATED', 'REVOKED'])
      .withMessage('Invalid mission status'),
    body('metadata')
      .optional()
      .isObject()
      .withMessage('Metadata must be an object')
  ],
  validateRequest,
  agentController.updateMissionStatus
);

/**
 * Record PnL snapshot
 */
router.post('/mission/:missionId/pnl-snapshot',
  [
    param('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('totalValue')
      .isString()
      .notEmpty()
      .withMessage('Total value is required'),
    body('totalPnl')
      .isString()
      .notEmpty()
      .withMessage('Total PnL is required'),
    body('unrealizedPnl')
      .isString()
      .notEmpty()
      .withMessage('Unrealized PnL is required'),
    body('realizedPnl')
      .isString()
      .notEmpty()
      .withMessage('Realized PnL is required')
  ],
  validateRequest,
  agentController.recordPnlSnapshot
);

/**
 * Sign EIP-712 typed data for Hyperliquid orders
 * This is the correct method for proper Hyperliquid signing
 */
router.post('/sign-typed-data',
  signingRateLimit,
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('typedData')
      .isObject()
      .withMessage('Typed data is required'),
    body('typedData.domain')
      .isObject()
      .withMessage('EIP-712 domain is required'),
    body('typedData.types')
      .isObject()
      .withMessage('EIP-712 types are required'),
    body('typedData.message')
      .isObject()
      .withMessage('EIP-712 message is required')
  ],
  validateRequest,
  agentController.signTypedData
);

/**
 * Sign trade using per-mission agent key (FAST PATH - zero Turnkey latency)
 * Used for Phase C trading. Decrypts the mission's local agent key and signs.
 */
router.post('/sign-with-agent-key',
  signingRateLimit,
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('typedData')
      .isObject()
      .withMessage('Typed data is required'),
    body('typedData.domain')
      .isObject()
      .withMessage('EIP-712 domain is required'),
    body('typedData.types')
      .isObject()
      .withMessage('EIP-712 types are required'),
    body('typedData.message')
      .isObject()
      .withMessage('EIP-712 message is required')
  ],
  validateRequest,
  agentController.signWithAgentKey
);

/**
 * Batch sign trades using per-mission agent keys (FAST PATH)
 */
router.post('/batch-sign-with-agent-key',
  batchRateLimit,
  [
    body('orders')
      .isArray({ min: 1, max: 100 })
      .withMessage('Orders must be an array with 1-100 items'),
    body('orders.*.missionId')
      .isUUID()
      .withMessage('Each order requires a valid mission ID'),
    body('orders.*.typedData')
      .isObject()
      .withMessage('Each order requires typed data')
  ],
  validateRequest,
  agentController.batchSignWithAgentKey
);

/**
 * Batch sign EIP-712 typed data for multiple orders
 */
router.post('/batch-sign-typed-data',
  batchRateLimit,
  [
    body('orders')
      .isArray({ min: 1, max: 100 })
      .withMessage('Orders must be an array with 1-100 items'),
    body('orders.*.missionId')
      .isUUID()
      .withMessage('Each order requires a valid mission ID'),
    body('orders.*.typedData')
      .isObject()
      .withMessage('Each order requires typed data')
  ],
  validateRequest,
  agentController.batchSignTypedData
);

/**
 * Deposit USDC to Hyperliquid via bridge on Arbitrum Sepolia
 * Bundles approve + deposit into a single gasless UserOperation
 */
router.post('/deposit-to-hyperliquid',
  signingRateLimit,
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('amount')
      .isString()
      .notEmpty()
      .withMessage('USDC amount is required'),
    body('chainId')
      .optional()
      .isInt()
      .withMessage('Chain ID must be an integer')
  ],
  validateRequest,
  agentController.depositToHyperliquid
);

/**
 * Sign a withdrawal from Hyperliquid back to user's smart wallet
 * Uses the master EOA (Turnkey) to sign the withdrawal request
 */
router.post('/withdraw-from-hyperliquid',
  signingRateLimit,
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('amount')
      .isString()
      .notEmpty()
      .withMessage('USDC amount is required')
  ],
  validateRequest,
  agentController.withdrawFromHyperliquid
);

/**
 * Transfer USDC from user's ZeroDev wallet to per-mission Master EOA on Arbitrum.
 * Executes as a gasless UserOperation via Pimlico paymaster.
 */
router.post('/transfer-to-master-eoa',
  signingRateLimit,
  [
    body('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('masterEoaAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid Ethereum address is required for Master EOA'),
    body('amount')
      .isString()
      .notEmpty()
      .withMessage('USDC amount is required')
  ],
  validateRequest,
  agentController.transferToMasterEoa
);

/**
 * Store the agent address on a mission.
 * Called by agent-service after SDK approve_agent() succeeds.
 * The agent key itself is stored as Vault ciphertext by agent-service directly.
 */
router.post('/mission/:missionId/store-agent-key',
  signingRateLimit,
  [
    param('missionId')
      .isUUID()
      .withMessage('Valid mission ID is required'),
    body('agentAddress')
      .matches(/^0x[a-fA-F0-9]{40}$/)
      .withMessage('Valid Ethereum address is required for agent'),
  ],
  validateRequest,
  agentController.storeAgentKey
);

export default router;
