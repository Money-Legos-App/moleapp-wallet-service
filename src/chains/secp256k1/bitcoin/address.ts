import crypto from 'crypto';

/**
 * Bitcoin Address Utilities
 * Handles Bitcoin address derivation and validation
 */
export class BitcoinAddressUtils {

  /**
   * Validate Bitcoin address format
   */
  static isValidBitcoinAddress(address: string): boolean {
    // Basic validation for Bitcoin testnet addresses

    // P2WPKH (SegWit) testnet addresses - tb1q... (42 chars)
    if (address.startsWith('tb1q') && address.length === 42) {
      return true; // Bech32 P2WPKH testnet
    }

    // P2TR (Taproot) testnet addresses - tb1p... (62 chars)
    if (address.startsWith('tb1p') && address.length === 62) {
      return true; // Bech32 P2TR testnet
    }

    // Legacy P2PKH testnet addresses
    if ((address.startsWith('m') || address.startsWith('n')) && address.length >= 26 && address.length <= 35) {
      return true; // Legacy testnet
    }

    return false;
  }

  /**
   * Get address type
   */
  static getAddressType(address: string): 'bech32_p2wpkh' | 'bech32_p2tr' | 'legacy' | 'unknown' {
    if (address.startsWith('tb1q')) {
      return 'bech32_p2wpkh'; // SegWit P2WPKH
    }
    if (address.startsWith('tb1p')) {
      return 'bech32_p2tr'; // Taproot P2TR
    }
    if (address.startsWith('m') || address.startsWith('n')) {
      return 'legacy'; // Legacy P2PKH
    }
    return 'unknown';
  }
}