/**
 * LocalRamp Webhook Service
 *
 * Handles incoming webhook notifications from LocalRamp.
 * Verification: compare `localramp-webhook-token` header against our stored token.
 *
 * Events:
 *   buy.fiat_received  — user's fiat payment confirmed
 *   buy.crypto_sent    — crypto sent to destination (includes txid)
 *   sell.completed     — fiat payout completed
 *   sell.failed        — fiat payout failed
 *   sell.initiated     — sell transaction initiated
 *   swap.completed     — swap completed (not used in momo flow)
 */

import { logger } from '../../../utils/logger';
import { PaymentStatus } from '../types';
import { getLocalRampConfig } from './apiClient';

// ================================
// Types
// ================================

export interface LRWebhookPayload {
  event_type: string;
  reference: string;
  tx_ext_reference?: string;
  sent_amount?: number;
  sender_currency?: string;
  received_amount?: number;
  receiver_currency?: string;
  from_currency?: string;
  to_currency?: string;
  from_amount?: number;
  to_amount?: number;
  txid?: string;
  type?: string; // 'bank_account' or 'mobile_money'
}

export interface WebhookValidationResult {
  isValid: boolean;
  payload?: LRWebhookPayload;
  error?: string;
}

export interface WebhookProcessingResult {
  transactionId: string | null;
  status: PaymentStatus;
  eventType: string;
  amount: number;
  txid?: string;
}

// ================================
// Status Mapping
// ================================

const EVENT_TO_STATUS: Record<string, PaymentStatus> = {
  'buy.fiat_received': PaymentStatus.PROCESSING,
  'buy.crypto_sent': PaymentStatus.SUCCESS,
  'sell.completed': PaymentStatus.SUCCESS,
  'sell.failed': PaymentStatus.FAILED,
  'sell.initiated': PaymentStatus.PROCESSING,
  'swap.completed': PaymentStatus.SUCCESS,
};

export function mapEventToStatus(eventType: string): PaymentStatus {
  return EVENT_TO_STATUS[eventType] || PaymentStatus.UNKNOWN;
}

// ================================
// Webhook Validation
// ================================

/**
 * Validate incoming LocalRamp webhook by comparing the shared token.
 */
export function validateWebhook(
  rawBody: string | Buffer,
  headers: Record<string, string | string[] | undefined>
): WebhookValidationResult {
  const token = headers['localramp-webhook-token'] as string;

  if (!token) {
    return { isValid: false, error: 'Missing webhook token header' };
  }

  const config = getLocalRampConfig();
  if (config.webhookToken && token !== config.webhookToken) {
    return { isValid: false, error: 'Invalid webhook token' };
  }

  try {
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const payload: LRWebhookPayload = JSON.parse(bodyStr);
    return { isValid: true, payload };
  } catch {
    return { isValid: false, error: 'Invalid webhook payload JSON' };
  }
}

/**
 * Process validated webhook payload into a standardized result.
 */
export function processWebhookPayload(payload: LRWebhookPayload): WebhookProcessingResult {
  const status = mapEventToStatus(payload.event_type);

  // reference is our orderId for buy; tx_ext_reference for sell
  const transactionId = payload.tx_ext_reference || payload.reference || null;
  const amount = payload.received_amount || payload.to_amount || payload.sent_amount || payload.from_amount || 0;

  logger.info('Processing LocalRamp webhook', {
    eventType: payload.event_type,
    reference: payload.reference,
    txExtReference: payload.tx_ext_reference,
    mappedStatus: status,
    amount,
    txid: payload.txid,
  });

  return {
    transactionId,
    status,
    eventType: payload.event_type,
    amount,
    txid: payload.txid,
  };
}
