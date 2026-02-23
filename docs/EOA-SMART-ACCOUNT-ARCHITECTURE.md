# EOA and Smart Account Management with Turnkey

## Architecture Overview

MoleApp uses a two-tier account structure for Account Abstraction:

1. **EOA (Externally Owned Account)** - Managed by Turnkey
2. **Smart Account (Account Abstraction)** - ZeroDev Kernel v3.1

### Current Flow

```
User → Passkey (WebAuthn) → Turnkey Sub-Organization → EOA Address → Smart Account Owner
                                                          ↓
                                                    TurnkeySigner Table
                                                          ↓
                                                    (ownerAddress)
                                                          ↓
                                                    KernelAccount
                                                  (Smart Account)
```

## Data Model

### TurnkeySigner (EOA)
```typescript
{
  address: string,          // EOA address from Turnkey (actual owner)
  turnkeySubOrgId: string,  // Turnkey sub-org identifier
  turnkeyUserId: string,    // Turnkey user identifier
  publicKey: string,        // Public key from Turnkey
  userId: string,           // Internal user ID
  walletId: string          // Links to Wallet table
}
```

### KernelAccount (Smart Account)
```typescript
{
  address: string,          // Smart account address (different from EOA)
  ownerAddress: string,     // MUST be TurnkeySigner.address (EOA)
  turnkeySubOrgId: string,  // Links to TurnkeySigner
  chainId: number,          // EVM chain ID
  walletId: string          // Links to Wallet table
}
```

## Critical Issues (Current Implementation)

### Issue 1: Wrong ownerAddress
**Location**: `backend/wallet-service/src/chains/secp256k1/evm/base.service.ts:86`

**Problem**: `walletAddress` (smart account address) is passed as `ownerAddress` instead of EOA address.

**Current Code**:
```typescript
await this.kernelService.createKernelAccount(
  userId,
  chainId,
  walletAddress,  // ❌ WRONG: This is smart account address, not EOA
  subOrgId,
  wallet.id
);
```

**Fix**: Use `TurnkeySigner.address` (EOA) as `ownerAddress`:
```typescript
// Get EOA from TurnkeySigner
const turnkeySigner = await this.prisma.turnkeySigner.findFirst({
  where: { turnkeySubOrgId: subOrgId, isActive: true }
});

if (!turnkeySigner) {
  throw new Error(`TurnkeySigner not found for sub-org: ${subOrgId}`);
}

await this.kernelService.createKernelAccount(
  userId,
  chainId,
  turnkeySigner.address as Address,  // ✅ CORRECT: EOA address
  subOrgId,
  wallet.id
);
```

### Issue 2: Deterministic Key Instead of Turnkey Signing
**Location**: `backend/wallet-service/src/services/turnkey/evm-signer.service.ts:62-72`

**Problem**: Creating deterministic private key from sub-org ID instead of using actual Turnkey-managed key.

**Current Code**:
```typescript
// ❌ WRONG: Deterministic key, not actual Turnkey key
const privateKeyHash = crypto
  .createHash('sha256')
  .update(turnkeySubOrgId + env.turnkeyApiPrivateKey)
  .digest('hex');

const privateKey = '0x' + privateKeyHash;
const viemAccount = privateKeyToAccount(privateKey as `0x${string}`);
```

**Fix**: Use Turnkey SDK to sign transactions directly. The signer should wrap Turnkey signing:

```typescript
import { TurnkeyClient } from '@turnkey/http';
import { createWalletClient, http } from 'viem';

async createZeroDevSigner(turnkeySubOrgId: string): Promise<any> {
  // Get TurnkeySigner record to find the key ID
  const signerRecord = await this.prisma.turnkeySigner.findFirst({
    where: { turnkeySubOrgId, isActive: true }
  });

  if (!signerRecord) {
    throw new Error(`No active Turnkey signer found for sub-org ${turnkeySubOrgId}`);
  }

  // Create a custom signer that uses Turnkey for signing
  // ZeroDev expects a viem account-compatible signer
  return {
    address: signerRecord.address as Address,
    signMessage: async ({ message }: { message: string }) => {
      // Use Turnkey to sign the message
      // This requires the actual Turnkey key ID/address
      // Implementation depends on Turnkey SDK v2.0.15 capabilities
    },
    signTransaction: async (transaction: any) => {
      // Use Turnkey to sign the transaction
    },
    signTypedData: async (typedData: any) => {
      // Use Turnkey to sign typed data
    }
  };
}
```

**Note**: Full implementation requires checking Turnkey SDK v2.0.15 documentation for direct signing methods.

### Issue 3: Signer Address Mismatch
**Problem**: The signer created has a different address than `TurnkeySigner.address`, causing validation failures.

**Fix**: Ensure the signer address matches `TurnkeySigner.address` exactly.

