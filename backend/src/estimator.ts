/**
 * ChainClone — Fast Estimation Heuristics
 *
 * Goal: produce a price estimate in <5 seconds WITHOUT reading all chain data.
 * We only make O(contracts) RPC calls:
 *   - eth_blockNumber         (1 call)
 *   - eth_getCode(contract)   (1 call per contract)
 *   - eth_getLogs(sample)     (1 call per contract, limit 100 logs)
 *   - eth_getStorageAt(0..7)  (8 calls per contract — heuristic slot scan)
 *
 * From these we extrapolate:
 *   - bytecode size → storage complexity
 *   - events in first 1000 blocks → total events via linear scale
 *   - non-zero storage slots from first 8 → estimate total
 *   - bytecode size >8KB or event sigs >50 → complex flag
 */

import { ethers } from 'ethers';
import { ContractEstimate } from './pricing';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Sample window for event density estimation: last N blocks */
const SAMPLE_BLOCK_WINDOW = 2000;

/** How many standard storage slots to probe for non-zero check */
const STORAGE_PROBE_COUNT = 8;

/** Threshold: bytecode bytes above which = complex */
const COMPLEX_BYTECODE_THRESHOLD = 8192;   // 8 KB

/** Threshold: distinct event topics above which = complex */
const COMPLEX_EVENT_TOPIC_THRESHOLD = 50;

/** Events per block scaling — extrapolate from sample window */
const MIN_ESTIMATED_EVENTS_FOR_EVENTS_SCOPE = 0;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EstimationResult {
  estimates: ContractEstimate[];
  estimatedGasPassthroughUSD: number;
  blockRange: number;            // total block range considered
  currentBlock: number;
  durationMs: number;
}

