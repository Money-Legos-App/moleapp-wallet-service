/**
 * Payment Provider Types
 *
 * Standard types for the multi-provider adapter pattern.
 * These types ensure zero dependency on specific providers in core business logic.
 */

// ================================
// PROVIDER IDENTIFIERS
// ================================

/**
 * Supported payment providers
 * Format: PROVIDER_COUNTRY (e.g., ORANGE_SN for Orange Money Senegal)
 */
export enum PaymentProviderCode {
  ORANGE_SN = 'ORANGE_SN',
  ORANGE_CI = 'ORANGE_CI',
  ORANGE_ML = 'ORANGE_ML',
  WAVE_SN = 'WAVE_SN',
  WAVE_CI = 'WAVE_CI',
  MTN_CI = 'MTN_CI',
  MTN_GH = 'MTN_GH',
  // LocalRamp aggregator (one per country)
  LR_NG = 'LR_NG',
  LR_GH = 'LR_GH',
  LR_KE = 'LR_KE',
  LR_SN = 'LR_SN',
  LR_CI = 'LR_CI',
  LR_CM = 'LR_CM',
  LR_RW = 'LR_RW',
  LR_UG = 'LR_UG',
  LR_ZM = 'LR_ZM',
}

/**
 * Provider family (for grouping)
 */
export enum ProviderFamily {
  ORANGE = 'ORANGE',
  WAVE = 'WAVE',
  MTN = 'MTN',
  LOCALRAMP = 'LOCALRAMP',
}

// ================================
// STANDARDIZED REQUEST TYPES
// ================================

/**
 * Standard collect payment request (Cash-In / On-Ramp)
 * Provider adapters translate this to their specific format
 */
export interface CollectPaymentRequest {
  /** Internal transaction ID */
  transactionId: string;
  /** Amount in local currency (XOF, GHS, etc.) */
  amount: number;
  /** Currency code (XOF, GHS, NGN) */
  currency: string;
  /** User's phone number in E.164 format (e.g., 221771234567) */
  phoneNumber: string;
  /** Callback URL for payment notifications */
  callbackUrl: string;
  /** Optional description shown to user */
  description?: string;
  /** Optional metadata */
  metadata?: Record<string, any>;
}

/**
 * Standard disburse payment request (Cash-Out / Off-Ramp)
 * Provider adapters translate this to their specific format
 */
export interface DisbursePaymentRequest {
  /** Internal transaction ID */
  transactionId: string;
  /** Amount in local currency */
  amount: number;
  /** Currency code */
  currency: string;
  /** Recipient's phone number in E.164 format */
  phoneNumber: string;
  /** Description for the payment */
  description?: string;
  /** Optional metadata */
  metadata?: Record<string, any>;
}

/**
 * Standard status check request
 */
export interface StatusCheckRequest {
  /** Internal transaction ID */
  transactionId: string;
  /** Provider's transaction reference (if available) */
  providerReference?: string;
  /** Provider's transaction ID (alias for providerReference) */
  providerTxId?: string;
  /** Provider reference (alias for providerReference) */
  providerRef?: string;
}

// ================================
// STANDARDIZED RESPONSE TYPES
// ================================

/**
 * Standard payment status values
 * All providers map to these values
 */
