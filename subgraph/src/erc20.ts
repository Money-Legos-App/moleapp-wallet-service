import { Transfer as TransferEvent, Approval as ApprovalEvent } from '../generated/USDC/ERC20';
import { Transfer, Approval, Account } from '../generated/schema';
import { BigInt } from '@graphprotocol/graph-ts';

export function handleTransfer(event: TransferEvent): void {
  let id = event.transaction.hash.toHexString() + '-' + event.logIndex.toString();
  let entity = new Transfer(id);

  entity.from = event.params.from;
  entity.to = event.params.to;
  entity.value = event.params.value;
  entity.token = event.address;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.logIndex = event.logIndex;
  entity.save();

  // Update sender account
  let fromId = event.params.from.toHexString();
  let fromAccount = Account.load(fromId);
  if (fromAccount == null) {
    fromAccount = new Account(fromId);
    fromAccount.transferCount = BigInt.fromI32(0);
    fromAccount.userOpCount = BigInt.fromI32(0);
    fromAccount.lastActivity = BigInt.fromI32(0);
  }
  fromAccount.transferCount = fromAccount.transferCount.plus(BigInt.fromI32(1));
  fromAccount.lastActivity = event.block.timestamp;
  fromAccount.save();

  // Update receiver account
  let toId = event.params.to.toHexString();
  let toAccount = Account.load(toId);
  if (toAccount == null) {
    toAccount = new Account(toId);
    toAccount.transferCount = BigInt.fromI32(0);
    toAccount.userOpCount = BigInt.fromI32(0);
    toAccount.lastActivity = BigInt.fromI32(0);
  }
  toAccount.transferCount = toAccount.transferCount.plus(BigInt.fromI32(1));
  toAccount.lastActivity = event.block.timestamp;
  toAccount.save();
}

export function handleApproval(event: ApprovalEvent): void {
  let id = event.transaction.hash.toHexString() + '-' + event.logIndex.toString();
  let entity = new Approval(id);

  entity.owner = event.params.owner;
  entity.spender = event.params.spender;
  entity.value = event.params.value;
  entity.token = event.address;
  entity.blockNumber = event.block.number;
  entity.blockTimestamp = event.block.timestamp;
  entity.transactionHash = event.transaction.hash;
  entity.save();
}
