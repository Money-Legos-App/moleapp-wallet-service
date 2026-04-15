/**
 * LocalRamp API Client
 *
 * Central HTTP client with token-based authentication for all LocalRamp API calls.
 * Auth: x-auth-token header with secret key (server-side) or public key (read-only).
 */

import axios, { AxiosInstance } from 'axios';
import { logger } from '../../../utils/logger';

export interface LocalRampConfig {
  secretKey: string;
  publicKey: string;
  baseUrl: string;
  webhookToken: string;
}

let lrConfig: LocalRampConfig | null = null;

export function initLocalRampConfig(config: LocalRampConfig): void {
  lrConfig = config;
}

export function getLocalRampConfig(): LocalRampConfig {
  if (!lrConfig) {
    lrConfig = {
      secretKey: process.env.LOCALRAMP_SECRET_KEY || process.env.DEV_LOCALRAMP_SECRET_KEY || '',
      publicKey: process.env.LOCALRAMP_PUBLIC_KEY || process.env.DEV_LOCALRAMP_PUBLIC_KEY || '',
      baseUrl: process.env.LOCALRAMP_BASE_URL || process.env.DEV_LOCALRAMP_BASE_URL || 'https://api.localramp.co',
      webhookToken: process.env.LOCALRAMP_WEBHOOK_TOKEN || process.env.DEV_LOCALRAMP_WEBHOOK_TOKEN || '',
    };
  }
  return lrConfig;
}

/**
 * Create an Axios client authenticated with the SECRET key (write operations).
 */
export function createLocalRampClient(): AxiosInstance {
  const config = getLocalRampConfig();

  const client = axios.create({
    baseURL: config.baseUrl,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-auth-token': config.secretKey,
    },
  });

  client.interceptors.request.use(
    (reqConfig) => {
      logger.debug('LocalRamp API request', { method: reqConfig.method, url: reqConfig.url });
      return reqConfig;
    },
    (error) => {
      logger.error('LocalRamp API request error', { error: error.message });
      return Promise.reject(error);
    }
  );

  client.interceptors.response.use(
    (response) => {
      logger.debug('LocalRamp API response', { status: response.status, url: response.config.url });
      return response;
    },
    (error) => {
      logger.error('LocalRamp API error', {
        status: error.response?.status,
        url: error.config?.url,
        data: error.response?.data,
      });
      return Promise.reject(error);
    }
  );

  return client;
}

/**
 * Create an Axios client authenticated with the PUBLIC key (read-only operations).
 */
export function createLocalRampPublicClient(): AxiosInstance {
  const config = getLocalRampConfig();

  return axios.create({
    baseURL: config.baseUrl,
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-auth-token': config.publicKey,
    },
  });
}

let secretClientInstance: AxiosInstance | null = null;
let publicClientInstance: AxiosInstance | null = null;

export function getLocalRampClient(): AxiosInstance {
  if (!secretClientInstance) {
    secretClientInstance = createLocalRampClient();
  }
  return secretClientInstance;
}

export function getLocalRampPublicClient(): AxiosInstance {
  if (!publicClientInstance) {
    publicClientInstance = createLocalRampPublicClient();
  }
  return publicClientInstance;
}

export function resetLocalRampClient(): void {
  secretClientInstance = null;
  publicClientInstance = null;
}
