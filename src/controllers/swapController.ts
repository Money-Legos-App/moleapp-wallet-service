/**
 * Swap Controller
 * Handles HTTP requests for gasless token swaps
 * Uses 0x API for quotes and ZeroDev Kernel for execution
 */

import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { SwapService } from '../services/swap/swap.service.js';
import { TurnkeyService } from '../services/turnkey/index.js';
import { KernelService } from '../services/kernel/account-abstraction.service.js';
import { ResponseUtils } from '../utils/responseUtils.js';
import { logger } from '../utils/logger.js';
import { SWAP_ERRORS } from '../services/swap/swap.types.js';
import type {
  SwapQuoteRequest,
  SwapQuoteReverseRequest,
  SwapExecuteRequest,
  SwapErrorCode,
} from '../services/swap/swap.types.js';

// Initialize services
const turnkeyService = new TurnkeyService(prisma);
const kernelService = new KernelService(prisma, turnkeyService);
const swapService = new SwapService(prisma, kernelService);

/**
 * Helper to create swap error response
 */
function swapError(
  res: Response,
  code: SwapErrorCode,
  message: string,
  statusCode: number = 400
) {
  const errorDef = SWAP_ERRORS[code];
  return res.status(statusCode).json({
    success: false,
    code: errorDef.code,
    error: errorDef.error,
    message,
  });
}

