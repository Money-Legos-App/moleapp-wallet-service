import { PrismaClient } from '@prisma/client';
import { Address } from 'viem';
import { TurnkeyBaseService } from './base.service.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import { TurnkeySubOrgConfig } from '../../types/index.js';
import { getSupportedChainKeys, getNetworkConfig } from '../../config/networks.js';
import crypto from 'crypto';

/**
 * TurnkeyOrganizationService - Sub-organization management
 * Internal service - not exposed via API
 * Handles creation and management of Turnkey sub-organizations
 */
export class TurnkeyOrganizationService extends TurnkeyBaseService {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    super();
    this.prisma = prisma;
  }

  /**
   * Create or get existing Turnkey sub-organization for user
   */
  async createSubOrganizationForUser(
    userId: string,
    phoneNumber: string,
    userEmail?: string
  ): Promise<{ subOrgId: string; turnkeyUserId: string; walletAddress: Address; allChainAddresses: any }> {
    try {
      logger.info(`Creating Turnkey sub-organization for user ${userId}`);

      // Generate a secure phone hash for privacy
      const phoneHash = this.hashPhoneNumber(phoneNumber);

      // Check if user already has a Turnkey sub-org
      const existingSigner = await this.prisma.turnkeySigner.findFirst({
        where: { userId }
      });

      if (existingSigner) {
        logger.info(`User ${userId} already has Turnkey sub-org: ${existingSigner.turnkeySubOrgId}`);
        return {
          subOrgId: existingSigner.turnkeySubOrgId,
          turnkeyUserId: existingSigner.turnkeyUserId,
          walletAddress: existingSigner.address as Address,
          allChainAddresses: existingSigner.passkeyConfig || {}
        };
      }

      // Create sub-organization with embedded wallet
      const subOrgConfig: TurnkeySubOrgConfig = {
        subOrganizationName: `MoleApp-User-${userId.slice(0, 8)}`,
        rootUsers: [{
          userName: `User-${userId.slice(0, 8)}`,
          userEmail: userEmail || `user-${userId}@moleapp.com`,
          apiKeys: [],
          authenticators: [],
          oauthProviders: []
        }],
        wallet: {
          walletName: 'Primary Wallet',
          accounts: [
            // Ethereum account
            {
              curve: 'CURVE_SECP256K1',
              pathFormat: 'PATH_FORMAT_BIP32',
              path: "m/44'/60'/0'/0/0",
              addressFormat: 'ADDRESS_FORMAT_ETHEREUM'
            },
            // Solana account
            {
              curve: 'CURVE_ED25519',
              pathFormat: 'PATH_FORMAT_BIP32',
              path: "m/44'/501'/0'/0'",
              addressFormat: 'ADDRESS_FORMAT_SOLANA'
            },
            // Bitcoin testnet account (P2WPKH - SegWit)
            {
              curve: 'CURVE_SECP256K1',
              pathFormat: 'PATH_FORMAT_BIP32',
              path: "m/84'/1'/0'/0/0",
              addressFormat: 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH'
            }
          ]
        }
      };

      logger.info('Creating sub-organization...');

      const requestBody = {
        type: 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V7' as const,
        organizationId: env.turnkeyOrganizationId,
        timestampMs: Date.now().toString(),
        parameters: {
          ...subOrgConfig,
          rootQuorumThreshold: 1
        }
      };

      // Submit the activity
      const activityResponse = await this.client.createSubOrganization(requestBody);
      logger.info('Activity submitted:', JSON.stringify(activityResponse, null, 2));

      // Handle activity response - need to access the activity result properly
      const activity = activityResponse.activity;
      const result = activity.result?.createSubOrganizationResult || activity.result?.createSubOrganizationResultV7;

      if (!result) {
        throw new Error('No result found in activity response');
      }

      const subOrgId = result.subOrganizationId;

      if (!subOrgId) {
        throw new Error('Missing subOrgId in activity result');
      }

      logger.info(`Sub-organization created successfully: ${subOrgId}`);

      // Fetch real wallet addresses from Turnkey API
      let walletAddress: string;
      let actualBitcoinAddress: string | null = null;
      let actualSolanaKey: string | null = null;

      try {
        logger.info(`Fetching real wallets from Turnkey for sub-org: ${subOrgId}`);

        // Get all wallets created for this sub-organization
        const turnkeyWallets = await this.getWallets(subOrgId);

        if (!turnkeyWallets || turnkeyWallets.length === 0) {
          throw new Error(`No wallets found in Turnkey for sub-org: ${subOrgId}. Cannot proceed without real wallet addresses.`);
        }

        // Use the first wallet (Primary Wallet)
        const primaryWallet = turnkeyWallets[0];
        logger.info(`Found primary wallet in Turnkey: ${primaryWallet.walletId}`);

        // Get wallet accounts (addresses) for the primary wallet
        const walletAccounts = await this.getWalletAccounts(subOrgId, primaryWallet.walletId);

        if (!walletAccounts || walletAccounts.length === 0) {
          throw new Error(`No accounts found for wallet ${primaryWallet.walletId}. Cannot proceed without real wallet addresses.`);
        }

        logger.info(`Found ${walletAccounts.length} wallet accounts from Turnkey`);

        // Extract addresses by curve and format
        let ethereumAddress: string | null = null;

        for (const account of walletAccounts) {
          logger.info(`Processing account: curve=${account.curve}, format=${account.addressFormat}, address=${account.address}`);

          if (account.curve === 'CURVE_SECP256K1' && account.addressFormat === 'ADDRESS_FORMAT_ETHEREUM') {
            ethereumAddress = account.address;
            logger.info(`✅ Found real Ethereum address from Turnkey: ${ethereumAddress}`);
          } else if (account.curve === 'CURVE_SECP256K1' && account.addressFormat === 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH') {
            actualBitcoinAddress = account.address; // Bitcoin testnet address (tb1...)
            logger.info(`✅ Found real Bitcoin testnet address from Turnkey: ${actualBitcoinAddress}`);
          } else if (account.curve === 'CURVE_ED25519' && account.addressFormat === 'ADDRESS_FORMAT_SOLANA') {
            actualSolanaKey = account.address;
            logger.info(`✅ Found real Solana address from Turnkey: ${actualSolanaKey}`);
          } else {
            logger.warn(`❓ Unknown account type: curve=${account.curve}, format=${account.addressFormat}`);
          }
        }

        // Require Ethereum address - no fallbacks to generated addresses
        if (!ethereumAddress) {
          throw new Error(`No Ethereum address found in Turnkey wallet accounts for sub-org: ${subOrgId}`);
        }

        walletAddress = ethereumAddress;
        logger.info(`✅ Primary wallet address (real Turnkey ETH): ${walletAddress}`);

        // Log summary of what we got from Turnkey
        logger.info(`📊 Turnkey address summary for sub-org ${subOrgId}:`, {
          ethereum: ethereumAddress,
          solana: actualSolanaKey || 'NOT_FOUND',
          bitcoin: actualBitcoinAddress || 'NOT_FOUND',
          totalAccounts: walletAccounts.length
        });
      } catch (fetchError) {
        logger.error('Failed to fetch wallets from Turnkey API:', fetchError);
        throw new Error(`Failed to fetch real wallet addresses from Turnkey: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`);
      }

      // Generate addresses for all supported chains
      const turnkeyUserId = `user-${userId}`;
      const supportedChainKeys = getSupportedChainKeys();
      const allChainAddresses: Record<string, any> = {};

      logger.info(`Generating wallet addresses for all supported chains: [${supportedChainKeys.join(', ')}]`);

      for (const chainKey of supportedChainKeys) {
        const networkConfig = getNetworkConfig(chainKey);
        let chainAddress: string;

        // Generate chain-specific addresses based on chain type
        if (networkConfig.chainType === 'EVM') {
          // All EVM chains use the same address (derived from same private key)
          chainAddress = walletAddress;
        } else if (networkConfig.chainType === 'SOLANA') {
          // Require actual Solana key from Turnkey - no generated fallbacks
          if (actualSolanaKey) {
            chainAddress = actualSolanaKey;
            logger.info(`Using real Solana address from Turnkey: ${chainAddress}`);
          } else {
            logger.error(`No Solana address found in Turnkey for ${chainKey}, skipping chain`);
            continue;
          }
        } else if (networkConfig.chainType === 'BITCOIN') {
          // Use actual Bitcoin testnet address from Turnkey (tb1... format)
          if (actualBitcoinAddress) {
            chainAddress = actualBitcoinAddress; // Already proper tb1... address from Turnkey
            logger.info(`Using real Bitcoin testnet address from Turnkey: ${chainAddress}`);
          } else {
            logger.error(`No Bitcoin testnet address found in Turnkey for ${chainKey}, skipping chain`);
            continue;
          }
        } else {
          logger.warn(`Unsupported chain type ${networkConfig.chainType} for ${chainKey}, skipping`);
          continue;
        }

        allChainAddresses[chainKey] = {
          address: chainAddress,
          chainType: networkConfig.chainType,
          addressFormat: networkConfig.addressFormat,
          curve: networkConfig.curve
        };

        logger.info(`Generated ${chainKey} (${networkConfig.chainType}) address: ${chainAddress}`);
      }

      // Create TurnkeySigner record immediately for wallet creation compatibility
      // This ensures the EVM signer service can find it when creating wallets
      try {
        const phoneHash = this.hashPhoneNumber(phoneNumber);

        await this.prisma.turnkeySigner.create({
          data: {
            userId,
            turnkeyUserId,
            turnkeySubOrgId: subOrgId,
            publicKey: `temp-public-key-${subOrgId.slice(0, 8)}`, // Will be updated by user-service
            address: walletAddress,
            phoneHash: phoneHash,
            isActive: true,
            passkeyConfig: {
              allChainAddresses: allChainAddresses
            },
            authMethods: ['turnkey']
          }
        });

        logger.info(`✅ Created TurnkeySigner record for sub-org ${subOrgId}`);
      } catch (signerError) {
        logger.warn(`TurnkeySigner already exists or creation failed:`, {
          subOrgId,
          error: signerError instanceof Error ? signerError.message : String(signerError)
        });
        // Don't fail the whole operation if signer already exists
      }

      logger.info(`Turnkey sub-organization setup complete for user ${userId}`);

      return {
        subOrgId,
        turnkeyUserId,
        walletAddress: walletAddress as Address,
        allChainAddresses
      };

    } catch (error) {
      logger.error('Failed to create sub-organization:', error);
      throw new Error(`Failed to create sub-organization: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Generate secure phone hash for privacy
   */
  private hashPhoneNumber(phoneNumber: string): string {
    return crypto
      .createHash('sha256')
      .update(phoneNumber + env.turnkeyApiPrivateKey) // Use API key as salt
      .digest('hex');
  }

}