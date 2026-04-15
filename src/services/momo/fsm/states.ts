/**
 * FSM State Definitions for Orange Money Transactions
 *
 * This module defines all possible states and valid transitions for
 * on-ramp (buy crypto) and off-ramp (sell crypto) transactions.
 *
 * Each state transition requires cryptographic verification before proceeding.
 */

// ================================
// ON-RAMP STATES (Mobile Money → Crypto)
// ================================

export const ON_RAMP_STATES = {
  // Initial state when transaction is created
  CREATED: 'CREATED',
  // Orange Money payment initiated, waiting for user action
  FIAT_PENDING: 'FIAT_PENDING',
  // USSD push sent, waiting for user PIN confirmation
  FIAT_PROCESSING: 'FIAT_PROCESSING',
  // Fiat payment confirmed via webhook or polling
  FIAT_RECEIVED: 'FIAT_RECEIVED',
  // Crypto transfer to user wallet in progress
  CRYPTO_MINTING: 'CRYPTO_MINTING',
  // Transaction completed successfully
  COMPLETED: 'COMPLETED',
  // Transaction failed at some stage
  FAILED: 'FAILED',
  // USSD push timeout (user didn't confirm in 120s)
  EXPIRED: 'EXPIRED',
  // User or system cancelled the transaction
  CANCELLED: 'CANCELLED',
  // Requires manual review by operations team
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;

export type OnRampState = typeof ON_RAMP_STATES[keyof typeof ON_RAMP_STATES];

// ================================
// OFF-RAMP STATES (Crypto → Mobile Money)
// ================================

export const OFF_RAMP_STATES = {
  // Initial state when transaction is created
  CREATED: 'CREATED',
  // Crypto locked in treasury, waiting for confirmations
  CRYPTO_LOCKED: 'CRYPTO_LOCKED',
  // Required block confirmations received
  CRYPTO_CONFIRMED: 'CRYPTO_CONFIRMED',
  // Orange Money payout request sent
  PAYOUT_PENDING: 'PAYOUT_PENDING',
  // Orange Money payout confirmed successful
  PAYOUT_SUCCESS: 'PAYOUT_SUCCESS',
  // Transaction completed successfully
  COMPLETED: 'COMPLETED',
  // Transaction failed at some stage
  FAILED: 'FAILED',
  // Refund in progress (payout failed)
  REFUNDING: 'REFUNDING',
  // Crypto refunded to user after payout failure
  REFUNDED: 'REFUNDED',
  // User or system cancelled the transaction
  CANCELLED: 'CANCELLED',
  // Requires manual review by operations team
  MANUAL_REVIEW: 'MANUAL_REVIEW',
} as const;

export type OffRampState = typeof OFF_RAMP_STATES[keyof typeof OFF_RAMP_STATES];

// ================================
// VALID STATE TRANSITIONS
// ================================

/**
 * ON-RAMP TRANSITION MAP
 *
 * OTP Payment Flow (synchronous):
 * CREATED → FIAT_RECEIVED → CRYPTO_MINTING → COMPLETED
 *     ↓           ↓                ↓
 *   FAILED     FAILED           FAILED
 *
 * Web Redirect Flow (async, kept for compatibility):
 * CREATED → FIAT_PENDING → FIAT_PROCESSING → FIAT_RECEIVED → CRYPTO_MINTING → COMPLETED
 *              ↓               ↓                                    ↓
 *          CANCELLED       EXPIRED                               FAILED
 */
export const ON_RAMP_TRANSITIONS: Record<OnRampState, OnRampState[]> = {
  [ON_RAMP_STATES.CREATED]: [
    ON_RAMP_STATES.FIAT_PENDING,    // Web redirect flow
    ON_RAMP_STATES.FIAT_RECEIVED,   // OTP payment flow (direct)
    ON_RAMP_STATES.CANCELLED,
    ON_RAMP_STATES.FAILED,
  ],
  [ON_RAMP_STATES.FIAT_PENDING]: [
    ON_RAMP_STATES.FIAT_PROCESSING,
    ON_RAMP_STATES.EXPIRED,
    ON_RAMP_STATES.CANCELLED,
    ON_RAMP_STATES.FAILED,
    ON_RAMP_STATES.MANUAL_REVIEW,
  ],
  [ON_RAMP_STATES.FIAT_PROCESSING]: [
    ON_RAMP_STATES.FIAT_RECEIVED,
    ON_RAMP_STATES.EXPIRED,
    ON_RAMP_STATES.CANCELLED,
    ON_RAMP_STATES.FAILED,
    ON_RAMP_STATES.MANUAL_REVIEW,
  ],
  [ON_RAMP_STATES.FIAT_RECEIVED]: [
    ON_RAMP_STATES.CRYPTO_MINTING,
    ON_RAMP_STATES.FAILED,
    ON_RAMP_STATES.MANUAL_REVIEW,
  ],
  [ON_RAMP_STATES.CRYPTO_MINTING]: [
    ON_RAMP_STATES.COMPLETED,
    ON_RAMP_STATES.FAILED,
    ON_RAMP_STATES.MANUAL_REVIEW,
  ],
  // MANUAL_REVIEW can be resolved to COMPLETED or FAILED
  [ON_RAMP_STATES.MANUAL_REVIEW]: [
    ON_RAMP_STATES.COMPLETED,
    ON_RAMP_STATES.FAILED,
    ON_RAMP_STATES.CANCELLED,
  ],
  // Terminal states - no further transitions allowed
  [ON_RAMP_STATES.COMPLETED]: [],
  [ON_RAMP_STATES.FAILED]: [],
  [ON_RAMP_STATES.EXPIRED]: [],
  [ON_RAMP_STATES.CANCELLED]: [],
};

/**
 * OFF-RAMP TRANSITION MAP
 *
 * CREATED → CRYPTO_LOCKED → CRYPTO_CONFIRMED → PAYOUT_PENDING → PAYOUT_SUCCESS → COMPLETED
 *               ↓                 ↓                   ↓
 *            FAILED           FAILED              REFUNDING → REFUNDED
 */
export const OFF_RAMP_TRANSITIONS: Record<OffRampState, OffRampState[]> = {
  [OFF_RAMP_STATES.CREATED]: [
    OFF_RAMP_STATES.CRYPTO_LOCKED,
    OFF_RAMP_STATES.FAILED,
    OFF_RAMP_STATES.CANCELLED,
  ],
  [OFF_RAMP_STATES.CRYPTO_LOCKED]: [
    OFF_RAMP_STATES.CRYPTO_CONFIRMED,
    OFF_RAMP_STATES.FAILED,
    OFF_RAMP_STATES.MANUAL_REVIEW,
  ],
  [OFF_RAMP_STATES.CRYPTO_CONFIRMED]: [
    OFF_RAMP_STATES.PAYOUT_PENDING,
    OFF_RAMP_STATES.FAILED,
    OFF_RAMP_STATES.REFUNDING,
    OFF_RAMP_STATES.MANUAL_REVIEW,
  ],
  [OFF_RAMP_STATES.PAYOUT_PENDING]: [
    OFF_RAMP_STATES.PAYOUT_SUCCESS,
    OFF_RAMP_STATES.REFUNDING,
    OFF_RAMP_STATES.FAILED,
    OFF_RAMP_STATES.MANUAL_REVIEW,
  ],
  [OFF_RAMP_STATES.PAYOUT_SUCCESS]: [
    OFF_RAMP_STATES.COMPLETED,
  ],
  [OFF_RAMP_STATES.REFUNDING]: [
    OFF_RAMP_STATES.REFUNDED,
    OFF_RAMP_STATES.FAILED,
    OFF_RAMP_STATES.MANUAL_REVIEW,
  ],
  // MANUAL_REVIEW can be resolved to COMPLETED, REFUNDING, or FAILED
  [OFF_RAMP_STATES.MANUAL_REVIEW]: [
    OFF_RAMP_STATES.COMPLETED,
    OFF_RAMP_STATES.REFUNDING,
    OFF_RAMP_STATES.FAILED,
  ],
  // Terminal states - no further transitions allowed
  [OFF_RAMP_STATES.COMPLETED]: [],
  [OFF_RAMP_STATES.FAILED]: [],
  [OFF_RAMP_STATES.REFUNDED]: [],
  [OFF_RAMP_STATES.CANCELLED]: [],
};

// ================================
// STATE VERIFICATION REQUIREMENTS
// ================================

/**
 * Defines what cryptographic/business verification is required
 * for each state transition.
 */
export interface StateVerification {
  /** Description of what needs to be verified */
  description: string;
  /** Required fields in verificationData */
  requiredFields: string[];
}

export const ON_RAMP_VERIFICATIONS: Partial<Record<OnRampState, StateVerification>> = {
  [ON_RAMP_STATES.FIAT_PENDING]: {
    description: 'Valid pay_token returned from Orange Money API (web redirect flow)',
    requiredFields: ['payToken', 'paymentUrl'],
  },
  [ON_RAMP_STATES.FIAT_PROCESSING]: {
    description: 'Web redirect in progress (web redirect flow)',
    requiredFields: ['payToken'],
  },
  [ON_RAMP_STATES.FIAT_RECEIVED]: {
    description: 'OTP Payment completed OR Webhook HMAC verified',
    requiredFields: ['providerTxId'],
  },
  [ON_RAMP_STATES.CRYPTO_MINTING]: {
    description: 'Treasury has sufficient balance for transfer',
    requiredFields: ['treasuryBalanceChecked'],
  },
  [ON_RAMP_STATES.COMPLETED]: {
    description: 'Blockchain transaction confirmed',
    requiredFields: ['blockchainTxHash', 'blockNumber'],
  },
};

export const OFF_RAMP_VERIFICATIONS: Partial<Record<OffRampState, StateVerification>> = {
  [OFF_RAMP_STATES.CRYPTO_LOCKED]: {
    description: 'User signed UserOperation to send crypto to treasury',
    requiredFields: ['userOpHash', 'blockchainTxHash'],
  },
  [OFF_RAMP_STATES.CRYPTO_CONFIRMED]: {
    description: 'Required block confirmations (2-3) received',
    requiredFields: ['confirmations', 'blockNumber'],
  },
  [OFF_RAMP_STATES.PAYOUT_PENDING]: {
    description: 'Orange Money payout request accepted',
    requiredFields: ['payoutRequestId'],
  },
  [OFF_RAMP_STATES.PAYOUT_SUCCESS]: {
    description: 'Orange Money confirms disbursement complete',
    requiredFields: ['providerTxId', 'payoutConfirmedAt'],
  },
  [OFF_RAMP_STATES.REFUNDING]: {
    description: 'Refund initiated due to payout failure',
    requiredFields: ['refundReason'],
  },
  [OFF_RAMP_STATES.REFUNDED]: {
    description: 'Crypto successfully refunded to user',
    requiredFields: ['refundTxHash', 'refundedAt'],
  },
};

// ================================
// HELPER FUNCTIONS
// ================================

/**
 * Check if a state is terminal (no further transitions allowed)
 */
export function isTerminalState(state: string, transactionType: 'ON_RAMP' | 'OFF_RAMP'): boolean {
  const transitions = transactionType === 'ON_RAMP'
    ? ON_RAMP_TRANSITIONS
    : OFF_RAMP_TRANSITIONS;

  const allowedTransitions = transitions[state as keyof typeof transitions];
  return !allowedTransitions || allowedTransitions.length === 0;
}

/**
 * Check if a transition from one state to another is valid
 */
export function isValidTransition(
  fromState: string,
  toState: string,
  transactionType: 'ON_RAMP' | 'OFF_RAMP'
): boolean {
  const transitions = transactionType === 'ON_RAMP'
    ? ON_RAMP_TRANSITIONS
    : OFF_RAMP_TRANSITIONS;

  const allowedTransitions = transitions[fromState as keyof typeof transitions];
  return allowedTransitions?.includes(toState as any) ?? false;
}

/**
 * Get verification requirements for a state transition
 */
export function getVerificationRequirements(
  targetState: string,
  transactionType: 'ON_RAMP' | 'OFF_RAMP'
): StateVerification | undefined {
  const verifications = transactionType === 'ON_RAMP'
    ? ON_RAMP_VERIFICATIONS
    : OFF_RAMP_VERIFICATIONS;

  return verifications[targetState as keyof typeof verifications];
}

/**
 * Check if a state indicates success
 */
export function isSuccessState(state: string): boolean {
  return state === ON_RAMP_STATES.COMPLETED ||
         state === OFF_RAMP_STATES.COMPLETED ||
         state === OFF_RAMP_STATES.REFUNDED;
}

/**
 * Check if a state indicates failure
 */
export function isFailureState(state: string): boolean {
  return state === ON_RAMP_STATES.FAILED ||
         state === ON_RAMP_STATES.EXPIRED ||
         state === ON_RAMP_STATES.CANCELLED ||
         state === OFF_RAMP_STATES.FAILED;
}
