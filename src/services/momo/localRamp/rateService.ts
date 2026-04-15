/**
 * LocalRamp Rate & Discovery Service
 *
 * Manages exchange rates, currencies, payment methods, and limits
 * with in-memory caching.
 */

import { getLocalRampPublicClient } from './apiClient';
import { logger } from '../../../utils/logger';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const RATE_CACHE_TTL = 30 * 1000; // 30 seconds

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<any>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.data;
  return null;
}

function setCache<T>(key: string, data: T, ttl: number): void {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ================================
// Types
// ================================

export interface LRCurrency {
  code: string;
  name: string;
  type: 'fiat' | 'crypto';
  max_decimal?: number;
}

export interface LRPaymentMethod {
  id: string;
  name: string;
  type: string; // 'instant_p2p', 'mobile_money_mtn', etc.
  country: string;
}

export interface LRQuote {
  exchange_rate: number;
  processor_fee: number;
  network_fee: number;
  sender_amount: number;
  receiver_amount: number;
  sender_currency: string;
  receiver_currency: string;
}

export interface LRLimits {
  min_amount: number;
  max_amount: number;
  sender_currency: string;
  receiver_currency: string;
}

// ================================
// Service
// ================================

/**
 * Get supported fiat (sender) and crypto (receiver) currencies for buy
 */
export async function getBuyCurrencies(): Promise<{ sender: LRCurrency[]; receiver: LRCurrency[] }> {
  const cacheKey = 'buy-currencies';
  const cached = getCached<{ sender: LRCurrency[]; receiver: LRCurrency[] }>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const response = await client.get('/v1/transaction/buy/currencies');
    const data = response.data?.data || response.data;
    setCache(cacheKey, data, CACHE_TTL);
    logger.info('Fetched LocalRamp buy currencies', { senderCount: data.sender?.length, receiverCount: data.receiver?.length });
    return data;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp buy currencies', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get supported crypto (from) and fiat (to) currencies for sell
 */
export async function getSellCurrencies(): Promise<{ sender: LRCurrency[]; receiver: LRCurrency[] }> {
  const cacheKey = 'sell-currencies';
  const cached = getCached<{ sender: LRCurrency[]; receiver: LRCurrency[] }>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const response = await client.get('/v1/transaction/sell/currencies');
    const data = response.data?.data || response.data;
    setCache(cacheKey, data, CACHE_TTL);
    logger.info('Fetched LocalRamp sell currencies', { senderCount: data.sender?.length, receiverCount: data.receiver?.length });
    return data;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp sell currencies', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get payment methods for a country/currency
 */
export async function getPaymentMethods(countryCode: string, currency?: string): Promise<LRPaymentMethod[]> {
  const cacheKey = `payment-methods:${countryCode}:${currency || 'all'}`;
  const cached = getCached<LRPaymentMethod[]>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const params: Record<string, string> = { country_code: countryCode };
    if (currency) params.sender_currency = currency;
    const response = await client.get('/v1/transaction/buy/payment-methods', { params });
    const methods: LRPaymentMethod[] = response.data?.data || response.data || [];
    setCache(cacheKey, methods, CACHE_TTL);
    logger.info('Fetched LocalRamp payment methods', { country: countryCode, count: methods.length });
    return methods;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp payment methods', { country: countryCode, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get buy quote (on-ramp rate)
 */
export async function getBuyQuote(
  senderCurrency: string,
  receiverCurrency: string,
  senderAmount: number
): Promise<LRQuote> {
  const cacheKey = `buy-quote:${senderCurrency}:${receiverCurrency}:${senderAmount}`;
  const cached = getCached<LRQuote>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const response = await client.get('/v1/transaction/buy/quote', {
      params: { sender_currency: senderCurrency, receiver_currency: receiverCurrency, sender_amount: senderAmount },
    });
    const quote: LRQuote = response.data?.data || response.data;
    setCache(cacheKey, quote, RATE_CACHE_TTL);
    logger.info('Fetched LocalRamp buy quote', { senderCurrency, receiverCurrency, rate: quote.exchange_rate });
    return quote;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp buy quote', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get sell rate (off-ramp rate)
 */
export async function getSellRate(
  fromCurrency: string,
  toCurrency: string,
  fromAmount?: number
): Promise<LRQuote> {
  const cacheKey = `sell-rate:${fromCurrency}:${toCurrency}:${fromAmount || 0}`;
  const cached = getCached<LRQuote>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const params: Record<string, string | number> = { from_currency: fromCurrency, to_currency: toCurrency };
    if (fromAmount) params.from_amount = fromAmount;
    const response = await client.get('/v1/transaction/sell/rate', { params });
    const rate: LRQuote = response.data?.data || response.data;
    setCache(cacheKey, rate, RATE_CACHE_TTL);
    logger.info('Fetched LocalRamp sell rate', { fromCurrency, toCurrency, rate: rate.exchange_rate });
    return rate;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp sell rate', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get buy limits
 */
export async function getBuyLimits(senderCurrency: string, receiverCurrency: string): Promise<LRLimits> {
  const cacheKey = `buy-limits:${senderCurrency}:${receiverCurrency}`;
  const cached = getCached<LRLimits>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const response = await client.get('/v1/transaction/buy/limits', {
      params: { sender_currency: senderCurrency, receiver_currency: receiverCurrency },
    });
    const limits: LRLimits = response.data?.data || response.data;
    setCache(cacheKey, limits, CACHE_TTL);
    return limits;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp buy limits', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get sell limits
 */
export async function getSellLimits(fromCurrency: string, toCurrency: string): Promise<LRLimits> {
  const cacheKey = `sell-limits:${fromCurrency}:${toCurrency}`;
  const cached = getCached<LRLimits>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const response = await client.get('/v1/transaction/sell/limits', {
      params: { from_currency: fromCurrency, to_currency: toCurrency },
    });
    const limits: LRLimits = response.data?.data || response.data;
    setCache(cacheKey, limits, CACHE_TTL);
    return limits;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp sell limits', { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Get supported banks for sell (off-ramp) in a country
 */
export async function getSupportedBanks(countryCode: string): Promise<any[]> {
  const cacheKey = `banks:${countryCode}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  try {
    const client = getLocalRampPublicClient();
    const response = await client.get('/v1/transaction/sell/supported-banks', {
      params: { country_code: countryCode },
    });
    const banks = response.data?.data || response.data || [];
    setCache(cacheKey, banks, CACHE_TTL);
    logger.info('Fetched LocalRamp supported banks', { country: countryCode, count: banks.length });
    return banks;
  } catch (error) {
    logger.error('Failed to fetch LocalRamp supported banks', { country: countryCode, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Clear all caches
 */
export function clearCaches(): void {
  cache.clear();
  logger.info('LocalRamp caches cleared');
}
