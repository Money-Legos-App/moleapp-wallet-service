import { PrismaClient } from '../../../lib/prisma';
import { Address } from 'viem';
import { logger } from '../../../utils/logger.js';
import { EVMChainService, CreateWalletResponse, UserOperationRequest, UserOperationResponse, DeploymentResponse, GasEstimate } from '../../types.js';
import { KernelService } from '../../../services/kernel/account-abstraction.service.js';

/**
 * Base EVM Chain Service
 * Handles common EVM operations with Account Abstraction support
 * Supports Ethereum, Polygon, BSC and other EVM-compatible chains
 */
export class EVMBaseService implements EVMChainService {
  protected prisma: PrismaClient;
  protected kernelService: KernelService;

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;
  }

  /**
   * Create EVM wallet with Account Abstraction support
   */
  async createWallet(params: {
    userId: string;
    subOrgId: string;
    turnkeyUserId: string;
    walletAddress: Address;
    chainConfig: any;
  }): Promise<CreateWalletResponse> {
    const { userId, subOrgId, turnkeyUserId, walletAddress, chainConfig } = params;
    const chainId = chainConfig.chainId;
    const walletName = `${chainConfig.name} Wallet`;

    try {
      logger.info(`Creating EVM wallet for ${chainConfig.name} (chainId: ${chainId})`);

      // Get EOA from TurnkeySigner first to ensure we have the correct owner address
      const turnkeySigner = await this.prisma.turnkeySigner.findFirst({
        where: { turnkeySubOrgId: subOrgId, isActive: true }
      });

      if (!turnkeySigner) {
        throw new Error(`TurnkeySigner not found for sub-org: ${subOrgId}. Please ensure passkey registration is complete before creating wallets.`);
      }

      const eoaAddress = turnkeySigner.address as Address;
      
      // Verify walletAddress matches EOA if provided
      if (walletAddress && walletAddress.toLowerCase() !== eoaAddress.toLowerCase()) {
        logger.warn(`⚠️ [EVM] Address mismatch: walletAddress (${walletAddress}) != TurnkeySigner.address (${eoaAddress}). Using TurnkeySigner.address as EOA.`);
      }

      // Note: Wallet address will be set to smart account address after Kernel account creation
      // For now, check by userId+chainId or create with temporary address
      const existingEvmWallet = await this.prisma.wallet.findFirst({
        where: {
          userId,
          chainId,
          walletType: 'smart_wallet'
        }
      });

      let wallet;
      if (existingEvmWallet) {
        logger.warn(`⚠️ [EVM] Wallet for user ${userId} on chain ${chainId} already exists, updating...`);
        wallet = await this.prisma.wallet.update({
          where: { id: existingEvmWallet.id },
          data: {
            userId,
            name: walletName,
            chainId,
            ownerAddress: eoaAddress, // ✅ Set EOA as owner
            isActive: true,
            lastActivityAt: new Date(),
            metadata: {
              turnkeySubOrgId: subOrgId,
              turnkeyUserId: turnkeyUserId,
              createdVia: 'multichain',
              updatedAt: new Date().toISOString()
            }
          }
        });
      } else {
        // Create wallet with temporary address (will be updated with smart account address)
        // The address will be set to the smart account address after Kernel account creation
        wallet = await this.prisma.wallet.create({
          data: {
            userId,
            address: eoaAddress, // Temporary: will be updated to smart account address
            name: walletName,
            chainId,
            walletType: 'smart_wallet',
            deploymentStatus: 'counterfactual',
            ownerAddress: eoaAddress, // ✅ Set EOA as owner from the start
            isActive: true,
            metadata: {
              turnkeySubOrgId: subOrgId,
              turnkeyUserId: turnkeyUserId,
              createdVia: 'multichain',
              eoaAddress: eoaAddress // Store EOA in metadata for reference
            }
          }
        });
      }

      // Create kernel account for EVM chains (Account Abstraction)
      // ownerAddress MUST be the EOA address from TurnkeySigner
      const kernelAccountResult = await this.kernelService.createKernelAccount(
        userId,
        chainId,
        eoaAddress, // ✅ Use EOA address from TurnkeySigner as owner
        subOrgId,
        wallet.id
      );

      // Update Wallet record with smart account address and EOA as owner
      const smartAccountAddress = kernelAccountResult.address;
      if (wallet.address !== smartAccountAddress) {
        await this.prisma.wallet.update({
          where: { id: wallet.id },
          data: {
            address: smartAccountAddress, // Smart account address
            ownerAddress: eoaAddress,      // EOA address from TurnkeySigner
            deploymentStatus: kernelAccountResult.isDeployed ? 'deployed' : 'counterfactual'
          }
        });
        logger.info(`✅ Updated Wallet record: address=${smartAccountAddress}, ownerAddress=${eoaAddress}`);
      }

      // Note: TurnkeySigner records are now managed by user-service during passkey registration

      const result: CreateWalletResponse = {
        walletId: wallet.id,
        address: smartAccountAddress, // Return smart account address
        chainId,
        deploymentStatus: kernelAccountResult.isDeployed ? 'deployed' : 'counterfactual',
        turnkeySubOrgId: subOrgId,
        turnkeyUserId: turnkeyUserId
      };

      logger.info(`Successfully created EVM wallet: ${result.address} on ${chainConfig.name}`);
      return result;

    } catch (error) {
      logger.error(`Failed to create EVM wallet for ${chainConfig.name}:`, error);
      throw new Error(`Failed to create EVM wallet: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Deploy EVM wallet to blockchain (Account Abstraction)
   */
  async deployWallet(walletId: string): Promise<DeploymentResponse> {
    try {
      // Get wallet info
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: walletId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      // Use kernel service to deploy
      const deploymentResult = await this.kernelService.deployKernelAccount(walletId, wallet.chainId);

      return {
        transactionHash: deploymentResult.transactionHash,
        address: deploymentResult.address,
        isDeployed: true
      };

    } catch (error) {
      logger.error(`Failed to deploy EVM wallet ${walletId}:`, error);
      throw error;
    }
  }

  /**
   * Submit UserOperation (gasless transaction) for EVM chains
   */
  async submitUserOperation(request: UserOperationRequest): Promise<UserOperationResponse> {
    try {
      logger.info(`Submitting UserOperation for EVM wallet ${request.walletId}`);

      // Validate wallet exists and is EVM
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: request.walletId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      if (!wallet.chainId || wallet.chainId === 0) {
        throw new Error('Invalid chain ID for EVM wallet');
      }

      // Submit through kernel service
      const result = await this.kernelService.submitUserOperation(
        request.walletId,
        request.chainId,
        request.calls,
        request.sponsorUserOperation ?? true
      );

      return {
        userOpHash: result.userOpHash,
        sponsored: request.sponsorUserOperation ?? true
      };

    } catch (error) {
      logger.error(`Failed to submit UserOperation:`, error);
      throw error;
    }
  }

  /**
   * Estimate gas for UserOperation
   */
  async estimateGas(request: UserOperationRequest): Promise<GasEstimate> {
    try {
      // Use kernel service to estimate gas
      const gasEstimate = await this.kernelService.estimateUserOperationGas(
        request.walletId,
        request.chainId,
        request.calls
      );

      return {
        callGasLimit: gasEstimate.callGasLimit,
        preVerificationGas: gasEstimate.preVerificationGas,
        verificationGasLimit: gasEstimate.verificationGasLimit,
        maxFeePerGas: gasEstimate.maxFeePerGas,
        maxPriorityFeePerGas: gasEstimate.maxPriorityFeePerGas,
        totalCostUsd: gasEstimate.totalCostUsd
      };

    } catch (error) {
      logger.error(`Failed to estimate gas:`, error);
      throw error;
    }
  }

  /**
   * Ensure TurnkeySigner exists and is properly linked
   */
  // TurnkeySigner management removed - handled by user-service during passkey registration
}