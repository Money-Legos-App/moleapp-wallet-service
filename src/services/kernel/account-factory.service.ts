import { createKernelAccount, createZeroDevPaymasterClient, createKernelAccountClient } from '@zerodev/sdk';
import { signerToEcdsaValidator } from '@zerodev/ecdsa-validator';
import { KERNEL_V3_1, getEntryPoint } from '@zerodev/sdk/constants';
import { Address, Chain, createPublicClient, Hex, http } from 'viem';
import { PrismaClient } from '../../lib/prisma';
import { getUserOperationGasPrice } from 'permissionless/actions/pimlico';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { getNetworkConfigByChainId } from '../../config/networks.js';
import { env } from '../../config/environment.js';
import { logger } from '../../utils/logger.js';
import { TurnkeyEVMSignerService } from '../turnkey/evm-signer.service.js';

/**
 * KernelAccountFactory - Centralized kernel account creation and caching
 * Internal service - not exposed via API
 * Eliminates duplicate kernel account creation across methods
 */
export class KernelAccountFactory {
  private prisma: PrismaClient;
  private evmSignerService: TurnkeyEVMSignerService;
  private accountCache: Map<string, any> = new Map();
  private clientCache: Map<string, any> = new Map();

  constructor(prisma: PrismaClient, evmSignerService: TurnkeyEVMSignerService) {
    this.prisma = prisma;
    this.evmSignerService = evmSignerService;
  }

  /**
   * Create or get cached kernel account
   * Eliminates repeated account creation in different methods
   */
  async createKernelAccount(
    userId: string,
    chainId: number,
    ownerAddress: Address,
    turnkeySubOrgId: string,
    walletId: string
  ): Promise<{ address: Address; initCode: Hex; isDeployed: boolean }> {
    const cacheKey = `kernel-${turnkeySubOrgId}-${chainId}`;

    // Check cache first to prevent recreation
    if (this.accountCache.has(cacheKey)) {
      logger.info(`Using cached kernel account for sub-org ${turnkeySubOrgId} on chain ${chainId}`);
      return this.accountCache.get(cacheKey);
    }

    try {
      logger.info(`Creating kernel account for user ${userId} on chain ${chainId}`);

      // Check for legacy kernel accounts (signerVersion=0) that used SHA256-derived keys.
      // Counterfactual (not deployed) legacy accounts are safe to delete and re-create
      // with the correct Turnkey-backed signer.
      const existingLegacy = await this.prisma.kernelAccount.findFirst({
        where: { walletId, chainId }
      });

      if (existingLegacy && existingLegacy.signerVersion === 0) {
        if (!existingLegacy.isDeployed) {
          logger.warn(`Replacing legacy SHA256 kernel account ${existingLegacy.address} with Turnkey-backed account for wallet ${walletId} chain ${chainId}`);
          await this.prisma.kernelAccount.delete({ where: { id: existingLegacy.id } });
          // Clear cache for this key so it gets re-created
          this.accountCache.delete(cacheKey);
        } else {
          logger.error(`Deployed legacy kernel account ${existingLegacy.address} requires ownership transfer migration (wallet ${walletId}, chain ${chainId})`);
          throw new Error('Legacy deployed kernel account requires migration. Contact support.');
        }
      }

      const networkConfig = getNetworkConfigByChainId(chainId);

      // Create public client for the chain (cached)
      const publicClient = this.getOrCreatePublicClient(chainId, networkConfig);

      // Get entry point for v0.7 and kernel version
      const entryPoint = getEntryPoint("0.7");
      const kernelVersion = KERNEL_V3_1;

      // Create proper signer using Turnkey EVM integration (cached)
      const signer = await this.evmSignerService.createZeroDevSigner(turnkeySubOrgId);

      // Create ECDSA validator
      const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
        signer,
        entryPoint,
        kernelVersion,
      });

      // Create Kernel account
      const kernelAccount = await createKernelAccount(publicClient, {
        plugins: {
          sudo: ecdsaValidator,
        },
        entryPoint,
        kernelVersion,
      });