export const swapController = {
  /**
   * GET /api/v2/swap/tokens
   * Returns list of supported tokens for swaps
   */
  async getSupportedTokens(req: Request, res: Response) {
    try {
      const tokens = swapService.getSupportedTokens();

      return ResponseUtils.success(res, {
        tokens,
        count: tokens.length,
      }, 'Supported tokens retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting supported tokens:', error);
      return swapError(res, 'E035', error.message || 'Failed to get supported tokens', 500);
    }
  },

  /**
   * GET /api/v2/swap/quote
   * Get swap quote for given parameters
   *
   * Query params:
   * - walletId: User's wallet ID (required)
   * - sellToken: Token symbol or address to sell (required)
   * - buyToken: Token symbol or address to buy (required)
   * - sellAmount: Amount to sell in smallest unit (required)
   * - slippageBps: Slippage tolerance in basis points (optional, default 100 = 1%)
   */
  async getQuote(req: Request, res: Response) {
    try {
      const { walletId, sellToken, buyToken, sellAmount, slippageBps } = req.query;

      // Validate required parameters
      if (!walletId || !sellToken || !buyToken || !sellAmount) {
        return ResponseUtils.error(res, 'Missing required parameters: walletId, sellToken, buyToken, sellAmount', 400, {
          code: 'MISSING_REQUIRED_PARAMS',
        });
      }

      const quoteRequest: SwapQuoteRequest = {
        walletId: walletId as string,
        sellToken: sellToken as string,
        buyToken: buyToken as string,
        sellAmount: sellAmount as string,
        slippageBps: slippageBps ? parseInt(slippageBps as string, 10) : undefined,
      };

      logger.info(`Getting swap quote`, {
        walletId: quoteRequest.walletId,
        sellToken: quoteRequest.sellToken,
        buyToken: quoteRequest.buyToken,
        sellAmount: quoteRequest.sellAmount,
      });

      const quote = await swapService.getQuote(quoteRequest);

      return ResponseUtils.success(res, quote, 'Swap quote retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting swap quote:', error);

      // Handle specific error types with user-friendly messages
      if (error.message?.includes('WALLET_NOT_FOUND')) {
        return swapError(res, 'E030', 'Your wallet was not found. Please sync your account and try again.', 404);
      }
      if (error.message?.includes('WALLET_INACTIVE')) {
        return swapError(res, 'E030', 'Your wallet is inactive. Please contact support.', 403);
      }
      if (error.message?.includes('NO_LIQUIDITY') || error.message?.includes('INSUFFICIENT_LIQUIDITY')) {
        return swapError(res, 'E037', 'No swap routes available. This token pair may not have sufficient liquidity on testnet.', 400);
      }
      if (error.message?.includes('INVALID_PATH')) {
        return swapError(res, 'E037',
          'Swap path validation failed. The MOLE/WETH pool may not be registered with this Uniswap V2 router. ' +
          'Please contact support or try again later.',
          400
        );
      }
      if (error.message?.includes('AMOUNT_TOO_SMALL')) {
        return swapError(res, 'E030',
          'Swap amount is too small. Minimum swap amount is 0.001 ETH.',
          400
        );
      }
      if (error.message?.includes('UNSUPPORTED_PAIR')) {
        return swapError(res, 'E035', 'Only MOLE/ETH swaps are currently supported.', 400);
      }
      if (error.message?.includes('Invalid sell token') || error.message?.includes('Invalid buy token')) {
        return swapError(res, 'E035', error.message, 400);
      }
      if (error.message?.includes('Quote expired')) {
        return swapError(res, 'E033', 'Quote expired. Please request a new quote.', 400);
      }
      if (error.message?.includes('not found')) {
        return swapError(res, 'E030', error.message, 404);
      }

      return swapError(res, 'E030', error.message || 'Failed to get swap quote. Please try again.', 500);
    }
  },

  /**
   * GET /api/v2/swap/quote-reverse
   * Get reverse swap quote (by buy amount)
   * Calculates required sell amount for desired buy amount
   *
   * Query params:
   * - walletId: User's wallet ID (required)
   * - sellToken: Token symbol or address to sell (required)
   * - buyToken: Token symbol or address to buy (required)
   * - buyAmount: Desired amount to receive in smallest unit (required)
   * - slippageBps: Slippage tolerance in basis points (optional, default 100 = 1%)
   */
  async getQuoteReverse(req: Request, res: Response) {
    try {
      const { walletId, sellToken, buyToken, buyAmount, slippageBps } = req.query;

      // Validate required parameters
      if (!walletId || !sellToken || !buyToken || !buyAmount) {
        return ResponseUtils.error(res, 'Missing required parameters: walletId, sellToken, buyToken, buyAmount', 400, {
          code: 'MISSING_REQUIRED_PARAMS',
        });
      }

      const quoteRequest: SwapQuoteReverseRequest = {
        walletId: walletId as string,
        sellToken: sellToken as string,
        buyToken: buyToken as string,
        buyAmount: buyAmount as string,
        slippageBps: slippageBps ? parseInt(slippageBps as string, 10) : undefined,
      };

      logger.info(`Getting reverse swap quote`, {
        walletId: quoteRequest.walletId,
        sellToken: quoteRequest.sellToken,
        buyToken: quoteRequest.buyToken,
        buyAmount: quoteRequest.buyAmount,
      });

      const quote = await swapService.getQuoteReverse(quoteRequest);

      return ResponseUtils.success(res, quote, 'Reverse swap quote retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting reverse swap quote:', error);

      // Handle specific error types with user-friendly messages
      if (error.message?.includes('WALLET_NOT_FOUND')) {
        return swapError(res, 'E030', 'Your wallet was not found. Please sync your account and try again.', 404);
      }
      if (error.message?.includes('WALLET_INACTIVE')) {
        return swapError(res, 'E030', 'Your wallet is inactive. Please contact support.', 403);
      }
      if (error.message?.includes('NO_LIQUIDITY')) {
        return swapError(res, 'E037', 'No swap routes available. This token pair may not have sufficient liquidity on testnet.', 400);
      }
      if (error.message?.includes('Invalid sell token') || error.message?.includes('Invalid buy token')) {
        return swapError(res, 'E035', error.message, 400);
      }
      if (error.message?.includes('Quote expired')) {
        return swapError(res, 'E033', 'Quote expired. Please request a new quote.', 400);
      }
      if (error.message?.includes('not found')) {
        return swapError(res, 'E030', error.message, 404);
      }

      return swapError(res, 'E030', error.message || 'Failed to get reverse swap quote. Please try again.', 500);
    }
  },

  /**
   * POST /api/v2/swap/execute
   * Execute swap using cached quote
   *
   * Body:
   * - walletId: User's wallet ID (required)
   * - quoteId: Quote ID from getQuote response (required)
   * - sellToken: Token to sell - must match quote (required)
   * - buyToken: Token to buy - must match quote (required)
   * - sellAmount: Amount to sell - must match quote (required)
   * - minBuyAmount: Minimum acceptable output with slippage (required)
   */
  async executeSwap(req: Request, res: Response) {
    try {
      const { walletId, quoteId, sellToken, buyToken, sellAmount, minBuyAmount } = req.body;

      // Validate required parameters
      if (!walletId || !quoteId || !sellToken || !buyToken || !sellAmount || !minBuyAmount) {
        return ResponseUtils.error(res, 'Missing required parameters: walletId, quoteId, sellToken, buyToken, sellAmount, minBuyAmount', 400, {
          code: 'MISSING_REQUIRED_PARAMS',
        });
      }

      const executeRequest: SwapExecuteRequest = {
        walletId,
        quoteId,
        sellToken,
        buyToken,
        sellAmount,
        minBuyAmount,
      };

      logger.info(`Executing swap`, {
        walletId,
        quoteId,
        sellToken,
        buyToken,
        sellAmount,
      });

      const result = await swapService.executeSwap(executeRequest);

      logger.info(`Swap executed successfully`, {
        userOpHash: result.userOpHash,
        sponsored: result.sponsored,
      });

      return ResponseUtils.success(res, result, 'Swap submitted successfully');
    } catch (error: any) {
      logger.error('Error executing swap:', error);

      // Handle specific error types
      if (error.message?.includes('Quote not found')) {
        return swapError(res, 'E033', 'Quote not found. Please request a new quote.', 400);
      }
      if (error.message?.includes('expired')) {
        return swapError(res, 'E033', error.message, 400);
      }
      if (error.message?.includes('do not match')) {
        return swapError(res, 'E036', error.message, 400);
      }
      if (error.message?.includes('insufficient') || error.message?.includes('balance')) {
        return swapError(res, 'E034', error.message, 400);
      }

      return swapError(res, 'E031', error.message || 'Failed to execute swap', 500);
    }
  },

  /**
   * GET /api/v2/swap/status/:userOpHash
   * Get swap transaction status
   */
  async getSwapStatus(req: Request, res: Response) {
    try {
      const { userOpHash } = req.params;

      if (!userOpHash) {
        return ResponseUtils.error(res, 'UserOperation hash is required', 400, {
          code: 'MISSING_USER_OP_HASH',
        });
      }

      logger.info(`Getting swap status for ${userOpHash}`);

      const status = await swapService.getSwapStatus(userOpHash);

      return ResponseUtils.success(res, status, 'Swap status retrieved successfully');
    } catch (error: any) {
      logger.error('Error getting swap status:', error);

      if (error.message?.includes('not found')) {
        return swapError(res, 'E032', 'UserOperation not found', 404);
      }

      return swapError(res, 'E032', error.message || 'Failed to get swap status', 500);
    }
  },

  /**
   * GET /api/v2/swap/health
   * Health check for swap service (0x API connectivity)
   */
  async healthCheck(req: Request, res: Response) {
    try {
      const { ZeroXClientService } = await import('../services/swap/zerox-client.service.js');
      const zeroxClient = new ZeroXClientService();
      const isHealthy = await zeroxClient.healthCheck();

      if (isHealthy) {
        return ResponseUtils.success(res, {
          status: 'healthy',
          zeroxApi: 'connected',
          timestamp: new Date().toISOString(),
        }, 'Swap service is healthy');
      } else {
        return res.status(503).json({
          success: false,
          status: 'unhealthy',
          zeroxApi: 'disconnected',
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error: any) {
      logger.error('Swap health check failed:', error);
      return res.status(503).json({
        success: false,
        status: 'error',
        zeroxApi: 'error',
        message: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  },

  /**
   * GET /api/v2/swap/pool-diagnostic
   * Diagnostic endpoint for MOLE/WETH Uniswap V2 pool
   * Helps debug INVALID_PATH errors by checking pool configuration
   */
  async poolDiagnostic(req: Request, res: Response) {
    try {
      const { UniswapV2ClientService } = await import('../services/swap/uniswap-v2-client.service.js');
      const { UNISWAP_V2_CONFIG } = await import('../config/uniswap-v2.config.js');
      const { SWAP_CONFIG } = await import('../config/tokens.js');

      const uniswapV2Client = new UniswapV2ClientService(SWAP_CONFIG.CHAIN_ID);

      // 1. Validate pool liquidity
      const liquidityCheck = await uniswapV2Client.validatePoolLiquidity();

      // 2. Test swap path validation with a sample amount (0.01 ETH)
      const testAmount = '10000000000000000'; // 0.01 ETH
      const testPath = [UNISWAP_V2_CONFIG.WETH_ADDRESS, UNISWAP_V2_CONFIG.MOLE_ADDRESS];
      const pathValidation = await uniswapV2Client.validateSwapPath(testAmount, testPath);

      // 3. Build diagnostic result
      const diagnostic = {
        timestamp: new Date().toISOString(),
        chainId: SWAP_CONFIG.CHAIN_ID,
        configuration: {
          routerAddress: UNISWAP_V2_CONFIG.ROUTER_ADDRESS,
          pairAddress: UNISWAP_V2_CONFIG.MOLE_WETH_PAIR,
          wethAddress: UNISWAP_V2_CONFIG.WETH_ADDRESS,
          moleAddress: UNISWAP_V2_CONFIG.MOLE_ADDRESS,
        },
        poolStatus: {
          hasLiquidity: liquidityCheck.isValid,
          reserveMole: liquidityCheck.reserveMole.toString(),
          reserveWeth: liquidityCheck.reserveWeth.toString(),
          factoryPairAddress: liquidityCheck.factoryPairAddress,
          pairMismatch: liquidityCheck.factoryPairAddress
            ? liquidityCheck.factoryPairAddress.toLowerCase() !== UNISWAP_V2_CONFIG.MOLE_WETH_PAIR.toLowerCase()
            : null,
        },
        routerValidation: {
          testAmount,
          testPath,
          isValid: pathValidation.isValid,
          amountsOut: pathValidation.amountsOut?.map(a => a.toString()),
          error: pathValidation.error,
        },
        recommendations: [] as string[],
      };

      // 4. Generate recommendations based on findings
      if (!liquidityCheck.isValid) {
        diagnostic.recommendations.push(
          'Pool has no liquidity. Add liquidity to the MOLE/WETH pair before swapping.'
        );
      }

      if (liquidityCheck.factoryPairAddress &&
          liquidityCheck.factoryPairAddress.toLowerCase() !== UNISWAP_V2_CONFIG.MOLE_WETH_PAIR.toLowerCase()) {
        diagnostic.recommendations.push(
          `PAIR MISMATCH: The router's factory has a different pair address (${liquidityCheck.factoryPairAddress}). ` +
          `Update MOLE_WETH_PAIR in uniswap-v2.config.ts to match.`
        );
      }

      if (liquidityCheck.factoryPairAddress === '0x0000000000000000000000000000000000000000') {
        diagnostic.recommendations.push(
          'PAIR NOT FOUND: The router\'s factory does not have a MOLE/WETH pair. ' +
          'Either create the pair using this factory, or update ROUTER_ADDRESS to the correct router.'
        );
      }

      if (!pathValidation.isValid) {
        diagnostic.recommendations.push(
          `ROUTER VALIDATION FAILED: ${pathValidation.error}. ` +
          'The swap will fail with INVALID_PATH error.'
        );
      }

      const overallStatus = liquidityCheck.isValid && pathValidation.isValid ? 'HEALTHY' : 'NEEDS_ATTENTION';

      logger.info('Pool diagnostic completed', {
        overallStatus,
        hasLiquidity: liquidityCheck.isValid,
        routerValid: pathValidation.isValid,
      });

      return ResponseUtils.success(res, {
        status: overallStatus,
        ...diagnostic,
      }, 'Pool diagnostic completed');
    } catch (error: any) {
      logger.error('Pool diagnostic failed:', error);
      return res.status(500).json({
        success: false,
        status: 'ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  },
};
