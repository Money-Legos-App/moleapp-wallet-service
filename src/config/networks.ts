import { Chain, sepolia, arbitrumSepolia, mainnet, arbitrum, base } from 'viem/chains';
import { developmentMode } from './environment.js';

export interface NetworkConfig {
  chainId: number | null; // null for non-EVM chains
  name: string;
  rpcUrl: string;
  entryPointV07?: string; // Not applicable for non-EVM chains
  paymasterUrl?: string;
  bundlerUrl?: string;
  explorerUrl?: string;
  currencySymbol: string;
  isTestnet: boolean;
  chain?: Chain; // Optional for non-EVM chains
  chainType: 'EVM' | 'SOLANA' | 'BITCOIN';
  addressFormat: 'ETHEREUM' | 'SOLANA' | 'BITCOIN';
  curve: 'SECP256K1' | 'ED25519';
}

// BSC Testnet configuration
export const bscTestnet = {
  id: 97,
  name: 'Binance Smart Chain Testnet',
  network: 'bsc-testnet',
  nativeCurrency: {
    decimals: 18,
    name: 'tBNB',
    symbol: 'tBNB',
  },
  rpcUrls: {
    public: { http: ['https://data-seed-prebsc-1-s1.binance.org:8545'] },
    default: { http: ['https://data-seed-prebsc-1-s1.binance.org:8545'] },
  },
  blockExplorers: {
    etherscan: { name: 'BscScan', url: 'https://testnet.bscscan.com' },
    default: { name: 'BscScan', url: 'https://testnet.bscscan.com' },
  },
} as const;

// BSC Mainnet configuration
export const bscMainnet = {
  id: 56,
  name: 'BNB Smart Chain',
  network: 'bsc',
  nativeCurrency: { decimals: 18, name: 'BNB', symbol: 'BNB' },
  rpcUrls: {
    public: { http: ['https://bsc-dataseed.binance.org/'] },
    default: { http: ['https://bsc-dataseed.binance.org/'] },
  },
  blockExplorers: {
    etherscan: { name: 'BscScan', url: 'https://bscscan.com' },
    default: { name: 'BscScan', url: 'https://bscscan.com' },
  },
} as const;

// Testnet network configurations
const TESTNET_NETWORKS: Record<string, NetworkConfig> = {
  // Ethereum Sepolia
  'ETH_SEPOLIA': {
    chainId: 11155111,
    name: 'Ethereum Sepolia',
    rpcUrl: process.env.ETH_TESTNET_RPC_URL || process.env.SEPOLIA_RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/lUkI7uYQQMITyFFDcP6KrEzBxA4j4Hl9',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/sepolia/rpc?apikey=${process.env.PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/sepolia/rpc?apikey=${process.env.PIMLICO_API_KEY}`,
    explorerUrl: 'https://sepolia.etherscan.io',
    currencySymbol: 'ETH',
    isTestnet: true,
    chain: sepolia,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1'
  },

  // Arbitrum Sepolia (for Hyperliquid bridge deposits/withdrawals)
  'ARBITRUM_SEPOLIA': {
    chainId: 421614,
    name: 'Arbitrum Sepolia',
    rpcUrl: process.env.ARBITRUM_TESTNET_RPC_URL || process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://sepolia-rollup.arbitrum.io/rpc',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/421614/rpc?apikey=${process.env.PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/421614/rpc?apikey=${process.env.PIMLICO_API_KEY}`,
    explorerUrl: 'https://sepolia.arbiscan.io',
    currencySymbol: 'ETH',
    isTestnet: true,
    chain: arbitrumSepolia,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1'
  },

  // BSC Testnet
  'BNB_TESTNET': {
    chainId: 97,
    name: 'BSC Testnet',
    rpcUrl: process.env.BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.binance.org:8545',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/bsc-testnet/rpc?apikey=${process.env.PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/bsc-testnet/rpc?apikey=${process.env.PIMLICO_API_KEY}`,
    explorerUrl: 'https://testnet.bscscan.com',
    currencySymbol: 'tBNB',
    isTestnet: true,
    chain: bscTestnet,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1'
  },

  // Solana Devnet
  'SOLANA_DEVNET': {
    chainId: null,
    name: 'Solana Devnet',
    rpcUrl: process.env.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com',
    explorerUrl: 'https://explorer.solana.com/?cluster=devnet',
    currencySymbol: 'SOL',
    isTestnet: true,
    chainType: 'SOLANA',
    addressFormat: 'SOLANA',
    curve: 'ED25519'
  },

  // Bitcoin Testnet
  'BITCOIN_TESTNET': {
    chainId: null,
    name: 'Bitcoin Testnet',
    rpcUrl: process.env.BITCOIN_TESTNET_RPC_URL || 'https://blockstream.info/testnet/api',
    explorerUrl: 'https://blockstream.info/testnet',
    currencySymbol: 'tBTC',
    isTestnet: true,
    chainType: 'BITCOIN',
    addressFormat: 'BITCOIN',
    curve: 'SECP256K1'
  }
};

