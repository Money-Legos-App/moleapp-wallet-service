import { Address, Hash, Hex } from 'viem';

export interface CreateWalletRequest {
  userId: string;
  chainId?: number;
  walletName?: string;
  turnkeySubOrgId?: string; // Optional: Use existing Turnkey sub-org instead of creating new one
}

export interface CreateWalletResponse {
  walletId: string;
  address: Address;
  chainId: number;
  deploymentStatus: 'counterfactual' | 'deployed';
  turnkeySubOrgId: string;
  turnkeyUserId: string;
}

export interface SignTransactionRequest {
  walletId: string;
  to: Address;
  value: string;
  data: Hex;
  chainId: number;
}

export interface SignTransactionResponse {
  signature: Hash;
  userOpHash: Hash;
  transactionHash?: Hash;
}

export interface RecoverWalletRequest {
  userId: string;
  phoneNumber: string;
  recoveryCode?: string;
  passkey?: boolean;
}

export interface RecoverWalletResponse {
  wallets: {
    walletId: string;
    address: Address;
    chainId: number;
    isRecovered: boolean;
  }[];
  turnkeySubOrgId: string;
}

export interface UserOperationRequest {
  walletId: string;
  chainId: number;
  calls: {
    to: Address;
    value: bigint;
    data: Hex;
  }[];
  sponsorUserOperation?: boolean;
}

export interface UserOperationResponse {
  userOpHash: Hash;
  bundlerTransactionHash?: Hash;
  userOperation?: any;
  sponsored: boolean;
  gasCostUsd?: string;
}

export interface WalletBalanceRequest {
  walletId: string;
  chainId?: number;
  tokenAddresses?: Address[];
}

export interface WalletBalanceResponse {
  balances: {
    tokenAddress: Address;
    balance: string;
    decimals: number;
    symbol: string;
    name?: string;
    balanceUsd: string;
    priceUsd: string;
    isVerified: boolean;
  }[];
  totalBalanceUsd: string;
}

export interface SessionKeyRequest {
  walletId: string;
  permissions: string[];
  expiryHours?: number;
  maxValue?: string;
  allowedTargets?: Address[];
}

export interface SessionKeyResponse {
  sessionKey: string;
  expiresAt: Date;
  permissions: string[];
  turnkeySignerId?: string;
}

export interface TurnkeySubOrgConfig {
  subOrganizationName: string;
  rootUsers: {
    userName: string;
    userEmail: string;
    apiKeys: {
      apiKeyName: string;
      publicKey: string;
      curveType: 'API_KEY_CURVE_SECP256K1' | 'API_KEY_CURVE_ED25519';
    }[];
    authenticators: any[];
    oauthProviders: any[];
  }[];
  wallet: {
    walletName: string;
    accounts: {
      curve: 'CURVE_SECP256K1' | 'CURVE_ED25519';
      pathFormat: 'PATH_FORMAT_BIP32';
      path: string;
      addressFormat: 'ADDRESS_FORMAT_ETHEREUM' | 'ADDRESS_FORMAT_SOLANA' | 'ADDRESS_FORMAT_COMPRESSED' | 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2WPKH' | 'ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR' | 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2WPKH' | 'ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR';
    }[];
  };
}

export interface SmartAccountConfig {
  kernelVersion: '0.3.0' | '0.2.4';
  entryPointVersion: '0.7' | '0.6';
  factoryAddress?: Address;
  accountLogicAddress?: Address;
  ecdsaValidatorAddress?: Address;
}

export interface ChainConfig {
  chainId: number;
  bundlerUrl: string;
  paymasterUrl: string;
  rpcUrl: string;
  entryPointAddress: Address;
}

export interface GasEstimate {
  callGasLimit: bigint;
  preVerificationGas: bigint;
  verificationGasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData?: Hex;
  sponsored: boolean;
  totalCostUsd?: string;
}

export interface TransactionStatus {
  userOpHash: Hash;
  transactionHash?: Hash;
  status: 'pending' | 'included' | 'failed';
  receipt?: any;
  blockNumber?: number;
  gasUsed?: bigint;
}

export interface WalletMetrics {
  walletId: string;
  totalTransactions: number;
  totalGasUsed: bigint;
  totalGasCostUsd: string;
  successRate: number;
  averageGasCostUsd: string;
  chainsUsed: number[];
}

export interface ErrorResponse {
  error: string;
  code: string;
  message: string;
  details?: any;
}