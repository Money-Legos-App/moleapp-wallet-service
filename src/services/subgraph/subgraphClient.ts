import { logger } from '../../utils/logger.js';
import { developmentMode } from '../../config/environment.js';

interface SubgraphResponse<T> {
  data: T;
  errors?: Array<{ message: string }>;
}

const SUBGRAPH_URLS: Record<number, string | undefined> = developmentMode ? {
  11155111: process.env.GOLDSKY_SUBGRAPH_URL_SEPOLIA,
  421614: process.env.GOLDSKY_SUBGRAPH_URL_ARB_SEPOLIA,
  97: process.env.GOLDSKY_SUBGRAPH_URL_CHAPEL,
} : {
  1: process.env.GOLDSKY_SUBGRAPH_URL_ETH,
  42161: process.env.GOLDSKY_SUBGRAPH_URL_ARBITRUM,
  8453: process.env.GOLDSKY_SUBGRAPH_URL_BASE,
};

const TIMEOUT_MS = 10_000;

export function getSubgraphUrl(chainId: number): string | null {
  return SUBGRAPH_URLS[chainId] ?? null;
}

export function getSupportedSubgraphChainIds(): number[] {
  return Object.entries(SUBGRAPH_URLS)
    .filter(([, url]) => !!url)
    .map(([id]) => Number(id));
}

export async function querySubgraph<T>(
  chainId: number,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T | null> {
  const url = getSubgraphUrl(chainId);
  if (!url) {
    logger.debug(`No subgraph URL configured for chain ${chainId}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.error('Subgraph query failed', {
        chainId,
        status: response.status,
        statusText: response.statusText,
      });
      return null;
    }

    const json = (await response.json()) as SubgraphResponse<T>;

    if (json.errors?.length) {
      logger.error('Subgraph returned errors', {
        chainId,
        errors: json.errors.map((e) => e.message),
      });
      return null;
    }

    return json.data;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      logger.warn('Subgraph query timed out', { chainId, timeoutMs: TIMEOUT_MS });
    } else {
      logger.error('Subgraph query exception', {
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
