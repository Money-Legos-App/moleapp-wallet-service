import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { hashTypedData, keccak256, toBytes } from 'viem';
import { logger } from '../utils/logger.js';

const prisma = new PrismaClient();

/**
 * Agent Controller
 *
 * Handles internal API requests from agent-service for:
 * - Mission management
 * - Turnkey signing for Hyperliquid trades
 * - PnL snapshot recording
 */

export const agentController = {
  /**
   * Create a new agent mission
   * Links to user's existing TurnkeySigner (no new wallet creation)
   */
  createMission: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId, missionType, depositAmount, walletId } = req.body;

      logger.info('Creating agent mission', { userId, missionType, depositAmount, walletId });

      // Find user's existing TurnkeySigner
      const turnkeySigner = await prisma.turnkeySigner.findFirst({
        where: {
          userId,
          walletId,
          isActive: true
        }
      });

      if (!turnkeySigner) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'No active Turnkey signer found for this user/wallet'
        });
      }

      // Determine duration based on mission type
      const durationDays = missionType === 'SHORT_TERM_30D' ? 30 : 45;

      // Get max leverage based on risk level (default MODERATE)
      const maxLeverage = 2;

      // Generate a unique agent keypair for this mission (security isolation)
      const { generateAgentKey } = await import('../utils/agentKeyManager.js');
      const agentKey = generateAgentKey();

      logger.info('Agent key generated for mission', {
        agentAddress: agentKey.address,
        userId,
      });

      // Create the mission with per-mission agent key
      const mission = await prisma.agentMission.create({
        data: {
          userId,
          walletId,
          turnkeySignerId: turnkeySigner.id,
          strategy: missionType,
          riskLevel: 'MODERATE',
          durationDays,
          initialCapital: depositAmount,
          maxLeverage,
          allowedAssets: ['ETH-USD', 'BTC-USD'],
          status: 'PENDING',
          agentAddress: agentKey.address,
          agentPrivateKeyEnc: agentKey.privateKeyEncrypted,
          agentKeyIv: agentKey.iv,
          agentKeyTag: agentKey.authTag,
        }
      });

      logger.info('Mission created with unique agent key', {
        missionId: mission.id,
        userId,
        agentAddress: agentKey.address,
      });

      return res.status(201).json({
        success: true,
        mission: {
          id: mission.id,
          userId: mission.userId,
          walletId: mission.walletId,
          strategy: mission.strategy,
          status: mission.status,
          initialCapital: mission.initialCapital.toString(),
          agentAddress: agentKey.address,
        },
        turnkeySignerId: turnkeySigner.id,
        userWalletAddress: turnkeySigner.address,
        agentAddress: agentKey.address,
      });

    } catch (error: any) {
      logger.error('Failed to create mission', { error: error.message });
      next(error);
    }
  },

  /**
   * Sign a Hyperliquid trade payload
   */
  signTrade: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId, payload } = req.body;

      logger.info('Signing trade', { missionId });

      // Fetch mission with signer info
      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: {
          turnkeySigner: true
        }
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found'
        });
      }

      if (mission.status !== 'ACTIVE') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_STATUS',
          message: `Mission is not active. Current status: ${mission.status}`
        });
      }

      if (!mission.hyperliquidApproved) {
        return res.status(400).json({
          success: false,
          error: 'NOT_APPROVED',
          message: 'Hyperliquid agent not approved for this mission'
        });
      }

      const turnkeySigner = mission.turnkeySigner;
      if (!turnkeySigner) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Turnkey signer not found for mission'
        });
      }

      // Build the message to sign for Hyperliquid
      // Hyperliquid uses EIP-712 typed data signing
      const nonce = Date.now();
      const messageToSign = JSON.stringify({
        ...payload,
        nonce
      });

      // Sign using Turnkey
      const signResult = await signWithTurnkey(
        turnkeySigner.turnkeySubOrgId,
        turnkeySigner.turnkeyUserId,
        messageToSign
      );

      if (!signResult.success) {
        return res.status(500).json({
          success: false,
          error: 'SIGNING_FAILED',
          message: signResult.error
        });
      }

      logger.info('Trade signed successfully', { missionId });

      return res.json({
        success: true,
        signature: signResult.signature,
        signedPayload: {
          action: payload,
          nonce,
          signature: signResult.signature
        },
        nonce
      });

    } catch (error: any) {
      logger.error('Failed to sign trade', { error: error.message });
      next(error);
    }
  },

  /**
   * Batch sign multiple orders
   */
  batchSign: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orders } = req.body;

      logger.info('Batch signing orders', { count: orders.length });

      const results = await Promise.all(
        orders.map(async (order: any) => {
          try {
            // Get mission
            const mission = await prisma.agentMission.findUnique({
              where: { id: order.missionId },
              include: { turnkeySigner: true }
            });

            if (!mission || mission.status !== 'ACTIVE' || !mission.hyperliquidApproved) {
              return {
                success: false,
                error: 'Invalid mission or not active/approved'
              };
            }

            const turnkeySigner = mission.turnkeySigner;
            if (!turnkeySigner) {
              return {
                success: false,
                error: 'Turnkey signer not found'
              };
            }

            const nonce = Date.now();
            const messageToSign = JSON.stringify({
              ...order.payload,
              nonce
            });

            const signResult = await signWithTurnkey(
              turnkeySigner.turnkeySubOrgId,
              turnkeySigner.turnkeyUserId,
              messageToSign
            );

            if (!signResult.success) {
              return {
                success: false,
                error: signResult.error
              };
            }

            return {
              success: true,
              signature: signResult.signature,
              signedPayload: {
                action: order.payload,
                nonce,
                signature: signResult.signature
              },
              nonce
            };

          } catch (e: any) {
            return {
              success: false,
              error: e.message
            };
          }
        })
      );

      const successCount = results.filter(r => r.success).length;
      logger.info('Batch signing completed', {
        total: orders.length,
        successful: successCount,
        failed: orders.length - successCount
      });

      return res.json({
        success: true,
        results
      });

    } catch (error: any) {
      logger.error('Failed to batch sign', { error: error.message });
      next(error);
    }
  },

  /**
   * Sign agent approval transaction for Hyperliquid
   */
  signAgentApproval: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId, agentAddress } = req.body;

      logger.info('Signing agent approval', { missionId, agentAddress });

      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: { turnkeySigner: true }
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found'
        });
      }

      const turnkeySigner = mission.turnkeySigner;
      if (!turnkeySigner) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Turnkey signer not found'
        });
      }

      // Build Hyperliquid agent approval message
      const nonce = Date.now();
      const approvalPayload = {
        type: 'approveAgent',
        hyperliquidChain: process.env.HYPERLIQUID_MAINNET === 'true' ? 'Mainnet' : 'Testnet',
        agentAddress,
        agentName: 'MoleApp Trading Agent',
        nonce
      };

      const messageToSign = JSON.stringify(approvalPayload);

      const signResult = await signWithTurnkey(
        turnkeySigner.turnkeySubOrgId,
        turnkeySigner.turnkeyUserId,
        messageToSign
      );

      if (!signResult.success) {
        return res.status(500).json({
          success: false,
          error: 'SIGNING_FAILED',
          message: signResult.error
        });
      }

      logger.info('Agent approval signed', { missionId });

      return res.json({
        success: true,
        signature: signResult.signature,
        signedPayload: {
          action: approvalPayload,
          nonce,
          signature: signResult.signature
        },
        nonce
      });

    } catch (error: any) {
      logger.error('Failed to sign agent approval', { error: error.message });
      next(error);
    }
  },

  /**
   * Validate mission and agent approval status
   */
  validateMission: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId } = req.params;

      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: { turnkeySigner: true }
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found'
        });
      }

      const isValid = mission.status === 'ACTIVE' && mission.hyperliquidApproved;

      return res.json({
        success: true,
        isValid,
        reason: !isValid
          ? (mission.status !== 'ACTIVE' ? `Mission status is ${mission.status}` : 'Agent not approved')
          : null,
        userWalletAddress: mission.turnkeySigner?.address,
        hyperliquidApproved: mission.hyperliquidApproved,
        status: mission.status
      });

    } catch (error: any) {
      logger.error('Failed to validate mission', { error: error.message });
      next(error);
    }
  },

  /**
   * Get full mission details
   */
  getMissionDetails: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId } = req.params;

      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: {
          turnkeySigner: true,
          positions: {
            where: { status: 'OPEN' }
          }
        }
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found'
        });
      }

      return res.json({
        success: true,
        mission: {
          id: mission.id,
          userId: mission.userId,
          walletId: mission.walletId,
          strategy: mission.strategy,
          riskLevel: mission.riskLevel,
          status: mission.status,
          initialCapital: mission.initialCapital.toString(),
          currentValue: mission.currentValue?.toString(),
          totalPnl: mission.totalPnl.toString(),
          totalTrades: mission.totalTrades,
          winRate: mission.winRate,
          maxDrawdown: mission.maxDrawdown,
          maxLeverage: mission.maxLeverage,
          allowedAssets: mission.allowedAssets,
          durationDays: mission.durationDays,
          startedAt: mission.startedAt,
          endsAt: mission.endsAt,
          hyperliquidApproved: mission.hyperliquidApproved,
          agentAddress: mission.agentAddress,
          createdAt: mission.createdAt
        },
        userWalletAddress: mission.turnkeySigner?.address,
        turnkeySignerId: mission.turnkeySignerId,
        agentAddress: mission.agentAddress,
        openPositionsCount: mission.positions.length
      });

    } catch (error: any) {
      logger.error('Failed to get mission details', { error: error.message });
      next(error);
    }
  },

  /**
   * Update mission status
   */
  updateMissionStatus: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId } = req.params;
      const { status, metadata } = req.body;

      logger.info('Updating mission status', { missionId, status });

      const updateData: any = { status };

      // Handle status-specific updates
      if (status === 'ACTIVE' && !metadata?.startedAt) {
        updateData.startedAt = new Date();
        // Calculate end date
        const mission = await prisma.agentMission.findUnique({
          where: { id: missionId },
          select: { durationDays: true }
        });
        if (mission) {
          updateData.endsAt = new Date(Date.now() + mission.durationDays * 24 * 60 * 60 * 1000);
        }
      }

      if (status === 'PAUSED') {
        updateData.pausedAt = new Date();
      }

      if (status === 'COMPLETED' || status === 'LIQUIDATED' || status === 'REVOKED') {
        updateData.completedAt = new Date();
      }

      // Merge any additional metadata
      if (metadata) {
        Object.assign(updateData, metadata);
      }

      const mission = await prisma.agentMission.update({
        where: { id: missionId },
        data: updateData
      });

      logger.info('Mission status updated', { missionId, newStatus: status });

      return res.json({
        success: true,
        mission: {
          id: mission.id,
          status: mission.status,
          startedAt: mission.startedAt,
          endsAt: mission.endsAt,
          completedAt: mission.completedAt
        }
      });

    } catch (error: any) {
      logger.error('Failed to update mission status', { error: error.message });
      next(error);
    }
  },

  /**
   * Record PnL snapshot
   */
  recordPnlSnapshot: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId } = req.params;
      const { totalValue, totalPnl, unrealizedPnl, realizedPnl } = req.body;

      logger.info('Recording PnL snapshot', { missionId, totalValue, totalPnl });

      // Create snapshot
      const snapshot = await prisma.agentPnLSnapshot.create({
        data: {
          missionId,
          totalValue,
          totalPnl,
          unrealizedPnl,
          realizedPnl
        }
      });

      // Also update mission's current value and PnL
      await prisma.agentMission.update({
        where: { id: missionId },
        data: {
          currentValue: totalValue,
          totalPnl
        }
      });

      logger.info('PnL snapshot recorded', { snapshotId: snapshot.id, missionId });

      return res.status(201).json({
        success: true,
        snapshot: {
          id: snapshot.id,
          missionId: snapshot.missionId,
          timestamp: snapshot.timestamp,
          totalValue: snapshot.totalValue.toString(),
          totalPnl: snapshot.totalPnl.toString()
        }
      });

    } catch (error: any) {
      logger.error('Failed to record PnL snapshot', { error: error.message });
      next(error);
    }
  },

  /**
   * Sign EIP-712 typed data for Hyperliquid orders
   * This is the correct method for proper Hyperliquid signing
   */
  signTypedData: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId, typedData } = req.body;

      logger.info('Signing EIP-712 typed data', {
        missionId,
        primaryType: typedData?.primaryType
      });

      // Validate typed data structure
      if (!typedData || !typedData.domain || !typedData.types || !typedData.message) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_TYPED_DATA',
          message: 'Missing required typed data fields (domain, types, message)'
        });
      }

      // Fetch mission with signer info
      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: {
          turnkeySigner: true
        }
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found'
        });
      }

      if (mission.status !== 'ACTIVE') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_STATUS',
          message: `Mission is not active. Current status: ${mission.status}`
        });
      }

      if (!mission.hyperliquidApproved) {
        return res.status(400).json({
          success: false,
          error: 'NOT_APPROVED',
          message: 'Hyperliquid agent not approved for this mission'
        });
      }

      const turnkeySigner = mission.turnkeySigner;
      if (!turnkeySigner) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Turnkey signer not found for mission'
        });
      }

      // Sign using Turnkey's signTypedData
      const signResult = await signTypedDataWithTurnkey(
        turnkeySigner.turnkeySubOrgId,
        turnkeySigner.turnkeyUserId,
        typedData
      );

      if (!signResult.success) {
        return res.status(500).json({
          success: false,
          error: 'SIGNING_FAILED',
          message: signResult.error
        });
      }

      logger.info('EIP-712 typed data signed successfully', { missionId });

      return res.json({
        success: true,
        signature: signResult.signature,
        typedData,
        nonce: typedData.message.nonce
      });

    } catch (error: any) {
      logger.error('Failed to sign typed data', { error: error.message });
      next(error);
    }
  },

  /**
   * Sign EIP-712 typed data using the mission's per-mission agent key.
   * This is the FAST PATH for trade signing - local key, zero Turnkey latency.
   *
   * Used for Phase C (Trading) where the agent signs orders.
   * The agent key was generated at mission creation and stored encrypted.
   */
  signWithAgentKey: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId, typedData } = req.body;

      logger.info('Signing with per-mission agent key', {
        missionId,
        primaryType: typedData?.primaryType,
      });

      if (!typedData || !typedData.domain || !typedData.types || !typedData.message) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_TYPED_DATA',
          message: 'Missing required typed data fields',
        });
      }

      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found',
        });
      }

      if (mission.status !== 'ACTIVE') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_STATUS',
          message: `Mission is not active. Current: ${mission.status}`,
        });
      }

      if (!mission.agentPrivateKeyEnc || !mission.agentKeyIv || !mission.agentKeyTag) {
        return res.status(400).json({
          success: false,
          error: 'NO_AGENT_KEY',
          message: 'Mission has no agent key configured',
        });
      }

      // Decrypt the mission's agent private key
      const { decryptAgentKey, signWithAgentKey } = await import('../utils/agentKeyManager.js');
      const privateKey = decryptAgentKey(
        mission.agentPrivateKeyEnc,
        mission.agentKeyIv,
        mission.agentKeyTag,
      );

      // Sign using the local agent key (zero latency)
      const signature = await signWithAgentKey(privateKey, typedData);

      logger.info('Trade signed with per-mission agent key', {
        missionId,
        agentAddress: mission.agentAddress,
      });

      return res.json({
        success: true,
        signature,
        agentAddress: mission.agentAddress,
        typedData,
        nonce: typedData.message?.nonce,
      });

    } catch (error: any) {
      logger.error('Agent key signing failed', { error: error.message });
      next(error);
    }
  },

  /**
   * Batch sign EIP-712 typed data using per-mission agent keys.
   * Fast path: decrypts each mission's key and signs locally.
   */
  batchSignWithAgentKey: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orders } = req.body;

      logger.info('Batch signing with agent keys', { count: orders?.length });

      if (!orders || !Array.isArray(orders)) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_REQUEST',
          message: 'Orders array is required',
        });
      }

      const { decryptAgentKey, signWithAgentKey } = await import('../utils/agentKeyManager.js');

      const results = await Promise.all(
        orders.map(async (order: any) => {
          try {
            const { missionId, typedData } = order;

            const mission = await prisma.agentMission.findUnique({
              where: { id: missionId },
            });

            if (!mission || mission.status !== 'ACTIVE' || !mission.hyperliquidApproved) {
              return { success: false, error: 'Invalid mission or not active/approved' };
            }

            if (!mission.agentPrivateKeyEnc || !mission.agentKeyIv || !mission.agentKeyTag) {
              return { success: false, error: 'No agent key configured' };
            }

            const privateKey = decryptAgentKey(
              mission.agentPrivateKeyEnc,
              mission.agentKeyIv,
              mission.agentKeyTag,
            );

            const signature = await signWithAgentKey(privateKey, typedData);

            return {
              success: true,
              signature,
              agentAddress: mission.agentAddress,
              nonce: typedData.message?.nonce,
            };

          } catch (e: any) {
            return { success: false, error: e.message };
          }
        })
      );

      const successCount = results.filter(r => r.success).length;
      logger.info('Batch agent key signing completed', {
        total: orders.length,
        successful: successCount,
        failed: orders.length - successCount,
      });

      return res.json({ success: true, results });

    } catch (error: any) {
      logger.error('Batch agent key signing failed', { error: error.message });
      next(error);
    }
  },

  /**
   * Batch sign EIP-712 typed data for multiple orders
   */
  batchSignTypedData: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { orders } = req.body;

      logger.info('Batch signing EIP-712 typed data', { count: orders?.length });

      if (!orders || !Array.isArray(orders)) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_REQUEST',
          message: 'Orders array is required'
        });
      }

      const results = await Promise.all(
        orders.map(async (order: any) => {
          try {
            const { missionId, typedData } = order;

            // Get mission
            const mission = await prisma.agentMission.findUnique({
              where: { id: missionId },
              include: { turnkeySigner: true }
            });

            if (!mission || mission.status !== 'ACTIVE' || !mission.hyperliquidApproved) {
              return {
                success: false,
                error: 'Invalid mission or not active/approved'
              };
            }

            const turnkeySigner = mission.turnkeySigner;
            if (!turnkeySigner) {
              return {
                success: false,
                error: 'Turnkey signer not found'
              };
            }

            const signResult = await signTypedDataWithTurnkey(
              turnkeySigner.turnkeySubOrgId,
              turnkeySigner.turnkeyUserId,
              typedData
            );

            if (!signResult.success) {
              return {
                success: false,
                error: signResult.error
              };
            }

            return {
              success: true,
              signature: signResult.signature,
              nonce: typedData.message?.nonce
            };

          } catch (e: any) {
            return {
              success: false,
              error: e.message
            };
          }
        })
      );

      const successCount = results.filter(r => r.success).length;
      logger.info('Batch EIP-712 signing completed', {
        total: orders.length,
        successful: successCount,
        failed: orders.length - successCount
      });

      return res.json({
        success: true,
        results
      });

    } catch (error: any) {
      logger.error('Failed to batch sign typed data', { error: error.message });
      next(error);
    }
  },

  /**
   * Deposit USDC to Hyperliquid via the bridge on Arbitrum Sepolia.
   *
   * Flow:
   * 1. Validate mission exists and is PENDING
   * 2. Find/create Kernel account on Arbitrum Sepolia
   * 3. Bundle USDC.approve + HLBridge.sendUsd into a single gasless UserOp
   * 4. Update mission status to DEPOSITING
   * 5. Return userOpHash for tracking
   */
  depositToHyperliquid: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId, amount, chainId } = req.body;

      logger.info('Initiating HL bridge deposit', { missionId, amount, chainId });

      // Fetch mission with signer and wallet info
      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: { turnkeySigner: true },
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found',
        });
      }

      if (mission.status !== 'PENDING') {
        return res.status(400).json({
          success: false,
          error: 'INVALID_STATUS',
          message: `Mission must be PENDING to deposit. Current: ${mission.status}`,
        });
      }

      const turnkeySigner = mission.turnkeySigner;
      if (!turnkeySigner) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Turnkey signer not found for mission',
        });
      }

      // Ensure Kernel account exists on Arbitrum Sepolia
      const targetChainId = chainId || 421614;
      let kernelAccount = await prisma.kernelAccount.findFirst({
        where: { walletId: mission.walletId, chainId: targetChainId },
      });

      if (!kernelAccount) {
        // Create Kernel account on Arbitrum Sepolia
        const { KernelAccountFactory } = await import('../services/kernel/account-factory.service.js');
        const { TurnkeyEVMSignerService } = await import('../services/turnkey/evm-signer.service.js');

        const evmSigner = new TurnkeyEVMSignerService(prisma);
        const factory = new KernelAccountFactory(prisma, evmSigner);

        const accountResult = await factory.createKernelAccount(
          mission.userId,
          targetChainId,
          turnkeySigner.address as `0x${string}`,
          turnkeySigner.turnkeySubOrgId,
          mission.walletId,
        );

        kernelAccount = await prisma.kernelAccount.findFirst({
          where: { walletId: mission.walletId, chainId: targetChainId },
        });

        if (!kernelAccount) {
          return res.status(500).json({
            success: false,
            error: 'ACCOUNT_CREATION_FAILED',
            message: 'Failed to create Kernel account on Arbitrum Sepolia',
          });
        }

        logger.info('Kernel account created on Arbitrum Sepolia', {
          address: accountResult.address,
          chainId: targetChainId,
        });
      }

      // Build and submit the deposit UserOperation
      const { HyperliquidBridgeService } = await import('../services/kernel/hyperliquid-bridge.service.js');
      const { KernelService } = await import('../services/kernel/account-abstraction.service.js');
      const { TurnkeyService } = await import('../services/turnkey/index.js');
      const turnkeyService = new TurnkeyService(prisma);
      const kernelService = new KernelService(prisma, turnkeyService);
      const bridgeService = new HyperliquidBridgeService(prisma, kernelService);

      // Convert USDC amount to atomic units (6 decimals)
      const usdcAmount = BigInt(Math.floor(parseFloat(amount) * 1e6));

      const result = await bridgeService.depositToHyperliquid(
        mission.walletId,
        missionId,
        usdcAmount,
        turnkeySigner.address as `0x${string}`,
      );

      // Update mission status to DEPOSITING
      await prisma.agentMission.update({
        where: { id: missionId },
        data: {
          status: 'DEPOSITING',
          metadata: {
            ...(mission.metadata as any || {}),
            depositUserOpHash: result.userOpHash,
            depositChainId: targetChainId,
            depositAmount: amount,
            depositInitiatedAt: new Date().toISOString(),
          },
        },
      });

      logger.info('HL bridge deposit initiated', {
        missionId,
        userOpHash: result.userOpHash,
        amount,
      });

      return res.json({
        success: true,
        userOpHash: result.userOpHash,
        status: 'DEPOSITING',
        chainId: targetChainId,
      });

    } catch (error: any) {
      logger.error('HL bridge deposit failed', { error: error.message });
      next(error);
    }
  },

  /**
   * Initiate withdrawal from Hyperliquid back to the user's smart wallet.
   *
   * IMPORTANT: On Hyperliquid, only the MASTER address can withdraw funds.
   * The agent cannot withdraw. This endpoint signs the withdrawal request
   * using the user's Turnkey master EOA.
   *
   * Flow:
   * 1. Validate mission and that it's in a terminal/winding-down state
   * 2. Build HL L1 withdrawal request (EIP-712)
   * 3. Sign with user's master EOA via Turnkey
   * 4. Return signed withdrawal for submission to Hyperliquid
   */
  withdrawFromHyperliquid: async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { missionId, amount } = req.body;

      logger.info('Initiating HL withdrawal', { missionId, amount });

      const mission = await prisma.agentMission.findUnique({
        where: { id: missionId },
        include: { turnkeySigner: true },
      });

      if (!mission) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Mission not found',
        });
      }

      // Withdrawal is allowed from ACTIVE, COMPLETED, REVOKED states
      const allowedStatuses = ['ACTIVE', 'COMPLETED', 'REVOKED', 'PAUSED'];
      if (!allowedStatuses.includes(mission.status)) {
        return res.status(400).json({
          success: false,
          error: 'INVALID_STATUS',
          message: `Cannot withdraw in ${mission.status} status`,
        });
      }

      const turnkeySigner = mission.turnkeySigner;
      if (!turnkeySigner) {
        return res.status(404).json({
          success: false,
          error: 'NOT_FOUND',
          message: 'Turnkey signer not found for mission',
        });
      }

      // Build EIP-712 withdrawal request for Hyperliquid
      // This must be signed by the MASTER (user's Turnkey EOA), not the agent
      const nonce = Date.now();
      const isMainnet = process.env.HYPERLIQUID_MAINNET === 'true';

      const withdrawTypedData = {
        domain: {
          name: 'HyperliquidSignTransaction',
          version: '1',
          chainId: isMainnet ? 1 : 1337,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        },
        types: {
          'HyperliquidTransaction:Withdraw': [
            { name: 'hyperliquidChain', type: 'string' },
            { name: 'destination', type: 'string' },
            { name: 'amount', type: 'string' },
            { name: 'time', type: 'uint64' },
          ],
        },
        primaryType: 'HyperliquidTransaction:Withdraw',
        message: {
          hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet',
          destination: turnkeySigner.address,
          amount: amount,
          time: nonce,
        },
      };

      // Sign with the user's master EOA (not the agent)
      const signResult = await signTypedDataWithTurnkey(
        turnkeySigner.turnkeySubOrgId,
        turnkeySigner.turnkeyUserId,
        withdrawTypedData,
      );

      if (!signResult.success) {
        return res.status(500).json({
          success: false,
          error: 'SIGNING_FAILED',
          message: signResult.error,
        });
      }

      logger.info('HL withdrawal signed by master EOA', { missionId });

      return res.json({
        success: true,
        signature: signResult.signature,
        withdrawalPayload: {
          action: {
            type: 'withdraw3',
            hyperliquidChain: isMainnet ? 'Mainnet' : 'Testnet',
            signatureChainId: isMainnet ? '0x1' : '0x539',
            destination: turnkeySigner.address,
            amount: amount,
            time: nonce,
          },
          nonce,
          signature: signResult.signature,
        },
      });

    } catch (error: any) {
      logger.error('HL withdrawal signing failed', { error: error.message });
      next(error);
    }
  },
};

