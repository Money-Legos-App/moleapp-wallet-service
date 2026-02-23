import { UserOperationEvent as UserOpEvent } from '../generated/EntryPoint/EntryPoint';
import { UserOperationEvent, Account } from '../generated/schema';
import { BigInt } from '@graphprotocol/graph-ts';

export function handleUserOperationEvent(event: UserOpEvent): void {
  let id = event.params.userOpHash.toHexString();
  let entity = new UserOperationEvent(id);

  entity.userOpHash = event.params.userOpHash;
  entity.sender = event.params.sender;
  entity.paymaster = event.params.paymaster;
  entity.nonce = event.params.nonce;
  entity.success = event.params.success;
  entity.actualGasCost = event.params.actualGasCost;
  entity.actualGasUsed = event.params.actualGasUsed;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();

  // Update sender account
  let accountId = event.params.sender.toHexString();
  let account = Account.load(accountId);
  if (account == null) {
    account = new Account(accountId);
    account.transferCount = BigInt.fromI32(0);
    account.userOpCount = BigInt.fromI32(0);
    account.lastActivity = BigInt.fromI32(0);
  }
  account.userOpCount = account.userOpCount.plus(BigInt.fromI32(1));
  account.lastActivity = event.block.timestamp;
  account.save();
}
