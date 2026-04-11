# Supported Chains

## Mainnet Chains

| Chain | Chain ID | Native Currency | Public RPCs | Storage Enumeration |
|---|---|---|---|---|
| Ethereum | 1 | ETH | llamarpc, ankr, publicnode | Standard slots only (no debug API on public) |
| Base | 8453 | ETH | base.org, llamarpc, ankr | Standard slots only |
| Optimism | 10 | ETH | optimism.io, ankr | Standard slots only |
| Arbitrum | 42161 | ETH | arbitrum.io, ankr | Standard slots only |
| Polygon | 137 | MATIC | polygon-rpc, ankr | Standard slots only |
| Avalanche | 43114 | AVAX | avax.network, ankr | Standard slots only |
| BNB Smart Chain | 56 | BNB | binance.org, ankr | Standard slots only |

## Testnet Chains

| Chain | Chain ID | Native Currency | Public RPCs | Notes |
|---|---|---|---|---|
| Sepolia | 11155111 | ETH | sepolia.org, ankr | Ethereum testnet |
| Base Sepolia | 84532 | ETH | sepolia.base.org | Base testnet (demo payments) |

## What Can Be Read

For every address, ChainClone reads:

| Data | Method | Availability |
|---|---|---|
| Bytecode | `eth_getCode` | All RPCs |
| ETH Balance | `eth_getBalance` | All RPCs |
| Nonce | `eth_getTransactionCount` | All RPCs |
| Storage (full) | `debug_storageRangeAt` | Archive nodes with debug API only |
| Storage (partial) | `eth_getStorageAt` | All RPCs (need to know slot positions) |

## Storage Enumeration Details

### Full Enumeration (Archive Nodes)

When `debug_storageRangeAt` is available (our RPCaaS, or user-provided archive node), we read every single storage slot. This gives perfect state replication.

### Heuristic Enumeration (Public RPCs)

When using public RPCs, we use multiple strategies:

1. **Standard slots 0-31** — Covers most simple state variables
2. **EIP-1967 slots** — Proxy implementation, admin, beacon
3. **Contract type detection** — Analyze bytecode for ERC-20/721/1155 selectors
4. **ERC-20 holder discovery** — Read Transfer event logs, compute balance mapping slots
5. **User-provided slots** — Customer can supply known slot positions

### Limitations

- Public RPCs do NOT support `debug_storageRangeAt`
- Mapping values (balances, allowances) require knowing the keys
- Without archive access, some storage will be missed
- Large contracts (1000+ slots) may not be fully captured

## When RPCaaS Replaces Public RPCs

Once our RPCaaS infrastructure (node-uk1) is ready:

- Each chain config will get an `rpcaasUrl` field
- Provider selection already prefers RPCaaS over public RPCs
- RPCaaS provides archive node access with debug API
- Full `debug_storageRangeAt` = complete storage enumeration
- No rate limits, no missing data

## Adding New Chains

To add a new EVM chain, add an entry to `CHAINS` in `backend/src/chains.ts`:

```typescript
'newchain': {
  name: 'New Chain',
  chainId: 12345,
  rpcUrls: ['https://rpc.newchain.io'],
  rpcaasUrl: undefined, // Add when RPCaaS supports it
  explorerUrl: 'https://explorer.newchain.io',
  nativeCurrency: 'TOKEN',
},
```

Any EVM-compatible chain with standard JSON-RPC works. Non-EVM chains (Solana, Cosmos, etc.) are not supported.
