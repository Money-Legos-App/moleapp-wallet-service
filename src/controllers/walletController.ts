import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { WalletOrchestrator } from '../services/wallet/orchestrator.service.js';
import { TurnkeyService } from '../services/turnkey/index.js';
import { ChainServiceFactory } from '../chains/factory.js';
import { KernelService } from '../services/kernel/account-abstraction.service.js';
import { DeFiBundlerService } from '../services/kernel/defi-bundler.service.js';
// WebAuthn removed - authentication handled by user-service
import { ResponseUtils } from "../utils/responseUtils"
import { AppError } from "../utils/appError"
import { logger } from '../utils/logger.js';
import { getTransactionHistory } from '../services/subgraph/index.js';
import { getSupportedChainIds } from '../config/networks.js';
import {
  CreateWalletRequest,
  SignTransactionRequest,
  RecoverWalletRequest,
  UserOperationRequest,
  ErrorResponse
} from '../types/index.js';

// Initialize services for orchestrator
const turnkeyService = new TurnkeyService(prisma);
const kernelService = new KernelService(prisma, turnkeyService);
const deFiBundlerService = new DeFiBundlerService(prisma, kernelService);
const chainFactory = new ChainServiceFactory(prisma, kernelService);
const walletOrchestrator = new WalletOrchestrator(prisma, chainFactory, turnkeyService);

