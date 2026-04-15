/**
 * FSM Module Exports
 *
 * Finite State Machine for Orange Money transaction management.
 * Ensures no state transition occurs without cryptographic verification.
 */

// State definitions and transitions
export {
  ON_RAMP_STATES,
  OFF_RAMP_STATES,
  ON_RAMP_TRANSITIONS,
  OFF_RAMP_TRANSITIONS,
  ON_RAMP_VERIFICATIONS,
  OFF_RAMP_VERIFICATIONS,
  isValidTransition,
  isTerminalState,
  getVerificationRequirements,
  isSuccessState,
  isFailureState,
  type OnRampState,
  type OffRampState,
  type StateVerification,
} from './states';

// State machine implementation
export {
  TransactionStateMachine,
  createStateMachine,
  createStateMachineFromTransaction,
  type TransitionContext,
  type TransitionResult,
  type StateChangeHandler,
} from './transactionStateMachine';
