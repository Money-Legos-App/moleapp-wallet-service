import { createZeroDevPaymasterClient } from '@zerodev/sdk';
import { getEntryPoint } from '@zerodev/sdk/constants';
import { Address, Hex, createPublicClient, http } from 'viem';
import { PrismaClient } from '@prisma/client';
import { getNetworkConfigByChainId } from '../../config/networks.js';
import { logger } from '../../utils/logger.js';
import { TurnkeyService } from '../turnkey/index.js';
import { KernelAccountFactory } from './account-factory.service.js';
import { TurnkeyEVMSignerService } from '../turnkey/evm-signer.service.js';

export class KernelService {
  private prisma: PrismaClient;
  private turnkeyService: TurnkeyService;
  private accountFactory: KernelAccountFactory;

  constructor(prisma: PrismaClient, turnkeyService: TurnkeyService) {
    this.prisma = prisma;
    this.turnkeyService = turnkeyService;

    // Initialize account factory with EVM signer service
    const evmSignerService = new TurnkeyEVMSignerService(prisma);
    this.accountFactory = new KernelAccountFactory(prisma, evmSignerService);
  }

  async createKernelAccount(
    userId: string,
    chainId: number,
    ownerAddress: Address,
    turnkeySubOrgId: string,
    walletId: string
  ): Promise<{ address: Address; initCode: Hex; isDeployed: boolean }> {
    // Use factory to eliminate duplication and enable caching
    return this.accountFactory.createKernelAccount(
      userId,
      chainId,
      ownerAddress,
      turnkeySubOrgId,
      walletId
    );
  }

  async getKernelAccount(walletId: string, chainId: number) {
    try {
      return await this.prisma.kernelAccount.findFirst({
        where: { walletId, chainId }
      });
    } catch (error) {
      logger.error('Failed to get Kernel account:', error);
      throw error;
    }
  }

  /**
   * Get or create kernel account for a wallet (backward compatibility)
   * If kernel account doesn't exist, auto-initialize it
   * This ensures legacy wallets without smart accounts can still use AA features
   */
  async getOrCreateKernelAccount(
    walletId: string,
    chainId: number
  ): Promise<{ address: Address; isDeployed: boolean }> {
    // 1. Try to find existing kernel account
    const existing = await this.prisma.kernelAccount.findFirst({
      where: { walletId, chainId }
    });

    if (existing) {
      logger.info(`Found existing kernel account for wallet ${walletId} on chain ${chainId}`);
      return {
        address: existing.address as Address,
        isDeployed: existing.isDeployed
      };
    }

    // 2. Auto-initialize for backward compatibility
    logger.info(`🔧 Auto-initializing kernel account for wallet ${walletId} on chain ${chainId}`);

    // Get wallet details
    const wallet = await this.prisma.wallet.findUnique({
      where: { id: walletId }
    });

    if (!wallet) {
      throw new Error(`Wallet ${walletId} not found`);
    }

    // Get turnkey signer info
    const signer = await this.prisma.turnkeySigner.findFirst({
      where: { walletId }
    });

    if (!signer || !signer.turnkeySubOrgId) {
      throw new Error(`Cannot auto-initialize kernel account: missing Turnkey signer for wallet ${walletId}`);
    }

    // Create kernel account using existing factory
    logger.info(`Creating kernel account for wallet ${walletId} with sub-org ${signer.turnkeySubOrgId}`);

    const result = await this.createKernelAccount(
      wallet.userId,
      chainId,
      wallet.address as Address,
      signer.turnkeySubOrgId,
      walletId
    );

    logger.info(`✅ Kernel account auto-initialized: ${result.address} (deployed: ${result.isDeployed})`);

    return {
      address: result.address,
      isDeployed: result.isDeployed
    };
  }

  async deployKernelAccount(
    walletId: string,
    chainId: number
  ): Promise<{ transactionHash: Hex; address: Address }> {
    try {
      const kernelAccount = await this.getKernelAccount(walletId, chainId);
      if (!kernelAccount) {
        throw new Error('Kernel account not found');
      }

      if (kernelAccount.isDeployed) {
        return {
          transactionHash: '0x' as Hex,
          address: kernelAccount.address as Address
        };
      }

      const networkConfig = getNetworkConfigByChainId(chainId);

      // Use cached kernel account client from factory
      if (!kernelAccount.turnkeySubOrgId) {
        throw new Error('Kernel account missing Turnkey sub-org ID');
      }

      const deploymentClient = await this.accountFactory.getKernelAccountClient(
        kernelAccount.turnkeySubOrgId,
        chainId
      );

      // Deploy by sending a minimal transaction
      const userOpHash = await deploymentClient.sendUserOperation({
        calls: [{ to: kernelAccount.address as Address, value: 0n, data: '0x' }],
      });

      // Wait for transaction receipt
      const receipt = await deploymentClient.waitForUserOperationReceipt({
        hash: userOpHash
      });

      // Update deployment status
      await this.prisma.kernelAccount.update({
        where: { id: kernelAccount.id },
        data: {
          isDeployed: true,
          deploymentHash: receipt.receipt.transactionHash
        }
      });

      logger.info(`Deployed Kernel account ${kernelAccount.address} on chain ${chainId}`);

      return {
        transactionHash: receipt.receipt.transactionHash,
        address: kernelAccount.address as Address
      };

    } catch (error) {
      logger.error('Failed to deploy Kernel account:', error);
      throw error;
    }
  }

