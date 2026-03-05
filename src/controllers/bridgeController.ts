/**
 * Bridge Controller
 * Handles cross-chain bridge operations via Across Protocol v4.
 */

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { KernelService } from '../services/kernel/account-abstraction.service.js';
import { TurnkeyService } from '../services/turnkey/index.js';
import { AcrossBridgeService } from '../services/bridge/across-bridge.service.js';
import { ResponseUtils } from '../utils/responseUtils.js';
import { logger } from '../utils/logger.js';
import { BRIDGE_ERRORS } from '../services/bridge/across-bridge.types.js';
import type { BridgeErrorCode } from '../services/bridge/across-bridge.types.js';

// Module-level service instantiation (same pattern as swapController)
const turnkeyService = new TurnkeyService(prisma);
const kernelService = new KernelService(prisma, turnkeyService);
const bridgeService = new AcrossBridgeService(prisma, kernelService);

function bridgeError(res: Response, code: BridgeErrorCode, message: string, statusCode = 400) {
  const def = BRIDGE_ERRORS[code];
  return res.status(statusCode).json({
    success: false,
    code: def.code,
    error: def.error,
    message,
  });
}

export const bridgeController = {
  /**
   * GET /api/v2/bridge/quote
   */
  async getQuote(req: Request, res: Response) {
    try {
      const { walletId, inputToken, outputToken, amount, originChainId, slippage } = req.query;

      const quote = await bridgeService.getQuote({
        walletId: walletId as string,
        inputToken: inputToken as string,
        outputToken: (outputToken as string) || 'ETH',
        amount: amount as string,
        originChainId: parseInt(originChainId as string),
        slippage: slippage ? parseFloat(slippage as string) : undefined,
      });

      return ResponseUtils.success(res, quote, 'Bridge quote retrieved successfully');
    } catch (error: any) {
      logger.error('Bridge quote failed', { error: error.message });

      if (error.message?.includes('WALLET_NOT_FOUND')) {
        return bridgeError(res, 'E050', 'Wallet not found.', 404);
      }
      if (error.message?.includes('BRIDGE_ROUTE_UNAVAILABLE')) {
        return bridgeError(res, 'E054', error.message, 400);
      }
      if (error.message?.includes('BRIDGE_AMOUNT_TOO_SMALL')) {
        return bridgeError(res, 'E055', 'Amount is below the minimum bridge threshold.', 400);
      }

      return bridgeError(res, 'E050', error.message || 'Failed to get bridge quote.', 500);
    }
  },

  /**
   * POST /api/v2/bridge/execute
   */
  async executeBridge(req: Request, res: Response) {
    try {
      const { walletId, quoteId, amount, originChainId } = req.body;

      const result = await bridgeService.executeBridge({
        walletId,
        quoteId,
        amount,
        originChainId: parseInt(originChainId),
      });

      logger.info('Bridge executed', {
        bridgeOperationId: result.bridgeOperationId,
        userOpHash: result.userOpHash,
      });

      return ResponseUtils.success(res, result, 'Bridge operation submitted successfully');
    } catch (error: any) {
      logger.error('Bridge execution failed', { error: error.message });

      if (error.message?.includes('BRIDGE_QUOTE_EXPIRED')) {
        return bridgeError(res, 'E053', 'Quote expired. Please request a new quote.', 400);
      }
      if (error.message?.includes('BRIDGE_QUOTE_MISMATCH')) {
        return bridgeError(res, 'E056', 'Request does not match cached quote.', 400);
      }

      return bridgeError(res, 'E051', error.message || 'Failed to execute bridge.', 500);
    }
  },

  /**
   * GET /api/v2/bridge/status/:bridgeOperationId
   */
  async getBridgeStatus(req: Request, res: Response) {
    try {
      const { bridgeOperationId } = req.params;
      const walletId = req.query.walletId as string;

      const status = await bridgeService.getBridgeStatus(bridgeOperationId, walletId);
      return ResponseUtils.success(res, status, 'Bridge status retrieved successfully');
    } catch (error: any) {
      logger.error('Bridge status failed', { error: error.message });

      if (error.message?.includes('NOT_FOUND')) {
        return bridgeError(res, 'E052', 'Bridge operation not found.', 404);
      }

      return bridgeError(res, 'E052', error.message || 'Failed to get bridge status.', 500);
    }
  },

  /**
   * GET /api/v2/bridge/history
   */
  async listBridgeHistory(req: Request, res: Response) {
    try {
      const { walletId, limit } = req.query;

      const operations = await bridgeService.listBridgeOperations(
        walletId as string,
        limit ? parseInt(limit as string) : 20,
      );

      return ResponseUtils.success(res, { operations, count: operations.length }, 'Bridge history retrieved');
    } catch (error: any) {
      logger.error('Bridge history failed', { error: error.message });
      return bridgeError(res, 'E052', error.message || 'Failed to get bridge history.', 500);
    }
  },
};

// Export service instance for internal routes
export { bridgeService };
