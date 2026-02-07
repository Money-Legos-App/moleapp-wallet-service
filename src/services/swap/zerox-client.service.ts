/**
 * 0x API Client Service
 * Handles communication with 0x Swap API for quotes and pricing
 * Configured for Sepolia testnet
 */

import { logger } from '../../utils/logger.js';
import { env } from '../../config/environment.js';
import { SWAP_CONFIG } from '../../config/tokens.js';
import type {
  ZeroXQuoteParams,
  ZeroXQuoteResponse,
  ZeroXPriceResponse,
} from './swap.types.js';

export class ZeroXClientService {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly chainId: number;

  constructor(chainId: number = SWAP_CONFIG.CHAIN_ID) {
    this.chainId = chainId;
    this.baseUrl = (env as any).zeroxBaseUrl || SWAP_CONFIG.ZEROX_BASE_URL;
    this.apiKey = (env as any).zeroxApiKey;

    if (!this.apiKey) {
      logger.warn('0x API key not configured - quotes may be rate limited');
    }

    logger.info(`ZeroXClient initialized for chain ${chainId} at ${this.baseUrl}`);
  }

  /**
   * Get swap quote from 0x API
   * Returns pricing info and transaction calldata for execution
   *
   * IMPORTANT: taker must be the smart account address (Kernel),
   * not the EOA address from Turnkey
   */
  async getQuote(params: ZeroXQuoteParams): Promise<ZeroXQuoteResponse> {
    const queryParams = new URLSearchParams({
      chainId: params.chainId.toString(),
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount,
      taker: params.taker, // Smart account address
      slippageBps: (params.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS).toString(),
      skipValidation: 'true', // Required for AA wallets
    });

    const url = `${this.baseUrl}/swap/v1/quote?${queryParams}`;

    logger.info(`Fetching 0x quote: ${params.sellToken} -> ${params.buyToken}`, {
      sellAmount: params.sellAmount,
      taker: params.taker,
      slippageBps: params.slippageBps,
    });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { '0x-api-key': this.apiKey }),
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`0x API error: ${response.status}`, {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
          url: url.replace(this.apiKey || '', '***'),
        });

        // Check for no liquidity or route errors (common on testnets)
        if (response.status === 400 && errorBody.includes('INSUFFICIENT_ASSET_LIQUIDITY')) {
          throw new Error('NO_LIQUIDITY: No swap routes available on Sepolia testnet');
        }

        // Check for 404 "no Route matched" error (testnet limitation)
        if (response.status === 404 && errorBody.includes('no Route matched')) {
          const isTestnet = params.chainId === 11155111; // Sepolia
          const message = isTestnet
            ? 'NO_LIQUIDITY: Sepolia testnet has very limited DEX liquidity. Most token pairs are not available for swapping. Consider using mainnet or a testnet with better liquidity support.'
            : 'NO_ROUTE: No swap route found for this token pair';
          throw new Error(message);
        }

        throw new Error(`0x API error: ${response.status} - ${errorBody}`);
      }

      const data = (await response.json()) as ZeroXQuoteResponse;

      // Validate response has required transaction data
      if (!data.transaction?.to || !data.transaction?.data) {
        logger.error('0x API returned incomplete transaction data', { data });
        throw new Error('Invalid 0x response: missing transaction data');
      }

      logger.info(`0x quote received successfully`, {
        buyAmount: data.buyAmount,
        sellAmount: data.sellAmount,
        allowanceTarget: data.allowanceTarget,
        gasEstimate: data.transaction.gas,
      });

      return data;
    } catch (error) {
      if (error instanceof Error) {
        logger.error('Failed to fetch 0x quote', {
          error: error.message,
          sellToken: params.sellToken,
          buyToken: params.buyToken,
        });
      }
      throw error;
    }
  }

  /**
   * Get swap quote by specifying buyAmount (reverse quote)
   * Calculates required sellAmount for desired buyAmount
   *
   * This enables UX where user enters desired output amount
   * and sees calculated input amount
   */
  async getQuoteByBuyAmount(
    params: Omit<ZeroXQuoteParams, 'sellAmount'> & { buyAmount: string }
  ): Promise<ZeroXQuoteResponse> {
    const queryParams = new URLSearchParams({
      chainId: params.chainId.toString(),
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      buyAmount: params.buyAmount, // Use buyAmount instead of sellAmount
      taker: params.taker,
      slippageBps: (params.slippageBps || SWAP_CONFIG.DEFAULT_SLIPPAGE_BPS).toString(),
      skipValidation: 'true',
    });

    const url = `${this.baseUrl}/swap/v1/quote?${queryParams}`;

    logger.info(`Fetching 0x reverse quote: ${params.sellToken} -> ${params.buyToken}`, {
      buyAmount: params.buyAmount,
      taker: params.taker,
      slippageBps: params.slippageBps,
    });

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { '0x-api-key': this.apiKey }),
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`0x API reverse quote error: ${response.status}`, {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
        });

        // Check for no liquidity or route errors (common on testnets)
        if (response.status === 400 && errorBody.includes('INSUFFICIENT_ASSET_LIQUIDITY')) {
          throw new Error('NO_LIQUIDITY: No swap routes available on Sepolia testnet');
        }

        // Check for 404 "no Route matched" error (testnet limitation)
        if (response.status === 404 && errorBody.includes('no Route matched')) {
          const isTestnet = params.chainId === 11155111; // Sepolia
          const message = isTestnet
            ? 'NO_LIQUIDITY: Sepolia testnet has very limited DEX liquidity. Most token pairs are not available for swapping. Consider using mainnet or a testnet with better liquidity support.'
            : 'NO_ROUTE: No swap route found for this token pair';
          throw new Error(message);
        }

        throw new Error(`0x API error: ${response.status} - ${errorBody}`);
      }

      const data = (await response.json()) as ZeroXQuoteResponse;

      if (!data.transaction?.to || !data.transaction?.data) {
        logger.error('0x API returned incomplete transaction data', { data });
        throw new Error('Invalid 0x response: missing transaction data');
      }

      logger.info(`0x reverse quote received successfully`, {
        sellAmount: data.sellAmount, // Calculated by 0x
        buyAmount: data.buyAmount,
        allowanceTarget: data.allowanceTarget,
      });

      return data;
    } catch (error) {
      if (error instanceof Error) {
        logger.error('Failed to fetch 0x reverse quote', {
          error: error.message,
          sellToken: params.sellToken,
          buyToken: params.buyToken,
        });
      }
      throw error;
    }
  }

  /**
   * Get indicative price (no transaction data)
   * Use for UI display before user commits to a swap
   * More lightweight than full quote
   */
  async getPrice(
    params: Omit<ZeroXQuoteParams, 'taker' | 'skipValidation'>
  ): Promise<ZeroXPriceResponse> {
    const queryParams = new URLSearchParams({
      chainId: params.chainId.toString(),
      sellToken: params.sellToken,
      buyToken: params.buyToken,
      sellAmount: params.sellAmount,
    });

    const url = `${this.baseUrl}/swap/v1/price?${queryParams}`;

    logger.debug(`Fetching 0x price: ${params.sellToken} -> ${params.buyToken}`);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { '0x-api-key': this.apiKey }),
        },
      });

      if (!response.ok) {
        const errorBody = await response.text();
        logger.error(`0x price API error: ${response.status}`, {
          status: response.status,
          body: errorBody,
        });

        // Check for no liquidity error
        if (response.status === 400 && errorBody.includes('INSUFFICIENT_ASSET_LIQUIDITY')) {
          throw new Error('NO_LIQUIDITY: No swap routes available');
        }

        throw new Error(`0x price API error: ${response.status}`);
      }

      const data = await response.json();

      return {
        buyAmount: data.buyAmount,
        sellAmount: data.sellAmount,
        price: data.price,
        sources: data.sources || [],
      };
    } catch (error) {
      if (error instanceof Error) {
        logger.error('Failed to fetch 0x price', { error: error.message });
      }
      throw error;
    }
  }

  /**
   * Check if 0x API is available and configured
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/swap/v1/sources`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey && { '0x-api-key': this.apiKey }),
        },
      });

      const isHealthy = response.ok;
      logger.info(`0x API health check: ${isHealthy ? 'OK' : 'FAILED'}`);
      return isHealthy;
    } catch (error) {
      logger.error('0x API health check failed', { error });
      return false;
    }
  }
}

// Export singleton instance for common usage
export const zeroXClient = new ZeroXClientService();
