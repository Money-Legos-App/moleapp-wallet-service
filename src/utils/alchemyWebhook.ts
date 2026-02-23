import crypto from 'crypto';

/**
 * Validates the Alchemy webhook signature (HMAC-SHA256)
 */
export function validateAlchemySignature(
  rawBody: string,
  signature: string,
  signingKey: string
): boolean {
  if (!signature || !signingKey) return false;

  const hmac = crypto.createHmac('sha256', signingKey);
  hmac.update(rawBody, 'utf8');
  const digest = hmac.digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf-8'),
      Buffer.from(digest, 'utf-8')
    );
  } catch {
    return false;
  }
}

/**
 * Alchemy Address Activity Webhook payload
 * https://docs.alchemy.com/reference/address-activity-webhook
 */
export interface AlchemyWebhookPayload {
  webhookId: string;
  id: string;
  createdAt: string;
  type: 'ADDRESS_ACTIVITY';
  event: {
    network: string;
    activity: AlchemyActivity[];
  };
}

export interface AlchemyActivity {
  fromAddress: string;
  toAddress: string;
  blockNum: string; // hex
  hash: string;
  value: number;
  asset: string; // "ETH" or token symbol
  category: 'external' | 'internal' | 'erc20' | 'erc721' | 'erc1155';
  rawContract: {
    rawValue: string;
    address?: string; // token contract address (null for native ETH)
    decimals?: number;
  };
  log?: any;
}
