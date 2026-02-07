import { TurnkeyClient } from '@turnkey/http';
import { ApiKeyStamper } from '@turnkey/api-key-stamper';
import { Turnkey } from '@turnkey/sdk-server';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';

/**
 * Base TurnkeyService - Core client and authentication
 * Internal service - not exposed via API
 */
export class TurnkeyBaseService {
  protected client: TurnkeyClient;
  protected sdkServer: Turnkey;

  constructor() {
    const stamper = new ApiKeyStamper({
      apiPublicKey: env.turnkeyApiPublicKey,
      apiPrivateKey: env.turnkeyApiPrivateKey,
    });

    this.client = new TurnkeyClient(
      { baseUrl: env.turnkeyBaseUrl },
      stamper
    );

    // Initialize Turnkey SDK Server for embedded wallet functionality
    this.sdkServer = new Turnkey({
      apiBaseUrl: env.turnkeyBaseUrl,
      defaultOrganizationId: env.turnkeyOrganizationId,
      apiPublicKey: env.turnkeyApiPublicKey,
      apiPrivateKey: env.turnkeyApiPrivateKey,
    });

    logger.info('TurnkeyBaseService initialized');
  }

  /**
   * Get the raw Turnkey client for advanced operations
   */
  protected getTurnkeyClient(): TurnkeyClient {
    return this.client;
  }

  /**
   * Get the Turnkey SDK server instance
   */
  protected getTurnkeySdkServer(): Turnkey {
    return this.sdkServer;
  }

  /**
   * Fetch wallets for a sub-organization from Turnkey API
   */
  async getWallets(subOrgId: string): Promise<any[]> {
    try {
      logger.info(`🔄 [TURNKEY] Fetching wallets from Turnkey API for sub-org: ${subOrgId}`);

      const response = await this.client.getWallets({
        organizationId: subOrgId
      });

      // Debug: Log the raw response from Turnkey
      logger.info(`🔍 [TURNKEY] Raw getWallets response structure:`, {
        hasResponse: !!response,
        responseType: typeof response,
        responseKeys: response ? Object.keys(response) : [],
        walletsExists: !!response?.wallets,
        walletsLength: response?.wallets?.length || 0,
        walletsType: typeof response?.wallets
      });

      if (response?.wallets?.length > 0) {
        logger.info(`🔍 [TURNKEY] Raw wallets data:`, response.wallets);
      }

      if (!response || !response.wallets) {
        logger.warn(`⚠️ [TURNKEY] No wallets found for sub-org: ${subOrgId}`);
        logger.info(`🔍 [TURNKEY] Response structure:`, {
          hasResponse: !!response,
          responseKeys: response ? Object.keys(response) : [],
          walletsValue: response?.wallets
        });
        return [];
      }

      logger.info(`✅ [TURNKEY] Found ${response.wallets.length} wallets in Turnkey for sub-org: ${subOrgId}`);

      // Debug: Log each wallet's structure with detailed analysis
      response.wallets.forEach((wallet: any, index: number) => {
        logger.info(`📱 [TURNKEY] Wallet ${index + 1} structure:`, {
          walletId: wallet?.walletId,
          walletName: wallet?.walletName,
          walletType: wallet?.walletType,
          dateCreated: wallet?.dateCreated,
          accounts: wallet?.accounts?.length || 0,
          walletKeys: wallet ? Object.keys(wallet) : []
        });

        // Log the full wallet object
        try {
          logger.info(`📱 [TURNKEY] Wallet ${index + 1} full data:`, wallet);
        } catch (error) {
          logger.info(`📱 [TURNKEY] Wallet ${index + 1} - error logging:`, error);
        }
      });

      return response.wallets;

    } catch (error) {
      logger.error(`Failed to fetch wallets from Turnkey for sub-org ${subOrgId}:`, error);
      throw new Error(`Failed to fetch wallets from Turnkey: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch wallet accounts (addresses/keys) for a specific wallet from Turnkey API
   */
  async getWalletAccounts(subOrgId: string, walletId: string): Promise<any[]> {
    try {
      logger.info(`🔄 [TURNKEY] Fetching wallet accounts from Turnkey API for wallet: ${walletId} in sub-org: ${subOrgId}`);

      const response = await this.client.getWalletAccounts({
        organizationId: subOrgId,
        walletId: walletId
      });

      // Debug: Log the raw response from Turnkey
      logger.info(`🔍 [TURNKEY] Raw getWalletAccounts response structure:`, {
        hasResponse: !!response,
        responseType: typeof response,
        responseKeys: response ? Object.keys(response) : [],
        accountsExists: !!response?.accounts,
        accountsLength: response?.accounts?.length || 0,
        accountsType: typeof response?.accounts
      });

      if (response?.accounts?.length > 0) {
        logger.info(`🔍 [TURNKEY] Raw accounts data:`, response.accounts);
      }

      if (!response || !response.accounts) {
        logger.warn(`⚠️ [TURNKEY] No accounts found for wallet: ${walletId} in sub-org: ${subOrgId}`);
        logger.info(`🔍 [TURNKEY] Response structure:`, {
          hasResponse: !!response,
          responseKeys: response ? Object.keys(response) : [],
          accountsValue: response?.accounts
        });
        return [];
      }

      logger.info(`✅ [TURNKEY] Found ${response.accounts.length} accounts for wallet: ${walletId}`);

      // Debug: Log each account's structure with detailed analysis
      response.accounts.forEach((account: any, index: number) => {
        logger.info(`🔑 [TURNKEY] Account ${index + 1} structure:`, {
          address: account?.address,
          curve: account?.curve,
          addressFormat: account?.addressFormat,
          path: account?.path,
          pathFormat: account?.pathFormat,
          publicKey: account?.publicKey,
          accountKeys: account ? Object.keys(account) : []
        });

        // Log the full account object
        try {
          logger.info(`🔑 [TURNKEY] Account ${index + 1} full data:`, account);
        } catch (error) {
          logger.info(`🔑 [TURNKEY] Account ${index + 1} - error logging:`, error);
        }
      });

      return response.accounts;

    } catch (error) {
      logger.error(`Failed to fetch wallet accounts from Turnkey:`, error);
      throw new Error(`Failed to fetch wallet accounts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}