/**
 * Momo Controller — mobile money on/off-ramp
 *
 * Legacy endpoints (/on-ramp, /off-ramp, /channels, /networks, /exchange-rates)
 * used to call LocalRamp. LocalRamp is disabled — these endpoints now delegate
 * to Fonbnk internally while preserving the legacy response shape so the
 * existing mobile build keeps working. New mobile builds should target the
 * native /fonbnk/* endpoints in fonbnkController.ts.
 */

import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { CommissionService } from '../services/momo/commission';
import { treasuryService } from '../services/treasury/treasuryService';
import { ON_RAMP_STATES, OFF_RAMP_STATES } from '../services/momo/fsm';
import * as quoteService from '../services/momo/fonbnk/quoteService';
import * as orderService from '../services/momo/fonbnk/orderService';

const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'https://moleapp-api-gateway.onrender.com';
const commissionService = new CommissionService();

const COUNTRY_DEFAULT_CHANNEL: Record<string, string> = {
  SN: 'mobile_money', CI: 'mobile_money', CM: 'mobile_money',
  RW: 'mobile_money', UG: 'mobile_money', KE: 'mobile_money',
  GH: 'mobile_money', ZM: 'mobile_money',
  NG: 'instant_p2p',
};

/**
 * Default Fonbnk carrier code per country. Used when the mobile client
 * doesn't pass a `carrierCode` explicitly. Conservative picks: the dominant
 * mobile-money operator in each market. Override via request body.
 */
const DEFAULT_CARRIER_BY_COUNTRY: Record<string, string> = {
  SN: 'sn_orange',  // Orange Senegal
  CI: 'ci_orange',  // Orange Côte d'Ivoire
  KE: 'ke_mpesa',   // Safaricom M-Pesa
  GH: 'gh_mtn',
  CM: 'cm_mtn',
  RW: 'rw_mtn',
  UG: 'ug_mtn',
  ZM: 'zm_mtn',
};

function detectCountryFromPhone(phoneNumber: string): string | null {
  const normalized = phoneNumber.replace(/[\s\-\(\)\+]/g, '');
  const prefixes: Record<string, string> = {
    '221': 'SN', '225': 'CI', '223': 'ML', '226': 'BF', '227': 'NE',
    '234': 'NG', '233': 'GH', '254': 'KE', '255': 'TZ', '256': 'UG',
    '27': 'ZA', '237': 'CM', '250': 'RW', '243': 'CD', '251': 'ET',
    '20': 'EG', '258': 'MZ', '260': 'ZM',
  };
  for (const [prefix, country] of Object.entries(prefixes)) {
    if (normalized.startsWith(prefix)) return country;
  }
  return null;
}

function countryToCurrency(country: string): string {
  const map: Record<string, string> = {
    'NG': 'NGN', 'GH': 'GHS', 'KE': 'KES', 'SN': 'XOF', 'CI': 'XOF',
    'CM': 'XAF', 'RW': 'RWF', 'UG': 'UGX', 'ZM': 'ZMW',
  };
  return map[country] || 'NGN';
}

/**
 * Map mobile-side crypto codes to Fonbnk's network-prefixed codes.
 *
 * Mobile sends generic codes like 'USDC' (LocalRamp legacy). Fonbnk's
 * sandbox + prod use network prefixes ('BASE_USDC', 'ETHEREUM_USDT', …).
 * Anything we don't recognize falls back to BASE_USDC since that's the
 * only chain we currently support for ramp.
 */
function normalizeFonbnkCryptoCode(input: string | undefined | null): string {
  if (!input) return 'BASE_USDC';
  const upper = String(input).toUpperCase();
  // Already network-prefixed (BASE_*, ETHEREUM_*, POLYGON_*, ARBITRUM_*, …)
  if (/^[A-Z]+_[A-Z0-9]+/.test(upper)) return upper;
  // Generic legacy codes from old LocalRamp flow
  const map: Record<string, string> = {
    USDC: 'BASE_USDC',
    USDT: 'BNB_USDT',         // closest live Fonbnk equivalent for USDT_BSC era
    USDT_BSC: 'BNB_USDT',
    USDC_ETH: 'ETHEREUM_USDC',
    USDT_ETH: 'ETHEREUM_USDT',
  };
  return map[upper] || 'BASE_USDC';
}

