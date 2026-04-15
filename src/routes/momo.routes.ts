/**
 * Momo Routes — LocalRamp mobile money on/off-ramp
 * Mounted at /api/v2/momo in wallet-service
 */

import { Router } from 'express';
import { body, query } from 'express-validator';
import { authenticate } from '../middleware/authenticate';
import {
  getChannels,
  getNetworks,
  getExchangeRates,
  initiateOnRamp,
  initiateOffRamp,
  getTransactionStatus,
  getUserCommissionSummary,
  handleLocalRampWebhook,
} from '../controllers/momoController';

const router = Router();

// ---- Public / Discovery ----

router.get('/health', (req, res) => {
  res.json({ success: true, data: { service: 'momo-module', status: 'healthy' } });
});

router.get('/channels', getChannels);
router.get('/networks', getNetworks);
router.get('/exchange-rates', getExchangeRates);

// ---- Authenticated ----

router.post('/on-ramp', authenticate, [
  body('phoneNumber').notEmpty().withMessage('Phone number is required'),
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be positive'),
  body('currency').notEmpty().withMessage('Currency is required'),
], initiateOnRamp);

router.post('/off-ramp', authenticate, [
  body('phoneNumber').notEmpty().withMessage('Phone number is required'),
  body('cryptoAmount').isFloat({ min: 0.01 }).withMessage('Crypto amount must be positive'),
  body('currency').notEmpty().withMessage('Currency is required'),
], initiateOffRamp);

router.get('/transaction/:transactionId', authenticate, getTransactionStatus);
router.get('/commission/user-summary', authenticate, getUserCommissionSummary);

// ---- Webhooks (no auth — validated by shared token) ----

router.post('/webhook/localramp', handleLocalRampWebhook);

export default router;