  async estimateUserOperationGas(
    walletId: string,
    chainId: number,
    calls: { to: Address; value: bigint; data: Hex }[]
  ) {
    try {
      const kernelAccount = await this.getKernelAccount(walletId, chainId);
      if (!kernelAccount) {
        throw new Error('Kernel account not found');
      }

      const networkConfig = getNetworkConfigByChainId(chainId);

      // Use cached kernel account client from factory
      if (!kernelAccount.turnkeySubOrgId) {
        throw new Error('Kernel account missing Turnkey sub-org ID');
      }

      const clientForGas = await this.accountFactory.getKernelAccountClient(
        kernelAccount.turnkeySubOrgId,
        chainId
      );

      // Estimate user operation gas
      const gasEstimate = await clientForGas.estimateUserOperationGas({
        calls: calls,
      });

      return gasEstimate;

    } catch (error) {
      logger.error('Failed to estimate gas:', error);
      throw error;
    }
  }

  async submitUserOperation(
    walletId: string,
    chainId: number,
    calls: { to: Address; value: bigint; data: Hex }[],
    sponsorUserOperation: boolean = true
  ) {
    try {
      const kernelAccount = await this.getKernelAccount(walletId, chainId);
      if (!kernelAccount) {
        throw new Error('Kernel account not found');
      }

      const networkConfig = getNetworkConfigByChainId(chainId);

      // Use cached kernel account client from factory
      if (!kernelAccount.turnkeySubOrgId) {
        throw new Error('Kernel account missing Turnkey sub-org ID');
      }

      const clientForSubmit = await this.accountFactory.getKernelAccountClient(
        kernelAccount.turnkeySubOrgId,
        chainId
      );

      // Submit user operation
      const submittedUserOpHash = await clientForSubmit.sendUserOperation({
        calls: calls,
      });

      // Store user operation in database
      await this.prisma.userOperation.create({
        data: {
          walletId,
          chainId,
          userOpHash: submittedUserOpHash,
          status: 'pending',
          transactions: calls.map(call => ({
            to: call.to,
            value: call.value.toString(),
            data: call.data
          })),
          metadata: {
            sponsored: sponsorUserOperation,
            bundlerUrl: networkConfig.bundlerUrl
          }
        }
      });

      logger.info(`Submitted user operation ${submittedUserOpHash} for wallet ${walletId}`);

      return {
        userOpHash: submittedUserOpHash,
        sponsored: sponsorUserOperation
      };

    } catch (error) {
      logger.error('Failed to submit user operation:', error);
      throw error;
    }
  }

  private async getAccountNonce(address: Address, chainId: number): Promise<bigint> {
    const networkConfig = getNetworkConfigByChainId(chainId);
    const entryPoint = getEntryPoint("0.7");

    const publicClient = createPublicClient({
      transport: http(networkConfig.rpcUrl),
      chain: networkConfig.chain,
    });

    try {
      // Get nonce from entry point
      const nonce = await publicClient.readContract({
        address: entryPoint.address,
        abi: [{
          inputs: [{ name: 'sender', type: 'address' }, { name: 'key', type: 'uint192' }],
          name: 'getNonce',
          outputs: [{ name: 'nonce', type: 'uint256' }],
          stateMutability: 'view',
          type: 'function',
        }],
        functionName: 'getNonce',
        args: [address, 0n],
      });

      return nonce as bigint;
    } catch {
      return 0n;
    }
  }

  private async encodeCallData(calls: { to: Address; value: bigint; data: Hex }[]): Promise<Hex> {
    if (calls.length === 1) {
      const call = calls[0];
      // Single call encoding for Kernel v3.1
      return `0x${call.to.slice(2)}${call.value.toString(16).padStart(64, '0')}${call.data.slice(2)}` as Hex;
    } else {
      // Batch call encoding for Kernel v3.1
      let encoded = '0x';
      for (const call of calls) {
        encoded += call.to.slice(2);
        encoded += call.value.toString(16).padStart(64, '0');
        encoded += (call.data.length - 2).toString(16).padStart(8, '0');
        encoded += call.data.slice(2);
      }
      return encoded as Hex;
    }
  }

  private async getTurnkeyUserId(subOrgId: string): Promise<string> {
    const signer = await this.prisma.turnkeySigner.findFirst({
      where: { turnkeySubOrgId: subOrgId }
    });

    if (!signer) {
      throw new Error(`No Turnkey signer found for sub-org: ${subOrgId}`);
    }

    return signer.turnkeyUserId;
  }
}