export enum PaymentStatus {
  /** Payment initiated, waiting for user action */
  PENDING = 'PENDING',
  /** User is completing the payment (USSD push sent) */
  PROCESSING = 'PROCESSING',
  /** Payment completed successfully */
  SUCCESS = 'SUCCESS',
  /** Payment failed */
  FAILED = 'FAILED',
  /** Payment cancelled by user or system */
  CANCELLED = 'CANCELLED',
  /** Payment expired (timeout) */
  EXPIRED = 'EXPIRED',
  /** Status unknown - needs manual review */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Standard collect payment response
 */
export interface CollectPaymentResponse {
  /** Whether the initiation was successful */
  success: boolean;
  /** Payment status */
  status: PaymentStatus;
  /** Provider's transaction ID */
  providerReference?: string;
  /** Payment URL (for redirect-based flows) */
  paymentUrl?: string;
  /** Pay token (for USSD push flows) */
  payToken?: string;
  /** USSD code to dial (if applicable) */
  ussdCode?: string;
  /** When the payment request expires */
  expiresAt?: Date;
  /** Error message if failed */
  error?: string;
  /** Error code from provider */
  errorCode?: string;
  /** Raw provider response (for debugging) */
  rawResponse?: any;
}

/**
 * Standard disburse payment response
 */
export interface DisbursePaymentResponse {
  /** Whether the disbursement was initiated successfully */
  success: boolean;
  /** Payment status */
  status: PaymentStatus;
  /** Provider's transaction ID */
  providerReference?: string;
  /** Provider's transaction ID (alias for providerReference) */
  providerTxId?: string;
  /** Provider reference (alias for providerReference) */
  providerRef?: string;
  /** Error message if failed */
  error?: string;
  /** Error message (alias for error) */
  errorMessage?: string;
  /** Error code from provider */
  errorCode?: string;
  /** Raw provider response (for debugging) */
  rawResponse?: any;
}

/**
 * Standard status check response
 */
export interface StatusCheckResponse {
  /** Whether the check was successful */
  success: boolean;
  /** Current payment status */
  status: PaymentStatus;
  /** Provider's transaction ID */
  providerReference?: string;
  /** Provider's transaction ID (alias for providerReference) */
  providerTxId?: string;
  /** Amount confirmed by provider */
  confirmedAmount?: number;
  /** Currency confirmed by provider */
  confirmedCurrency?: string;
  /** When the transaction was completed */
  completedAt?: Date;
  /** Error message if status check failed */
  error?: string;
  /** Failure reason (alias for error) */
  failureReason?: string;
  /** Raw provider response (for debugging) */
  rawResponse?: any;
}

// ================================
// WEBHOOK TYPES
// ================================

/**
 * Standardized webhook event
 * All provider webhooks are normalized to this format
 */
export interface StandardizedWebhookEvent {
  /** Internal transaction ID (mapped from provider's reference) */
  transactionId: string;
  /** Standardized status */
  status: PaymentStatus;
  /** Provider that sent the webhook */
  provider: PaymentProviderCode;
  /** Provider code (alias for provider) */
  providerCode?: PaymentProviderCode;
  /** Provider's transaction reference */
  providerReference: string;
  /** Provider's transaction ID (alias for providerReference) */
  providerTxId?: string;
  /** Amount from webhook */
  amount?: number;
  /** Currency from webhook */
  currency?: string;
  /** When the event occurred */
  timestamp: Date;
  /** Raw webhook payload (for audit) */
  rawPayload: any;
  /** Raw data (alias for rawPayload) */
  rawData?: any;
  /** Whether HMAC/signature was verified */
  signatureVerified: boolean;
  /** Failure reason if payment failed */
  failureReason?: string;
}

/**
 * Webhook validation result
 */
export interface WebhookValidationResult {
  /** Whether the webhook is valid */
  isValid: boolean;
  /** Standardized event if valid */
  event?: StandardizedWebhookEvent;
  /** Error message if invalid */
  error?: string;
}

// ================================
// PROVIDER CONFIGURATION
// ================================

/**
 * Provider configuration stored in database
 */
export interface ProviderConfig {
  /** Provider code */
  code: PaymentProviderCode;
  /** Display name */
  displayName: string;
  /** Country code (SN, CI, GH, etc.) */
  country: string;
  /** Whether provider is active */
  isActive: boolean;
  /** API configuration */
  apiConfig: {
    baseUrl: string;
    authUrl?: string;
    webhookSecret?: string;
    merchantKey?: string;
    clientId?: string;
    clientSecret?: string;
    [key: string]: any;
  };
  /** Fee configuration */
  fees: {
    collectFeePercent: number;
    disburseFeePercent: number;
    fixedFee: number;
  };
  /** Transaction limits */
  limits: {
    minAmount: number;
    maxAmount: number;
    dailyLimit: number;
    monthlyLimit: number;
  };
  /** Supported currencies */
  supportedCurrencies: string[];
}

// ================================
// TRANSACTION LIFECYCLE
// ================================

/**
 * Transaction lifecycle stages
 * Provider-agnostic stages that track the overall flow
 */
export enum TransactionLifecycleStage {
  /** Transaction created, not yet submitted to provider */
  CREATED = 'CREATED',
  /** Submitted to provider, awaiting user action */
  PROVIDER_PENDING = 'PROVIDER_PENDING',
  /** Fiat confirmed by provider */
  FIAT_CONFIRMED = 'FIAT_CONFIRMED',
  /** Crypto operation queued */
  CRYPTO_QUEUED = 'CRYPTO_QUEUED',
  /** Crypto operation in progress */
  CRYPTO_PROCESSING = 'CRYPTO_PROCESSING',
  /** Fully completed */
  COMPLETED = 'COMPLETED',
  /** Failed at any stage */
  FAILED = 'FAILED',
  /** Refund in progress */
  REFUNDING = 'REFUNDING',
  /** Refund completed */
  REFUNDED = 'REFUNDED',
  /** Requires manual review */
  MANUAL_REVIEW = 'MANUAL_REVIEW',
  /** Cancelled */
  CANCELLED = 'CANCELLED',
}

/**
 * Transaction type
 */
export enum TransactionType {
  /** Fiat to Crypto (On-Ramp / Cash-In) */
  CASH_IN = 'CASH_IN',
  /** Crypto to Fiat (Off-Ramp / Cash-Out) */
  CASH_OUT = 'CASH_OUT',
}

/**
 * Payment method type
 */
export enum PaymentMethod {
  /** Traditional USSD push - Orange sends prompt to user's phone */
  USSD_PUSH = 'USSD_PUSH',
  /** OTP Payment - User generates OTP via #144# and provides to merchant */
  OTP_PAYMENT = 'OTP_PAYMENT',
  /** Web redirect - User redirected to Orange Money web portal */
  WEB_REDIRECT = 'WEB_REDIRECT',
  /** Mobile money via LocalRamp aggregator */
  MOBILE_MONEY = 'MOBILE_MONEY',
  /** Bank transfer via LocalRamp aggregator */
  BANK_TRANSFER = 'BANK_TRANSFER',
}

// ================================
// OTP PAYMENT TYPES
// ================================

/**
 * OTP Payment Request - One-step payment with customer-provided OTP
 *
 * Flow:
 * 1. Customer generates OTP via #144# or Orange Money app
 * 2. Customer provides phone number, OTP, and PIN to merchant
 * 3. Merchant encrypts PIN with Orange's RSA public key
 * 4. Single API call completes the payment immediately
 */
export interface OTPPaymentRequest {
  /** Internal transaction ID */
  transactionId: string;
  /** Amount in local currency (XOF) */
  amount: number;
  /** Currency code (XOF) */
  currency: string;
  /** Customer's phone number (MSISDN) in E.164 format */
  phoneNumber: string;
  /** OTP code generated by customer via #144#391# (6 digits, valid 15 min) */
  otpCode: string;
  /** RSA-encrypted PIN (optional - OTP alone can authorize the transaction) */
  encryptedPin?: string;
  /** Merchant code for identification */
  merchantCode?: string;
  /** Optional description for the transaction */
  description?: string;
  /** Optional metadata */
  metadata?: Record<string, any>;
}

/**
 * OTP Payment Response - Synchronous payment result
 *
 * Unlike USSD push which requires webhook for confirmation,
 * OTP payment returns the final result immediately.
 */
export interface OTPPaymentResponse {
  /** Whether payment completed successfully */
  success: boolean;
  /** Payment status (SUCCESS, FAILED, or rarely PENDING) */
  status: PaymentStatus;
  /** Provider's transaction ID */
  providerReference?: string;
  /** Orange Money transaction ID (txnid) */
  orangeTxnId?: string;
  /** Confirmed amount from Orange */
  confirmedAmount?: number;
  /** Confirmed currency */
  confirmedCurrency?: string;
  /** Timestamp of completion */
  completedAt?: Date;
  /** Error message if failed */
  error?: string;
  /** Error code from Orange Money API */
  errorCode?: string;
  /** Detailed error description */
  errorDescription?: string;
  /** Raw response from Orange API for debugging */
  rawResponse?: any;
}

/**
 * Public Key Response for PIN encryption
 *
 * Orange provides an RSA public key that must be used to encrypt
 * the customer's PIN before sending it in the OTP payment request.
 */
export interface PublicKeyResponse {
  /** RSA public key in PEM format */
  publicKey: string;
  /** Key ID for reference/versioning */
  keyId: string;
  /** Key expiration timestamp */
  expiresAt: Date;
  /** Algorithm used (RSA-OAEP) */
  algorithm: string;
  /** Key size in bits */
  keySize: number;
}

/**
 * Orange Money API OTP Payment Request format
 * This is the exact format Orange Money API expects
 */
export interface OrangeOTPPaymentAPIRequest {
  /** Merchant identification code */
  merchant_code: string;
  /** Customer phone number (MSISDN) */
  customer_msisdn: string;
  /** Payment amount (integer, no decimals for XOF) */
  amount: number;
  /** OTP code from customer */
  otp: string;
  /** RSA-encrypted PIN (optional - OTP alone can authorize) */
  pin?: string;
  /** Unique order/transaction ID */
  order_id: string;
  /** Optional payment description */
  description?: string;
  /** Optional external reference */
  external_id?: string;
}

/**
 * Orange Money API OTP Payment Response format
 * This is the exact format Orange Money API returns
 */
export interface OrangeOTPPaymentAPIResponse {
  /** Response status code */
  status: number;
  /** Status message */
  message: string;
  /** Transaction ID from Orange */
  txnid?: string;
  /** Order ID echoed back */
  order_id?: string;
  /** Transaction amount */
  amount?: number;
  /** Currency */
  currency?: string;
  /** Additional data */
  data?: {
    /** Customer balance after transaction */
    balance?: number;
    /** Transaction reference */
    reference?: string;
    /** Transaction timestamp */
    timestamp?: string;
  };
}

/**
 * Orange Money API Public Key Response format
 */
export interface OrangePublicKeyAPIResponse {
  /** Response status */
  status: number;
  /** Status message */
  message: string;
  /** Public key data */
  data: {
    /** RSA public key in PEM format */
    public_key: string;
    /** Key identifier */
    key_id: string;
    /** Expiration timestamp (ISO 8601) */
    expires_at: string;
  };
}

/**
 * Sandbox Test Number Generation Response
 */
export interface SandboxTestNumbersResponse {
  /** Test customer phone number */
  customerMsisdn: string;
  /** Test merchant code */
  merchantCode: string;
  /** Test PIN (for sandbox only) */
  pin: string;
  /** Initial balance */
  balance: number;
  /** Currency */
  currency: string;
}

/**
 * Sandbox OTP Generation Response
 */
export interface SandboxOTPResponse {
  /** Generated OTP code */
  otpCode: string;
  /** Phone number the OTP is for */
  msisdn: string;
  /** OTP expiration time */
  expiresAt: Date;
  /** OTP validity in seconds */
  validitySeconds: number;
}

/**
 * OTP Payment Error Codes from Orange Money
 */
export enum OTPPaymentErrorCode {
  /** Invalid or expired OTP */
  INVALID_OTP = 'INVALID_OTP',
  /** Incorrect PIN */
  INVALID_PIN = 'INVALID_PIN',
  /** Insufficient balance */
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  /** Account blocked or suspended */
  ACCOUNT_BLOCKED = 'ACCOUNT_BLOCKED',
  /** Daily limit exceeded */
  LIMIT_EXCEEDED = 'LIMIT_EXCEEDED',
  /** Invalid phone number */
  INVALID_MSISDN = 'INVALID_MSISDN',
  /** Invalid merchant */
  INVALID_MERCHANT = 'INVALID_MERCHANT',
  /** Amount out of range */
  INVALID_AMOUNT = 'INVALID_AMOUNT',
  /** System error */
  SYSTEM_ERROR = 'SYSTEM_ERROR',
  /** Timeout */
  TIMEOUT = 'TIMEOUT',
  /** Duplicate transaction */
  DUPLICATE_TRANSACTION = 'DUPLICATE_TRANSACTION',
}
