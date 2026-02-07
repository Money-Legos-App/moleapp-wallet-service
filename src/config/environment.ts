import dotenv from 'dotenv';

dotenv.config();

// Environment switcher - determines if we're in DEV or PROD mode
const isDevelopmentMode = process.env.DEVELOPMENT_MODE === 'true';

/**
 * Helper function to get environment variable with DEV_/PROD_ prefix support
 * @param key - The base key name (without prefix)
 * @param defaultValue - Default value if not found
 * @returns The environment variable value
 */
const getEnvVar = (key: string, defaultValue: string = ''): string => {
  const prefix = isDevelopmentMode ? 'DEV_' : 'PROD_';
  // First try prefixed version, then fall back to non-prefixed, then default
  return process.env[`${prefix}${key}`] || process.env[key] || defaultValue;
};

/**
 * Helper function for boolean environment variables
 */
const getEnvBool = (key: string, defaultValue: boolean = false): boolean => {
  // For shared feature flags, check non-prefixed first
  const directValue = process.env[key];
  if (directValue !== undefined) {
    return directValue === 'true';
  }
  const value = getEnvVar(key, String(defaultValue));
  return value === 'true';
};

/**
 * Helper function for numeric environment variables
 */
const getEnvNumber = (key: string, defaultValue: number): number => {
  // For shared numeric configs, check non-prefixed first
  const directValue = process.env[key];
  if (directValue !== undefined) {
    return parseInt(directValue, 10) || defaultValue;
  }
  const value = getEnvVar(key, String(defaultValue));
  return parseInt(value, 10) || defaultValue;
};

export interface EnvironmentConfig {
  // Server configuration
  port: number;
  nodeEnv: string;
  
  // Database
  databaseUrl: string;
  
  // Service URLs
  userServiceUrl: string;
  notificationServiceUrl: string;
  momoServiceUrl: string;
  
  // Turnkey configuration
  turnkeyBaseUrl: string;
  turnkeyOrganizationId: string;
  turnkeyApiPrivateKey: string;
  turnkeyApiPublicKey: string;
  
  // ZeroDev configuration
  zerodevProjectId: string;
  zerodevBundlerUrl: string;
  zerodevPaymasterUrl: string;
  
  // Pimlico configuration
  pimlicoApiKey: string;
  pimlicoBaseUrl: string;
  pimlicoSponsorshipPolicyId: string;
  
  // Network RPC URLs
  sepoliaRpcUrl: string;
  bscTestnetRpcUrl: string;
  polygonAmoyRpcUrl: string;
  arbitrumSepoliaRpcUrl: string;
  
  // 0x API configuration
  zeroxBaseUrlSepolia: string;
  zeroxApiKey: string;
  
  // Session Key configuration
  sessionKeyDefaultTtl: number;
  sessionKeyMaxTtl: number;
  maxActiveSessions: number;
  
  // Security
  phoneHashSalt: string;
  
  // Feature flags
  useRealBlockchain: boolean;
  sendSwapNotifications: boolean;
  simulateWalletBalances: boolean;
  
  // Test configuration
  testWalletPrivateKey?: string;
  testWalletAddress?: string;
  
  // Keycloak configuration
  keycloakUrl: string;
  keycloakRealm: string;
  keycloakClientId: string;
  keycloakClientSecret: string;
}