/**
 * Helper function to sign with Turnkey (legacy - for simple messages)
 * This uses the existing Turnkey service infrastructure
 */
async function signWithTurnkey(
  subOrgId: string,
  userId: string,
  message: string
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    // Use Turnkey EVM signer service for signing
    // The message will be signed using the user's Turnkey private key
    const { EvmSignerService } = await import('../services/turnkey/evm-signer.service.js');

    const signer = new EvmSignerService();

    // Hash the message for signing using viem
    const messageHash = keccak256(toBytes(message));

    // Sign using Turnkey (this calls the Turnkey API)
    const signature = await signer.signMessage(
      subOrgId,
      messageHash
    );

    return {
      success: true,
      signature
    };

  } catch (error: any) {
    logger.error('Turnkey signing failed', { error: error.message, subOrgId });
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Sign EIP-712 typed data with Turnkey
 * This is the correct method for Hyperliquid order signing
 */
async function signTypedDataWithTurnkey(
  subOrgId: string,
  userId: string,
  typedData: {
    domain: {
      name?: string;
      version?: string;
      chainId?: number;
      verifyingContract?: string;
    };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType?: string;
    message: Record<string, any>;
  }
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const { EvmSignerService } = await import('../services/turnkey/evm-signer.service.js');
    const signer = new EvmSignerService();

    // Remove EIP712Domain from types if present (viem adds it automatically)
    const typesWithoutDomain = { ...typedData.types };
    delete typesWithoutDomain['EIP712Domain'];

    // Determine the primary type
    const primaryType = typedData.primaryType || Object.keys(typesWithoutDomain).find(k => k !== 'EIP712Domain') || 'Message';

    // Use viem to compute the EIP-712 hash for logging
    const typedDataHash = hashTypedData({
      domain: typedData.domain as any,
      types: typesWithoutDomain as any,
      primaryType,
      message: typedData.message
    });

    logger.info('Signing EIP-712 typed data', {
      subOrgId,
      primaryType,
      typedDataHash,
    });

    // Sign the typed data using Turnkey via viem
    const signature = await signer.signTypedData(
      subOrgId,
      typedData.domain as any,
      typesWithoutDomain,
      typedData.message
    );

    return {
      success: true,
      signature
    };

  } catch (error: any) {
    logger.error('Turnkey EIP-712 signing failed', { error: error.message, subOrgId });
    return {
      success: false,
      error: error.message
    };
  }
}
