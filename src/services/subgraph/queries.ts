/**
 * GraphQL queries for Goldsky subgraphs.
 * All queries accept lowercase address strings and support cursor-based pagination.
 */

export const TRANSFERS_BY_ACCOUNT = `
  query TransfersByAccount(
    $account: Bytes!
    $first: Int!
    $skip: Int!
    $orderDirection: OrderDirection!
  ) {
    sent: transfers(
      where: { from: $account }
      first: $first
      skip: $skip
      orderBy: blockTimestamp
      orderDirection: $orderDirection
    ) {
      id
      from
      to
      value
      token
      blockNumber
      blockTimestamp
      transactionHash
      logIndex
    }
    received: transfers(
      where: { to: $account }
      first: $first
      skip: $skip
      orderBy: blockTimestamp
      orderDirection: $orderDirection
    ) {
      id
      from
      to
      value
      token
      blockNumber
      blockTimestamp
      transactionHash
      logIndex
    }
  }
`;

export const APPROVALS_BY_OWNER = `
  query ApprovalsByOwner(
    $owner: Bytes!
    $first: Int!
    $skip: Int!
  ) {
    approvals(
      where: { owner: $owner }
      first: $first
      skip: $skip
      orderBy: blockTimestamp
      orderDirection: desc
    ) {
      id
      owner
      spender
      value
      token
      blockNumber
      blockTimestamp
      transactionHash
    }
  }
`;

export const USER_OPS_BY_SENDER = `
  query UserOpsBySender(
    $sender: Bytes!
    $first: Int!
    $skip: Int!
  ) {
    userOperationEvents(
      where: { sender: $sender }
      first: $first
      skip: $skip
      orderBy: blockTimestamp
      orderDirection: desc
    ) {
      id
      userOpHash
      sender
      paymaster
      nonce
      success
      actualGasCost
      actualGasUsed
      blockNumber
      blockTimestamp
      transactionHash
    }
  }
`;

export const ACCOUNT_SUMMARY = `
  query AccountSummary($id: ID!) {
    account(id: $id) {
      id
      transferCount
      userOpCount
      lastActivity
    }
  }
`;

/** Raw types matching the subgraph schema */

export interface SubgraphTransfer {
  id: string;
  from: string;
  to: string;
  value: string;
  token: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
  logIndex: string;
}

export interface SubgraphApproval {
  id: string;
  owner: string;
  spender: string;
  value: string;
  token: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
}

export interface SubgraphUserOp {
  id: string;
  userOpHash: string;
  sender: string;
  paymaster: string;
  nonce: string;
  success: boolean;
  actualGasCost: string;
  actualGasUsed: string;
  blockNumber: string;
  blockTimestamp: string;
  transactionHash: string;
}

export interface SubgraphAccount {
  id: string;
  transferCount: string;
  userOpCount: string;
  lastActivity: string;
}

export interface TransfersByAccountResponse {
  sent: SubgraphTransfer[];
  received: SubgraphTransfer[];
}

export interface ApprovalsByOwnerResponse {
  approvals: SubgraphApproval[];
}

export interface UserOpsBySenderResponse {
  userOperationEvents: SubgraphUserOp[];
}

export interface AccountSummaryResponse {
  account: SubgraphAccount | null;
}
