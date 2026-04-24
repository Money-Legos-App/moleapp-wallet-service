import { createFonbnkClient } from './apiClient';

export interface FonbnkQuote {
  quoteId: string;
  deposit: {
    amount: number;
    currencyCode: string;
    currencyType: string;
    amountUsd: number;
  };
  payout: {
    amount: number;
    currencyCode: string;
    currencyType: string;
    amountUsd: number;
  };
  feeSettings: {
    type: string;
    name: string;
    rate: number;
    amount: number;
  }[];
  exchangeRate: number;
  expiresAt: string;
  fieldsToCreateOrder: Record<string, unknown>;
}

export interface FonbnkCurrency {
  currencyType: string;
  currencyCode: string;
  paymentChannels: {
    name: string;
    type: string;
    transferTypes: string[];
    isDepositAllowed: boolean;
    isPayoutAllowed: boolean;
    carriers?: { code: string; name: string }[];
  }[];
  currencyDetails: { countryIsoCode?: string };
  pairs: string[];
}

export interface FonbnkOrderLimits {
  deposit: { min: number; max: number; minUsd: number; maxUsd: number; step: number; supportsDecimals: boolean };
  payout: { min: number; max: number; minUsd: number; maxUsd: number; step: number; supportsDecimals: boolean };
}

const CACHE_TTL = {
  currencies: 5 * 60 * 1000,
  limits: 60 * 1000,
};

let currenciesCache: { data: FonbnkCurrency[] | null; expiry: number } = { data: null, expiry: 0 };

export async function getCurrencies(): Promise<FonbnkCurrency[]> {
  if (currenciesCache.data && Date.now() < currenciesCache.expiry) {
    return currenciesCache.data;
  }

  const client = createFonbnkClient();
  const res = await client.get('/api/v2/currencies');
  currenciesCache = { data: res.data, expiry: Date.now() + CACHE_TTL.currencies };
  return res.data;
}

export async function getOrderLimits(params: {
  depositCurrencyType: string;
  depositCurrencyCode: string;
  depositPaymentChannel: string;
  payoutCurrencyType: string;
  payoutCurrencyCode: string;
  payoutPaymentChannel: string;
  countryIsoCode: string;
}): Promise<FonbnkOrderLimits> {
  const client = createFonbnkClient();
  const res = await client.get('/api/v2/order-limits', { params });
  return res.data;
}

export async function getQuote(params: {
  deposit: {
    currencyType: string;
    currencyCode: string;
    paymentChannel: string;
    amount?: number;
    countryIsoCode?: string;
  };
  payout: {
    currencyType: string;
    currencyCode: string;
    paymentChannel: string;
    amount?: number;
    countryIsoCode?: string;
  };
}): Promise<FonbnkQuote> {
  const client = createFonbnkClient();
  const res = await client.post('/api/v2/quote', params);
  return res.data;
}