      const accountAddress = kernelAccount.address;

      // Check if account is deployed
      const code = await publicClient.getBytecode({ address: accountAddress });
      const isDeployed = code !== undefined && code !== '0x';

      logger.info(`Kernel account created: ${accountAddress}, deployed: ${isDeployed}`);

      // Save to database
      await this.saveKernelAccountToDatabase(
        walletId,
        accountAddress,
        turnkeySubOrgId,
        chainId,
        isDeployed,
        userId,
        ownerAddress
      );

      const result = {
        address: accountAddress,
        initCode: '0x' as Hex, // Placeholder - actual initCode from kernel account if needed
        isDeployed
      };

      // Cache the result to prevent recreation
      this.accountCache.set(cacheKey, result);

      return result;

    } catch (error) {
      logger.error(`Failed to create kernel account for user ${userId}:`, error);
      throw new Error(`Failed to create kernel account: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Get or create cached kernel account client for transactions
   */
  async getKernelAccountClient(
    turnkeySubOrgId: string,
    chainId: number
  ): Promise<any> {
    const cacheKey = `client-${turnkeySubOrgId}-${chainId}`;

    // Check cache first
    if (this.clientCache.has(cacheKey)) {
      logger.info(`Using cached kernel client for sub-org ${turnkeySubOrgId} on chain ${chainId}`);
      return this.clientCache.get(cacheKey);
    }

    try {
      const networkConfig = getNetworkConfigByChainId(chainId);
      const publicClient = this.getOrCreatePublicClient(chainId, networkConfig);

      // Get entry point and kernel version
      const entryPoint = getEntryPoint("0.7");
      const kernelVersion = KERNEL_V3_1;

      // Create signer
      const signer = await this.evmSignerService.createZeroDevSigner(turnkeySubOrgId);

      // Create ECDSA validator
      const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
        signer,
        entryPoint,
        kernelVersion,
      });

      // Create Kernel account
      const kernelAccount = await createKernelAccount(publicClient, {
        plugins: {
          sudo: ecdsaValidator,
        },
        entryPoint,
        kernelVersion,
      });

      // Migrate legacy kernel accounts: if DB has a signerVersion=0 record
      // with a different address (computed with old SHA256-derived signer),
      // update it to the correct Turnkey-backed counterfactual address.
      const legacyAccount = await this.prisma.kernelAccount.findFirst({
        where: { turnkeySubOrgId, chainId, signerVersion: 0 },
      });
      if (legacyAccount && legacyAccount.address !== kernelAccount.address) {
        if (!legacyAccount.isDeployed) {
          logger.warn(
            `Migrating legacy kernel account ${legacyAccount.address} → ${kernelAccount.address} ` +
            `(sub-org ${turnkeySubOrgId}, chain ${chainId})`
          );
          await this.prisma.kernelAccount.update({
            where: { id: legacyAccount.id },
            data: { address: kernelAccount.address, signerVersion: 1 },
          });
          // Also update the parent wallet address to match
          await this.prisma.wallet.update({
            where: { id: legacyAccount.walletId },
            data: { address: kernelAccount.address },
          });
        } else {
          logger.error(
            `Deployed legacy kernel account ${legacyAccount.address} cannot be auto-migrated ` +
            `(sub-org ${turnkeySubOrgId}, chain ${chainId}). Requires ownership transfer.`
          );
        }
      }

      // Create Pimlico paymaster client for controlled gas sponsorship
      const pimlicoClient = createPimlicoClient({
        chain: networkConfig.chain,
        transport: http(networkConfig.bundlerUrl!),
        entryPoint,
      });

      // Build sponsorship context: when a policy is configured, pass it via
      // paymasterContext so viem forwards it in pm_getPaymasterData RPC calls.
      const sponsorshipPolicyId = env.pimlicoSponsorshipPolicyId || undefined;
      if (!sponsorshipPolicyId) {
        logger.warn('No PIMLICO_SPONSORSHIP_POLICY_ID configured — UserOps will be sponsored unconditionally');
      }

      const paymasterContext = sponsorshipPolicyId
        ? { sponsorshipPolicyId }
        : undefined;

      // Create Kernel account client with Pimlico-compatible gas estimation.
      // Pass pimlicoClient directly — it already exposes the correct
      // getPaymasterData / getPaymasterStubData methods for EP v0.7.
      const smartAccountClient = createKernelAccountClient({
        account: kernelAccount,
        chain: networkConfig.chain,
        bundlerTransport: http(networkConfig.bundlerUrl!),
        paymaster: pimlicoClient,
        paymasterContext,
        userOperation: {
          // Use Pimlico's gas price method instead of ZeroDev's zd_getUserOperationGasPrice
          estimateFeesPerGas: async ({ bundlerClient }) => {
            const gasPrices = await getUserOperationGasPrice(bundlerClient);
            return {
              maxFeePerGas: gasPrices.standard.maxFeePerGas,
              maxPriorityFeePerGas: gasPrices.standard.maxPriorityFeePerGas,
            };
          },
        },
      });

      // Cache the client
      this.clientCache.set(cacheKey, smartAccountClient);

      return smartAccountClient;

    } catch (error) {
      logger.error(`Failed to create kernel account client:`, error);
      throw error;
    }
  }

  /**
   * Get or create cached public client for a chain
   */
  private getOrCreatePublicClient(chainId: number, networkConfig: any): any {
    const cacheKey = `public-${chainId}`;

    if (this.clientCache.has(cacheKey)) {
      return this.clientCache.get(cacheKey);
    }

    const publicClient = createPublicClient({
      transport: http(networkConfig.rpcUrl),
      chain: networkConfig.chain,
    });

    this.clientCache.set(cacheKey, publicClient);
    return publicClient;
  }

  /**
   * Save kernel account to database
   */
  private async saveKernelAccountToDatabase(
    walletId: string,
    accountAddress: Address,
    turnkeySubOrgId: string,
    chainId: number,
    isDeployed: boolean,
    userId: string,
    ownerAddress: Address
  ): Promise<void> {
    try {
      // Check if record exists for this specific wallet + chain combination
      const existingByWalletChain = await this.prisma.kernelAccount.findFirst({
        where: { walletId, chainId }
      });

      if (existingByWalletChain) {
        // Update existing record for this wallet/chain
        await this.prisma.kernelAccount.update({
          where: { id: existingByWalletChain.id },
          data: {
            address: accountAddress,
            isDeployed,
            signerVersion: env.useTurnkeyViemSigner ? 1 : 0,
            updatedAt: new Date()
          }
        });
        logger.info(`Updated existing kernel account for wallet ${walletId} on chain ${chainId}`);
      } else {
        // Create new record for this wallet/chain
        // The same Kernel address is expected across multiple EVM chains
        await this.prisma.kernelAccount.create({
          data: {
            walletId,
            userId,
            address: accountAddress,
            ownerAddress,
            chainId,
            turnkeySubOrgId,
            isDeployed,
            signerVersion: env.useTurnkeyViemSigner ? 1 : 0,
          }
        });
        logger.info(`Created new kernel account ${accountAddress} for wallet ${walletId} on chain ${chainId}`);
      }
    } catch (error) {
      logger.error('Failed to save kernel account to database:', error);
      // Don't throw - this is not critical for the wallet creation flow
    }
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.accountCache.clear();
    this.clientCache.clear();
    logger.info('Kernel account factory caches cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { accounts: number; clients: number; publicClients: number } {
    const publicClientCount = Array.from(this.clientCache.keys())
      .filter(key => key.startsWith('public-')).length;
    const clientCount = Array.from(this.clientCache.keys())
      .filter(key => key.startsWith('client-')).length;

    return {
      accounts: this.accountCache.size,
      clients: clientCount,
      publicClients: publicClientCount
    };
  }
}