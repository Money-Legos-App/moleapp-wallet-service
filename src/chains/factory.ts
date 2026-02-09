import { PrismaClient } from '../lib/prisma';
import { EVMBaseService, EVMChainFactory } from './secp256k1/evm/index.js';
import { BitcoinService } from './secp256k1/bitcoin/service.js';
import { SolanaService } from './ed25519/solana/service.js';
import { KernelService } from '../services/kernel/account-abstraction.service.js';
import { logger } from '../utils/logger.js';
import {
  ChainService,
  EVMChainService,
  ChainConfig,
  EVMChainKey,
  BitcoinChainKey,
  SolanaChainKey,
  SupportedChainKey
} from './types.js';

/**
 * Main Chain Service Factory
 * Creates appropriate chain services based on chain configuration
 * Central point for chain service instantiation
 */
export class ChainServiceFactory {
  private prisma: PrismaClient;
  private kernelService: KernelService;
  private evmFactory: EVMChainFactory;
  private bitcoinService: BitcoinService;
  private solanaService: SolanaService;

  constructor(prisma: PrismaClient, kernelService: KernelService) {
    this.prisma = prisma;
    this.kernelService = kernelService;

    // Initialize chain-specific factories and services
    this.evmFactory = new EVMChainFactory(prisma, kernelService);
    this.bitcoinService = new BitcoinService(prisma);
    this.solanaService = new SolanaService(prisma);

    logger.info('ChainServiceFactory initialized');
  }

  /**
   * Get appropriate service by chain configuration
   */
  getServiceByChainConfig(chainConfig: ChainConfig): ChainService | EVMChainService {
    switch (chainConfig.chainType) {
      case 'EVM':
        return this.getEVMService(chainConfig.name as EVMChainKey);

      case 'BITCOIN':
        return this.getBitcoinService();

      case 'SOLANA':
        return this.getSolanaService();

      default:
        throw new Error(`Unsupported chain type: ${chainConfig.chainType}`);
    }
  }

  /**
   * Get appropriate service by chain key
   */
  getServiceByChainKey(chainKey: SupportedChainKey): ChainService | EVMChainService {
    // EVM chains
    if (this.isEVMChain(chainKey)) {
      return this.getEVMService(chainKey as EVMChainKey);
    }

    // Bitcoin chains
    if (this.isBitcoinChain(chainKey)) {
      return this.getBitcoinService();
    }

    // Solana chains
    if (this.isSolanaChain(chainKey)) {
      return this.getSolanaService();
    }

    throw new Error(`Unsupported chain key: ${chainKey}`);
  }

  /**
   * Get EVM service for specific chain
   */
  getEVMService(chainKey: EVMChainKey): EVMBaseService {
    return this.evmFactory.getEVMService(chainKey);
  }

  /**
   * Get Bitcoin service
   */
  getBitcoinService(): BitcoinService {
    return this.bitcoinService;
  }

  /**
   * Get Solana service
   */
  getSolanaService(): SolanaService {
    return this.solanaService;
  }

  /**
   * Get Ethereum-specific service
   */
  getEthereumService(): EVMBaseService {
    return this.evmFactory.getEthereumService();
  }

  /**
   * Get Polygon-specific service
   */
  getPolygonService(): EVMBaseService {
    return this.evmFactory.getPolygonService();
  }

  /**
   * Get BSC-specific service
   */
  getBSCService(): EVMBaseService {
    return this.evmFactory.getBSCService();
  }

  /**
   * Get all supported chain types
   */
  getSupportedChainTypes(): string[] {
    return ['EVM', 'BITCOIN', 'SOLANA'];
  }

  /**
   * Get supported chains by curve type
   */
  getChainsByCurve(curve: 'SECP256K1' | 'ED25519'): SupportedChainKey[] {
    switch (curve) {
      case 'SECP256K1':
        return ['ETH_SEPOLIA', 'POLYGON_AMOY', 'BNB_TESTNET', 'BITCOIN_TESTNET'];

      case 'ED25519':
        return ['SOLANA_DEVNET'];

      default:
        return [];
    }
  }

  /**
   * Check if chain supports Account Abstraction
   */
  supportsAccountAbstraction(chainKey: SupportedChainKey): boolean {
    return this.isEVMChain(chainKey);
  }

  /**
   * Check if chain is EVM-compatible
   */
  private isEVMChain(chainKey: string): boolean {
    const evmChains: EVMChainKey[] = ['ETH_SEPOLIA', 'POLYGON_AMOY', 'BNB_TESTNET'];
    return evmChains.includes(chainKey as EVMChainKey);
  }

  /**
   * Check if chain is Bitcoin
   */
  private isBitcoinChain(chainKey: string): boolean {
    const bitcoinChains: BitcoinChainKey[] = ['BITCOIN_TESTNET'];
    return bitcoinChains.includes(chainKey as BitcoinChainKey);
  }

  /**
   * Check if chain is Solana
   */
  private isSolanaChain(chainKey: string): boolean {
    const solanaChains: SolanaChainKey[] = ['SOLANA_DEVNET'];
    return solanaChains.includes(chainKey as SolanaChainKey);
  }

  /**
   * Get chain curve type
   */
  getChainCurve(chainKey: SupportedChainKey): 'SECP256K1' | 'ED25519' {
    if (this.isEVMChain(chainKey) || this.isBitcoinChain(chainKey)) {
      return 'SECP256K1';
    }

    if (this.isSolanaChain(chainKey)) {
      return 'ED25519';
    }

    throw new Error(`Unknown curve for chain: ${chainKey}`);
  }

  /**
   * Clear all service caches (useful for testing)
   */
  clearCaches(): void {
    // If services have caches, clear them here
    logger.info('Chain service caches cleared');
  }
}