async function getUserWalletAddress(userId: string): Promise<string | null> {
  const wallet = await prisma.wallet.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return wallet?.address || null;
}

/**
 * GET /channels?country=SN — returns payment methods for a country
 */
export async function getChannels(req: Request, res: Response) {
  try {
    const { country } = req.query;
    if (!country || typeof country !== 'string') {
      return res.status(400).json({ success: false, error: 'Country parameter is required' });
    }
    const cc = country.toUpperCase();
    const fiat = countryToCurrency(cc);

    let methods: Array<{ id: string; name: string; type: string; country: string }> = [];
    try {
      const currencies = await quoteService.getCurrencies();
      const match = currencies.find(
        (c) => c.currencyType === 'fiat' && c.currencyCode === fiat &&
               c.currencyDetails?.countryIsoCode === cc,
      );
      methods = (match?.paymentChannels || [])
        .filter((ch) => ch.isDepositAllowed)
        .map((ch) => ({ id: ch.type, name: ch.name, type: ch.type, country: cc }));
    } catch (err: any) {
      logger.warn('Fonbnk channels fetch failed, using default', { error: err.message });
    }

    if (methods.length === 0) {
      const defaultType = COUNTRY_DEFAULT_CHANNEL[cc] || 'mobile_money';
      methods = [{ id: defaultType, name: 'Mobile Money', type: defaultType, country: cc }];
    }

    res.json({ success: true, data: { channels: methods, country: cc } });
  } catch (error: any) {
    logger.error('Failed to get channels', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /networks?country=SN — returns supported banks for off-ramp
 */
export async function getNetworks(req: Request, res: Response) {
  try {
    const { country } = req.query;
    if (!country || typeof country !== 'string') {
      return res.status(400).json({ success: false, error: 'Country parameter is required' });
    }
    const cc = country.toUpperCase();
    const fiat = countryToCurrency(cc);

    let banks: Array<{ code: string; name: string }> = [];
    try {
      const currencies = await quoteService.getCurrencies();
      const match = currencies.find(
        (c) => c.currencyType === 'fiat' && c.currencyCode === fiat &&
               c.currencyDetails?.countryIsoCode === cc,
      );
      const channels = match?.paymentChannels || [];
      const carriers = channels.flatMap((ch) => ch.carriers || []);
      banks = carriers.map((b) => ({ code: b.code, name: b.name }));
    } catch (err: any) {
      logger.warn('Fonbnk networks fetch failed, returning empty list', { error: err.message });
    }

    res.json({ success: true, data: { networks: banks, country: cc } });
  } catch (error: any) {
    logger.error('Failed to get networks', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /exchange-rates?from=XOF&to=USDC&country=SN&amount=10000
 */
export async function getExchangeRates(req: Request, res: Response) {
  const { from, to, country, amount } = req.query;
  const fromStr = String(from || 'XOF');
  const toStr = String(to || 'USDC');

  const mockRates: Record<string, number> = {
    'XOF-USDC': 650, 'XOF-USD': 650,
    'NGN-USDC': 1550, 'NGN-USD': 1550,
    'GHS-USDC': 15, 'GHS-USD': 15,
    'KES-USDC': 130, 'KES-USD': 130,
    'UGX-USDC': 3700, 'RWF-USDC': 1300, 'ZMW-USDC': 25,
    'TZS-USDC': 2700, 'ZAR-USDC': 18, 'XAF-USDC': 650,
  };

  try {
    const senderAmount = amount ? parseFloat(String(amount)) : 10000;
    const payoutCode = normalizeFonbnkCryptoCode(toStr);
    const countryIso = (country as string | undefined)?.toUpperCase();

    const quote = await quoteService.getQuote({
      deposit: { currencyType: 'fiat', currencyCode: fromStr, paymentChannel: 'mobile_money', amount: senderAmount, countryIsoCode: countryIso },
      payout: { currencyType: 'crypto', currencyCode: payoutCode, paymentChannel: 'crypto' },
    });

    const processorFee = quote.feeSettings
      ?.filter((f) => f.type === 'processor' || f.name?.toLowerCase().includes('processor'))
      ?.reduce((sum, f) => sum + (f.amount || 0), 0) ?? 0;
    const networkFee = quote.feeSettings
      ?.filter((f) => f.type === 'network' || f.name?.toLowerCase().includes('network'))
      ?.reduce((sum, f) => sum + (f.amount || 0), 0) ?? 0;

    return res.json({
      success: true,
      data: {
        fromCurrency: fromStr, toCurrency: toStr,
        buyRate: quote.exchangeRate, rate: quote.exchangeRate,
        processorFee, networkFee,
        source: 'fonbnk', country: countryIso,
        timestamp: new Date(), validUntil: quote.expiresAt || new Date(Date.now() + 30_000),
      },
    });
  } catch (err: any) {
    logger.warn('Fonbnk rate fetch failed, falling back to mock', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const rate = mockRates[`${fromStr}-${toStr}`] || mockRates[`${fromStr}-USDC`] || 650;
  return res.json({
    success: true,
    data: {
      fromCurrency: fromStr, toCurrency: toStr, rate,
      buyRate: rate, source: 'mock',
      country: (country as string)?.toUpperCase(),
      timestamp: new Date(), validUntil: new Date(Date.now() + 30_000),
    },
  });
}

/**
 * POST /on-ramp — Initiate fiat-to-crypto via Fonbnk (legacy-shape response)
 */
export async function initiateOnRamp(req: Request, res: Response) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { walletAddress, phoneNumber, amount, currency, cryptoCurrency, country, email, paymentMethod, carrierCode, fullName } = req.body;
    const orderIdLocal = `onramp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    logger.info('Initiating on-ramp (fonbnk)', { userId, amount, currency, orderId: orderIdLocal });

    const detectedCountry = (country || detectCountryFromPhone(phoneNumber) || 'SN').toUpperCase();
    const fiatCurrency = currency || countryToCurrency(detectedCountry);
    const payoutCode = normalizeFonbnkCryptoCode(cryptoCurrency) || 'BASE_USDC';
    const depositChannel = paymentMethod || COUNTRY_DEFAULT_CHANNEL[detectedCountry] || 'mobile_money';
    const resolvedCarrier = carrierCode || DEFAULT_CARRIER_BY_COUNTRY[detectedCountry];
    const resolvedFullName = fullName || `MoleApp User ${String(userId).slice(0, 8)}`;

    const quote = await quoteService.getQuote({
      deposit: { currencyType: 'fiat', currencyCode: fiatCurrency, paymentChannel: depositChannel, amount: Number(amount), countryIsoCode: detectedCountry },
      payout: { currencyType: 'crypto', currencyCode: payoutCode, paymentChannel: 'crypto' },
    });
    const exchangeRate = quote.exchangeRate;

    const comm = commissionService.calculateFiatOnrampCommission(amount);

    const treasuryAddress = treasuryService.getTreasuryAddress();
    const order = await orderService.createOrder({
      quoteId: quote.quoteId,
      userEmail: email || `${userId}@moleapp.africa`,
      userIp: (req.ip || '0.0.0.0'),
      userCountryIsoCode: detectedCountry,
      deposit: {
        paymentChannel: depositChannel,
        currencyType: 'fiat',
        currencyCode: fiatCurrency,
        countryIsoCode: detectedCountry,
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

    const grossCrypto = quote.payout.amount;
    const cryptoFee = grossCrypto * comm.commissionRate;
    const usdcAmount = Math.floor((grossCrypto - cryptoFee) * 100) / 100;

    const processorFee = (order.chargedFees || [])
      .filter((f) => f.name?.toLowerCase().includes('processor'))
      .reduce((sum, f) => sum + (f.amount || 0), 0);
    const networkFee = (order.chargedFees || [])
      .filter((f) => f.name?.toLowerCase().includes('network'))
      .reduce((sum, f) => sum + (f.amount || 0), 0);

    const checkoutLink = order.transferInstructions?.redirectUrl || '';

    await prisma.momoTransaction.create({
      data: {
        id: orderIdLocal, userId, walletAddress,
        providerId: 'fonbnk', providerCode: `FONBNK_${detectedCountry}`,
        paymentMethod: depositChannel === 'instant_p2p' ? 'BANK_TRANSFER' : 'MOBILE_MONEY',
        type: 'ON_RAMP', status: 'PENDING',
        amount, currency: fiatCurrency, cryptoAmount: usdcAmount, cryptoCurrency: payoutCode,
        exchangeRate, phoneNumber,
        currentState: ON_RAMP_STATES.FIAT_PENDING, lifecycleStage: 'PROVIDER_PENDING',
        providerTxId: order.id, providerRef: order.id,
        metadata: {
          provider: 'fonbnk', country: detectedCountry,
          fonbnkOrderId: order.id, quoteId: quote.quoteId,
          transferInstructions: order.transferInstructions as any,
          fees: order.chargedFees as any,
          grossCrypto, cryptoFee, netCrypto: usdcAmount,
          commissionRate: comm.commissionRate,
          treasuryIntermediary: true, userWalletAddress: walletAddress,
        },
      },
    });

    await prisma.transactionStateHistory.create({
      data: {
        transactionId: orderIdLocal,
        previousState: ON_RAMP_STATES.CREATED, currentState: ON_RAMP_STATES.FIAT_PENDING,
        trigger: 'FONBNK_BUY_INITIATED',
        metadata: { fonbnkOrderId: order.id },
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: orderIdLocal, status: 'PENDING', type: 'ON_RAMP', provider: 'fonbnk',
        country: detectedCountry, amount, currency: fiatCurrency,
        cryptoAmount: usdcAmount, cryptoCurrency: payoutCode, exchangeRate,
        phoneNumber: phoneNumber.slice(0, 5) + '***',
        commission: { amount: comm.commission, rate: comm.commissionRate, description: 'MoleApp service fee' },
        walletAddress, checkoutLink,
        transferInstructions: order.transferInstructions,
        processorFee, networkFee,
        estimatedTime: '2-10 minutes',
        message: 'Buy initiated. Follow the transfer instructions to complete payment.',
        createdAt: new Date(),
      },
    });
  } catch (error: any) {
    logger.error('On-ramp failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to process on-ramp' });
  }
}

/**
 * POST /off-ramp — Initiate crypto-to-fiat via Fonbnk (legacy-shape response)
 */
export async function initiateOffRamp(req: Request, res: Response) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const {
      walletAddress, phoneNumber, cryptoAmount, cryptoCurrency, currency, country,
      email, destinationType, accountNumber, bankCode, carrierCode, fullName,
    } = req.body;
    const orderIdLocal = `offramp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    logger.info('Initiating off-ramp (fonbnk)', { userId, cryptoAmount, currency, orderId: orderIdLocal });

    const detectedCountry = (country || detectCountryFromPhone(phoneNumber) || 'SN').toUpperCase();
    const fiatCurrency = currency || countryToCurrency(detectedCountry);
    const depositCrypto = normalizeFonbnkCryptoCode(cryptoCurrency) || 'BASE_USDC';
    const payoutChannel = destinationType === 'bank_account' ? 'bank_transfer' : 'mobile_money';
    const resolvedCarrier = carrierCode || DEFAULT_CARRIER_BY_COUNTRY[detectedCountry];
    const resolvedFullName = fullName || `MoleApp User ${String(userId).slice(0, 8)}`;

    const sourceAddress = walletAddress || await getUserWalletAddress(userId);
    if (!sourceAddress) return res.status(400).json({ success: false, error: 'No wallet found' });

    // ── MoleApp fee split ─────────────────────────────────────────────
    // Fonbnk pays fiat directly to the user — we can't intercept on the fiat
    // side. So we take our fee from the gross USDC BEFORE handing off.
    // Mobile then constructs a single batched UserOp: one transfer to treasury
    // (feeUsdc), one transfer to Fonbnk's deposit address (netUsdc). Atomic.
    const offRampFeePercent = parseFloat(process.env.OFF_RAMP_FEE_PERCENT || '0.01');
    const grossUsdc = Number(cryptoAmount);
    // Round fee + net to 6 decimal places (USDC precision) to avoid float drift
    const feeUsdcRaw = grossUsdc * offRampFeePercent;
    const feeUsdc = Math.floor(feeUsdcRaw * 1e6) / 1e6;
    const netUsdc = Math.floor((grossUsdc - feeUsdc) * 1e6) / 1e6;

    if (netUsdc <= 0) {
      return res.status(400).json({
        success: false,
        error: 'AMOUNT_TOO_SMALL',
        message: 'Amount is too small to cover the platform fee. Try a larger amount.',
      });
    }

    // Quote Fonbnk with the NET amount (what they'll actually receive)
    const quote = await quoteService.getQuote({
      deposit: { currencyType: 'crypto', currencyCode: depositCrypto, paymentChannel: 'crypto', amount: netUsdc },
      payout: { currencyType: 'fiat', currencyCode: fiatCurrency, paymentChannel: payoutChannel, countryIsoCode: detectedCountry },
    });
    const exchangeRate = quote.exchangeRate;
    const fiatAmount = quote.payout.amount;

    const fields: Record<string, unknown> = {
      phoneNumber: String(phoneNumber || '').replace(/^\+/, ''),
      fullName: resolvedFullName,
      blockchainWalletAddress: sourceAddress,
    };
    if (destinationType === 'bank_account') {
      fields.accountNumber = accountNumber;
      fields.bankCode = bankCode;
    }

    const order = await orderService.createOrder({
      quoteId: quote.quoteId,
      userEmail: email || `${userId}@moleapp.africa`,
      userIp: (req.ip || '0.0.0.0'),
      userCountryIsoCode: detectedCountry,
      deposit: {
        paymentChannel: 'crypto',
        currencyType: 'crypto',
        currencyCode: depositCrypto,
        amount: netUsdc,
      },
      payout: {
        paymentChannel: payoutChannel,
        currencyType: 'fiat',
        currencyCode: fiatCurrency,
        countryIsoCode: detectedCountry,
        carrierCode: payoutChannel === 'mobile_money' ? resolvedCarrier : undefined,
      },
      fieldsToCreateOrder: fields,
      webhookUrl: `${WEBHOOK_BASE_URL}/api/v2/momo/webhook/fonbnk`,
    });

    const fonbnkFee = (order.chargedFees || []).reduce((sum, f) => sum + (f.amount || 0), 0);

    // Extract Fonbnk's deposit address from order — defensive across possible shapes
    // (transferInstructions varies by paymentChannel; sandbox uses the manual flow
    // for crypto deposits so accountNumber holds the on-chain address).
    const ti = order.transferInstructions as any;
    const fonbnkDepositAddress: string | null =
      ti?.blockchainWalletAddress ||
      ti?.accountNumber ||
      ti?.address ||
      (order as any)?.deposit?.blockchainWalletAddress ||
      null;

    const treasuryAddress = treasuryService.getTreasuryAddress();
    const usdcContractAddress = process.env.OFF_RAMP_USDC_CONTRACT_ADDRESS
      || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet USDC
    const usdcChainId = parseInt(process.env.OFF_RAMP_USDC_CHAIN_ID || '8453', 10); // Base mainnet

    await prisma.momoTransaction.create({
      data: {
        id: orderIdLocal, userId, walletAddress: sourceAddress,
        providerId: 'fonbnk', providerCode: `FONBNK_${detectedCountry}`,
        paymentMethod: destinationType === 'bank_account' ? 'BANK_TRANSFER' : 'MOBILE_MONEY',
        type: 'OFF_RAMP', status: 'PENDING',
        amount: fiatAmount, currency: fiatCurrency, cryptoAmount: grossUsdc, cryptoCurrency: depositCrypto,
        exchangeRate, phoneNumber,
        currentState: OFF_RAMP_STATES.CRYPTO_LOCKED, lifecycleStage: 'PROVIDER_PENDING',
        providerTxId: order.id, providerRef: order.id,
        metadata: {
          provider: 'fonbnk', country: detectedCountry,
          fonbnkOrderId: order.id, quoteId: quote.quoteId,
          transferInstructions: order.transferInstructions as any,
          fonbnkDepositAddress, treasuryAddress, usdcContractAddress, usdcChainId,
          grossUsdc, feeUsdc, netUsdc, offRampFeePercent,
          fees: order.chargedFees as any,
        },
      },
    });

    await prisma.transactionStateHistory.create({
      data: {
        transactionId: orderIdLocal,
        previousState: OFF_RAMP_STATES.CREATED, currentState: OFF_RAMP_STATES.CRYPTO_LOCKED,
        trigger: 'FONBNK_SELL_INITIATED',
        metadata: { fonbnkOrderId: order.id, grossUsdc, feeUsdc, netUsdc },
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: orderIdLocal, status: 'PENDING', type: 'OFF_RAMP', provider: 'fonbnk',
        country: detectedCountry,
        // Fiat side
        amount: fiatAmount, currency: fiatCurrency, exchangeRate,
        // Crypto side — break down so mobile can build the batched UserOp
        cryptoCurrency: depositCrypto,
        cryptoAmount: grossUsdc,
        feeUsdc,
        netUsdc,
        offRampFeePercent,
        // Settlement coordinates
        depositAddress: fonbnkDepositAddress,
        treasuryAddress,
        usdcContractAddress,
        usdcChainId,
        usdcDecimals: 6,
        // Counterparty + UX bits
        phoneNumber: phoneNumber.slice(0, 5) + '***',
        commission: {
          amount: feeUsdc,
          rate: offRampFeePercent,
          description: `MoleApp fee (${(offRampFeePercent * 100).toFixed(1)}% of gross USDC)`,
        },
        walletAddress: sourceAddress,
        transferInstructions: order.transferInstructions,
        // Legacy fields kept for older mobile builds
        lrReference: order.id, lrFee: fonbnkFee, lrFiatAmount: fiatAmount,
        estimatedTime: '2-15 minutes',
        message: fonbnkDepositAddress
          ? `Send ${netUsdc} ${depositCrypto} (and ${feeUsdc} fee) from your wallet — we'll deposit ${Math.round(fiatAmount)} ${fiatCurrency} to your phone.`
          : `Off-ramp initiated. Follow the on-screen instructions.`,
        createdAt: new Date(),
      },
    });
  } catch (error: any) {
    logger.error('Off-ramp failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to process off-ramp' });
  }
}

/**
 * GET /transaction/:transactionId
 */
export async function getTransactionStatus(req: Request, res: Response) {
  try {
    const { transactionId } = req.params;
    const userId = (req as any).userId;

    const transaction = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (transaction.userId !== userId) return res.status(403).json({ success: false, error: 'Not authorized' });

    res.json({
      success: true,
      data: {
        id: transaction.id, status: transaction.status, type: transaction.type,
        currentState: transaction.currentState, lifecycleStage: transaction.lifecycleStage,
        amount: transaction.amount, currency: transaction.currency,
        cryptoAmount: transaction.cryptoAmount, cryptoCurrency: transaction.cryptoCurrency,
        exchangeRate: transaction.exchangeRate,
        blockchainTxHash: transaction.blockchainTxHash,
        providerCode: transaction.providerCode,
        failureReason: transaction.failureReason,
        createdAt: transaction.createdAt, updatedAt: transaction.updatedAt,
      },
    });
  } catch (error: any) {
    logger.error('Failed to get transaction status', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /commission/user-summary
 */
export async function getUserCommissionSummary(req: Request, res: Response) {
  try {
    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });
    const summary = await commissionService.getUserCommissionPaid(userId);
    res.json({ success: true, data: summary });
  } catch (error: any) {
    logger.error('Failed to get commission summary', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}
