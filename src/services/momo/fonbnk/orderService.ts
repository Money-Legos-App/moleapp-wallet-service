import { createFonbnkClient } from './apiClient';

export interface FonbnkTransferInstructions {
  type: 'manual' | 'stk_push' | 'otp_stk_push' | 'redirect';
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  reference?: string;
  redirectUrl?: string;
  phoneNumber?: string;
  instructions?: string;
}

export interface FonbnkOrder {
  id: string;
  status: string;
  deposit: {
    amount: number;
    currency: string;
    amountUsd: number;
    cashoutAmountBeforeFees: number;
    cashoutAmountAfterFees: number;
  };
  payout: {
    amount: number;
    currency: string;
    amountUsd: number;
    cashoutAmountBeforeFees: number;
    cashoutAmountAfterFees: number;
  };
  chargedFees: {
    name: string;
    amount: number;
    currency: string;
    amountUsd: number;
  }[];
  transferInstructions: FonbnkTransferInstructions;
  exchangeRate: number;
  transactionHash?: string;
  userKyc: {
    status: string;
    tier: string;
  };
  createdAt: string;
}

export interface FonbnkOrderSide {
  paymentChannel: string;
  currencyType: string;
  currencyCode: string;
  countryIsoCode?: string;
  carrierCode?: string;
  amount?: number;
}

/**
 * Create a Fonbnk order.
 *
 * Fonbnk's /api/v2/order requires the deposit/payout metadata (paymentChannel,
 * currencyType, currencyCode, etc.) at the top level — mirroring the quote —
 * plus a flat `fieldsToCreateOrder` containing user inputs (phoneNumber,
 * carrierCode values, blockchainWalletAddress, fullName). `carrierCode` lives
 * on the `deposit` object for fiat-in flows.
 */
export async function createOrder(params: {
  quoteId: string;
  userEmail: string;
  userIp: string;
  userCountryIsoCode: string;
  deposit: FonbnkOrderSide;
  payout: FonbnkOrderSide;
  fieldsToCreateOrder: Record<string, unknown>;
  webhookUrl?: string;
}): Promise<FonbnkOrder> {
  const client = createFonbnkClient();
  const res = await client.post('/api/v2/order', params);
  return res.data;
}

export async function confirmOrder(orderId: string): Promise<FonbnkOrder> {
  const client = createFonbnkClient();
  const res = await client.post('/api/v2/order/confirm', { orderId });
  return res.data;
}

export async function submitIntermediateAction(params: {
  orderId: string;
  otp?: string;
  action?: string;
}): Promise<FonbnkOrder> {
  const client = createFonbnkClient();
  const res = await client.post('/api/v2/order/intermediate-action', params);
  return res.data;
}

export async function getOrderStatus(orderId: string): Promise<FonbnkOrder> {
  const client = createFonbnkClient();
  const res = await client.get(`/api/v2/order/${orderId}`);
  return res.data;
}
