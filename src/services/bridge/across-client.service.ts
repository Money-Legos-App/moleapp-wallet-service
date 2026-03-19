/**
 * Across Protocol v4 API Client
 * Thin HTTP wrapper for Across REST API endpoints.
 */

import { logger } from '../../utils/logger.js';
import { developmentMode } from '../../config/environment.js';
import type {
  AcrossSwapApprovalParams,
  AcrossSwapApprovalResponse,
  AcrossDepositStatusResponse,
} from './across-bridge.types.js';

export class AcrossClientService {
  private readonly baseUrl: string;
  private readonly integratorId: string;

  constructor() {
    this.baseUrl = developmentMode
      ? 'https://testnet.across.to/api'
      : 'https://app.across.to/api';

    this.integratorId = process.env.ACROSS_INTEGRATOR_ID || '0x0000';

    logger.info('AcrossClient initialized', { baseUrl: this.baseUrl, developmentMode });
  }

  /**
   * GET /swap/approval — high-level endpoint returning ready-to-sign calldata.
   * Returns approvalTxns[] for ERC-20 tokens and transaction for the bridge deposit.
   * For native ETH, approvalTxns will be empty.
   */
  async getSwapApproval(params: AcrossSwapApprovalParams): Promise<AcrossSwapApprovalResponse> {
    const queryParams = new URLSearchParams({
      tradeType: params.tradeType,
      amount: params.amount,
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      originChainId: params.originChainId.toString(),
      destinationChainId: params.destinationChainId.toString(),
      depositor: params.depositor,
      recipient: params.recipient,
      integratorId: this.integratorId,
      slippage: params.slippage.toString(),
    });

    const url = `${this.baseUrl}/swap/approval?${queryParams}`;

    logger.info('Requesting Across /swap/approval', {
      inputToken: params.inputToken,
      outputToken: params.outputToken,
      amount: params.amount,
      originChainId: params.originChainId,
      destinationChainId: params.destinationChainId,
    });

    const response = await fetch(url);

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error('Across API error', { status: response.status, body: errorBody });

      if (response.status === 400 && errorBody.includes('route')) {
        throw new Error('BRIDGE_ROUTE_UNAVAILABLE');
      }
      if (response.status === 400 && errorBody.includes('amount')) {
        throw new Error('BRIDGE_AMOUNT_TOO_SMALL');
      }
      throw new Error(`Across API error ${response.status}: ${errorBody}`);
    }

    const data = await response.json();

    logger.info('Across /swap/approval response keys', {
      keys: Object.keys(data),
      hasSwapTx: !!data.swapTx,
      hasTransaction: !!data.transaction,
      hasSteps: !!data.steps,
      feesKeys: data.fees ? Object.keys(data.fees) : [],
    });

    // Normalize: support both old 'transaction' and new 'swapTx' field names
    if (!data.swapTx && data.transaction) {
      data.swapTx = data.transaction;
    }

    // Normalize: support both old 'expectedOutputAmount' and new 'steps.bridge.outputAmount'
    if (!data.expectedOutputAmount && data.steps?.bridge?.outputAmount) {
      data.expectedOutputAmount = data.steps.bridge.outputAmount;
    }

    return data as AcrossSwapApprovalResponse;
  }

  /**
   * GET /deposit/status — poll deposit status by transaction hash.
   */
  async getDepositStatus(
    depositTxHash: string,
    originChainId: number,
  ): Promise<AcrossDepositStatusResponse> {
    const queryParams = new URLSearchParams({
      depositTxHash,
      originChainId: originChainId.toString(),
    });

    const url = `${this.baseUrl}/deposit/status?${queryParams}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Across status API error ${response.status}`);
    }

    return response.json();
  }

  /**
   * GET /available-routes — check if a route is supported.
   */
  async isRouteAvailable(
    originChainId: number,
    destinationChainId: number,
    originToken: string,
    destinationToken: string,
  ): Promise<boolean> {
    try {
      const queryParams = new URLSearchParams({
        originChainId: originChainId.toString(),
        destinationChainId: destinationChainId.toString(),
        originToken,
        destinationToken,
      });

      const response = await fetch(`${this.baseUrl}/available-routes?${queryParams}`);
      if (!response.ok) return false;

      const routes = await response.json();
      return Array.isArray(routes) && routes.length > 0;
    } catch {
      return false;
    }
  }
}