export const walletController = {
  // Wrapper removed - use createMultiChainWallets directly

  // Submit a user operation (gasless transaction)
  async submitUserOperation(req: Request, res: Response) {
    try {
      const userOpRequest: UserOperationRequest = {
        walletId: req.body.walletId,
        chainId: req.body.chainId,
        calls: (req.body.calls || []).map((call: any) => ({
          to: call.to,
          value: BigInt(call.value || '0'),
          data: call.data || '0x',
        })),
        sponsorUserOperation: req.body.sponsorUserOperation !== false
      };

      const result = await walletOrchestrator.submitUserOperation(userOpRequest);
      
      logger.info(`User operation submitted: ${result.userOpHash}`);
      res.status(200).json({
        success: true,
        data: result
      });

    } catch (error: any) {
      logger.error('Error submitting user operation:', error);
      const errorResponse: ErrorResponse = {
        error: 'USER_OPERATION_FAILED',
        code: 'E002',
        message: error.message || 'Failed to submit user operation'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Sign a transaction (legacy method, converts to user operation)
  async signTransaction(req: Request, res: Response) {
    try {
      const signRequest: SignTransactionRequest = {
        walletId: req.body.walletId,
        to: req.body.to,
        value: req.body.value || '0',
        data: req.body.data || '0x',
        chainId: req.body.chainId
      };

      const result = await walletOrchestrator.signTransaction(signRequest);
      
      logger.info(`Transaction signed: ${result.userOpHash}`);
      res.status(200).json({
        success: true,
        data: result
      });

    } catch (error: any) {
      logger.error('Error signing transaction:', error);
      const errorResponse: ErrorResponse = {
        error: 'TRANSACTION_SIGNING_FAILED',
        code: 'E003',
        message: error.message || 'Failed to sign transaction'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Recover wallet using phone number
  async recoverWallet(req: Request, res: Response) {
    try {
      const recoverRequest: RecoverWalletRequest = {
        userId: req.body.userId,
        phoneNumber: req.body.phoneNumber,
        recoveryCode: req.body.recoveryCode,
        passkey: req.body.passkey
      };

      const result = await walletOrchestrator.recoverWallet(recoverRequest);
      
      logger.info(`Wallet recovery completed for user ${recoverRequest.userId}`);
      res.status(200).json({
        success: true,
        data: result
      });

    } catch (error: any) {
      logger.error('Error recovering wallet:', error);
      const errorResponse: ErrorResponse = {
        error: 'WALLET_RECOVERY_FAILED',
        code: 'E004',
        message: error.message || 'Failed to recover wallet'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Wrapper removed - use getUserMultiChainWallets directly

  // Get wallet details by ID
  async getWalletById(req: Request, res: Response) {
    try {
      const { walletId } = req.params;
      
      // Get wallet details using Prisma directly since orchestrator doesn't have getWalletById
      const wallet = await prisma.wallet.findUnique({
        where: { id: walletId },
        include: {
          kernelAccounts: true,
          transactions: {
            take: 5,
            orderBy: { createdAt: 'desc' }
          }
        }
      });
      
      if (!wallet) {
        res.status(404).json({
          success: false,
          error: 'WALLET_NOT_FOUND',
          code: 'E006',
          message: 'Wallet not found'
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: wallet
      });

    } catch (error: any) {
      logger.error('Error getting wallet:', error);
      const errorResponse: ErrorResponse = {
        error: 'GET_WALLET_FAILED',
        code: 'E007',
        message: error.message || 'Failed to get wallet'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Deploy a wallet to blockchain
  async deployWallet(req: Request, res: Response) {
    try {
      const { walletId } = req.params;
      const { chainId } = req.body;
      
      const result = await walletOrchestrator.deployWallet(walletId, chainId);
      
      logger.info(`Wallet ${walletId} deployed on chain ${chainId}`);
      res.status(200).json({
        success: true,
        data: result
      });

    } catch (error: any) {
      logger.error('Error deploying wallet:', error);
      const errorResponse: ErrorResponse = {
        error: 'WALLET_DEPLOYMENT_FAILED',
        code: 'E008',
        message: error.message || 'Failed to deploy wallet'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Health check endpoint
  async healthCheck(req: Request, res: Response) {
    try {
      // Test database connection
      await prisma.$queryRaw`SELECT 1`;
      
      res.status(200).json({
        success: true,
        service: 'wallet-service',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        database: 'connected',
        turnkey: 'configured',
        kernel: 'ready'
      });

    } catch (error: any) {
      logger.error('Health check failed:', error);
      res.status(503).json({
        success: false,
        service: 'wallet-service',
        version: '2.0.0',
        timestamp: new Date().toISOString(),
        database: 'disconnected',
        error: error.message
      });
    }
  },

  // ================================
  // MULTI-CHAIN WALLET METHODS
  // ================================

  // Create wallets for all supported networks
  async createMultiChainWallets(req: Request, res: Response) {
    try {
      const { userId } = req.body;

      if (!userId) {
        return ResponseUtils.error(res, 'User ID is required', 400, {
          code: 'MISSING_USER_ID'
        });
      }

      const results = await walletOrchestrator.createMultiChainWallets(userId);

      logger.info(`Multi-chain wallets created for user ${userId}: ${results.length} wallets`);

      // Return in the format expected by user service
      res.status(200).json({
        success: true,
        data: {
          wallets: results,
          totalCreated: results.length,
          supportedNetworks: results.map(w => ({
            chainId: w.chainId,
            walletId: w.walletId,
            address: w.address,
            deploymentStatus: w.deploymentStatus
          }))
        }
      });

    } catch (error: any) {
      logger.error('Error creating multi-chain wallets:', error);

      if (error instanceof AppError) {
        return ResponseUtils.appErrorResponse(res, error);
      }

      return ResponseUtils.error(res, error.message || 'Failed to create multi-chain wallets', 400, {
        code: 'MULTICHAIN_WALLET_CREATION_FAILED'
      });
    }
  },

  // Get comprehensive multi-chain wallet data for a user
  async getUserMultiChainWallets(req: Request, res: Response) {
    try {
      const { userId } = req.params;

      if (!userId) {
        return ResponseUtils.error(res, 'User ID is required', 400, {
          code: 'MISSING_USER_ID'
        });
      }

      const wallets = await walletOrchestrator.getUserMultiChainWallets(userId);

      logger.info(`Retrieved multi-chain wallets for user ${userId}: ${wallets.length} wallets`);
      return ResponseUtils.success(res, { wallets, totalWallets: wallets.length }, 'Multi-chain wallets retrieved successfully');

    } catch (error: any) {
      logger.error('Error getting user multi-chain wallets:', error);

      const errorResponse: ErrorResponse = {
        error: 'GET_MULTICHAIN_WALLETS_FAILED',
        code: 'E013',
        message: error.message || 'Failed to get user multi-chain wallets'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Validate and reconcile wallet addresses with Turnkey
  async validateAndReconcileWallets(req: Request, res: Response) {
    try {
      const { userId } = req.params;

      if (!userId) {
        return ResponseUtils.error(res, 'User ID is required', 400, {
          code: 'MISSING_USER_ID'
        });
      }

      const result = await walletOrchestrator.validateAndReconcileWallets(userId);

      logger.info(`Wallet reconciliation completed for user ${userId}:`, {
        reconciled: result.reconciled,
        changes: result.changes.length,
        errors: result.errors.length
      });

      if (result.reconciled) {
        return ResponseUtils.success(res, result, 'Wallet addresses validated and reconciled successfully');
      } else {
        return ResponseUtils.error(res, 'Wallet reconciliation failed', 400, {
          code: 'WALLET_RECONCILIATION_FAILED',
          details: result.errors
        });
      }

    } catch (error: any) {
      logger.error('Error validating and reconciling wallets:', error);

      const errorResponse: ErrorResponse = {
        error: 'WALLET_RECONCILIATION_FAILED',
        code: 'E014',
        message: error.message || 'Failed to validate and reconcile wallets'
      };

      res.status(500).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Initialize kernel account for existing wallet (migration helper)
  async initializeKernelAccount(req: Request, res: Response) {
    try {
      const { walletId } = req.params;
      const { chainId } = req.body;

      if (!walletId || !chainId) {
        return ResponseUtils.error(res, 'Wallet ID and chain ID are required', 400, {
          code: 'MISSING_REQUIRED_FIELDS'
        });
      }

      logger.info(`Initializing kernel account for wallet ${walletId} on chain ${chainId}`);

      // Get wallet details
      const wallet = await prisma.wallet.findUnique({
        where: { id: walletId },
        include: { kernelAccounts: true }
      });

      if (!wallet) {
        return ResponseUtils.error(res, 'Wallet not found', 404, {
          code: 'WALLET_NOT_FOUND'
        });
      }

      // Check if kernel account already exists
      const existingKernel = wallet.kernelAccounts.find(ka => ka.chainId === chainId);
      if (existingKernel) {
        logger.info(`Kernel account already exists for wallet ${walletId} on chain ${chainId}`);
        return ResponseUtils.success(res, {
          kernelAccountAddress: existingKernel.address,
          isDeployed: existingKernel.isDeployed,
          alreadyExisted: true
        }, 'Kernel account already initialized');
      }

      // Get Turnkey signer for wallet
      const signer = await prisma.turnkeySigner.findFirst({
        where: { walletId }
      });

      if (!signer || !signer.turnkeySubOrgId) {
        return ResponseUtils.error(res, 'Turnkey signer not found for wallet', 400, {
          code: 'TURNKEY_SIGNER_NOT_FOUND'
        });
      }

      // Create kernel account using the kernel service
      const result = await kernelService.createKernelAccount(
        wallet.userId,
        chainId,
        wallet.address as `0x${string}`,
        signer.turnkeySubOrgId,
        walletId
      );

      logger.info(`Kernel account initialized for wallet ${walletId}:`, {
        address: result.address,
        isDeployed: result.isDeployed
      });

      return ResponseUtils.success(res, {
        kernelAccountAddress: result.address,
        isDeployed: result.isDeployed,
        alreadyExisted: false
      }, 'Kernel account initialized successfully');

    } catch (error: any) {
      logger.error('Error initializing kernel account:', error);

      const errorResponse: ErrorResponse = {
        error: 'KERNEL_ACCOUNT_INIT_FAILED',
        code: 'E016',
        message: error.message || 'Failed to initialize kernel account'
      };

      res.status(500).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // ================================
  // DEFI BUNDLING METHODS
  // ================================

  // Bundle Morpho operations into a single UserOperation
  async bundleMorphoOperations(req: Request, res: Response) {
    try {
      const { walletId, chainId, operations } = req.body;

      if (!walletId || !chainId || !operations || !Array.isArray(operations)) {
        return ResponseUtils.error(res, 'Missing required fields: walletId, chainId, operations', 400, {
          code: 'MISSING_REQUIRED_FIELDS'
        });
      }

      const result = await deFiBundlerService.bundleMorphoOperations(walletId, chainId, operations);

      logger.info(`Morpho operations bundled: ${result.userOpHash} with ${result.bundledCalls} calls`);
      return ResponseUtils.success(res, result, 'Morpho operations bundled successfully');

    } catch (error: any) {
      logger.error('Error bundling Morpho operations:', error);
      const errorResponse: ErrorResponse = {
        error: 'MORPHO_BUNDLING_FAILED',
        code: 'E015',
        message: error.message || 'Failed to bundle Morpho operations'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Bundle swap + DeFi operations
  async bundleSwapAndDeFi(req: Request, res: Response) {
    try {
      const { walletId, chainId, swapOperation, defiOperations } = req.body;

      if (!walletId || !chainId || !swapOperation || !defiOperations) {
        return ResponseUtils.error(res, 'Missing required fields: walletId, chainId, swapOperation, defiOperations', 400, {
          code: 'MISSING_REQUIRED_FIELDS'
        });
      }

      const result = await deFiBundlerService.bundleSwapAndDeFi(walletId, chainId, swapOperation, defiOperations);

      logger.info(`Swap + DeFi operations bundled: ${result.userOpHash} with ${result.bundledCalls} calls`);
      return ResponseUtils.success(res, result, 'Swap + DeFi operations bundled successfully');

    } catch (error: any) {
      logger.error('Error bundling swap + DeFi operations:', error);
      const errorResponse: ErrorResponse = {
        error: 'SWAP_DEFI_BUNDLING_FAILED',
        code: 'E016',
        message: error.message || 'Failed to bundle swap + DeFi operations'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Bundle yield optimization operations
  async bundleYieldOptimization(req: Request, res: Response) {
    try {
      const { walletId, chainId, optimizationStrategy } = req.body;

      if (!walletId || !chainId || !optimizationStrategy) {
        return ResponseUtils.error(res, 'Missing required fields: walletId, chainId, optimizationStrategy', 400, {
          code: 'MISSING_REQUIRED_FIELDS'
        });
      }

      const result = await deFiBundlerService.bundleYieldOptimization(walletId, chainId, optimizationStrategy);

      logger.info(`Yield optimization bundled: ${result.userOpHash} with ${result.bundledCalls} calls`);
      return ResponseUtils.success(res, result, 'Yield optimization operations bundled successfully');

    } catch (error: any) {
      logger.error('Error bundling yield optimization:', error);
      const errorResponse: ErrorResponse = {
        error: 'YIELD_OPTIMIZATION_BUNDLING_FAILED',
        code: 'E017',
        message: error.message || 'Failed to bundle yield optimization operations'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Get DeFi bundled operations for a wallet
  async getDeFiBundledOperations(req: Request, res: Response) {
    try {
      const { walletId } = req.params;
      const { limit = 10, offset = 0, protocol } = req.query;

      if (!walletId) {
        return ResponseUtils.error(res, 'Wallet ID is required', 400, {
          code: 'MISSING_WALLET_ID'
        });
      }

      const whereClause: any = { walletId };
      if (protocol) {
        whereClause.protocol = protocol;
      }

      const operations = await prisma.deFiBundledOperation.findMany({
        where: whereClause,
        take: Number(limit),
        skip: Number(offset),
        orderBy: { createdAt: 'desc' },
        include: {
          wallet: {
            select: {
              id: true,
              userId: true,
              chainId: true
            }
          }
        }
      });

      const total = await prisma.deFiBundledOperation.count({
        where: whereClause
      });

      logger.info(`Retrieved ${operations.length} DeFi bundled operations for wallet ${walletId}`);
      return ResponseUtils.success(res, {
        operations,
        pagination: {
          total,
          limit: Number(limit),
          offset: Number(offset),
          hasMore: Number(offset) + Number(limit) < total
        }
      }, 'DeFi bundled operations retrieved successfully');

    } catch (error: any) {
      logger.error('Error getting DeFi bundled operations:', error);
      const errorResponse: ErrorResponse = {
        error: 'GET_DEFI_OPERATIONS_FAILED',
        code: 'E018',
        message: error.message || 'Failed to get DeFi bundled operations'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // Validate multiple wallet IDs (for storage sync)
  async validateWallets(req: Request, res: Response) {
    try {
      const { walletIds } = req.body;

      if (!Array.isArray(walletIds) || walletIds.length === 0) {
        return ResponseUtils.error(res, 'walletIds must be a non-empty array', 400, {
          code: 'INVALID_WALLET_IDS'
        });
      }

      // Limit to 50 wallet IDs per request to prevent abuse
      if (walletIds.length > 50) {
        return ResponseUtils.error(res, 'Maximum 50 wallet IDs allowed per request', 400, {
          code: 'TOO_MANY_WALLET_IDS'
        });
      }

      // Query database for all wallet IDs
      const existingWallets = await prisma.wallet.findMany({
        where: {
          id: {
            in: walletIds
          }
        },
        select: {
          id: true,
          address: true,
          chainId: true,
          walletType: true,
          deploymentStatus: true,
          isActive: true
        }
      });

      // Create a map of existing wallet IDs for quick lookup
      const existingWalletMap = new Map(
        existingWallets.map(w => [w.id, w])
      );

      // Build validation result for each wallet ID
      const validationResults = walletIds.map(walletId => {
        const wallet = existingWalletMap.get(walletId);
        return {
          walletId,
          exists: !!wallet,
          isActive: wallet?.isActive ?? false,
          wallet: wallet || null
        };
      });

      // Summary stats
      const summary = {
        total: walletIds.length,
        valid: validationResults.filter(r => r.exists && r.isActive).length,
        invalid: validationResults.filter(r => !r.exists).length,
        inactive: validationResults.filter(r => r.exists && !r.isActive).length
      };

      logger.info(`Validated ${walletIds.length} wallets: ${summary.valid} valid, ${summary.invalid} invalid, ${summary.inactive} inactive`);

      return ResponseUtils.success(res, {
        validationResults,
        summary
      }, 'Wallets validated successfully');

    } catch (error: any) {
      logger.error('Error validating wallets:', error);
      const errorResponse: ErrorResponse = {
        error: 'WALLET_VALIDATION_FAILED',
        code: 'E019',
        message: error.message || 'Failed to validate wallets'
      };
      res.status(400).json({
        success: false,
        ...errorResponse
      });
    }
  },

  /**
   * Get multi-chain transaction history for a user.
   * Queries Goldsky subgraphs and merges results across all chains.
   *
   * GET /api/v2/wallet/user/:userId/history?chainId=&limit=&offset=&type=
   */
  async getTransactionHistory(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Number(req.query.offset) || 0;
      const chainId = req.query.chainId ? Number(req.query.chainId) : undefined;
      const type = req.query.type as 'transfer' | 'approval' | 'userop' | undefined;

      if (!userId) {
        return res.status(400).json({ success: false, error: 'userId is required' });
      }

      // Fetch user's wallets + kernel accounts to get all addresses per chain
      const wallets = await prisma.wallet.findMany({
        where: { userId, isActive: true },
        include: { kernelAccounts: true },
      });

      if (!wallets.length) {
        return ResponseUtils.success(res, { items: [], total: 0 }, 'No wallets found');
      }

      // Build list of (chainId, address) pairs
      const addresses: { chainId: number; address: string }[] = [];
      for (const wallet of wallets) {
        // EOA address on each supported EVM chain
        for (const cid of getSupportedChainIds().filter((id): id is number => id !== null)) {
          addresses.push({ chainId: cid, address: wallet.address });
        }
        // Kernel (smart account) addresses
        for (const ka of wallet.kernelAccounts) {
          addresses.push({ chainId: ka.chainId, address: ka.address });
        }
      }

      const result = await getTransactionHistory(addresses, {
        limit,
        offset,
        chainId,
        type,
      });

      return ResponseUtils.success(res, result, 'Transaction history fetched');

    } catch (error: any) {
      logger.error('Error fetching transaction history:', error);
      const errorResponse: ErrorResponse = {
        error: 'TRANSACTION_HISTORY_FAILED',
        code: 'E020',
        message: error.message || 'Failed to fetch transaction history'
      };
      res.status(500).json({
        success: false,
        ...errorResponse
      });
    }
  },

  // ================================
  // WALLET EXPORT
  // ================================

  // Export wallet mnemonic (seed phrase) as encrypted bundle
  async exportWalletMnemonic(req: Request, res: Response) {
    try {
      const { userId } = req.params;
      const { targetPublicKey } = req.body;

      if (!userId) {
        return ResponseUtils.error(res, 'User ID is required', 400, {
          code: 'MISSING_USER_ID'
        });
      }

      if (!targetPublicKey || !/^04[a-fA-F0-9]{128}$/.test(targetPublicKey)) {
        return ResponseUtils.error(res, 'Valid P256 uncompressed public key is required', 400, {
          code: 'INVALID_TARGET_KEY'
        });
      }

      const result = await turnkeyService.exportWalletMnemonic(
        userId,
        targetPublicKey,
        req.ip,
        req.headers['user-agent']
      );

      logger.info(`Wallet mnemonic export bundle generated for user ${userId}`);
      return ResponseUtils.success(res, {
        exportBundle: result.exportBundle,
        exportType: 'WALLET_MNEMONIC'
      }, 'Export bundle generated successfully');

    } catch (error: any) {
      logger.error('Error exporting wallet mnemonic:', error);
      return ResponseUtils.error(
        res,
        error.message || 'Failed to export wallet',
        error.statusCode || 500,
        { code: 'WALLET_EXPORT_FAILED' }
      );
    }
  }
};