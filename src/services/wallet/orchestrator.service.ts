import { PrismaClient } from '../../lib/prisma';
import { Address } from 'viem';
import { logger } from '../../utils/logger.js';
import { ChainServiceFactory } from '../../chains/factory.js';
import { TurnkeyService } from '../turnkey/index.js';
import { NETWORKS, getSupportedChainKeys, getNetworkConfig } from '../../config/networks.js';
import {
  CreateWalletResponse,
  UserOperationRequest,
  UserOperationResponse,
  SignTransactionRequest,
  SignTransactionResponse,
  RecoverWalletRequest,
  RecoverWalletResponse
} from '../../types/index.js';

/**
 * Wallet Orchestrator Service
 * Coordinates multi-chain wallet operations using chain-specific services
 * Replaces the monolithic walletService with a modular approach
 */
export class WalletOrchestrator {
  private prisma: PrismaClient;
  private chainFactory: ChainServiceFactory;
  private turnkeyService: TurnkeyService;

  constructor(prisma: PrismaClient, chainFactory: ChainServiceFactory, turnkeyService: TurnkeyService) {
    this.prisma = prisma;
    this.chainFactory = chainFactory;
    this.turnkeyService = turnkeyService;
  }

  /**
   * Create wallets for all supported networks (multi-chain wallet setup)
   * This ensures the user has access to all supported blockchain networks
   */
  async createMultiChainWallets(userId: string): Promise<CreateWalletResponse[]> {
    // Use a simple in-memory lock to prevent race conditions for the same userId
    const lockKey = `wallet_creation_${userId}`;
    const existingLock = (this as any)._locks?.[lockKey];

    if (existingLock) {
      logger.info(`Wallet creation already in progress for user ${userId}, waiting...`);
      await existingLock;

      // Return existing wallets after lock is released
      const existingWallets = await this.prisma.wallet.findMany({
        where: { userId, isActive: true },
        include: { kernelAccounts: true }
      });

      // Fetch turnkey signers for existing wallets
      const signers = await this.prisma.turnkeySigner.findMany({
        where: { userId }
      });
      const signerMap = new Map(signers.map(s => [s.walletId, s]));

      return existingWallets.map(w => {
        const signer = signerMap.get(w.id) || w.kernelAccounts[0];
        return {
          walletId: w.id,
          address: w.address as Address,
          chainId: w.chainId || 0,
          deploymentStatus: w.deploymentStatus as 'counterfactual' | 'deployed',
          turnkeySubOrgId: signer?.turnkeySubOrgId || '',
          turnkeyUserId: signer?.turnkeyUserId || ''
        };
      });
    }

    // Create lock promise
    let resolveLock: () => void;
    const lockPromise = new Promise<void>((resolve) => { resolveLock = resolve; });
    if (!(this as any)._locks) (this as any)._locks = {};
    (this as any)._locks[lockKey] = lockPromise;

    try {
      logger.info(`Creating multi-chain wallets for user ${userId}`);

      // Get user information
      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new Error('User not found');
      }

      // Check existing wallets to avoid duplicates (double-check within lock)
      const existingWallets = await this.prisma.wallet.findMany({
        where: { userId, isActive: true },
        include: {
          kernelAccounts: true
        }
      });

      const existingChainIds = new Set(existingWallets.map(w => w.chainId));
      logger.info(`User ${userId} already has wallets on chains: [${Array.from(existingChainIds).join(', ')}]`);

      // Get all supported chain keys
      const supportedChainKeys = getSupportedChainKeys();
      const results: CreateWalletResponse[] = [];

      // Create Turnkey sub-organization once (reuse for all wallets)
      let sharedSubOrgId: string | undefined;
      let sharedTurnkeyUserId: string | undefined;
      let turnkeyAddresses: any = {};

      // Process each supported network
      for (const chainKey of supportedChainKeys) {
        try {
          const networkConfig = getNetworkConfig(chainKey);
          const chainId = networkConfig.chainId; // null for non-EVM chains

          // Create unique identifier for chain comparison
          const chainIdentifier = chainId || chainKey;

          // Skip if wallet already exists for this chain
          const existingWallet = existingWallets.find(w =>
            (chainId && w.chainId === chainId) ||
            (!chainId && w.metadata && (w.metadata as any).chainKey === chainKey)
          );

          if (existingWallet) {
            logger.info(`Wallet already exists for ${chainKey}`);

            const signer = await this.prisma.turnkeySigner.findFirst({
              where: { walletId: existingWallet.id }
            });

            results.push({
              walletId: existingWallet.id,
              address: existingWallet.address as Address,
              chainId: existingWallet.chainId || 0, // 0 for non-EVM
              deploymentStatus: existingWallet.deploymentStatus as 'counterfactual' | 'deployed',
              turnkeySubOrgId: signer?.turnkeySubOrgId || '',
              turnkeyUserId: signer?.turnkeyUserId || ''
            });
            continue;
          }

          logger.info(`Creating wallet for ${chainKey} (chainType: ${networkConfig.chainType})`);

          // Initialize shared sub-org on first wallet creation
          if (!sharedSubOrgId) {
            logger.info(`🔧 [ORCHESTRATOR] Initializing shared Turnkey sub-org for user ${userId}`);

            // PRIORITY 1: Check if user already has Turnkey credentials stored (from user-service registration)
            if (user.turnkeySubOrgId && user.turnkeyUserId) {
              sharedSubOrgId = user.turnkeySubOrgId;
              sharedTurnkeyUserId = user.turnkeyUserId;
              logger.info(`♻️ [ORCHESTRATOR] Using existing sub-org from user record: ${sharedSubOrgId}`);

              // Check if TurnkeySigner record exists for wallet creation
              const existingSignerForUserCreds = await this.prisma.turnkeySigner.findFirst({
                where: { turnkeySubOrgId: sharedSubOrgId, userId }
              });

              if (!existingSignerForUserCreds) {
                // Create TurnkeySigner record for wallet creation compatibility
                // This happens when user-service creates the sub-org but wallet-service hasn't created the signer record yet
                logger.info(`🔧 [ORCHESTRATOR] Creating TurnkeySigner record for existing sub-org ${sharedSubOrgId}`);

                // Fetch addresses from Turnkey to populate the signer record
                const allAddresses = await this.turnkeyService.getAllWalletsFromTurnkey(sharedSubOrgId);

                try {
                  const phoneHash = require('crypto')
                    .createHash('sha256')
                    .update(user.phoneNumber + (process.env.TURNKEY_API_PRIVATE_KEY || ''))
                    .digest('hex');

                  await this.prisma.turnkeySigner.create({
                    data: {
                      userId,
                      turnkeyUserId: sharedTurnkeyUserId,
                      turnkeySubOrgId: sharedSubOrgId,
                      publicKey: `temp-public-key-${sharedSubOrgId.slice(0, 8)}`,
                      address: allAddresses.ethereum || '',
                      phoneHash: phoneHash,
                      isActive: true,
                      passkeyConfig: {
                        allChainAddresses: {
                          'ETH_SEPOLIA': {
                            address: allAddresses.ethereum,
                            chainType: 'EVM',
                            addressFormat: 'ETHEREUM',
                            curve: 'CURVE_SECP256K1'
                          },
                          'BNB_TESTNET': {
                            address: allAddresses.ethereum,
                            chainType: 'EVM',
                            addressFormat: 'ETHEREUM',
                            curve: 'CURVE_SECP256K1'
                          },
                          'SOLANA_DEVNET': allAddresses.solana ? {
                            address: allAddresses.solana,
                            chainType: 'SOLANA',
                            addressFormat: 'SOLANA',
                            curve: 'CURVE_ED25519'
                          } : undefined,
                          'BITCOIN_TESTNET': allAddresses.bitcoin ? {
                            address: allAddresses.bitcoin,
                            chainType: 'BITCOIN',
                            addressFormat: 'BITCOIN',
                            curve: 'CURVE_SECP256K1'
                          } : undefined
                        }
                      },
                      authMethods: ['turnkey']
                    }
                  });

                  logger.info(`✅ [ORCHESTRATOR] Created TurnkeySigner record for sub-org ${sharedSubOrgId}`);
                } catch (signerError) {
                  logger.warn(`⚠️ [ORCHESTRATOR] TurnkeySigner creation failed (may already exist):`, {
                    error: signerError instanceof Error ? signerError.message : String(signerError)
                  });
                }
              }
            } else {
              // PRIORITY 2: Check if user already has a sub-org in TurnkeySigner table (legacy)
              const existingSigner = await this.prisma.turnkeySigner.findFirst({
                where: { userId }
              });

              if (existingSigner && existingSigner.turnkeySubOrgId) {
                sharedSubOrgId = existingSigner.turnkeySubOrgId;
                sharedTurnkeyUserId = existingSigner.turnkeyUserId;
                logger.info(`♻️ [ORCHESTRATOR] Using existing sub-org from signer: ${sharedSubOrgId}`);
              } else {
                // PRIORITY 3: Create new sub-org (only if no existing credentials found)
                logger.info(`🆕 [ORCHESTRATOR] Creating new sub-org for user ${userId}`);
                const createResult = await this.turnkeyService.createSubOrganizationForUser(
                  userId,
                  user.phoneNumber,
                  user.email || undefined
                );
                sharedSubOrgId = createResult.subOrgId;
                sharedTurnkeyUserId = createResult.turnkeyUserId;
              }
            }

            // Fetch all addresses from Turnkey
            try {
              if (!sharedSubOrgId) {
                throw new Error('Turnkey sub-org ID is required but not available');
              }
              logger.info(`📡 [ORCHESTRATOR] Fetching all addresses from Turnkey for sub-org: ${sharedSubOrgId}`);
              turnkeyAddresses = await this.turnkeyService.getAllWalletsFromTurnkey(sharedSubOrgId);
              logger.info(`📋 [ORCHESTRATOR] Fetched addresses from Turnkey:`, {
                subOrgId: sharedSubOrgId,
                ethereum: turnkeyAddresses.ethereum,
                solana: turnkeyAddresses.solana,
                bitcoin: turnkeyAddresses.bitcoin
              });
            } catch (error) {
              logger.error(`❌ [ORCHESTRATOR] Failed to fetch Turnkey addresses:`, error);
              turnkeyAddresses = {};
            }
          }

          // Get appropriate address for this chain type - FAIL FAST if missing
          let walletAddress = '';
          if (networkConfig.chainType === 'EVM') {
            walletAddress = turnkeyAddresses.ethereum;
            if (!walletAddress) {
              logger.error(`❌ [ORCHESTRATOR] Missing Ethereum address from Turnkey for user ${userId}`);
              throw new Error(`Failed to create ${chainKey} wallet: Missing Ethereum address from Turnkey`);
            }
          } else if (networkConfig.chainType === 'SOLANA') {
            walletAddress = turnkeyAddresses.solana;
            if (!walletAddress) {
              logger.warn(`⚠️ [ORCHESTRATOR] Missing Solana address from Turnkey for user ${userId}, generating fallback`);
              // Use fallback address from chain addresses storage
              const allChainAddresses = (await this.prisma.turnkeySigner.findFirst({
                where: { turnkeySubOrgId: sharedSubOrgId!, isActive: true }
              }))?.passkeyConfig as any;
              walletAddress = allChainAddresses?.allChainAddresses?.['SOLANA_DEVNET']?.address;
              if (!walletAddress) {
                logger.error(`❌ [ORCHESTRATOR] No Solana address available for user ${userId}`);
                continue;
              }
            }
          } else if (networkConfig.chainType === 'BITCOIN') {
            walletAddress = turnkeyAddresses.bitcoin;
            if (!walletAddress) {
              logger.warn(`⚠️ [ORCHESTRATOR] Missing Bitcoin address from Turnkey for user ${userId}, generating fallback`);
              // Use fallback address from chain addresses storage
              const allChainAddresses = (await this.prisma.turnkeySigner.findFirst({
                where: { turnkeySubOrgId: sharedSubOrgId!, isActive: true }
              }))?.passkeyConfig as any;
              walletAddress = allChainAddresses?.allChainAddresses?.['BITCOIN_TESTNET']?.address;
              if (!walletAddress) {
                logger.error(`❌ [ORCHESTRATOR] No Bitcoin address available for user ${userId}`);
                continue;
              }
            }
          } else {
            logger.warn(`Unsupported chain type: ${networkConfig.chainType}, skipping ${chainKey}`);
            continue;
          }

          // Get appropriate chain service
          const chainService = this.chainFactory.getServiceByChainKey(chainKey as any);

          // Create wallet using chain-specific service
          const walletResult = await chainService.createWallet({
            userId,
            subOrgId: sharedSubOrgId!,
            turnkeyUserId: sharedTurnkeyUserId!,
            walletAddress: walletAddress as Address,
            chainConfig: networkConfig
          });

          // Validate kernel account was created for EVM chains
          if (networkConfig.chainType === 'EVM' && chainId) {
            const kernelCount = await this.prisma.kernelAccount.count({
              where: { walletId: walletResult.walletId }
            });

            if (kernelCount === 0) {
              logger.error(`❌ No kernel account created for ${chainKey} wallet ${walletResult.walletId}`);
              throw new Error(`Failed to create kernel account for ${chainKey}`);
            }

            logger.info(`✅ Kernel account validation passed for ${chainKey} wallet`);
          }

          results.push(walletResult);
          logger.info(`Successfully created ${chainKey} wallet: ${walletResult.address}`);

        } catch (error) {
          logger.error(`Failed to create wallet for ${chainKey}:`, error);
          // Continue with other chains even if one fails
          continue;
        }
      }

      logger.info(`Multi-chain wallet creation completed for user ${userId}. Created ${results.length} wallets.`);

      // Update TurnkeySigner walletId from temp to real wallet ID
      // The TurnkeySigner is created early with a temp walletId; now that real wallets exist, link to the primary EVM wallet
      // Ethereum Sepolia = 11155111, BSC Testnet = 97 — prefer ETH Sepolia as the primary
      const evmWallet = results.find(r => r.chainId === 11155111) || results.find(r => r.chainId === 97) || results[0];
      if (evmWallet) {
        const updated = await this.prisma.turnkeySigner.updateMany({
          where: {
            userId,
            walletId: null
          },
          data: {
            walletId: evmWallet.walletId
          }
        });
        if (updated.count > 0) {
          logger.info(`✅ [ORCHESTRATOR] Updated TurnkeySigner walletId from temp to ${evmWallet.walletId} for user ${userId}`);
        }
      }

      return results;

    } catch (error) {
      logger.error('Failed to create multi-chain wallets:', error);
      throw new Error(`Failed to create multi-chain wallets: ${error}`);
    } finally {
      // Release the lock
      if (resolveLock!) {
        resolveLock!();
        delete (this as any)._locks[lockKey];
        logger.info(`Released wallet creation lock for user ${userId}`);
      }
    }
  }

  /**
   * Submit UserOperation (EVM chains only)
   */
  async submitUserOperation(request: UserOperationRequest): Promise<UserOperationResponse> {
    try {
      logger.info(`Submitting user operation for wallet ${request.walletId}`);

      // Validate wallet exists
      const wallet = await this.prisma.wallet.findUnique({
        where: { id: request.walletId }
      });

      if (!wallet) {
        throw new Error('Wallet not found');
      }

      // Ensure this is an EVM wallet
      if (!wallet.chainId || wallet.chainId === 0) {
        throw new Error('UserOperations are only supported on EVM chains');
      }

      // Get network config to determine chain key
      const networkConfig = Object.entries(NETWORKS).find(([_, config]) => config.chainId === wallet.chainId);
      if (!networkConfig) {
        throw new Error(`Unsupported chain ID: ${wallet.chainId}`);
      }

      const [chainKey] = networkConfig;

      // Get EVM service
      const evmService = this.chainFactory.getEVMService(chainKey as any);

      // Submit user operation via chain service
      const result = await evmService.submitUserOperation(request);

      logger.info(`User operation submitted: ${result.userOpHash}`);
      return result;

    } catch (error) {
      logger.error('Failed to submit user operation:', error);
      throw error;
    }
  }

  /**
   * Sign transaction (legacy endpoint, converts to user operation for EVM)
   */
  async signTransaction(request: SignTransactionRequest): Promise<SignTransactionResponse> {
    try {
      logger.info(`Signing transaction for wallet ${request.walletId}`);

      const { walletId, to, value, data, chainId } = request;

      // Convert to user operation format
      const calls = [{
        to,
        value: BigInt(value),
        data
      }];

      const result = await this.submitUserOperation({
        walletId,
        chainId,
        calls,
        sponsorUserOperation: true
      });

      return {
        signature: result.userOpHash,
        userOpHash: result.userOpHash,
        transactionHash: undefined // Will be available after bundler processes
      };

    } catch (error) {
      logger.error('Failed to sign transaction:', error);
      throw error;
    }
  }

  /**
   * Deploy wallet to blockchain (EVM chains only)
   */
  async deployWallet(walletId: string, chainId: number) {
    try {
      logger.info(`Deploying wallet ${walletId} on chain ${chainId}`);

      // Get network config to determine chain key
      const networkConfig = Object.entries(NETWORKS).find(([_, config]) => config.chainId === chainId);
      if (!networkConfig) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
      }

      const [chainKey] = networkConfig;

      // Get EVM service (only EVM chains support deployment)
      const evmService = this.chainFactory.getEVMService(chainKey as any);

      // Deploy wallet via chain service
      const result = await evmService.deployWallet(walletId);

      logger.info(`Wallet deployed: ${result.address}`);
      return result;

    } catch (error) {
      logger.error('Failed to deploy wallet:', error);
      throw error;
    }
  }

  /**
   * Recover wallet (placeholder implementation)
   */
  async recoverWallet(request: RecoverWalletRequest): Promise<RecoverWalletResponse> {
    try {
      logger.info(`Recovering wallet for user ${request.userId}`);

      const { userId, phoneNumber } = request;

      // Attempt to recover via Turnkey
      const recoveryResult = await this.turnkeyService.recoverWallet(phoneNumber);

      if (!recoveryResult) {
        throw new Error('No wallet found for this phone number');
      }

      // Get all wallets for this user
      const wallets = await this.prisma.wallet.findMany({
        where: { userId, isActive: true }
      });

      const walletResults = wallets.map(wallet => ({
        walletId: wallet.id,
        address: wallet.address as Address,
        chainId: wallet.chainId || 0,
        isRecovered: true
      }));

      return {
        wallets: walletResults,
        turnkeySubOrgId: recoveryResult.subOrgId || ''
      };

    } catch (error) {
      logger.error('Failed to recover wallet:', error);
      throw new Error(`Failed to recover wallet: ${error}`);
    }
  }

  /**
   * Get comprehensive multi-chain wallet data for a user
   */
  async getUserMultiChainWallets(userId: string) {
    try {
      logger.info(`Fetching multi-chain wallets for user ${userId}`);

      const wallets = await this.prisma.wallet.findMany({
        where: { userId, isActive: true },
        include: {
          kernelAccounts: true,
          transactions: {
            take: 5,
            orderBy: { createdAt: 'desc' }
          }
        },
        orderBy: { createdAt: 'asc' }
      });

      // Group wallets by network and add metadata
      const walletsByNetwork = wallets.map(wallet => {
        let networkConfig;
        let chainKey;

        // For EVM chains, find by chainId
        if (wallet.chainId && wallet.chainId !== 0) {
          const networkEntry = Object.entries(NETWORKS).find(([_, config]) => config.chainId === wallet.chainId);
          if (networkEntry) {
            [chainKey, networkConfig] = networkEntry;
          }
        } else {
          // For non-EVM chains, find by chainKey in metadata
          const metadataChainKey = (wallet.metadata as any)?.chainKey;
          if (metadataChainKey && NETWORKS[metadataChainKey]) {
            chainKey = metadataChainKey;
            networkConfig = NETWORKS[metadataChainKey];
          }
        }

        return {
          walletId: wallet.id,
          address: wallet.address,
          chainId: wallet.chainId,
          network: networkConfig ? {
            name: networkConfig.name,
            chainKey: chainKey,
            chainType: networkConfig.chainType,
            currencySymbol: networkConfig.currencySymbol,
            explorerUrl: networkConfig.explorerUrl,
            isTestnet: networkConfig.isTestnet
          } : {
            name: 'Unknown Network',
            chainKey: 'UNKNOWN',
            chainType: 'EVM',
            currencySymbol: 'UNKNOWN',
            explorerUrl: '',
            isTestnet: true
          },
          deploymentStatus: wallet.deploymentStatus,
          walletType: wallet.walletType,
          isActive: wallet.isActive,
          createdAt: wallet.createdAt,
          lastActivityAt: wallet.lastActivityAt,
          recentTransactions: wallet.transactions.length,
          kernelAccounts: wallet.kernelAccounts.map(ka => ({
            id: ka.id,
            address: ka.address,
            initCode: ka.initCode,
            isDeployed: ka.isDeployed
          }))
        };
      });

      return walletsByNetwork;

    } catch (error) {
      logger.error('Failed to get user multi-chain wallets:', error);
      throw error;
    }
  }

  /**
   * Validate and reconcile wallet addresses with Turnkey
   * This method checks if database addresses match Turnkey and fixes mismatches
   */
  async validateAndReconcileWallets(userId: string): Promise<{
    reconciled: boolean;
    changes: Array<{
      walletId: string;
      oldAddress: string;
      newAddress: string;
      chainType: string;
    }>;
    errors: string[];
  }> {
    try {
      logger.info(`🔍 [RECONCILE] Starting wallet validation and reconciliation for user ${userId}`);

      const wallets = await this.prisma.wallet.findMany({
        where: { userId, isActive: true }
      });

      // Get Turnkey signers separately
      const turnkeySigners = await this.prisma.turnkeySigner.findMany({
        where: { userId, isActive: true }
      });

      if (wallets.length === 0) {
        return { reconciled: true, changes: [], errors: [] };
      }

      // Get the Turnkey sub-organization ID from the first signer
      const subOrgId = turnkeySigners[0]?.turnkeySubOrgId;
      if (!subOrgId) {
        logger.warn(`No Turnkey sub-organization found for user ${userId}`);
        return {
          reconciled: false,
          changes: [],
          errors: ['No Turnkey sub-organization found']
        };
      }

      // Fetch current addresses from Turnkey
      let turnkeyAddresses;
      try {
        logger.info(`📡 [RECONCILE] Fetching Turnkey addresses for validation from sub-org: ${subOrgId}`);
        turnkeyAddresses = await this.turnkeyService.getAllWalletsFromTurnkey(subOrgId);
        logger.info(`📋 [RECONCILE] Fetched Turnkey addresses for validation:`, {
          subOrgId,
          ethereum: turnkeyAddresses.ethereum,
          solana: turnkeyAddresses.solana,
          bitcoin: turnkeyAddresses.bitcoin
        });
      } catch (error: any) {
        logger.error(`❌ [RECONCILE] Failed to fetch Turnkey addresses for validation:`, error);
        return {
          reconciled: false,
          changes: [],
          errors: [`Failed to fetch Turnkey addresses: ${error.message}`]
        };
      }

      const changes: Array<{
        walletId: string;
        oldAddress: string;
        newAddress: string;
        chainType: string;
      }> = [];
      const errors: string[] = [];

      // Check each wallet for address mismatches
      for (const wallet of wallets) {
        try {
          let expectedAddress: string | undefined;
          let chainType: string;

          // Determine expected address based on wallet type
          if (wallet.chainId && wallet.chainId !== 0) {
            // EVM wallet
            expectedAddress = turnkeyAddresses.ethereum;
            chainType = 'ETHEREUM';
          } else if ((wallet.metadata as any)?.chainType === 'SOLANA') {
            expectedAddress = turnkeyAddresses.solana;
            chainType = 'SOLANA';
          } else if ((wallet.metadata as any)?.chainType === 'BITCOIN') {
            expectedAddress = turnkeyAddresses.bitcoin;
            chainType = 'BITCOIN';
          } else {
            chainType = 'UNKNOWN';
          }

          // Check for mismatch
          if (expectedAddress && wallet.address !== expectedAddress) {
            logger.warn(`Address mismatch for wallet ${wallet.id}:`, {
              current: wallet.address,
              expected: expectedAddress,
              chainType
            });

            // Update the wallet address
            await this.prisma.wallet.update({
              where: { id: wallet.id },
              data: {
                address: expectedAddress,
                lastActivityAt: new Date()
              }
            });

            // Update Turnkey signer address
            const turnkeySigner = turnkeySigners.find(s => s.walletId === wallet.id);
            if (turnkeySigner) {
              await this.prisma.turnkeySigner.update({
                where: { id: turnkeySigner.id },
                data: { address: expectedAddress }
              });
            }

            // Update user's primary wallet address if this is the main ETH wallet
            if (chainType === 'ETHEREUM') {
              await this.prisma.user.update({
                where: { id: userId },
                data: { walletAddress: expectedAddress }
              });
            }

            changes.push({
              walletId: wallet.id,
              oldAddress: wallet.address,
              newAddress: expectedAddress,
              chainType
            });

            logger.info(`Reconciled wallet ${wallet.id} address: ${wallet.address} → ${expectedAddress}`);
          }

        } catch (error: any) {
          const errorMsg = `Failed to reconcile wallet ${wallet.id}: ${error.message}`;
          logger.error(errorMsg, error);
          errors.push(errorMsg);
        }
      }

      const reconciled = errors.length === 0;
      logger.info(`Wallet reconciliation completed for user ${userId}:`, {
        reconciled,
        changesCount: changes.length,
        errorsCount: errors.length
      });

      return { reconciled, changes, errors };

    } catch (error: any) {
      logger.error(`Failed to validate and reconcile wallets for user ${userId}:`, error);
      return {
        reconciled: false,
        changes: [],
        errors: [`Validation failed: ${error.message}`]
      };
    }
  }
}