const validateEnvironment = (): EnvironmentConfig => {
  const requiredEnvVars = [
    'DATABASE_URL',
    'TURNKEY_ORGANIZATION_ID',
    'TURNKEY_API_PRIVATE_KEY',
    'TURNKEY_API_PUBLIC_KEY',
    'PIMLICO_API_KEY',
    'PHONE_HASH_SALT'
  ];

  for (const envVar of requiredEnvVars) {
    const value = getEnvVar(envVar);
    if (!value) {
      const prefix = isDevelopmentMode ? 'DEV_' : 'PROD_';
      throw new Error(`Missing required environment variable: ${prefix}${envVar}`);
    }
  }

  return {
    // Server configuration (shared - no prefix)
    port: parseInt(process.env.PORT || '3002', 10),
    nodeEnv: process.env.NODE_ENV || 'development',

    // Database (prefixed)
    databaseUrl: getEnvVar('DATABASE_URL'),

    // Service URLs (prefixed)
    userServiceUrl: getEnvVar('USER_SERVICE_URL', 'http://localhost:3001'),
    notificationServiceUrl: getEnvVar('NOTIFICATION_SERVICE_URL', 'http://localhost:3003'),
    momoServiceUrl: getEnvVar('MOMO_SERVICE_URL', 'http://localhost:3004'),

    // Turnkey configuration (base URL shared, credentials prefixed)
    turnkeyBaseUrl: process.env.TURNKEY_BASE_URL || 'https://api.turnkey.com',
    turnkeyOrganizationId: getEnvVar('TURNKEY_ORGANIZATION_ID'),
    turnkeyApiPrivateKey: getEnvVar('TURNKEY_API_PRIVATE_KEY'),
    turnkeyApiPublicKey: getEnvVar('TURNKEY_API_PUBLIC_KEY'),

    // ZeroDev configuration (prefixed)
    zerodevProjectId: getEnvVar('ZERODEV_PROJECT_ID'),
    zerodevBundlerUrl: getEnvVar('ZERODEV_BUNDLER_URL'),
    zerodevPaymasterUrl: getEnvVar('ZERODEV_PAYMASTER_URL'),

    // Pimlico configuration (base URL shared, credentials prefixed)
    pimlicoApiKey: getEnvVar('PIMLICO_API_KEY'),
    pimlicoBaseUrl: process.env.PIMLICO_BASE_URL || 'https://api.pimlico.io/v2',
    pimlicoSponsorshipPolicyId: getEnvVar('PIMLICO_SPONSORSHIP_POLICY_ID'),

    // Network RPC URLs (prefixed)
    sepoliaRpcUrl: getEnvVar('SEPOLIA_RPC_URL', 'https://eth-sepolia.g.alchemy.com/v2/lUkI7uYQQMITyFFDcP6KrEzBxA4j4Hl9'),
    bscTestnetRpcUrl: getEnvVar('BSC_TESTNET_RPC_URL', 'https://data-seed-prebsc-1-s1.bnbchain.org:8545'),
    polygonAmoyRpcUrl: getEnvVar('POLYGON_AMOY_RPC_URL', 'https://rpc-amoy.polygon.technology'),
    arbitrumSepoliaRpcUrl: getEnvVar('ARBITRUM_SEPOLIA_RPC_URL', 'https://sepolia-rollup.arbitrum.io/rpc'),

    // 0x API configuration (prefixed)
    zeroxBaseUrlSepolia: getEnvVar('ZEROX_BASE_URL_SEPOLIA', 'https://sepolia.api.0x.org'),
    zeroxApiKey: getEnvVar('ZEROX_API_KEY'),

    // Session Key configuration (shared - no prefix)
    sessionKeyDefaultTtl: getEnvNumber('SESSION_KEY_DEFAULT_TTL', 900),
    sessionKeyMaxTtl: getEnvNumber('SESSION_KEY_MAX_TTL', 3600),
    maxActiveSessions: getEnvNumber('MAX_ACTIVE_SESSIONS', 10),

    // Security (prefixed)
    phoneHashSalt: getEnvVar('PHONE_HASH_SALT'),

    // Feature flags (shared - no prefix)
    useRealBlockchain: getEnvBool('USE_REAL_BLOCKCHAIN', false),
    sendSwapNotifications: getEnvBool('SEND_SWAP_NOTIFICATIONS', false),
    simulateWalletBalances: getEnvBool('SIMULATE_WALLET_BALANCES', false),

    // Test configuration (prefixed)
    testWalletPrivateKey: getEnvVar('TEST_WALLET_PRIVATE_KEY') || undefined,
    testWalletAddress: getEnvVar('TEST_WALLET_ADDRESS') || undefined,

    // Keycloak configuration (prefixed)
    keycloakUrl: getEnvVar('KEYCLOAK_URL', 'http://localhost:8080'),
    keycloakRealm: getEnvVar('KEYCLOAK_REALM', 'wallet-realm'),
    keycloakClientId: getEnvVar('KEYCLOAK_CLIENT_ID', 'wallet-service'),
    keycloakClientSecret: getEnvVar('KEYCLOAK_CLIENT_SECRET', 'wallet-service-secret')
  };
};

export const env = validateEnvironment();
export default env;

// Export the development mode flag for use elsewhere
export const developmentMode = isDevelopmentMode;