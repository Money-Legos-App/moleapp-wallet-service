/**
 * Chains Module - Multi-Chain Wallet Support
 *
 * This module provides a clean separation of chain-specific logic:
 * - EVM chains (Ethereum, Polygon, BSC) with Account Abstraction
 * - Bitcoin with native transactions
 * - Solana with native transactions
 *
 * Architecture:
 * - SECP256K1 curve: EVM chains, Bitcoin
 * - Ed25519 curve: Solana, Cosmos (future)
 */

// Main factory
export { ChainServiceFactory } from './factory.js';

// Chain services
export { EVMBaseService, EVMChainFactory } from './secp256k1/evm/index.js';
export { BitcoinService } from './secp256k1/bitcoin/service.js';
export { SolanaService } from './ed25519/solana/service.js';

// Utilities
export { BitcoinAddressUtils } from './secp256k1/bitcoin/address.js';
export { SolanaProgramUtils } from './ed25519/solana/programs.js';

// Types
export * from './types.js';

// Chain constants
export const SUPPORTED_CHAINS = {
  EVM: ['ETH_SEPOLIA', 'POLYGON_AMOY'] as const, // 'BNB_TESTNET' temporarily disabled due to RPC connectivity issues
  BITCOIN: ['BITCOIN_TESTNET'] as const,
  SOLANA: ['SOLANA_DEVNET'] as const
} as const;

export const CHAIN_CURVES = {
  SECP256K1: ['ETH_SEPOLIA', 'POLYGON_AMOY', 'BITCOIN_TESTNET'] as const, // 'BNB_TESTNET' temporarily disabled
  ED25519: ['SOLANA_DEVNET'] as const
} as const;