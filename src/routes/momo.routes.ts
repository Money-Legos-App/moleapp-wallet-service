/**
 * Momo Routes — mobile money on/off-ramp
 * Mounted at /api/v2/momo in wallet-service
 *
 * Legacy endpoints delegate to Fonbnk internally (LocalRamp disabled).
 * Webhook now lives at /webhook/fonbnk only.
 */

import { Router } from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/authenticate';
import {
  getChannels,
  getNetworks,
  getExchangeRates,
  initiateOnRamp,
  initiateOffRamp,
  getTransactionStatus,
  getUserCommissionSummary,
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

// ---- Fonbnk Routes ----

import {
  fonbnkGetCurrencies,
  fonbnkGetQuote,
  fonbnkGetLimits,
  fonbnkOnRamp,
  fonbnkOffRamp,
  fonbnkConfirmDeposit,
  fonbnkSubmitOtp,
  handleFonbnkWebhook,
} from '../controllers/fonbnkController';

// Discovery (public)
router.get('/fonbnk/currencies', fonbnkGetCurrencies);
router.get('/fonbnk/quote', authenticate, fonbnkGetQuote);
router.get('/fonbnk/limits', authenticate, fonbnkGetLimits);

// Transact (authenticated + KYC-gated)
router.post('/fonbnk/on-ramp', authenticate, [
  body('amount').isFloat({ min: 1 }).withMessage('Amount must be positive'),
  body('currency').notEmpty().withMessage('Currency is required'),
  body('country').notEmpty().withMessage('Country is required'),
], fonbnkOnRamp);

router.post('/fonbnk/off-ramp', authenticate, [
  body('cryptoAmount').isFloat({ min: 0.01 }).withMessage('Crypto amount must be positive'),
  body('currency').notEmpty().withMessage('Currency is required'),
  body('country').notEmpty().withMessage('Country is required'),
], fonbnkOffRamp);

router.post('/fonbnk/confirm/:orderId', authenticate, fonbnkConfirmDeposit);
router.post('/fonbnk/otp/:orderId', authenticate, fonbnkSubmitOtp);

// ---- Webhooks (no auth — signature-verified in handler) ----

router.post('/webhook/fonbnk', handleFonbnkWebhook);

export default router;