// Mainnet network configurations
const MAINNET_NETWORKS: Record<string, NetworkConfig> = {
  'ETH_MAINNET': {
    chainId: 1,
    name: 'Ethereum',
    rpcUrl: process.env.PROD_ETH_RPC_URL || process.env.ETH_RPC_URL || 'https://eth.llamarpc.com',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/1/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/1/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    explorerUrl: 'https://etherscan.io',
    currencySymbol: 'ETH',
    isTestnet: false,
    chain: mainnet,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1',
  },
  'ARBITRUM_ONE': {
    chainId: 42161,
    name: 'Arbitrum One',
    rpcUrl: process.env.PROD_ARBITRUM_RPC_URL || process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/42161/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/42161/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    explorerUrl: 'https://arbiscan.io',
    currencySymbol: 'ETH',
    isTestnet: false,
    chain: arbitrum,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1',
  },
  'BASE': {
    chainId: 8453,
    name: 'Base',
    rpcUrl: process.env.PROD_BASE_RPC_URL || process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/8453/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/8453/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    explorerUrl: 'https://basescan.org',
    currencySymbol: 'ETH',
    isTestnet: false,
    chain: base,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1',
  },

  // BNB Smart Chain (mainnet equivalent of BNB_TESTNET)
  'BNB_MAINNET': {
    chainId: 56,
    name: 'BNB Smart Chain',
    rpcUrl: process.env.PROD_BSC_RPC_URL || process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org/',
    entryPointV07: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    paymasterUrl: `https://api.pimlico.io/v2/56/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    bundlerUrl: `https://api.pimlico.io/v2/56/rpc?apikey=${process.env.PIMLICO_API_KEY || process.env.PROD_PIMLICO_API_KEY}`,
    explorerUrl: 'https://bscscan.com',
    currencySymbol: 'BNB',
    isTestnet: false,
    chain: bscMainnet,
    chainType: 'EVM',
    addressFormat: 'ETHEREUM',
    curve: 'SECP256K1',
  },

  // Solana Mainnet (mainnet equivalent of SOLANA_DEVNET)
  'SOLANA_MAINNET': {
    chainId: null,
    name: 'Solana',
    rpcUrl: process.env.PROD_SOLANA_RPC_URL || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    currencySymbol: 'SOL',
    isTestnet: false,
    chainType: 'SOLANA',
    addressFormat: 'SOLANA',
    curve: 'ED25519',
  },

  // Bitcoin Mainnet (mainnet equivalent of BITCOIN_TESTNET)
  'BITCOIN_MAINNET': {
    chainId: null,
    name: 'Bitcoin',
    rpcUrl: process.env.PROD_BITCOIN_RPC_URL || process.env.BITCOIN_RPC_URL || 'https://blockstream.info/api',
    explorerUrl: 'https://blockstream.info',
    currencySymbol: 'BTC',
    isTestnet: false,
    chainType: 'BITCOIN',
    addressFormat: 'BITCOIN',
    curve: 'SECP256K1',
  },
};

// Active networks based on environment
export const NETWORKS: Record<string, NetworkConfig> = developmentMode ? TESTNET_NETWORKS : MAINNET_NETWORKS;

// Default EVM chain ID based on environment
export const DEFAULT_EVM_CHAIN_ID = developmentMode ? 11155111 : 42161;

export const getSupportedChainKeys = (): string[] => {
  return Object.keys(NETWORKS);
};

export const getSupportedChainIds = (): (number | null)[] => {
  return Object.values(NETWORKS).map(config => config.chainId);
};

export const getNetworkConfig = (chainKey: string): NetworkConfig => {
  const config = NETWORKS[chainKey];
  if (!config) {
    throw new Error(`Unsupported network: ${chainKey}`);
  }
  return config;
};

export const getNetworkConfigByChainId = (chainId: number): NetworkConfig => {
  const config = Object.values(NETWORKS).find(n => n.chainId === chainId);
  if (!config) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }
  return config;
};

export const isTestnet = (chainKey: string): boolean => {
  const config = getNetworkConfig(chainKey);
  return config.isTestnet;
};

export const getChainByType = (chainType: 'EVM' | 'SOLANA' | 'BITCOIN'): NetworkConfig[] => {
  return Object.values(NETWORKS).filter(config => config.chainType === chainType);
};

export default NETWORKS;
