/**
 * LocalRamp Sell Service (Off-Ramp)
 *
 * Handles crypto-to-fiat off-ramp via LocalRamp API.
 * Flow: initiate sell -> LocalRamp disburses fiat -> webhook confirms
 */

import { getLocalRampClient } from './apiClient';
import { logger } from '../../../utils/logger';

// ================================
// Types
// ================================

export interface InitiateSellRequest {
  /** Unique external reference */
  txExtReference: string;
  /** User email */
  email: string;
  /** Crypto currency (USDT_BSC, USDC_ETH, etc.) */
  fromCurrency: string;
  /** Fiat currency (NGN, GHS, KES, XOF, etc.) */
  toCurrency: string;
  /** ISO 3166-1 alpha-2 country code */
  countryCode: string;
  /** Crypto amount to sell */
  fromAmount?: number;
  /** Fiat amount to receive (alternative) */
  toAmount?: number;
  /** Destination type: 'bank_account' or 'mobile_money' */
  destinationType: 'bank_account' | 'mobile_money';
  /** Bank details (for bank_account) */
  accountNumber?: string;
  bankCode?: string;
  /** Mobile money details (for mobile_money) */
  phoneNumber?: string;
  phoneNetwork?: string;
}

export interface SellResponse {
  reference: string;
  tx_ext_reference: string;
  status: string;
  from_currency: string;
  to_currency: string;
  from_amount: number;
  to_amount: number;
  exchange_rate: number;
  fee: number;
}

export interface SellStatus {
  reference: string;
  tx_ext_reference: string;
  status: string; // 'pending', 'processing', 'completed', 'failed'
  from_currency: string;
  to_currency: string;
  from_amount: number;
  to_amount: number;
  exchange_rate: number;
  created_at: string;
  updated_at: string;
}

// ================================
// Service
// ================================

/**
 * Initiate a sell (off-ramp) transaction.
 */
export async function initiateSell(request: InitiateSellRequest): Promise<SellResponse> {
  try {
    const client = getLocalRampClient();

    const payload: Record<string, any> = {
      tx_ext_reference: request.txExtReference,
      email: request.email,
      from_currency: request.fromCurrency,
      to_currency: request.toCurrency,
      country_code: request.countryCode,
      destination_type: request.destinationType,
    };

    if (request.fromAmount) payload.from_amount = request.fromAmount;
    if (request.toAmount) payload.to_amount = request.toAmount;

    if (request.destinationType === 'bank_account') {
      payload.account_number = request.accountNumber;
      payload.bank_code = request.bankCode;
    } else {
      payload.phone_number = request.phoneNumber;
      payload.phone_network = request.phoneNetwork;
    }

    logger.info('Initiating LocalRamp sell', {
      txExtReference: request.txExtReference,
      fromCurrency: request.fromCurrency,
      toCurrency: request.toCurrency,
      countryCode: request.countryCode,
    });

    const response = await client.post('/v1/transaction/sell/initiate', payload);
    const result: SellResponse = response.data?.data || response.data;

    logger.info('LocalRamp sell initiated', {
      reference: result.reference,
      fromAmount: result.from_amount,
      toAmount: result.to_amount,
      rate: result.exchange_rate,
    });

    return result;
  } catch (error) {
    logger.error('Failed to initiate LocalRamp sell', {
      error: error instanceof Error ? error.message : String(error),
      txExtReference: request.txExtReference,
    });
    throw error;
  }
}

/**
 * Get status of a sell transaction by reference.
 */
export async function getSellStatus(reference: string): Promise<SellStatus> {
  try {
    const client = getLocalRampClient();
    const response = await client.get(`/v1/transaction/sell/status/${reference}`);
    const status: SellStatus = response.data?.data || response.data;

    logger.debug('LocalRamp sell status', { reference, status: status.status });
    return status;
  } catch (error) {
    logger.error('Failed to get LocalRamp sell status', {
      reference,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Get status of a sell transaction by external reference.
 */
export async function getSellStatusByExtRef(extReference: string): Promise<SellStatus> {
  try {
    const client = getLocalRampClient();
    const response = await client.get(`/v1/transaction/sell/status/${extReference}/ext`);
    const status: SellStatus = response.data?.data || response.data;

    logger.debug('LocalRamp sell status (ext ref)', { extReference, status: status.status });
    return status;
  } catch (error) {
    logger.error('Failed to get LocalRamp sell status by ext ref', {
      extReference,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Verify a bank account before initiating sell.
 */
export async function verifyBankAccount(
  accountNumber: string,
  bankCode: string,
  countryCode: string
): Promise<{ account_name: string; account_number: string; bank_name: string }> {
  try {
    const client = getLocalRampClient();
    const response = await client.post('/v1/transaction/sell/verify-bank', {
      account_number: accountNumber,
      bank_code: bankCode,
      country_code: countryCode,
    });
    return response.data?.data || response.data;
  } catch (error) {
    logger.error('Failed to verify bank account', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