export async function estimateContracts(
  provider: ethers.JsonRpcProvider,
  addresses: string[],
  chainId: number,
  what: 'storage' | 'events' | 'history' | 'full',
): Promise<EstimationResult> {
  const t0 = Date.now();

  // 1. Current block (1 call)
  const currentBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - SAMPLE_BLOCK_WINDOW);
  const blockRange = currentBlock - fromBlock;

  // 2. Estimate each contract in parallel (bounded at 5 concurrent to respect rate limits)
  const estimates = await pMap(addresses, async (address): Promise<ContractEstimate> => {
    try {
      return await estimateOneContract(provider, address, currentBlock, fromBlock, what);
    } catch (err: any) {
      // Estimation failure means we return a conservative (expensive) estimate
      console.warn(`[Estimator] Failed to estimate ${address}: ${err.message}`);
      return {
        address,
        bytecodeSizeBytes: 4096,      // assume medium
        estimatedEventCount: 10000,   // assume moderate
        estimatedStorageSlots: 20,
        isComplex: false,
        blockRange,
      };
    }
  }, 5);

  // 3. Gas passthrough estimate: use a fixed heuristic
  //    For storage+events read: ~0 on our end (we use public RPCs).
  //    For external chain write: ~$0.50 per contract on L2s, ~$5 on L1.
  //    We leave this at 0 here; the API layer adds chain-specific gas.
  const estimatedGasPassthroughUSD = 0;

  return {
    estimates,
    estimatedGasPassthroughUSD,
    blockRange: currentBlock - Math.max(0, currentBlock - SAMPLE_BLOCK_WINDOW),
    currentBlock,
    durationMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Per-contract estimation
// ---------------------------------------------------------------------------

async function estimateOneContract(
  provider: ethers.JsonRpcProvider,
  address: string,
  currentBlock: number,
  fromBlock: number,
  what: 'storage' | 'events' | 'history' | 'full',
): Promise<ContractEstimate> {
  const checksumAddress = ethers.getAddress(address);
  const blockRange = currentBlock - fromBlock;

  // Parallel: bytecode + storage probe slots
  const [bytecode, ...storageSlots] = await Promise.all([
    provider.getCode(checksumAddress),
    ...Array.from({ length: STORAGE_PROBE_COUNT }, (_, i) =>
      provider.getStorage(checksumAddress, i).catch(() => '0x' + '0'.repeat(64))
    ),
  ]);

  const bytecodeSizeBytes = bytecode === '0x' ? 0 : Math.floor((bytecode.length - 2) / 2);

  // Count non-zero storage slots in probe
  const nonZeroSlots = storageSlots.filter(s => s !== '0x' + '0'.repeat(64) && s !== '0x0000000000000000000000000000000000000000000000000000000000000000').length;
  // Extrapolate: if 3/8 probed slots are non-zero, and typical contracts have ~100 meaningful slots...
  // Conservative: multiply by 12 (heuristic based on common ERC-20/721 patterns)
  const estimatedStorageSlots = nonZeroSlots > 0 ? nonZeroSlots * 12 : 5;

  // Event estimation (only if we care about events)
  let estimatedEventCount = 0;
  let distinctTopics = 0;

  if (what === 'events' || what === 'history' || what === 'full') {
    try {
      // Sample logs in the window — limit 100 to stay fast
      const rawProvider = provider as any;
      const logs = await rawProvider.send('eth_getLogs', [{
        address: checksumAddress,
        fromBlock: ethers.toBeHex(fromBlock),
        toBlock: ethers.toBeHex(currentBlock),
      }]);

      const logArray = Array.isArray(logs) ? logs : [];
      const sampleCount = logArray.length;

      // Extrapolate to full contract lifetime
      // We only looked at the last SAMPLE_BLOCK_WINDOW blocks.
      // Contract may have a much longer history — use block age heuristic.
      // Deploy block is unknown, but we cap estimation at 10× sample window.
      const scaleFactor = Math.min(10, Math.max(1, Math.round(currentBlock / Math.max(fromBlock, 1))));
      estimatedEventCount = sampleCount < 100
        ? Math.round(sampleCount * scaleFactor)
        : Math.round((sampleCount / SAMPLE_BLOCK_WINDOW) * currentBlock);  // dense contract

      // Count distinct event topics (= distinct event types)
      const topicSet = new Set<string>();
      for (const log of logArray) {
        if (log.topics && log.topics[0]) topicSet.add(log.topics[0]);
      }
      distinctTopics = topicSet.size;
    } catch {
      // eth_getLogs may fail on some chains — use 0 as fallback
      estimatedEventCount = MIN_ESTIMATED_EVENTS_FOR_EVENTS_SCOPE;
    }
  }

  const isComplex = bytecodeSizeBytes > COMPLEX_BYTECODE_THRESHOLD || distinctTopics > COMPLEX_EVENT_TOPIC_THRESHOLD;

  return {
    address: checksumAddress,
    bytecodeSizeBytes,
    estimatedEventCount,
    estimatedStorageSlots,
    isComplex,
    blockRange,
  };
}

// ---------------------------------------------------------------------------
// Gas heuristics by chain
// ---------------------------------------------------------------------------

/** Estimate gas passthrough USD for WRITING to a destination chain. */
export function estimateWriteGasUSD(destChainId: number, contractCount: number): number {
  // Gas costs are non-refundable on failure.
  // Estimates based on current gas prices × typical deploy gas (300K-500K per contract).
  const gasPerChain: Record<number, number> = {
    1:      5.00,   // Ethereum L1: ~300K gas × ~15 gwei × $3K ETH ≈ $13. Cap at $5 per contract.
    8453:   0.05,   // Base: very cheap
    10:     0.05,   // Optimism
    42161:  0.05,   // Arbitrum
    137:    0.02,   // Polygon
    56:     0.03,   // BNB
    43114:  0.10,   // Avalanche
    100:    0.01,   // Gnosis
    324:    0.05,   // zkSync
    59144:  0.05,   // Linea
    534352: 0.05,   // Scroll
    5000:   0.02,   // Mantle
  };
  const perContractUSD = gasPerChain[destChainId] ?? 0.10;
  return Math.round(perContractUSD * contractCount * 100) / 100;
}

// ---------------------------------------------------------------------------
// Minimal pMap utility (avoids adding p-map dependency)
// ---------------------------------------------------------------------------

async function pMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);
  return results;
}