## Correct Implementation Pattern

### Step 1: Create Wallet Flow
```typescript
// 1. Get EOA from TurnkeySigner (created during passkey registration)
const turnkeySigner = await prisma.turnkeySigner.findFirst({
  where: { turnkeySubOrgId, isActive: true }
});

// 2. Create smart account with EOA as owner
const kernelAccount = await kernelService.createKernelAccount(
  userId,
  chainId,
  turnkeySigner.address as Address,  // EOA address
  turnkeySubOrgId,
  walletId
);

// 3. Wallet record should have smart account address
// ownerAddress should reference the EOA
await prisma.wallet.create({
  data: {
    address: kernelAccount.address,      // Smart account address
    ownerAddress: turnkeySigner.address, // EOA address
    walletType: 'smart_wallet',
    // ...
  }
});
```

### Step 2: Transaction Signing Flow
```typescript
// For gasless swaps and DeFi operations:

// 1. Get Kernel account (smart account)
const kernelAccount = await prisma.kernelAccount.findFirst({
  where: { walletId, chainId }
});

// 2. Get Turnkey signer (EOA owner)
const turnkeySigner = await prisma.turnkeySigner.findFirst({
  where: { turnkeySubOrgId: kernelAccount.turnkeySubOrgId }
});

// 3. Create signer that uses Turnkey for actual signing
const signer = await turnkeyEVMSignerService.createZeroDevSigner(
  kernelAccount.turnkeySubOrgId
);

// 4. Create Kernel account client with Turnkey signer
const kernelClient = await accountFactory.getKernelAccountClient(
  kernelAccount.turnkeySubOrgId,
  chainId
);

// 5. Submit UserOperation (gasless via paymaster)
const userOpHash = await kernelClient.sendUserOperation({
  calls: [{ to, value, data }]
});
```

## For Gasless Swaps and DeFi

### Current Implementation
The swap service correctly uses smart account addresses:
```typescript
// backend/wallet-service/src/services/swap/swap.service.ts:88-98
const kernelAccount = await this.prisma.kernelAccount.findFirst({
  where: { walletId: request.walletId, chainId: SWAP_CONFIG.CHAIN_ID }
});

// ✅ CORRECT: Uses smart account address for 0x API quote
const zeroxQuote = await this.zeroxClient.getQuote({
  taker: kernelAccount.address as Address,  // Smart account
  // ...
});
```

### Transaction Execution
The swap execution correctly uses Kernel account client:
```typescript
// ✅ CORRECT: Uses Kernel account client for gasless execution
const userOpHash = await this.kernelService.submitUserOperation(
  walletId,
  chainId,
  calls,  // [approval, swap]
  true    // sponsorUserOperation = true (gasless)
);
```

## Migration Path

### Phase 1: Fix ownerAddress
1. Update `EVMBaseService.createWallet()` to use `TurnkeySigner.address` as `ownerAddress`
2. Update `KernelAccountFactory.createKernelAccount()` to validate `ownerAddress` matches `TurnkeySigner.address`

### Phase 2: Implement Proper Turnkey Signing
1. Research Turnkey SDK v2.0.15 signing capabilities
2. Create `TurnkeyAccount` that implements viem account interface
3. Replace deterministic key generation with actual Turnkey signing

### Phase 3: Validation and Testing
1. Ensure `KernelAccount.ownerAddress === TurnkeySigner.address`
2. Test gasless swaps with actual Turnkey signing
3. Verify smart account validation passes with correct owner

## Key Principles

1. **EOA is the owner**: `KernelAccount.ownerAddress` MUST equal `TurnkeySigner.address`
2. **Smart account is the executor**: All transactions use `KernelAccount.address`
3. **Turnkey manages keys**: Private keys never leave Turnkey infrastructure
4. **Signing via Turnkey**: All signatures must go through Turnkey SDK, not deterministic keys
5. **Gasless by default**: All smart account operations use paymaster (gasless)

## Database Relationship

```
User
  ↓
TurnkeySigner (EOA) ─── ownerAddress ─── KernelAccount (Smart Account)
  ↓                                                  ↓
walletId                                            walletId
  ↓                                                  ↓
Wallet ───────────────────────────────────────────── Wallet
```

**Critical Constraint**: `KernelAccount.ownerAddress` must always equal `TurnkeySigner.address`

## Testing Checklist

- [ ] EOA and smart account addresses are different
- [ ] `KernelAccount.ownerAddress === TurnkeySigner.address`
- [ ] Smart account can sign transactions via Turnkey
- [ ] Gasless swaps work with smart account address
- [ ] DeFi operations use smart account, not EOA
- [ ] Account validation passes with correct owner
- [ ] Multi-chain: Same EOA owner, different smart accounts per chain


