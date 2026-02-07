import { Address, Hex } from 'viem';

/**
 * Base interface for all chain services
 * Each chain type implements this interface
 */
export interface ChainService {
  /**
   * Create wallet for this chain
   */
  createWallet(params: {
    userId: string;
    subOrgId: string;
    turnkeyUserId: string;
    walletAddress: Address;
    chainConfig: any;
  }): Promise<CreateWalletResponse>;

  /**
   * Get wallet balance for this chain
   */
  getBalance?(address: Address): Promise<BalanceResponse>;

  /**
   * Submit transaction for this chain
   */
  submitTransaction?(request: TransactionRequest): Promise<TransactionResponse>;
}

/**
 * EVM-specific chain service interface
 * Extends base with Account Abstraction features
 */
export interface EVMChainService extends ChainService {
  /**
   * Deploy wallet to blockchain (Account Abstraction)
   */
  deployWallet(walletId: string): Promise<DeploymentResponse>;

  /**
   * Submit UserOperation (gasless transaction)
   */
  submitUserOperation(request: UserOperationRequest): Promise<UserOperationResponse>;

  /**
   * Estimate gas for UserOperation
   */
  estimateGas(request: UserOperationRequest): Promise<GasEstimate>;
}

// Response Types
export interface CreateWalletResponse {
  walletId: string;
  address: Address;
  chainId: number;
  deploymentStatus: 'counterfactual' | 'deployed';
  turnkeySubOrgId: string;
  turnkeyUserId: string;
}

export interface BalanceResponse {
  address: Address;
  balance: string;
  decimals: number;
  symbol: string;
  balanceUsd?: string;
}

export interface TransactionRequest {
  walletId: string;
  to: Address;
  value: string;
  data?: Hex;
  chainId: number;
}

export interface TransactionResponse {
  transactionHash: Hex;
  status: 'pending' | 'confirmed' | 'failed';
}

export interface UserOperationRequest {
  walletId: string;
  chainId: number;
  calls: Array<{
    to: Address;
    value: bigint;
    data: Hex;
  }>;
  sponsorUserOperation?: boolean;
}

export interface UserOperationResponse {
  userOpHash: Hex;
  bundlerTransactionHash?: Hex;
  sponsored: boolean;
  gasCostUsd?: string;
}

export interface DeploymentResponse {
  transactionHash: Hex;
  address: Address;
  isDeployed: boolean;
}

export interface GasEstimate {
  callGasLimit: bigint;
  preVerificationGas: bigint;
  verificationGasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  totalCostUsd?: string;
}

// Chain Configuration Types
export interface ChainConfig {
  chainId: number | null;
  name: string;
  chainType: 'EVM' | 'SOLANA' | 'BITCOIN' | 'COSMOS';
  curve: 'SECP256K1' | 'ED25519';
  addressFormat: 'ETHEREUM' | 'SOLANA' | 'BITCOIN' | 'COSMOS';
  rpcUrl: string;
  explorerUrl: string;
  currencySymbol: string;
  isTestnet: boolean;
  // EVM-specific
  entryPointV07?: string;
  paymasterUrl?: string;
  bundlerUrl?: string;
}

// Chain Type Enums
export type ChainType = 'EVM' | 'SOLANA' | 'BITCOIN' | 'COSMOS';
export type CurveType = 'SECP256K1' | 'ED25519';
export type AddressFormat = 'ETHEREUM' | 'SOLANA' | 'BITCOIN' | 'COSMOS';

// Supported Chain Keys
export type EVMChainKey = 'ETH_SEPOLIA' | 'POLYGON_AMOY' | 'BNB_TESTNET';
export type BitcoinChainKey = 'BITCOIN_TESTNET';
export type SolanaChainKey = 'SOLANA_DEVNET';
export type SupportedChainKey = EVMChainKey | BitcoinChainKey | SolanaChainKey;