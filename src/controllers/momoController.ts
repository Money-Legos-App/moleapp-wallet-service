/**
 * Momo Controller — LocalRamp mobile money on/off-ramp
 * Migrated from momo-service into wallet-service (direct treasury calls)
 */

import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { prisma } from '../lib/prisma';
import { logger } from '../utils/logger';
import { CommissionService } from '../services/momo/commission';
import { treasuryService } from '../services/treasury/treasuryService';
import { ON_RAMP_STATES, OFF_RAMP_STATES } from '../services/momo/fsm';
import { PaymentStatus } from '../services/momo/types';
import { Address } from 'viem';
import * as rateService from '../services/momo/localRamp/rateService';
import * as buyService from '../services/momo/localRamp/buyService';
import * as sellService from '../services/momo/localRamp/sellService';
import * as webhookService from '../services/momo/localRamp/webhookService';
import { getQueueService, QUEUE_NAMES } from '../services/momo/queue/queueService';

const DEFAULT_CHAIN_ID = parseInt(process.env.DEFAULT_CHAIN_ID || '42161');
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'https://moleapp-api-gateway.onrender.com';
const commissionService = new CommissionService();

// Helper: detect country from phone prefix
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

// Helper: map country code to fiat currency
function countryToCurrency(country: string): string {
  const map: Record<string, string> = {
    'NG': 'NGN', 'GH': 'GHS', 'KE': 'KES', 'SN': 'XOF', 'CI': 'XOF',
    'CM': 'XAF', 'RW': 'RWF', 'UG': 'UGX', 'ZM': 'ZMW',
  };
  return map[country] || 'NGN';
}

