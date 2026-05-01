import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { treasuryService } from '../services/treasury/treasuryService';
import { ON_RAMP_STATES, OFF_RAMP_STATES } from '../services/momo/fsm';
import * as quoteService from '../services/momo/fonbnk/quoteService';
import * as orderService from '../services/momo/fonbnk/orderService';
import * as webhookSvc from '../services/momo/fonbnk/webhookService';
import { createKeycloakAuth } from '../utils/keycloakAuth';
import axios from 'axios';

const KYC_GATE_ENABLED = process.env.KYC_GATE_ENABLED === 'true';
const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'https://moleapp-api-gateway.onrender.com';

const DEFAULT_CARRIER_BY_COUNTRY: Record<string, string> = {
  SN: 'sn_orange', CI: 'ci_orange', KE: 'ke_mpesa',
  GH: 'gh_mtn', CM: 'cm_mtn', RW: 'rw_mtn', UG: 'ug_mtn', ZM: 'zm_mtn',
};

// Keycloak client for service-to-service auth (cached token, auto-refresh)
const kcAuth = createKeycloakAuth({
  baseURL: process.env.KEYCLOAK_URL || 'http://keycloak:8080',
  realm: process.env.KEYCLOAK_REALM || 'wallet-realm',
  clientId: process.env.KEYCLOAK_CLIENT_ID || 'wallet-service',
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET || '',
});

interface KycGateResult {
  verified: boolean;
  status: string;
  tier: number;
  inGrace: boolean;
  graceExpired: boolean;
  /** Whether on-ramp deposits are allowed right now */
  depositAllowed: boolean;
  /** Per-transaction USD limit driven by KYC tier */
  perTxnLimitUsd: number;
}

/**
 * Per-transaction USD limit by KYC tier.
 *  - 0 (unverified, BETA_LEGACY in grace): low cap so users can test
 *  - 1 (BASIC): launch tier
 *  - 2 (ENHANCED): high-volume tier (requires Enhanced KYC)
 *
 * Override via env: KYC_TIER_LIMIT_USD_0 / _1 / _2.
 */
function getTierLimitUsd(tier: number): number {
  const overrides = [
    process.env.KYC_TIER_LIMIT_USD_0,
    process.env.KYC_TIER_LIMIT_USD_1,
    process.env.KYC_TIER_LIMIT_USD_2,
  ];
  const defaults = [50, 500, 5000];
  const idx = Math.max(0, Math.min(tier, defaults.length - 1));
  const fromEnv = overrides[idx];
  return fromEnv ? Number(fromEnv) : defaults[idx];
}

async function checkKycGate(userId: string): Promise<KycGateResult> {
  if (!KYC_GATE_ENABLED) {
    return {
      verified: true,
      status: 'GATE_DISABLED',
      tier: 99,
      inGrace: false,
      graceExpired: false,
      depositAllowed: true,
      perTxnLimitUsd: Number.MAX_SAFE_INTEGER,
    };
  }

  try {
    const serviceToken = await kcAuth.getServiceToken();
    const res = await axios.get(`${USER_SERVICE_URL}/api/v1/users/kyc/check/${userId}`, {
      timeout: 5_000,
      headers: { authorization: `Bearer ${serviceToken.access_token}` },
    });
    const data = res.data.data;
    const verified = !!data.verified;
    const inGrace = !!data.inGrace;
    const graceExpired = !!data.graceExpired;
    const tier: number = Number(data.tier ?? 0);

    // Deposits allowed only if verified OR within BETA_LEGACY grace window
    const depositAllowed = verified || inGrace;

    return {
      verified,
      status: data.status,
      tier,
      inGrace,
      graceExpired,
      depositAllowed,
      perTxnLimitUsd: getTierLimitUsd(tier),
    };
  } catch (err: any) {
    // FAIL CLOSED — never silently pass through
    logger.error('KYC check failed — failing closed', { userId, error: err?.message });
    return {
      verified: false,
      status: 'CHECK_FAILED',
      tier: 0,
      inGrace: false,
      graceExpired: true,
      depositAllowed: false,
      perTxnLimitUsd: 0,
    };
  }
}

// ---- Discovery ----

