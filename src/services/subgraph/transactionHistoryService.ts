import { logger } from '../../utils/logger.js';
import { querySubgraph, getSupportedSubgraphChainIds } from './subgraphClient.js';
import {
  TRANSFERS_BY_ACCOUNT,
  USER_OPS_BY_SENDER,
  APPROVALS_BY_OWNER,
  type TransfersByAccountResponse,
  type UserOpsBySenderResponse,
  type ApprovalsByOwnerResponse,
  type SubgraphTransfer,
  type SubgraphUserOp,
  type SubgraphApproval,
} from './queries.js';

export type TransactionHistoryType = 'transfer' | 'approval' | 'userop';

export interface TransactionHistoryItem {
  id: string;
  type: 'send' | 'receive' | 'approve' | 'userop';
  chainId: number;
  transactionHash: string;
  blockNumber: number;
  blockTimestamp: number;
  /** ISO-8601 timestamp */
  timestamp: string;
  from: string;
  to: string;
  /** Raw value in token smallest unit */
  value: string;
  /** Token contract address (null for UserOps) */
  tokenAddress: string | null;
  /** UserOp-specific fields */
  userOpHash: string | null;
  success: boolean | null;
  gasCost: string | null;
}

export interface TransactionHistoryOptions {
  limit?: number;
  offset?: number;
  chainId?: number;
  type?: TransactionHistoryType;
}

interface AddressOnChain {
  chainId: number;
  address: string;
}

/**
 * Fetch multi-chain transaction history from Goldsky subgraphs.
 *
 * Queries all configured chain subgraphs in parallel, merges results,
 * and returns a unified, paginated list sorted by timestamp descending.
 */
export async function getTransactionHistory(
  addresses: AddressOnChain[],
  options: TransactionHistoryOptions = {},
): Promise<{ items: TransactionHistoryItem[]; total: number }> {
  const { limit = 20, offset = 0, chainId: filterChainId, type: filterType } = options;
  const perChainLimit = 100; // fetch more per chain, then merge + paginate

  // Determine which chains to query
  const configuredChains = getSupportedSubgraphChainIds();
  const chainsToQuery = filterChainId
    ? configuredChains.filter((c) => c === filterChainId)
    : configuredChains;

  // Build parallel queries for each (address, chain) pair
  const queryPromises: Promise<TransactionHistoryItem[]>[] = [];

  for (const { chainId, address } of addresses) {
    if (!chainsToQuery.includes(chainId)) continue;
    const lowerAddress = address.toLowerCase();

    // Transfers
    if (!filterType || filterType === 'transfer') {
      queryPromises.push(
        fetchTransfers(chainId, lowerAddress, perChainLimit),
      );
    }

    // Approvals
    if (!filterType || filterType === 'approval') {
      queryPromises.push(
        fetchApprovals(chainId, lowerAddress, perChainLimit),
      );
    }

    // UserOps (use kernel account addresses)
    if (!filterType || filterType === 'userop') {
      queryPromises.push(
        fetchUserOps(chainId, lowerAddress, perChainLimit),
      );
    }
  }

  const results = await Promise.allSettled(queryPromises);

  // Collect all items
  const allItems: TransactionHistoryItem[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    } else {
      logger.warn('Subgraph query failed in history merge', {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  // Deduplicate by id (same tx can appear if address is both sender and receiver)
  const seen = new Set<string>();
  const deduped = allItems.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });

  // Sort by timestamp descending
  deduped.sort((a, b) => b.blockTimestamp - a.blockTimestamp);

  return {
    items: deduped.slice(offset, offset + limit),
    total: deduped.length,
  };
}

async function fetchTransfers(
  chainId: number,
  address: string,
  limit: number,
): Promise<TransactionHistoryItem[]> {
  const data = await querySubgraph<TransfersByAccountResponse>(
    chainId,
    TRANSFERS_BY_ACCOUNT,
    { account: address, first: limit, skip: 0, orderDirection: 'desc' },
  );

  if (!data) return [];

  const items: TransactionHistoryItem[] = [];

  for (const tx of data.sent) {
    items.push(mapTransfer(tx, chainId, 'send'));
  }

  for (const tx of data.received) {
    items.push(mapTransfer(tx, chainId, 'receive'));
  }

  return items;
}

async function fetchApprovals(
  chainId: number,
  address: string,
  limit: number,
): Promise<TransactionHistoryItem[]> {
  const data = await querySubgraph<ApprovalsByOwnerResponse>(
    chainId,
    APPROVALS_BY_OWNER,
    { owner: address, first: limit, skip: 0 },
  );

  if (!data) return [];

  return data.approvals.map((a) => mapApproval(a, chainId));
}

async function fetchUserOps(
  chainId: number,
  address: string,
  limit: number,
): Promise<TransactionHistoryItem[]> {
  const data = await querySubgraph<UserOpsBySenderResponse>(
    chainId,
    USER_OPS_BY_SENDER,
    { sender: address, first: limit, skip: 0 },
  );

  if (!data) return [];

  return data.userOperationEvents.map((op) => mapUserOp(op, chainId));
}

function mapTransfer(
  tx: SubgraphTransfer,
  chainId: number,
  type: 'send' | 'receive',
): TransactionHistoryItem {
  const ts = Number(tx.blockTimestamp);
  return {
    id: `${chainId}-transfer-${tx.id}`,
    type,
    chainId,
    transactionHash: tx.transactionHash,
    blockNumber: Number(tx.blockNumber),
    blockTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    from: tx.from,
    to: tx.to,
    value: tx.value,
    tokenAddress: tx.token,
    userOpHash: null,
    success: null,
    gasCost: null,
  };
}

function mapApproval(
  a: SubgraphApproval,
  chainId: number,
): TransactionHistoryItem {
  const ts = Number(a.blockTimestamp);
  return {
    id: `${chainId}-approval-${a.id}`,
    type: 'approve',
    chainId,
    transactionHash: a.transactionHash,
    blockNumber: Number(a.blockNumber),
    blockTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    from: a.owner,
    to: a.spender,
    value: a.value,
    tokenAddress: a.token,
    userOpHash: null,
    success: null,
    gasCost: null,
  };
}

function mapUserOp(
  op: SubgraphUserOp,
  chainId: number,
): TransactionHistoryItem {
  const ts = Number(op.blockTimestamp);
  return {
    id: `${chainId}-userop-${op.id}`,
    type: 'userop',
    chainId,
    transactionHash: op.transactionHash,
    blockNumber: Number(op.blockNumber),
    blockTimestamp: ts,
    timestamp: new Date(ts * 1000).toISOString(),
    from: op.sender,
    to: '',
    value: '0',
    tokenAddress: null,
    userOpHash: op.userOpHash,
    success: op.success,
    gasCost: op.actualGasCost,
  };
}
