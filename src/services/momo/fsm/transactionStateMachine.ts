/**
 * Transaction State Machine
 *
 * Core FSM implementation that enforces state transitions with
 * cryptographic verification. No transition occurs unless the
 * previous step is verified.
 */

import { prisma, MomoTransaction, TransactionType } from '../../../lib/prisma';
import { logger } from '../../../utils/logger';
import {
  ON_RAMP_TRANSITIONS,
  OFF_RAMP_TRANSITIONS,
  ON_RAMP_VERIFICATIONS,
  OFF_RAMP_VERIFICATIONS,
  isValidTransition,
  isTerminalState,
  getVerificationRequirements,
  OnRampState,
  OffRampState,
} from './states';

// ================================
// TYPES
// ================================

export interface TransitionContext {
  /** What triggered this transition (e.g., 'WEBHOOK_SUCCESS', 'POLLING_SUCCESS') */
  trigger: string;
  /** Cryptographic proof or verification data */
  verificationData?: Record<string, any>;
  /** Error message if transitioning to FAILED state */
  errorMessage?: string;
  /** Additional metadata */
  metadata?: Record<string, any>;
}

export interface TransitionResult {
  success: boolean;
  previousState: string;
  currentState: string;
  transactionId: string;
  error?: string;
}

export type StateChangeHandler = (
  transactionId: string,
  fromState: string,
  toState: string,
  context: TransitionContext
) => Promise<void>;

// ================================
// TRANSACTION STATE MACHINE
// ================================

export class TransactionStateMachine {
  private transaction: MomoTransaction;
  private stateChangeHandlers: StateChangeHandler[] = [];

  constructor(transaction: MomoTransaction) {
    this.transaction = transaction;
  }

  /**
   * Get current state
   */
  getCurrentState(): string {
    return this.transaction.currentState;
  }

  /**
   * Get transaction type
   */
  getTransactionType(): TransactionType {
    return this.transaction.type;
  }

  /**
   * Check if current state is terminal
   */
  isInTerminalState(): boolean {
    return isTerminalState(
      this.transaction.currentState,
      this.transaction.type as 'ON_RAMP' | 'OFF_RAMP'
    );
  }

  /**
   * Register a handler to be called after state changes
   */
  onStateChange(handler: StateChangeHandler): void {
    this.stateChangeHandlers.push(handler);
  }

