import { PrismaClient } from '@prisma/client';
import { EVMBaseService } from './base.service.js';
import { KernelService } from '../../../services/kernel/account-abstraction.service.js';
import { EVMChainKey } from '../../types.js';

/**
 * EVM Chain Factory
 * Creates EVM-specific services for different networks
 */
export class EVMChainFactory {
  private prisma: PrismaClient;
  private kernelService: KernelService;

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;
  }

  /**
   * Get EVM service for any supported EVM chain
   */
  getEVMService(chainKey: EVMChainKey): EVMBaseService {
    // For now, all EVM chains use the same base service
    // In the future, chain-specific services can extend the base
    return new EVMBaseService(this.prisma, this.kernelService);
  }

  /**
   * Get Ethereum-specific service
   */
  getEthereumService(): EVMBaseService {
    return this.getEVMService('ETH_SEPOLIA');
  }

  /**
   * Get Polygon-specific service
   */
  getPolygonService(): EVMBaseService {
    return this.getEVMService('POLYGON_AMOY');
  }

  /**
   * Get BSC-specific service
   */
  getBSCService(): EVMBaseService {
    return this.getEVMService('BNB_TESTNET');
  }
}

// Export the base service for direct use
export { EVMBaseService };