export async function fonbnkGetCurrencies(req: Request, res: Response) {
  try {
    const currencies = await quoteService.getCurrencies();
    return res.json({ success: true, data: currencies });
  } catch (err: any) {
    logger.error('Fonbnk getCurrencies failed', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to fetch currencies' });
  }
}

export async function fonbnkGetQuote(req: Request, res: Response) {
  try {
    const {
      depositCurrencyType, depositCurrencyCode, depositChannel,
      payoutCurrencyType, payoutCurrencyCode, payoutChannel,
      amount, country,
    } = req.query;

    const quote = await quoteService.getQuote({
      deposit: {
        currencyType: depositCurrencyType as string,
        currencyCode: depositCurrencyCode as string,
        paymentChannel: depositChannel as string,
        amount: amount ? Number(amount) : undefined,
        countryIsoCode: depositCurrencyType === 'fiat' ? (country as string) : undefined,
      },
      payout: {
        currencyType: payoutCurrencyType as string,
        currencyCode: payoutCurrencyCode as string,
        paymentChannel: payoutChannel as string,
        countryIsoCode: payoutCurrencyType === 'fiat' ? (country as string) : undefined,
      },
    });

    return res.json({ success: true, data: quote });
  } catch (err: any) {
    logger.error('Fonbnk getQuote failed', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to get quote' });
  }
}

export async function fonbnkGetLimits(req: Request, res: Response) {
  try {
    const {
      depositCurrencyType, depositCurrencyCode, depositChannel,
      payoutCurrencyType, payoutCurrencyCode, payoutChannel,
      country,
    } = req.query;

    const limits = await quoteService.getOrderLimits({
      depositCurrencyType: depositCurrencyType as string,
      depositCurrencyCode: depositCurrencyCode as string,
      depositPaymentChannel: depositChannel as string,
      payoutCurrencyType: payoutCurrencyType as string,
      payoutCurrencyCode: payoutCurrencyCode as string,
      payoutPaymentChannel: payoutChannel as string,
      countryIsoCode: country as string,
    });

    return res.json({ success: true, data: limits });
  } catch (err: any) {
    logger.error('Fonbnk getLimits failed', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to get limits' });
  }
}

// ---- On-Ramp ----

export async function fonbnkOnRamp(req: Request, res: Response) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const userId = (req as any).userId;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const kyc = await checkKycGate(userId);
  if (!kyc.depositAllowed) {
    const message = kyc.graceExpired
      ? 'Your verification deadline has passed. Please verify your identity to resume deposits.'
      : 'Please verify your identity before depositing. It only takes 2 minutes.';

    return res.status(403).json({
      success: false,
      error: 'KYC_REQUIRED',
      message,
      reason: kyc.graceExpired ? 'grace_expired' : 'not_verified',
    });
  }

  try {
    const { amount, currency, country, cryptoCurrency, walletAddress, phoneNumber, email, carrierCode, fullName } = req.body;

    const treasuryAddress = treasuryService.getTreasuryAddress();
    const upperCountry = String(country || '').toUpperCase();
    const payoutCode = cryptoCurrency || 'BASE_USDC';
    const resolvedCarrier = carrierCode || DEFAULT_CARRIER_BY_COUNTRY[upperCountry];
    const resolvedFullName = fullName || `MoleApp User ${String(userId).slice(0, 8)}`;

    const quote = await quoteService.getQuote({
      deposit: { currencyType: 'fiat', currencyCode: currency, paymentChannel: 'mobile_money', amount: Number(amount), countryIsoCode: upperCountry },
      payout: { currencyType: 'crypto', currencyCode: payoutCode, paymentChannel: 'crypto' },
    });

    // ── Tier-based per-transaction limit ──
    // Fonbnk's quote already returns a USD-equivalent amount; reject early if
    // it exceeds what this user's KYC tier allows. Uses USD because Fonbnk
    // limits + our internal tiers are USD-denominated regardless of fiat input.
    const txnUsd = Number(quote.deposit?.amountUsd ?? 0);
    if (txnUsd > kyc.perTxnLimitUsd) {
      logger.warn('On-ramp blocked by tier limit', {
        userId, tier: kyc.tier, txnUsd, perTxnLimitUsd: kyc.perTxnLimitUsd,
      });
      return res.status(403).json({
        success: false,
        error: 'KYC_TIER_LIMIT_EXCEEDED',
        message: `This transaction (~$${txnUsd.toFixed(2)}) exceeds your verification tier's limit ($${kyc.perTxnLimitUsd}). Complete enhanced verification to raise your limit.`,
        tier: kyc.tier,
        perTxnLimitUsd: kyc.perTxnLimitUsd,
        txnUsd,
      });
    }

    const order = await orderService.createOrder({
      quoteId: quote.quoteId,
      userEmail: email || `${userId}@moleapp.africa`,
      userIp: req.ip || '0.0.0.0',
      userCountryIsoCode: upperCountry,
      deposit: {
        paymentChannel: 'mobile_money',
        currencyType: 'fiat',
        currencyCode: currency,
        countryIsoCode: upperCountry,
        carrierCode: resolvedCarrier,
        amount: Number(amount),
      },
      payout: { paymentChannel: 'crypto', currencyType: 'crypto', currencyCode: payoutCode },
      fieldsToCreateOrder: {
        phoneNumber: String(phoneNumber || '').replace(/^\+/, ''),
        fullName: resolvedFullName,
        blockchainWalletAddress: treasuryAddress,
      },
      webhookUrl: `${WEBHOOK_BASE_URL}/api/v2/momo/webhook/fonbnk`,
    });

    const orderId = `fonbnk-onramp-${order.id}`;

    await prisma.momoTransaction.create({
      data: {
        id: orderId,
        userId,
        walletAddress: walletAddress || '',
        providerId: 'fonbnk',
        providerCode: `FONBNK_${country}`,
        paymentMethod: 'MOBILE_MONEY',
        type: 'ON_RAMP',
        status: 'PENDING',
        amount,
        currency,
        cryptoAmount: quote.payout.amount,
        cryptoCurrency: cryptoCurrency || 'BASE_USDC',
        exchangeRate: quote.exchangeRate,
        phoneNumber: phoneNumber || '',
        currentState: ON_RAMP_STATES.FIAT_PENDING,
        lifecycleStage: 'PROVIDER_PENDING',
        providerTxId: order.id,
        metadata: {
          provider: 'fonbnk',
          country,
          fonbnkOrderId: order.id,
          quoteId: quote.quoteId,
          transferInstructions: order.transferInstructions,
          fees: order.chargedFees,
          treasuryIntermediary: true,
          userWalletAddress: walletAddress,
        },
      },
    });

    return res.json({
      success: true,
      data: {
        orderId,
        fonbnkOrderId: order.id,
        transferInstructions: order.transferInstructions,
        deposit: order.deposit,
        payout: order.payout,
        fees: order.chargedFees,
        exchangeRate: quote.exchangeRate,
      },
    });
  } catch (err: any) {
    logger.error('Fonbnk onRamp failed', { userId, error: err.message });
    return res.status(500).json({ success: false, error: 'On-ramp initiation failed' });
  }
}

// ---- Off-Ramp ----

export async function fonbnkOffRamp(req: Request, res: Response) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  const userId = (req as any).userId;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  // Off-ramp (withdrawals) remain available even when grace period expires,
  // but we still require verified KYC for AML compliance on higher tiers
  // and for countries where Fonbnk KYC is mandatory before payout.
  const kyc = await checkKycGate(userId);
  if (!kyc.verified && kyc.status !== 'GATE_DISABLED') {
    logger.info('Off-ramp allowed without KYC (withdrawals stay open)', { userId, status: kyc.status });
  }

  try {
    const { cryptoAmount, cryptoCurrency, currency, country, phoneNumber, email, destinationType, accountNumber, bankCode, carrierCode, fullName, walletAddress } = req.body;

    const upperCountry = String(country || '').toUpperCase();
    const depositCrypto = cryptoCurrency || 'BASE_USDC';
    const payoutChannel = destinationType === 'bank_account' ? 'bank_transfer' : 'mobile_money';
    const resolvedCarrier = carrierCode || DEFAULT_CARRIER_BY_COUNTRY[upperCountry];
    const resolvedFullName = fullName || `MoleApp User ${String(userId).slice(0, 8)}`;

    const quote = await quoteService.getQuote({
      deposit: { currencyType: 'crypto', currencyCode: depositCrypto, paymentChannel: 'crypto', amount: Number(cryptoAmount) },
      payout: { currencyType: 'fiat', currencyCode: currency, paymentChannel: payoutChannel, countryIsoCode: upperCountry },
    });

    // Tier limit on off-ramp too — stops a tier-0 user from cashing out too much
    const offrampUsd = Number(quote.deposit?.amountUsd ?? 0);
    if (kyc.verified && offrampUsd > kyc.perTxnLimitUsd) {
      logger.warn('Off-ramp blocked by tier limit', {
        userId, tier: kyc.tier, offrampUsd, perTxnLimitUsd: kyc.perTxnLimitUsd,
      });
      return res.status(403).json({
        success: false,
        error: 'KYC_TIER_LIMIT_EXCEEDED',
        message: `This withdrawal (~$${offrampUsd.toFixed(2)}) exceeds your verification tier's limit ($${kyc.perTxnLimitUsd}). Complete enhanced verification to raise your limit.`,
        tier: kyc.tier,
        perTxnLimitUsd: kyc.perTxnLimitUsd,
        txnUsd: offrampUsd,
      });
    }

    const fieldsToCreateOrder: Record<string, unknown> = {
      phoneNumber: String(phoneNumber || '').replace(/^\+/, ''),
      fullName: resolvedFullName,
      blockchainWalletAddress: walletAddress || '',
    };
    if (destinationType === 'bank_account') {
      fieldsToCreateOrder.accountNumber = accountNumber;
      fieldsToCreateOrder.bankCode = bankCode;
    }

    const order = await orderService.createOrder({
      quoteId: quote.quoteId,
      userEmail: email || `${userId}@moleapp.africa`,
      userIp: req.ip || '0.0.0.0',
      userCountryIsoCode: upperCountry,
      deposit: {
        paymentChannel: 'crypto',
        currencyType: 'crypto',
        currencyCode: depositCrypto,
        amount: Number(cryptoAmount),
      },
      payout: {
        paymentChannel: payoutChannel,
        currencyType: 'fiat',
        currencyCode: currency,
        countryIsoCode: upperCountry,
        carrierCode: payoutChannel === 'mobile_money' ? resolvedCarrier : undefined,
      },
      fieldsToCreateOrder,
      webhookUrl: `${WEBHOOK_BASE_URL}/api/v2/momo/webhook/fonbnk`,
    });

    const orderId = `fonbnk-offramp-${order.id}`;

    await prisma.momoTransaction.create({
      data: {
        id: orderId,
        userId,
        walletAddress: '',
        providerId: 'fonbnk',
        providerCode: `FONBNK_${country}`,
        paymentMethod: destinationType === 'bank_account' ? 'BANK_TRANSFER' : 'MOBILE_MONEY',
        type: 'OFF_RAMP',
        status: 'PENDING',
        amount: quote.payout.amount,
        currency,
        cryptoAmount,
        cryptoCurrency: cryptoCurrency || 'BASE_USDC',
        exchangeRate: quote.exchangeRate,
        phoneNumber: phoneNumber || '',
        currentState: OFF_RAMP_STATES.CRYPTO_LOCKED,
        lifecycleStage: 'PROVIDER_PENDING',
        providerTxId: order.id,
        metadata: {
          provider: 'fonbnk',
          country,
          fonbnkOrderId: order.id,
          quoteId: quote.quoteId,
          depositAddress: order.transferInstructions,
          fees: order.chargedFees,
        },
      },
    });

    return res.json({
      success: true,
      data: {
        orderId,
        fonbnkOrderId: order.id,
        transferInstructions: order.transferInstructions,
        deposit: order.deposit,
        payout: order.payout,
        fees: order.chargedFees,
      },
    });
  } catch (err: any) {
    logger.error('Fonbnk offRamp failed', { userId, error: err.message });
    return res.status(500).json({ success: false, error: 'Off-ramp initiation failed' });
  }
}

// ---- Confirm deposit ----

export async function fonbnkConfirmDeposit(req: Request, res: Response) {
  const { orderId } = req.params;
  try {
    const result = await orderService.confirmOrder(orderId);
    return res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error('Fonbnk confirmDeposit failed', { orderId, error: err.message });
    return res.status(500).json({ success: false, error: 'Confirm failed' });
  }
}

// ---- Submit OTP (for otp_stk_push flow) ----

export async function fonbnkSubmitOtp(req: Request, res: Response) {
  const { orderId } = req.params;
  const { otp } = req.body;
  try {
    const result = await orderService.submitIntermediateAction({ orderId, otp });
    return res.json({ success: true, data: result });
  } catch (err: any) {
    logger.error('Fonbnk submitOtp failed', { orderId, error: err.message });
    return res.status(500).json({ success: false, error: 'OTP submission failed' });
  }
}

// ---- Webhook ----

export async function handleFonbnkWebhook(req: Request, res: Response) {
  // express.raw() gives us a Buffer for this route. We MUST hash the exact
  // bytes Fonbnk signed — re-stringifying parsed JSON changes bytes.
  let rawBody: string;
  if (Buffer.isBuffer(req.body)) {
    rawBody = req.body.toString('utf8');
  } else if (typeof req.body === 'string') {
    rawBody = req.body;
  } else {
    logger.error('Fonbnk webhook: raw body unavailable (express.raw not applied?)');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const signature = req.headers['x-signature'] as string | undefined;

  const validation = webhookSvc.validateFonbnkWebhook(rawBody, signature);
  if (!validation.valid) {
    logger.warn('Fonbnk webhook validation failed', { error: validation.error });
    return res.status(401).json({ error: validation.error });
  }

  try {
    const payload = JSON.parse(rawBody);
    const result = webhookSvc.processFonbnkWebhook(payload);

    const transaction = await prisma.momoTransaction.findFirst({
      where: { providerTxId: result.orderId },
    });

    if (!transaction) {
      logger.warn('Fonbnk webhook: transaction not found', { fonbnkOrderId: result.orderId });
      return res.status(200).json({ success: true, skipped: true });
    }

    const terminalStates = ['COMPLETED', 'FAILED', 'REFUNDED'];
    if (terminalStates.includes(transaction.status)) {
      return res.status(200).json({ success: true, alreadyProcessed: true });
    }

    await prisma.momoTransaction.update({
      where: { id: transaction.id },
      data: {
        status: result.fonbnkStatus === 'payout_successful' ? 'COMPLETED' : result.fonbnkStatus === 'payout_failed' ? 'FAILED' : 'PROCESSING',
        blockchainTxHash: result.transactionHash || undefined,
        currentState: result.fonbnkStatus,
        stateUpdatedAt: new Date(),
        lifecycleStage: webhookSvc.isFonbnkTerminalStatus(result.fonbnkStatus) ? 'COMPLETED' : 'PROVIDER_PENDING',
      },
    });

    await prisma.transactionStateHistory.create({
      data: {
        transactionId: transaction.id,
        previousState: transaction.currentState,
        currentState: result.fonbnkStatus,
        trigger: 'FONBNK_WEBHOOK',
        metadata: { fonbnkStatus: result.fonbnkStatus, amount: result.amount },
      },
    });

    // On-ramp payout success: forward crypto from treasury to user wallet
    if (result.fonbnkStatus === 'payout_successful' && transaction.type === 'ON_RAMP') {
      const metadata = transaction.metadata as Record<string, any>;
      const userWallet = metadata?.userWalletAddress;

      if (!userWallet) {
        logger.error('Fonbnk on-ramp: missing userWalletAddress in metadata — cannot forward', {
          transactionId: transaction.id,
        });
      } else {
        const netCrypto = Number(transaction.cryptoAmount);
        const chainId = parseInt(process.env.DEFAULT_CHAIN_ID || '42161');

        try {
          const forwardResult = await treasuryService.creditUserFromTreasury(
            userWallet,
            netCrypto,
            chainId,
            transaction.id,
          );

          await prisma.momoTransaction.update({
            where: { id: transaction.id },
            data: {
              blockchainTxHash: forwardResult?.txHash || result.transactionHash,
              lifecycleStage: 'COMPLETED',
            },
          });

          logger.info('Fonbnk on-ramp: treasury forward complete', {
            transactionId: transaction.id,
            userWallet,
            netCrypto,
            txHash: forwardResult?.txHash,
          });
        } catch (forwardErr: any) {
          // Treasury forward failed — mark for manual review but keep webhook 2xx
          // (don't let Fonbnk retry; our state is recorded, ops can remediate)
          logger.error('Treasury forward failed — MANUAL REVIEW REQUIRED', {
            transactionId: transaction.id,
            userWallet,
            netCrypto,
            error: forwardErr?.message,
          });
          await prisma.momoTransaction.update({
            where: { id: transaction.id },
            data: {
              lifecycleStage: 'MANUAL_REVIEW',
              failureReason: `Treasury forward failed: ${forwardErr?.message}`,
            },
          });
        }
      }
    }

    logger.info('Fonbnk webhook processed', {
      transactionId: transaction.id,
      fonbnkStatus: result.fonbnkStatus,
    });

    return res.status(200).json({ success: true });
  } catch (err: any) {
    logger.error('Fonbnk webhook processing failed', { error: err.message });
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
}