  /**
   * Attempt state transition with cryptographic verification
   *
   * @param targetState - The state to transition to
   * @param context - Transition context with trigger and verification data
   * @returns TransitionResult indicating success or failure
   */
  async transition(
    targetState: string,
    context: TransitionContext
  ): Promise<TransitionResult> {
    const currentState = this.transaction.currentState;
    const transactionType = this.transaction.type as 'ON_RAMP' | 'OFF_RAMP';

    logger.info('Attempting state transition', {
      transactionId: this.transaction.id,
      from: currentState,
      to: targetState,
      trigger: context.trigger,
    });

    // 1. Check if already in terminal state
    if (this.isInTerminalState()) {
      const error = `Transaction is in terminal state: ${currentState}`;
      logger.warn(error, { transactionId: this.transaction.id });
      return {
        success: false,
        previousState: currentState,
        currentState: currentState,
        transactionId: this.transaction.id,
        error,
      };
    }

    // 2. Validate transition is allowed
    if (!isValidTransition(currentState, targetState, transactionType)) {
      const error = `Invalid state transition: ${currentState} -> ${targetState}`;
      logger.error(error, {
        transactionId: this.transaction.id,
        transactionType,
      });
      return {
        success: false,
        previousState: currentState,
        currentState: currentState,
        transactionId: this.transaction.id,
        error,
      };
    }

    // 3. Verify cryptographic proof if required (skip for failure states)
    if (!this.isFailureTransition(targetState)) {
      const verificationResult = await this.verifyCryptographicProof(
        targetState,
        context.verificationData || {}
      );

      if (!verificationResult.valid) {
        const error = `Verification failed for ${targetState}: ${verificationResult.error}`;
        logger.error(error, {
          transactionId: this.transaction.id,
          requiredFields: verificationResult.missingFields,
        });
        return {
          success: false,
          previousState: currentState,
          currentState: currentState,
          transactionId: this.transaction.id,
          error,
        };
      }
    }

    // 4. Execute transition in database transaction
    try {
      await prisma.$transaction(async (tx) => {
        // Record state history
        await tx.transactionStateHistory.create({
          data: {
            transactionId: this.transaction.id,
            previousState: currentState,
            currentState: targetState,
            trigger: context.trigger,
            verificationData: context.verificationData || {},
            errorMessage: context.errorMessage,
            metadata: {
              timestamp: new Date().toISOString(),
              ...context.metadata,
            },
          },
        });

        // Update transaction state
        const updateData: Record<string, any> = {
          currentState: targetState,
          stateUpdatedAt: new Date(),
        };

        // Add error message if transitioning to FAILED
        if (context.errorMessage) {
          updateData.failureReason = context.errorMessage;
        }

        // Update verification-specific fields based on target state
        this.addStateSpecificFields(targetState, context.verificationData || {}, updateData);

        await tx.momoTransaction.update({
          where: { id: this.transaction.id },
          data: updateData,
        });
      });

      // 5. Update local reference
      this.transaction.currentState = targetState;

      logger.info('State transition completed', {
        transactionId: this.transaction.id,
        from: currentState,
        to: targetState,
        trigger: context.trigger,
      });

      // 6. Call state change handlers
      await this.notifyStateChangeHandlers(currentState, targetState, context);

      return {
        success: true,
        previousState: currentState,
        currentState: targetState,
        transactionId: this.transaction.id,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('State transition failed', {
        transactionId: this.transaction.id,
        from: currentState,
        to: targetState,
        error: errorMessage,
      });

      return {
        success: false,
        previousState: currentState,
        currentState: currentState,
        transactionId: this.transaction.id,
        error: errorMessage,
      };
    }
  }

  /**
   * Verify cryptographic proof for state transition
   */
  private async verifyCryptographicProof(
    targetState: string,
    verificationData: Record<string, any>
  ): Promise<{ valid: boolean; error?: string; missingFields?: string[] }> {
    const requirements = getVerificationRequirements(
      targetState,
      this.transaction.type as 'ON_RAMP' | 'OFF_RAMP'
    );

    // No verification required for this state
    if (!requirements) {
      return { valid: true };
    }

    // Check required fields
    const missingFields = requirements.requiredFields.filter(
      (field) => !verificationData[field] && verificationData[field] !== 0
    );

    if (missingFields.length > 0) {
      return {
        valid: false,
        error: `Missing required verification fields: ${missingFields.join(', ')}`,
        missingFields,
      };
    }

    // Additional state-specific validation
    const validationResult = await this.performStateSpecificValidation(
      targetState,
      verificationData
    );

    return validationResult;
  }

  /**
   * Perform additional validation based on target state
   */
  private async performStateSpecificValidation(
    targetState: string,
    verificationData: Record<string, any>
  ): Promise<{ valid: boolean; error?: string }> {
    switch (targetState) {
      case 'FIAT_RECEIVED':
        // Verify that providerTxId is not empty
        if (!verificationData.providerTxId || verificationData.providerTxId.length < 5) {
          return { valid: false, error: 'Invalid provider transaction ID' };
        }
        break;

      case 'CRYPTO_CONFIRMED':
        // Verify sufficient block confirmations
        const confirmations = verificationData.confirmations || 0;
        if (confirmations < 2) {
          return { valid: false, error: `Insufficient confirmations: ${confirmations} (need >= 2)` };
        }
        break;

      case 'COMPLETED':
        // Verify blockchain transaction hash format
        const txHash = verificationData.blockchainTxHash;
        if (!txHash || !txHash.startsWith('0x') || txHash.length !== 66) {
          return { valid: false, error: 'Invalid blockchain transaction hash format' };
        }
        break;

      case 'REFUNDED':
        // Verify refund transaction hash
        const refundHash = verificationData.refundTxHash;
        if (!refundHash || !refundHash.startsWith('0x') || refundHash.length !== 66) {
          return { valid: false, error: 'Invalid refund transaction hash format' };
        }
        break;
    }

    return { valid: true };
  }

  /**
   * Check if transitioning to a failure state
   */
  private isFailureTransition(targetState: string): boolean {
    return ['FAILED', 'EXPIRED', 'CANCELLED'].includes(targetState);
  }

  /**
   * Add state-specific fields to the update data
   */
  private addStateSpecificFields(
    targetState: string,
    verificationData: Record<string, any>,
    updateData: Record<string, any>
  ): void {
    switch (targetState) {
      case 'FIAT_PENDING':
        if (verificationData.payToken) {
          updateData.payToken = verificationData.payToken;
        }
        if (verificationData.notifToken) {
          updateData.notifToken = verificationData.notifToken;
        }
        break;

      case 'FIAT_PROCESSING':
        if (verificationData.ussdPushSentAt) {
          updateData.ussdPushSentAt = new Date(verificationData.ussdPushSentAt);
        }
        if (verificationData.ussdTimeoutAt) {
          updateData.ussdTimeoutAt = new Date(verificationData.ussdTimeoutAt);
        }
        break;

      case 'FIAT_RECEIVED':
      case 'PAYOUT_SUCCESS':
        if (verificationData.providerTxId) {
          updateData.providerTxId = verificationData.providerTxId;
        }
        break;

      case 'CRYPTO_LOCKED':
      case 'COMPLETED':
        if (verificationData.blockchainTxHash) {
          updateData.blockchainTxHash = verificationData.blockchainTxHash;
        }
        if (verificationData.blockNumber) {
          updateData.blockNumber = BigInt(verificationData.blockNumber);
        }
        break;

      case 'REFUNDED':
        if (verificationData.refundTxHash) {
          updateData.refundTxHash = verificationData.refundTxHash;
        }
        if (verificationData.refundedAt) {
          updateData.refundedAt = new Date(verificationData.refundedAt);
        }
        if (verificationData.refundReason) {
          updateData.refundReason = verificationData.refundReason;
        }
        break;
    }
  }

  /**
   * Notify all registered state change handlers
   */
  private async notifyStateChangeHandlers(
    fromState: string,
    toState: string,
    context: TransitionContext
  ): Promise<void> {
    for (const handler of this.stateChangeHandlers) {
      try {
        await handler(this.transaction.id, fromState, toState, context);
      } catch (error) {
        logger.error('State change handler failed', {
          transactionId: this.transaction.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        // Don't throw - handlers are best-effort
      }
    }
  }

  /**
   * Get the full state history for this transaction
   */
  async getStateHistory() {
    return prisma.transactionStateHistory.findMany({
      where: { transactionId: this.transaction.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Force transition to FAILED state (bypasses verification)
   * Use only for error recovery scenarios
   */
  async forceFailure(reason: string, metadata?: Record<string, any>): Promise<TransitionResult> {
    return this.transition('FAILED', {
      trigger: 'FORCE_FAILURE',
      errorMessage: reason,
      metadata,
    });
  }
}

// ================================
// FACTORY FUNCTION
// ================================

/**
 * Create a state machine for an existing transaction
 */
export async function createStateMachine(
  transactionId: string
): Promise<TransactionStateMachine | null> {
  const transaction = await prisma.momoTransaction.findUnique({
    where: { id: transactionId },
  });

  if (!transaction) {
    logger.error('Transaction not found for FSM', { transactionId });
    return null;
  }

  return new TransactionStateMachine(transaction);
}

/**
 * Create a state machine from a transaction object
 */
export function createStateMachineFromTransaction(
  transaction: MomoTransaction
): TransactionStateMachine {
  return new TransactionStateMachine(transaction);
}
