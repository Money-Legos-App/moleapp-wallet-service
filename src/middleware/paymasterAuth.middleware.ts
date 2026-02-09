import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';
import { ResponseUtils } from '../utils/responseUtils';

const prisma = new PrismaClient();

/**
 * Extended request with AA binding claims from Keycloak token
 */
export interface AAAuthenticatedRequest extends Request {
  user?: {
    id: string;
    email?: string;
    turnkeySubOrgId?: string;
    walletConfigAddress?: string;
    sessionId?: string;
    roles: string[];
  };
  wallet?: any;
  kernelAccount?: any;
}

/**
 * Verify AA Binding - ensures the token's turnkey_sub_org_id matches the transaction signer
 *
 * This middleware is CRITICAL for Account Abstraction security:
 * - Prevents users from submitting transactions for Smart Accounts they don't own
 * - Verifies the Keycloak token's turnkey_sub_org_id claim matches the signer
 *
 * Flow:
 * 1. Extract turnkey_sub_org_id from token claims (set by Keycloak Protocol Mapper)
 * 2. Extract signer/from address from request body
 * 3. Look up the TurnkeySigner for that wallet address
 * 4. Verify token.turnkey_sub_org_id == signer's turnkeySubOrgId
 */
export const verifyAABinding = async (
  req: AAAuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const tokenSubOrgId = req.user?.turnkeySubOrgId;
    const transactionSigner = req.body.sender || req.body.from || req.body.signer;

    // If no AA binding claim in token, check if this is a service-to-service call
    if (!tokenSubOrgId) {
      // Service accounts (client credentials) won't have turnkey_sub_org_id
      // Allow if it's an internal service call
      const isServiceCall = req.user?.roles?.includes('service-account');
      if (isServiceCall) {
        logger.debug('Service-to-service call, skipping AA binding check');
        return next();
      }

      logger.warn('AA Binding verification failed - no turnkey_sub_org_id in token', {
        userId: req.user?.id,
        path: req.path
      });
      return ResponseUtils.forbidden(res, 'Token does not contain AA binding claim');
    }

    // If no signer provided, skip AA binding check (let route handle it)
    if (!transactionSigner) {
      logger.debug('No signer in request, skipping AA binding check');
      return next();
    }

    // Look up the signer's Turnkey credentials
    const signerAccount = await prisma.turnkeySigner.findFirst({
      where: {
        address: transactionSigner.toLowerCase()
      }
    });

    if (!signerAccount) {
      logger.warn('AA Binding verification failed - signer not found', {
        transactionSigner,
        tokenSubOrgId
      });
      return ResponseUtils.forbidden(res, 'Unknown signer address');
    }

    // CRITICAL: Verify the token's turnkey_sub_org_id matches the signer's
    if (signerAccount.turnkeySubOrgId !== tokenSubOrgId) {
      logger.warn('AA Binding mismatch - token does not authorize this signer', {
        tokenSubOrgId,
        signerSubOrgId: signerAccount.turnkeySubOrgId,
        transactionSigner,
        userId: req.user?.id
      });
      return ResponseUtils.forbidden(res, 'Token does not authorize this Smart Account');
    }

    // AA Binding verified - fetch wallet info and attach to request
    const wallet = signerAccount.walletId
      ? await prisma.wallet.findUnique({ where: { id: signerAccount.walletId } })
      : null;
    req.wallet = wallet;
    logger.debug('AA Binding verified successfully', {
      userId: req.user?.id,
      transactionSigner,
      walletId: signerAccount.walletId
    });

    next();
  } catch (error) {
    logger.error('AA Binding verification error', {
      error: error instanceof Error ? error.message : String(error),
      path: req.path
    });
    return ResponseUtils.error(res, 'AA Binding verification failed', 500);
  }
};

/**
 * Verify Smart Account ownership by wallet_config_address claim
 *
 * Alternative verification using the Smart Account address directly
 * instead of turnkey_sub_org_id
 */
export const verifySmartAccountByClaim = async (
  req: AAAuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const tokenWalletAddress = req.user?.walletConfigAddress;
    const requestedAddress = req.params.address || req.body.sender || req.body.from;

    if (!tokenWalletAddress) {
      logger.warn('No wallet_config_address in token claims');
      return next(); // Allow, let other middleware handle
    }

    if (!requestedAddress) {
      return next();
    }

    // Case-insensitive comparison for Ethereum addresses
    if (tokenWalletAddress.toLowerCase() !== requestedAddress.toLowerCase()) {
      logger.warn('Smart Account address mismatch', {
        tokenAddress: tokenWalletAddress,
        requestedAddress,
        userId: req.user?.id
      });
      return ResponseUtils.forbidden(res, 'Token does not authorize this Smart Account');
    }

    logger.debug('Smart Account ownership verified by claim', {
      walletAddress: requestedAddress,
      userId: req.user?.id
    });

    next();
  } catch (error) {
    logger.error('Smart Account claim verification error', {
      error: error instanceof Error ? error.message : String(error)
    });
    return ResponseUtils.error(res, 'Smart Account verification failed', 500);
  }
};
