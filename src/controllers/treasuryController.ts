/**
 * Treasury Controller
 *
 * REST API endpoints for treasury operations.
 * Used by momo-service for on/off-ramp settlements.
 */

import { Request, Response } from 'express';
import { validationResult } from 'express-validator';
import { treasuryService } from '../services/treasury';
import { logger } from '../utils/logger';
import { Address, Hex } from 'viem';
import { getSupportedChainIds, DEFAULT_EVM_CHAIN_ID } from '../config/networks.js';

// Response helpers
const successResponse = (res: Response, data: any, message: string = 'Success', statusCode: number = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};

const errorResponse = (res: Response, code: string, message: string, statusCode: number = 400) => {
  return res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
  });
};

export class TreasuryController {
  /**
   * POST /api/v2/treasury/credit
   * Credit user wallet from treasury (on-ramp completion)
   */
  async creditUser(req: Request, res: Response): Promise<Response> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return errorResponse(res, 'VALIDATION_ERROR', errors.array()[0].msg);
      }

      const { userId, walletAddress, usdcAmount, transactionId, metadata } = req.body;
      const chainId = parseInt(req.body.chainId, 10) || DEFAULT_EVM_CHAIN_ID; // Default to Sepolia

      logger.info('Treasury credit request', {
        userId,
        walletAddress,
        usdcAmount,
        chainId,
        transactionId,
      });

      const result = await treasuryService.creditUserFromTreasury(
        walletAddress as Address,
        usdcAmount,
        chainId,
        transactionId
      );

      if (!result.success) {
        return errorResponse(res, 'CREDIT_FAILED', result.error || 'Credit failed', 500);
      }

      return successResponse(res, {
        success: true,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        walletAddress,
        amount: usdcAmount,
      }, 'User credited successfully');

    } catch (error) {
      logger.error('Treasury credit error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        body: req.body,
      });
      return errorResponse(res, 'INTERNAL_ERROR', 'Failed to process credit request', 500);
    }
  }

  /**
   * POST /api/v2/treasury/lock
   * Lock user funds to treasury (off-ramp initiation)
   */
  async lockFunds(req: Request, res: Response): Promise<Response> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return errorResponse(res, 'VALIDATION_ERROR', errors.array()[0].msg);
      }

      const { userId, walletAddress, usdcAmount, transactionId, metadata } = req.body;
      const chainId = parseInt(req.body.chainId, 10) || DEFAULT_EVM_CHAIN_ID;

      logger.info('Treasury lock request', {
        userId,
        walletAddress,
        usdcAmount,
        chainId,
        transactionId,
      });

      const result = await treasuryService.lockUserToTreasury(
        walletAddress as Address,
        usdcAmount,
        chainId,
        transactionId
      );

      if (!result.success) {
        return errorResponse(res, 'LOCK_FAILED', result.error || 'Lock failed', 500);
      }

      return successResponse(res, {
        success: true,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        walletAddress,
        amount: usdcAmount,
      }, 'Funds locked successfully');

    } catch (error) {
      logger.error('Treasury lock error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        body: req.body,
      });
      return errorResponse(res, 'INTERNAL_ERROR', 'Failed to process lock request', 500);
    }
  }

  /**
   * POST /api/v2/treasury/refund
   * Refund user from treasury (failed payout)
   */
  async refundUser(req: Request, res: Response): Promise<Response> {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return errorResponse(res, 'VALIDATION_ERROR', errors.array()[0].msg);
      }

      const { userId, walletAddress, usdcAmount, transactionId, reason, metadata } = req.body;
      const chainId = parseInt(req.body.chainId, 10) || DEFAULT_EVM_CHAIN_ID;

      logger.info('Treasury refund request', {
        userId,
        walletAddress,
        usdcAmount,
        chainId,
        transactionId,
        reason,
      });

      const result = await treasuryService.refundFromTreasury(
        walletAddress as Address,
        usdcAmount,
        chainId,
        transactionId,
        reason
      );

      if (!result.success) {
        return errorResponse(res, 'REFUND_FAILED', result.error || 'Refund failed', 500);
      }

      return successResponse(res, {
        success: true,
        txHash: result.txHash,
        blockNumber: result.blockNumber,
        walletAddress,
        amount: usdcAmount,
        reason,
      }, 'Refund processed successfully');

    } catch (error) {
      logger.error('Treasury refund error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        body: req.body,
      });
      return errorResponse(res, 'INTERNAL_ERROR', 'Failed to process refund request', 500);
    }
  }

  /**
   * GET /api/v2/treasury/balance
   * Get treasury balance for a chain
   */
  async getBalance(req: Request, res: Response): Promise<Response> {
    try {
      const chainId = parseInt(req.query.chainId as string, 10) || DEFAULT_EVM_CHAIN_ID;

      logger.info('Treasury balance request', { chainId });

      const balance = await treasuryService.getTreasuryBalance(chainId);

      return successResponse(res, balance, 'Treasury balance retrieved');

    } catch (error) {
      logger.error('Treasury balance error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        query: req.query,
      });
      return errorResponse(res, 'INTERNAL_ERROR', 'Failed to get treasury balance', 500);
    }
  }

  /**
   * GET /api/v2/treasury/tx-status/:txHash
   * Check transaction confirmation status
   */
  async getTransactionStatus(req: Request, res: Response): Promise<Response> {
    try {
      const { txHash } = req.params;
      const chainId = parseInt(req.query.chainId as string, 10) || DEFAULT_EVM_CHAIN_ID;

      logger.info('Transaction status request', { txHash, chainId });

      const status = await treasuryService.checkTransactionConfirmations(
        txHash as Hex,
        chainId
      );

      return successResponse(res, status, 'Transaction status retrieved');

    } catch (error) {
      logger.error('Transaction status error', {
        error: error instanceof Error ? error.message : 'Unknown error',
        txHash: req.params.txHash,
      });
      return errorResponse(res, 'INTERNAL_ERROR', 'Failed to get transaction status', 500);
    }
  }

  /**
   * GET /api/v2/treasury/address
   * Get treasury wallet address
   */
  async getAddress(req: Request, res: Response): Promise<Response> {
    try {
      const address = treasuryService.getTreasuryAddress();

      return successResponse(res, {
        address,
        supportedChains: getSupportedChainIds().filter((id): id is number => id !== null),
      }, 'Treasury address retrieved');

    } catch (error) {
      logger.error('Treasury address error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return errorResponse(res, 'INTERNAL_ERROR', 'Failed to get treasury address', 500);
    }
  }
}

export const treasuryController = new TreasuryController();
