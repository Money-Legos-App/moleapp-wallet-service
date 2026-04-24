import { verifyWebhookSignature } from './apiClient';
import { PaymentStatus } from '../types';

export interface FonbnkWebhookPayload {
  event: string;
  data: {
    id: string;
    status: string;
    deposit: {
      amount: number;
      currency: string;
      amountUsd: number;
    };
    payout: {
      amount: number;
      currency: string;
      amountUsd: number;
    };
    transactionHash?: string;
    userKyc?: {
      status: string;
      tier: string;
    };
  };
}

const STATUS_MAP: Record<string, PaymentStatus> = {
  deposit_awaiting: 'PENDING' as PaymentStatus,
  deposit_validating: 'PROCESSING' as PaymentStatus,
  deposit_successful: 'PROCESSING' as PaymentStatus,
  payout_pending: 'PROCESSING' as PaymentStatus,
  payout_successful: 'SUCCESS' as PaymentStatus,
  payout_failed: 'FAILED' as PaymentStatus,
  refund_pending: 'PROCESSING' as PaymentStatus,
  refund_successful: 'FAILED' as PaymentStatus,
};

export function validateFonbnkWebhook(
  rawBody: string,
  signature: string | undefined,
): { valid: boolean; error?: string } {
  if (!signature) {
    return { valid: false, error: 'Missing x-signature header' };
  }

  if (!verifyWebhookSignature(rawBody, signature)) {
    return { valid: false, error: 'Invalid webhook signature' };
  }

  return { valid: true };
}

export function processFonbnkWebhook(payload: FonbnkWebhookPayload): {
  orderId: string;
  status: PaymentStatus;
  fonbnkStatus: string;
  amount: number;
  currency: string;
  transactionHash?: string;
} {
  const data = payload.data;
  const fonbnkStatus = data.status;
  const mappedStatus = STATUS_MAP[fonbnkStatus] || ('PENDING' as PaymentStatus);

  return {
    orderId: data.id,
    status: mappedStatus,
    fonbnkStatus,
    amount: data.payout?.amount || data.deposit?.amount || 0,
    currency: data.payout?.currency || data.deposit?.currency || '',
    transactionHash: data.transactionHash,
  };
}

export function isFonbnkTerminalStatus(status: string): boolean {
  return ['payout_successful', 'payout_failed', 'refund_successful'].includes(status);
}
