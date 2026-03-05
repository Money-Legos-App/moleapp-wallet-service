import { type Hex } from 'viem';

/**
 * Agent Key Manager — EIP-712 Signing Utility
 *
 * All key generation and encryption is now handled by agent-service
 * via HCP Vault Transit (encryption-as-a-service). This module only
 * retains the EIP-712 typed data signing helper used for Hyperliquid
 * trade order signing when a decrypted key is available in memory.
 */

/**
 * Sign EIP-712 typed data using a decrypted agent private key.
 * Used for Hyperliquid trade order signing (local, zero-latency).
 *
 * @param privateKey - Decrypted private key (from Vault Transit JIT decrypt)
 * @param typedData - EIP-712 typed data to sign
 * @returns Signature hex string
 */
export async function signWithAgentKey(
  privateKey: Hex,
  typedData: {
    domain: any;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, any>;
  },
): Promise<string> {
  const { signTypedData } = await import('viem/accounts');

  // Remove EIP712Domain from types if present
  const types = { ...typedData.types };
  delete types['EIP712Domain'];

  const signature = await signTypedData({
    privateKey,
    domain: typedData.domain,
    types,
    primaryType: typedData.primaryType,
    message: typedData.message,
  });

  return signature;
}
