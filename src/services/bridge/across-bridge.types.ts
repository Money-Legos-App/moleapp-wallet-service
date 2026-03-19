/**
 * Across Protocol v4 Bridge Types
 * Cross-chain bridge via Across /swap/approval API
 */

// ============ REQUEST TYPES ============

export interface BridgeQuoteRequest {
  walletId: string;
  inputToken: string;         // Token symbol ('ETH', 'USDC') or address
  outputToken: string;        // Token symbol or address on destination chain
  amount: string;             // Amount in smallest unit (wei for ETH)
  originChainId: number;      // Source chain
  destinationChainId: number;  // Required — caller must specify destination chain
  recipient?: string;         // Custom recipient address on destination chain (defaults to own Kernel account)
  slippage?: number;          // 0.005 = 0.5%
}

export interface BridgeExecuteRequest {
  walletId: string;
  quoteId: string;
  amount: string;
  originChainId: number;
  destinationChainId?: number;
  recipient?: string;         // Custom recipient address on destination chain
}

export interface BridgeForMissionRequest {
  missionId: string;
  walletId: string;
  amount: string;
  sourceChainId: number;
  inputToken: string;
  recipientAddress: string;   // Master EOA or Kernel account on Arbitrum
}

export interface BridgeForSavingsRequest {
  walletId: string;
  amount: string;
  sourceChainId: number;
  recipientAddress: string;   // User's Hyperliquid L1 address
}

// ============ RESPONSE TYPES ============

export interface BridgeQuoteResponse {
  quoteId: string;
  originChainId: number;
  destinationChainId: number;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  expectedOutputAmount: string;
  minOutputAmount: string;
  bridgeFeeUsd: string;
  relayerFeePercent: string;
  estimatedFillTime: number;
  expiresAt: number;
  requiresApproval: boolean;
  recipientAddress: string;   // Address receiving funds on destination chain
}

export interface BridgeExecuteResponse {
  bridgeOperationId: string;
  userOpHash: string;
  status: 'submitted';
  originChainId: number;
  destinationChainId: number;
  inputAmount: string;
  expectedOutputAmount: string;
  sponsored: boolean;
}

export interface BridgeStatusResponse {
  bridgeOperationId: string;
  status: 'PENDING' | 'DEPOSIT_CONFIRMED' | 'FILLED' | 'REFUNDED' | 'FAILED';
  userOpHash?: string;
  depositTxHash?: string;
  fillTxHash?: string;
  inputAmount: string;
  outputAmount?: string;
  originChainId: number;
  destinationChainId: number;
  createdAt: string;
  updatedAt: string;
}

// ============ ACROSS API TYPES ============

export interface AcrossSwapApprovalParams {
  tradeType: 'exactInput' | 'minOutput' | 'exactOutput';
  amount: string;
  inputToken: string;
  outputToken: string;
  originChainId: number;
  destinationChainId: number;
  depositor: string;
  recipient: string;
  integratorId: string;
  slippage: number;
}

export interface AcrossApprovalTxn {
  chainId?: number;
  to: string;
  data: string;
  value?: string;
}

export interface AcrossSwapTx {
  simulationSuccess?: boolean;
  chainId?: number;
  to: string;
  data: string;
  value: string;
  gas?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}

export interface AcrossSwapApprovalResponse {
  crossSwapType: string;
  checks?: {
    allowance: { token: string; spender: string; actual: string; expected: string };
    balance: { token: string; actual: string; expected: string };
  };
  approvalTxns?: AcrossApprovalTxn[];
  swapTx: AcrossSwapTx;
  steps?: {
    bridge?: { inputAmount: string; outputAmount: string };
  };
  fees?: {
    total: string;
    totalMax: string;
    originGas: string;
  };
  expectedOutputAmount?: string;
  expectedFillTime?: number;
  quoteExpiryTimestamp?: number;
}

export interface AcrossDepositStatusResponse {
  status: 'pending' | 'filled' | 'expired';
  /** Across v4 API returns `fillTx` (not `fillTxHash`) */
  fillTx?: string;
  outputAmount?: string;
}

// ============ INTERNAL CACHE TYPE ============

export interface CachedBridgeQuoteData {
  acrossResponse: AcrossSwapApprovalResponse;
  walletId: string;
  kernelAccountAddress: string;
  recipientAddress: string;
  originChainId: number;
  destinationChainId: number;
  inputToken: string;
  outputToken: string;
  amount: string;
  expiresAt: number;
}

// ============ ERROR TYPES ============

export type BridgeErrorCode =
  | 'E050'   // BRIDGE_QUOTE_FAILED
  | 'E051'   // BRIDGE_EXECUTION_FAILED
  | 'E052'   // BRIDGE_STATUS_FAILED
  | 'E053'   // BRIDGE_QUOTE_EXPIRED
  | 'E054'   // BRIDGE_ROUTE_UNAVAILABLE
  | 'E055'   // BRIDGE_AMOUNT_TOO_SMALL
  | 'E056'   // BRIDGE_QUOTE_MISMATCH
  | 'E057';  // BRIDGE_REFUNDED

export const BRIDGE_ERRORS: Record<BridgeErrorCode, { code: BridgeErrorCode; error: string }> = {
  E050: { code: 'E050', error: 'BRIDGE_QUOTE_FAILED' },
  E051: { code: 'E051', error: 'BRIDGE_EXECUTION_FAILED' },
  E052: { code: 'E052', error: 'BRIDGE_STATUS_FAILED' },
  E053: { code: 'E053', error: 'BRIDGE_QUOTE_EXPIRED' },
  E054: { code: 'E054', error: 'BRIDGE_ROUTE_UNAVAILABLE' },
  E055: { code: 'E055', error: 'BRIDGE_AMOUNT_TOO_SMALL' },
  E056: { code: 'E056', error: 'BRIDGE_QUOTE_MISMATCH' },
  E057: { code: 'E057', error: 'BRIDGE_REFUNDED' },
};
