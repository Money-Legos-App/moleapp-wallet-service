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

// Environment-aware chain configuration
import { developmentMode } from '../config/environment.js';

// Chain constants - switch between testnet and mainnet based on environment
export const SUPPORTED_CHAINS = developmentMode ? {
  EVM: ['ETH_SEPOLIA', 'ARBITRUM_SEPOLIA'] as const,
  BITCOIN: ['BITCOIN_TESTNET'] as const,
  SOLANA: ['SOLANA_DEVNET'] as const
} : {
  EVM: ['ETH_MAINNET', 'ARBITRUM_ONE', 'BASE', 'BNB_MAINNET'] as const,
  BITCOIN: ['BITCOIN_MAINNET'] as const,
  SOLANA: ['SOLANA_MAINNET'] as const
};

export const CHAIN_CURVES = developmentMode ? {
  SECP256K1: ['ETH_SEPOLIA', 'ARBITRUM_SEPOLIA', 'BITCOIN_TESTNET'] as const,
  ED25519: ['SOLANA_DEVNET'] as const
} : {
  SECP256K1: ['ETH_MAINNET', 'ARBITRUM_ONE', 'BASE', 'BNB_MAINNET', 'BITCOIN_MAINNET'] as const,
  ED25519: ['SOLANA_MAINNET'] as const
};