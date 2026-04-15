/**
 * LocalRamp Buy Service (On-Ramp)
 *
 * Handles fiat-to-crypto on-ramp via LocalRamp API.
 * Flow: initiate buy -> user pays via checkout link -> webhook confirms -> crypto sent
 */

import { getLocalRampClient } from './apiClient';
import { logger } from '../../../utils/logger';

// ================================
// Types
// ================================

export interface InitiateBuyRequest {
  /** Unique reference for this transaction */
  reference: string;
  /** User email */
  email: string;
  /** Fiat currency code (NGN, GHS, KES, XOF, etc.) */
  senderCurrency: string;
  /** ISO 3166-1 alpha-2 country code */
  countryCode: string;
  /** Crypto currency (USDT_BSC, USDC_ETH, etc.) */
  receiverCurrency: string;
  /** Amount in fiat */
  senderAmount?: number;
  /** Amount in crypto (alternative to senderAmount) */
  receiverAmount?: number;
  /** Wallet address to receive crypto */
  destinationAddress: string;
  /** Webhook callback URL */
  callbackUrl: string;
  /** Payment method ID (from getPaymentMethods) */
  paymentMethod?: string;
}

export interface BuyResponse {
  reference: string;
  status: string;
  checkout_link: string;
  sender_amount: number;
  sender_currency: string;
  receiver_amount: number;
  receiver_currency: string;
  exchange_rate: number;
  processor_fee: number;
  network_fee: number;
}

export interface BuyStatus {
  reference: string;
  status: string; // 'pending', 'processing', 'completed', 'failed', 'expired'
  sender_amount: number;
  sender_currency: string;
  receiver_amount: number;
  receiver_currency: string;
  exchange_rate: number;
  txid?: string;
  created_at: string;
  updated_at: string;
}

// ================================
// Service
// ================================

/**
 * Initiate a buy (on-ramp) transaction — returns a checkout link for the user.
 */
export async function initiateBuy(request: InitiateBuyRequest): Promise<BuyResponse> {
  try {
    const client = getLocalRampClient();

    const payload: Record<string, any> = {
      reference: request.reference,
      email: request.email,
      sender_currency: request.senderCurrency,
      country_code: request.countryCode,
      receiver_currency: request.receiverCurrency,
      destination_address: request.destinationAddress,
      callback_url: request.callbackUrl,
    };

    if (request.senderAmount) payload.sender_amount = request.senderAmount;
    if (request.receiverAmount) payload.receiver_amount = request.receiverAmount;
    if (request.paymentMethod) payload.payment_method = request.paymentMethod;

    logger.info('Initiating LocalRamp buy', {
      reference: request.reference,
      senderCurrency: request.senderCurrency,
      countryCode: request.countryCode,
      senderAmount: request.senderAmount,
    });

    const response = await client.post('/v1/transaction/buy/initiate', payload);
    const result: BuyResponse = response.data?.data || response.data;

    logger.info('LocalRamp buy initiated', {
      reference: result.reference,
      senderAmount: result.sender_amount,
      receiverAmount: result.receiver_amount,
      rate: result.exchange_rate,
    });

    return result;
  } catch (error) {
    logger.error('Failed to initiate LocalRamp buy', {
      error: error instanceof Error ? error.message : String(error),
      reference: request.reference,
    });
    throw error;
  }
}

/**
 * Get status of a buy transaction by reference.
 */
export async function getBuyStatus(reference: string): Promise<BuyStatus> {
  try {
    const client = getLocalRampClient();
    const response = await client.get(`/v1/transaction/buy/status/${reference}`);
    const status: BuyStatus = response.data?.data || response.data;

    logger.debug('LocalRamp buy status', { reference, status: status.status });
    return status;
  } catch (error) {
    logger.error('Failed to get LocalRamp buy status', {
      reference,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
