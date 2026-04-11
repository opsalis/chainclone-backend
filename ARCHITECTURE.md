# ChainClone Architecture

## Overview

ChainClone is a blockchain state migration engine. It reads the complete on-chain state (bytecode, storage, balances) from any EVM chain and writes it to another.

## How Migration Works

```
Source Chain                  ChainClone Backend                Destination
┌──────────┐                 ┌──────────────────┐              ┌──────────────┐
│ Ethereum │──── reader.ts ──│  Read bytecode   │              │              │
│ Base     │                 │  Read storage    │── writer.ts ──│  L2aaS chain │
│ Polygon  │                 │  Read balances   │              │  or external │
│ etc.     │                 │  Read nonces     │              │              │
└──────────┘                 └──────────────────┘              └──────────────┘
```

### Phase 1: Read (reader.ts + storage.ts)

1. Validate addresses and connect to source chain RPC
2. Read bytecode, balance, nonce for each address
3. Enumerate storage slots using multiple strategies:
   - **Strategy 1:** `debug_storageRangeAt` (archive nodes only) — gets ALL slots
   - **Strategy 2:** Read standard slots 0-31 + EIP-1967 proxy slots
   - **Strategy 3:** Type detection (ERC-20/721/1155) and read known patterns
   - **Strategy 4:** User-supplied slot list
4. Return complete `ContractState` objects

### Phase 2: Write (writer.ts)

Two paths depending on destination:

#### Path A: L2aaS Destination (FREE)
- Generate `genesis.json` alloc block with full state
- Customer's L2aaS chain boots with all contracts pre-deployed
- Perfect fidelity: same addresses, same storage, same balances
- This is the ideal path — no gas costs, no limitations

#### Path B: External Chain (PAID)
- Deploy each contract's runtime bytecode via transaction
- Limitations:
  - New addresses (different from source)
  - Storage cannot be set externally after deployment
  - Constructor logic won't re-run
  - Gas costs passed to customer
- Returns address mapping (old → new)

## Storage Enumeration Challenges

The hardest problem in blockchain cloning is reading ALL storage slots:

1. **No native API** — Ethereum doesn't expose "list all slots"
2. **debug_storageRangeAt** — Only available on archive nodes with debug API
3. **Public RPCs** — Never expose debug API (rate-limited, no archive)
4. **Mappings** — Slot positions computed via keccak256, not sequential

Our approach:
- Try debug API first (works with our RPCaaS when ready)
- Fall back to heuristic reading (standard slots + type detection)
- Allow users to provide specific slots they know about
- For ERC-20: discover holders via Transfer events, compute mapping slots

## Pricing Model

| Destination | Price | Why |
|---|---|---|
| L2aaS | FREE | Incentive to use our chain |
| Base/Optimism/Arbitrum/Polygon | $5/contract | Low gas L2s |
| Ethereum L1 | $50/contract | High gas |
| BNB Chain | $3/contract | Cheap gas |

Volume discounts: 5+ (5%), 10+ (10%), 20+ (20%), 50+ (30%), 100+ (40%)

## Payment Flow

1. Customer calls `POST /api/estimate` to get price
2. Customer approves USDC to MigrationPayment contract (Base Sepolia for demo)
3. Customer calls `payMigration()` on-chain
4. Backend detects `MigrationPaid` event
5. Backend starts migration job
6. Customer polls `GET /api/jobs/:id` for progress

## Integration Points

### RPCaaS (Future)
When node-uk1 RPCaaS is ready, each chain config gets an `rpcaasUrl`.
The provider selection logic already prefers RPCaaS over public RPCs.
RPCaaS provides archive node access = full `debug_storageRangeAt` support.

### L2aaS (Free Tier)
ChainClone generates genesis alloc → L2aaS chain provisioning injects it.
Customer gets their own L2 with all contracts pre-loaded.

## API Architecture

- Express server on port 3300
- In-memory job store (replace with Redis/PostgreSQL for production scale)
- Async job execution with progress tracking
- Concurrency-limited RPC calls (5 parallel per job)
- 24h auto-cleanup of completed jobs

## Deployment

- Docker multi-stage build (builder → slim runtime)
- k3s deployment, 2 replicas
- Health checks via `/health` endpoint
- No persistent state required (jobs are ephemeral)
