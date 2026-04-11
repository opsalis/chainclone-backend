# ChainClone API Reference

Base URL: `http://localhost:3300` (dev) / `https://api.chainclone.io` (production)

## Endpoints

### GET /health

Health check.

```bash
curl http://localhost:3300/health
```

Response:
```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600.5
}
```

---

### GET /api/chains

List all supported chains.

```bash
curl http://localhost:3300/api/chains
```

Response:
```json
{
  "chains": [
    {
      "id": "ethereum",
      "name": "Ethereum",
      "chainId": 1,
      "explorer": "https://etherscan.io",
      "nativeCurrency": "ETH"
    },
    {
      "id": "base",
      "name": "Base",
      "chainId": 8453,
      "explorer": "https://basescan.org",
      "nativeCurrency": "ETH"
    }
  ]
}
```

---

### POST /api/preview

Read contract state from source chain without migrating. Use this to verify what will be migrated.

```bash
curl -X POST http://localhost:3300/api/preview \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChain": "ethereum",
    "addresses": [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    ],
    "slots": ["0x0", "0x1", "0x2"]
  }'
```

Request body:
| Field | Type | Required | Description |
|---|---|---|---|
| sourceChain | string | Yes | Chain identifier (e.g., "ethereum") |
| addresses | string[] | Yes | Contract addresses to read (max 20) |
| slots | string[] | No | Specific storage slots to read |

Response:
```json
{
  "sourceChain": "ethereum",
  "contracts": [
    {
      "address": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "isContract": true,
      "bytecodeSize": 7234,
      "balance": "0",
      "nonce": 1,
      "storageSlotsFound": 18
    }
  ]
}
```

---

### POST /api/estimate

Get price estimate for a migration.

```bash
curl -X POST http://localhost:3300/api/estimate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChain": "ethereum",
    "destChain": "base",
    "addresses": [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7"
    ]
  }'
```

Request body:
| Field | Type | Required | Description |
|---|---|---|---|
| sourceChain | string | Yes | Source chain identifier |
| destChain | string | Yes | Destination chain (or "l2aas" for free tier) |
| addresses | string[] | Yes | Addresses to migrate |

Response:
```json
{
  "destChain": "base",
  "contractCount": 2,
  "pricePerContract": 5,
  "discount": "0%",
  "totalUSDC": 10,
  "message": "Migration to base: $10 USDC (2 contracts)"
}
```

---

### POST /api/migrate

Start a migration job. Returns immediately with a job ID.

```bash
curl -X POST http://localhost:3300/api/migrate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChain": "ethereum",
    "destChain": "l2aas",
    "addresses": [
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
    ]
  }'
```

For external chain migration (requires wallet key):
```bash
curl -X POST http://localhost:3300/api/migrate \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChain": "ethereum",
    "destChain": "base-sepolia",
    "addresses": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
    "destWalletKey": "0xYOUR_PRIVATE_KEY",
    "slots": ["0x0", "0x1", "0x2", "0x3"]
  }'
```

Request body:
| Field | Type | Required | Description |
|---|---|---|---|
| sourceChain | string | Yes | Source chain identifier |
| destChain | string | Yes | Destination chain or "l2aas" |
| addresses | string[] | Yes | Addresses to migrate (max 100) |
| destWalletKey | string | Conditional | Required for external chain (not l2aas) |
| slots | string[] | No | Specific storage slots to include |

Response:
```json
{
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "started"
}
```

---

### GET /api/jobs/:id

Check migration job status and results.

```bash
curl http://localhost:3300/api/jobs/550e8400-e29b-41d4-a716-446655440000
```

Response (in progress):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sourceChain": "ethereum",
  "destChain": "l2aas",
  "addresses": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
  "status": "reading",
  "progress": 25,
  "createdAt": 1712678400000
}
```

Response (complete — L2aaS):
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "sourceChain": "ethereum",
  "destChain": "l2aas",
  "addresses": ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"],
  "status": "complete",
  "progress": 100,
  "result": {
    "sourceChain": "ethereum",
    "destChain": "l2aas",
    "contractsMigrated": 1,
    "genesisAlloc": {
      "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
        "code": "0x60806040...",
        "storage": {
          "0x0000...0000": "0x0000...0001"
        }
      }
    }
  },
  "createdAt": 1712678400000
}
```

---

### GET /api/jobs

List recent migration jobs.

```bash
curl http://localhost:3300/api/jobs
```

Response:
```json
{
  "jobs": [
    {
      "id": "...",
      "sourceChain": "ethereum",
      "destChain": "base",
      "status": "complete",
      "progress": 100,
      "createdAt": 1712678400000
    }
  ]
}
```

## Error Responses

All errors return:
```json
{
  "error": "Description of what went wrong"
}
```

Status codes:
- `400` — Bad request (missing/invalid parameters)
- `404` — Job not found
- `500` — Internal server error (RPC failure, etc.)