// Helper: get user wallet address from DB
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
    const currency = countryToCurrency(cc);
    const methods = await rateService.getPaymentMethods(cc, currency);
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
    const banks = await rateService.getSupportedBanks(country.toUpperCase());
    res.json({ success: true, data: { networks: banks, country: country.toUpperCase() } });
  } catch (error: any) {
    logger.error('Failed to get networks', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * GET /exchange-rates?from=XOF&to=USDT_BSC&country=SN&amount=10000
 */
export async function getExchangeRates(req: Request, res: Response) {
  try {
    const { from, to, country, amount } = req.query;

    if (from && to) {
      try {
        const senderAmount = amount ? parseFloat(amount as string) : 10000;
        const quote = await rateService.getBuyQuote(from as string, (to as string) || 'USDT_BSC', senderAmount);
        return res.json({
          success: true,
          data: {
            fromCurrency: from, toCurrency: to || 'USDT_BSC',
            buyRate: quote.exchange_rate, rate: quote.exchange_rate,
            processorFee: quote.processor_fee, networkFee: quote.network_fee,
            source: 'localramp', country: (country as string)?.toUpperCase(),
            timestamp: new Date(), validUntil: new Date(Date.now() + 30_000),
          },
        });
      } catch (lrError) {
        logger.warn('LocalRamp rate fetch failed, falling back to mock', {
          error: lrError instanceof Error ? lrError.message : String(lrError),
        });
      }
    }

    // Fallback mock rates
    const mockRates: Record<string, number> = {
      'XOF-USDC': 650, 'XOF-USD': 650, 'NGN-USDC': 1550, 'NGN-USD': 1550,
      'GHS-USDC': 15, 'GHS-USD': 15, 'KES-USDC': 130, 'KES-USD': 130,
      'TZS-USDC': 2700, 'UGX-USDC': 3700, 'ZAR-USDC': 18, 'XAF-USDC': 650,
    };
    const rate = mockRates[`${from}-${to}`];
    if (!rate) return res.status(404).json({ success: false, error: 'Rate not found' });
    res.json({ success: true, data: { fromCurrency: from, toCurrency: to, rate, source: 'mock', timestamp: new Date() } });
  } catch (error: any) {
    logger.error('Failed to get exchange rates', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
}

/**
 * POST /on-ramp — Initiate fiat-to-crypto via LocalRamp
 */
export async function initiateOnRamp(req: Request, res: Response) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const { walletAddress, phoneNumber, amount, currency, cryptoCurrency, country, email, paymentMethod } = req.body;
    const orderId = `onramp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    logger.info('Initiating on-ramp', { userId, amount, currency, orderId });

    const detectedCountry = country || detectCountryFromPhone(phoneNumber) || 'SN';
    const fiatCurrency = currency || countryToCurrency(detectedCountry);
    const receiverCurrency = cryptoCurrency || 'USDT_BSC';

    // Get LocalRamp buy quote
    const quote = await rateService.getBuyQuote(fiatCurrency, receiverCurrency, amount);
    const exchangeRate = quote.exchange_rate;

    // Commission — collected on the crypto side via treasury intermediary
    const comm = commissionService.calculateFiatOnrampCommission(amount);

    // Route crypto to MoleApp treasury (NOT user wallet).
    // On buy.crypto_sent webhook, treasury forwards (amount - 1.5% fee) to user.
    const treasuryAddress = treasuryService.getTreasuryAddress();
    const buyResult = await buyService.initiateBuy({
      reference: orderId,
      email: email || `${userId}@moleapp.africa`,
      senderCurrency: fiatCurrency,
      countryCode: detectedCountry,
      receiverCurrency,
      senderAmount: amount,
      destinationAddress: treasuryAddress,
      callbackUrl: `${WEBHOOK_BASE_URL}/api/v2/momo/webhook/localramp`,
      paymentMethod,
    });

    const grossCrypto = quote.receiver_amount || (exchangeRate > 0 ? amount / exchangeRate : 0);
    const cryptoFee = grossCrypto * comm.commissionRate;
    const usdcAmount = Math.floor((grossCrypto - cryptoFee) * 100) / 100; // net to user

    // Create DB record
    await prisma.momoTransaction.create({
      data: {
        id: orderId, userId, walletAddress,
        providerId: 'localramp', providerCode: `LR_${detectedCountry}`,
        paymentMethod: 'MOBILE_MONEY', type: 'ON_RAMP', status: 'PENDING',
        amount, currency: fiatCurrency, cryptoAmount: usdcAmount, cryptoCurrency: receiverCurrency,
        exchangeRate, phoneNumber,
        currentState: ON_RAMP_STATES.FIAT_PENDING, lifecycleStage: 'PROVIDER_PENDING',
        providerTxId: buyResult.reference, providerRef: buyResult.reference,
        metadata: {
          provider: 'localramp', country: detectedCountry,
          lrReference: buyResult.reference, lrRate: exchangeRate,
          lrProcessorFee: buyResult.processor_fee, lrNetworkFee: buyResult.network_fee,
          checkoutLink: buyResult.checkout_link,
          grossCrypto, cryptoFee, netCrypto: usdcAmount,
          commissionRate: comm.commissionRate,
          treasuryIntermediary: true, userWalletAddress: walletAddress,
        },
      },
    });

    await prisma.transactionStateHistory.create({
      data: {
        transactionId: orderId,
        previousState: ON_RAMP_STATES.CREATED, currentState: ON_RAMP_STATES.FIAT_PENDING,
        trigger: 'LR_BUY_INITIATED',
        metadata: { lrReference: buyResult.reference },
      },
    });

    res.status(201).json({
      success: true,
      data: {
        id: orderId, status: 'PENDING', type: 'ON_RAMP', provider: 'localramp',
        country: detectedCountry, amount, currency: fiatCurrency,
        cryptoAmount: usdcAmount, cryptoCurrency: receiverCurrency, exchangeRate,
        phoneNumber: phoneNumber.slice(0, 5) + '***',
        commission: { amount: comm.commission, rate: comm.commissionRate, description: 'MoleApp service fee' },
        walletAddress, checkoutLink: buyResult.checkout_link,
        processorFee: buyResult.processor_fee, networkFee: buyResult.network_fee,
        estimatedTime: '2-10 minutes',
        message: 'Buy initiated. Complete payment via the checkout link.',
        createdAt: new Date(),
      },
    });
  } catch (error: any) {
    logger.error('On-ramp failed', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to process on-ramp' });
  }
}

/**
 * POST /off-ramp — Initiate crypto-to-fiat via LocalRamp
 */
export async function initiateOffRamp(req: Request, res: Response) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

    const userId = (req as any).userId;
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication required' });

    const {
      walletAddress, phoneNumber, cryptoAmount, cryptoCurrency, currency, country,
      email, destinationType, accountNumber, bankCode, phoneNetwork,
    } = req.body;
    const orderId = `offramp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    logger.info('Initiating off-ramp', { userId, cryptoAmount, currency, orderId });

    const detectedCountry = country || detectCountryFromPhone(phoneNumber) || 'SN';
    const fiatCurrency = currency || countryToCurrency(detectedCountry);
    const fromCurrency = cryptoCurrency || 'USDT_BSC';

    // Fee is deducted on the crypto side: lock full amount, sell only (amount - 2%)
    const offRampFeeRate = parseFloat(process.env.OFF_RAMP_FEE_PERCENT || '0.01');
    const cryptoFee = cryptoAmount * offRampFeeRate;
    const netCryptoToSell = Math.floor((cryptoAmount - cryptoFee) * 100) / 100;

    // Get LocalRamp sell rate for the net amount
    const rateData = await rateService.getSellRate(fromCurrency, fiatCurrency, netCryptoToSell);
    const exchangeRate = rateData.exchange_rate;
    const fiatAmount = rateData.receiver_amount || netCryptoToSell * exchangeRate;

    // Lock FULL crypto from user → treasury keeps the fee portion
    const sourceAddress = walletAddress || await getUserWalletAddress(userId);
    if (!sourceAddress) return res.status(400).json({ success: false, error: 'No wallet found' });

    const lockResult = await treasuryService.lockUserToTreasury(
      sourceAddress as Address, cryptoAmount, DEFAULT_CHAIN_ID, orderId
    );
    if (!lockResult.success) {
      return res.status(500).json({ success: false, error: lockResult.error || 'Wallet lock failed' });
    }

    // Sell only (crypto - fee) through LocalRamp → fiat goes direct to user
    const sellResult = await sellService.initiateSell({
      txExtReference: orderId,
      email: email || `${userId}@moleapp.africa`,
      fromCurrency,
      toCurrency: fiatCurrency,
      countryCode: detectedCountry,
      fromAmount: netCryptoToSell,
      destinationType: destinationType || 'mobile_money',
      accountNumber,
      bankCode,
      phoneNumber,
      phoneNetwork,
    });

    // Create DB record
    await prisma.momoTransaction.create({
      data: {
        id: orderId, userId, walletAddress: sourceAddress,
        providerId: 'localramp', providerCode: `LR_${detectedCountry}`,
        paymentMethod: destinationType === 'bank_account' ? 'BANK_TRANSFER' : 'MOBILE_MONEY',
        type: 'OFF_RAMP', status: 'PROCESSING',
        amount: fiatAmount, currency: fiatCurrency, cryptoAmount, cryptoCurrency: fromCurrency,
        exchangeRate, phoneNumber,
        currentState: OFF_RAMP_STATES.PAYOUT_PENDING, lifecycleStage: 'CRYPTO_PROCESSING',
        providerTxId: sellResult.reference, providerRef: sellResult.reference,
        blockchainTxHash: lockResult.txHash,
        metadata: {
          provider: 'localramp', country: detectedCountry,
          lrReference: sellResult.reference, lrExtReference: orderId,
          lrRate: exchangeRate, lrFee: sellResult.fee, lrFiatAmount: sellResult.to_amount,
          grossCrypto: cryptoAmount, cryptoFee, netCryptoSold: netCryptoToSell,
          commissionRate: offRampFeeRate,
        },
      },
    });

    await prisma.transactionStateHistory.create({
      data: {
        transactionId: orderId,
        previousState: OFF_RAMP_STATES.CREATED, currentState: OFF_RAMP_STATES.PAYOUT_PENDING,
        trigger: 'LR_SELL_INITIATED',
        metadata: { lrReference: sellResult.reference, blockchainTxHash: lockResult.txHash },
      },
    });

    // Record commission (crypto-side: fee = cryptoFee USDC equivalent)
    const fiatFeeEquivalent = cryptoFee * exchangeRate;
    await commissionService.recordCommission({
      userId, transactionId: orderId, type: 'FIAT_OFFRAMP',
      grossAmount: cryptoAmount, commission: cryptoFee, netAmount: netCryptoToSell, currency: 'USDC',
      provider: 'localramp', blockchainTxHash: lockResult.txHash,
      metadata: { exchangeRate, lrReference: sellResult.reference, fiatFeeEquivalent },
    });

    res.status(201).json({
      success: true,
      data: {
        id: orderId, status: 'PROCESSING', type: 'OFF_RAMP', provider: 'localramp',
        country: detectedCountry, amount: fiatAmount, currency: fiatCurrency,
        cryptoAmount, cryptoCurrency: fromCurrency, exchangeRate,
        phoneNumber: phoneNumber.slice(0, 5) + '***',
        commission: { amount: cryptoFee, rate: offRampFeeRate, description: 'MoleApp service fee (deducted from crypto)' },
        walletAddress: sourceAddress, blockchainTxHash: lockResult.txHash,
        lrReference: sellResult.reference, lrFee: sellResult.fee, lrFiatAmount: sellResult.to_amount,
        estimatedTime: '2-15 minutes',
        message: `Your ${destinationType === 'bank_account' ? 'bank account' : 'mobile money account'} will be credited with ${Math.round(fiatAmount)} ${fiatCurrency}.`,
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

/**
 * POST /webhook/localramp — Handle LocalRamp webhook notifications
 */
export async function handleLocalRampWebhook(req: Request, res: Response) {
  try {
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);
    const headers = req.headers as Record<string, string>;

    logger.info('LocalRamp webhook received', {
      eventType: req.body?.event_type, reference: req.body?.reference,
    });

    const validation = webhookService.validateWebhook(rawBody, headers);
    if (!validation.isValid) {
      logger.warn('LocalRamp webhook validation failed', { error: validation.error });
      return res.status(400).json({ success: false, error: validation.error });
    }

    const payload = validation.payload!;
    const processed = webhookService.processWebhookPayload(payload);

    const transactionId = processed.transactionId;
    if (!transactionId) {
      return res.json({ success: true, data: { received: true }, message: 'Acknowledged (no reference)' });
    }

    const transaction = await prisma.momoTransaction.findUnique({ where: { id: transactionId } });
    if (!transaction) {
      return res.json({ success: true, data: { received: true }, message: 'Acknowledged (tx not found)' });
    }

    if (payload.event_type === 'buy.fiat_received') {
      // On-ramp: fiat confirmed — waiting for crypto
      await prisma.momoTransaction.update({
        where: { id: transactionId },
        data: { status: 'PROCESSING', currentState: ON_RAMP_STATES.FIAT_RECEIVED, lifecycleStage: 'FIAT_CONFIRMED', stateUpdatedAt: new Date() },
      });
      await prisma.transactionStateHistory.create({
        data: {
          transactionId,
          previousState: transaction.currentState || ON_RAMP_STATES.FIAT_PENDING,
          currentState: ON_RAMP_STATES.FIAT_RECEIVED,
          trigger: 'LR_FIAT_RECEIVED',
          verificationData: { reference: payload.reference },
        },
      });
      logger.info('LocalRamp fiat received, awaiting crypto send', { transactionId });

    } else if (payload.event_type === 'buy.crypto_sent') {
      // On-ramp: crypto arrived at treasury → forward net amount to user's wallet
      const meta = transaction.metadata as any;
      const netCrypto = meta?.netCrypto || Number(transaction.cryptoAmount);
      const userWallet = meta?.userWalletAddress || transaction.walletAddress;

      logger.info('LocalRamp crypto received at treasury, forwarding to user', {
        transactionId, netCrypto, userWallet, txid: payload.txid,
      });

      // Forward net crypto from treasury to user (deducting our fee)
      const forwardResult = await treasuryService.creditUserFromTreasury(
        userWallet as Address, netCrypto, DEFAULT_CHAIN_ID, transactionId
      );

      await prisma.momoTransaction.update({
        where: { id: transactionId },
        data: {
          status: forwardResult.success ? 'COMPLETED' : 'PROCESSING',
          currentState: forwardResult.success ? 'COMPLETED' : 'CRYPTO_PROCESSING',
          lifecycleStage: forwardResult.success ? 'COMPLETED' : 'CRYPTO_PROCESSING',
          stateUpdatedAt: new Date(),
          blockchainTxHash: forwardResult.txHash || payload.txid || transaction.blockchainTxHash,
        },
      });
      await prisma.transactionStateHistory.create({
        data: {
          transactionId,
          previousState: transaction.currentState || ON_RAMP_STATES.FIAT_RECEIVED,
          currentState: forwardResult.success ? 'COMPLETED' : 'CRYPTO_PROCESSING',
          trigger: 'LR_CRYPTO_SENT',
          verificationData: { reference: payload.reference, txid: payload.txid, forwardTxHash: forwardResult.txHash },
        },
      });

      // Record on-ramp commission
      const grossCrypto = meta?.grossCrypto || netCrypto;
      const cryptoFee = grossCrypto - netCrypto;
      if (cryptoFee > 0) {
        await commissionService.recordCommission({
          userId: transaction.userId, transactionId, type: 'FIAT_ONRAMP',
          grossAmount: grossCrypto, commission: cryptoFee, netAmount: netCrypto, currency: 'USDC',
          provider: 'localramp', blockchainTxHash: forwardResult.txHash,
          metadata: { lrTxid: payload.txid },
        });
      }

      logger.info('Buy on-ramp forwarding complete', {
        transactionId, success: forwardResult.success, forwardTxHash: forwardResult.txHash,
      });

    } else if (payload.event_type === 'sell.completed') {
      // Off-ramp: fiat disbursed — complete
      await prisma.momoTransaction.update({
        where: { id: transactionId },
        data: { status: 'COMPLETED', currentState: OFF_RAMP_STATES.COMPLETED, lifecycleStage: 'COMPLETED', stateUpdatedAt: new Date() },
      });
      await prisma.transactionStateHistory.create({
        data: {
          transactionId,
          previousState: transaction.currentState || OFF_RAMP_STATES.PAYOUT_PENDING,
          currentState: OFF_RAMP_STATES.COMPLETED,
          trigger: 'LR_SELL_COMPLETED',
          verificationData: { reference: payload.reference },
        },
      });
      logger.info('LocalRamp sell complete', { transactionId });

    } else if (payload.event_type === 'sell.failed') {
      const failedState = transaction.type === 'ON_RAMP' ? ON_RAMP_STATES.FAILED : OFF_RAMP_STATES.FAILED;
      await prisma.momoTransaction.update({
        where: { id: transactionId },
        data: {
          status: 'FAILED', currentState: failedState, lifecycleStage: 'FAILED',
          failureReason: 'LocalRamp payout failed', stateUpdatedAt: new Date(),
        },
      });
      await prisma.transactionStateHistory.create({
        data: {
          transactionId,
          previousState: transaction.currentState || 'CREATED', currentState: failedState,
          trigger: 'LR_SELL_FAILED',
          metadata: { reference: payload.reference },
        },
      });

      // Refund crypto if off-ramp failed
      if (transaction.type === 'OFF_RAMP' && transaction.cryptoAmount) {
        const walletAddr = await getUserWalletAddress(transaction.userId);
        if (walletAddr) {
          await treasuryService.refundFromTreasury(
            walletAddr as Address, Number(transaction.cryptoAmount),
            DEFAULT_CHAIN_ID, transactionId, 'LocalRamp payout failed'
          );
        }
      }
      logger.warn('LocalRamp transaction failed', { transactionId });
    }

    res.json({ success: true, data: { received: true, transactionId, newStatus: processed.status } });
  } catch (error: any) {
    logger.error('LocalRamp webhook error', { error: error.message });
    res.json({ success: true, data: { received: true, error: error.message } });
  }
}
