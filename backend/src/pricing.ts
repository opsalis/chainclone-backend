/**
 * ChainClone Dynamic Pricing Engine
 *
 * Pricing model anchored against competitors:
 *   - Alchemy: $0.45/M CUs (~$0.45 per 1M simple RPC calls)
 *   - QuickNode: $0.50-$0.62/M API credits; IPFS $0.04-$0.10/GB
 *   - Moralis: $5-$11.25/M CUs; $49-$490/month plans
 *   - The Graph: $2/100K queries = $20/M queries for indexed data reads
 *   - Dune: subscription-gated, no public per-unit price
 *
 * ChainClone is a one-shot job service (not subscription), so we price per job:
 *   data extraction + complexity + gas passthrough + margin
 *
 * The Graph at $20/M queries is our anchor for indexed data reads.
 * A typical contract with 50K events = ~$1 in pure query cost.
 * Our margin target: 40-60% above pure data cost.
 *
 * Free tier: L2aaS customers (internal — incentivises platform adoption).
 */

export interface QuoteLineItem {
  label: string;
  amountUSD: number;
  detail: string;
}

export interface DynamicQuote {
  estimateId: string;
  validUntil: number;           // unix ms — quotes valid for 30 min
  sourceChainId: number;
  contracts: string[];
  what: string;
  delivery: string;

  // Itemized breakdown
  lineItems: QuoteLineItem[];

  // Totals
  subtotalUSD: number;
  marginUSD: number;
  gasPassthroughUSD: number;
  totalUSD: number;
  totalUSDC: number;            // 1:1 with totalUSD (USDC stablecoin)

  isFree: boolean;
  freeReason?: string;
  message: string;
}

export interface EstimationInput {
  estimateId: string;
  sourceChainId: number;
  contracts: ContractEstimate[];
  what: 'storage' | 'events' | 'history' | 'full';
  delivery: 'zip' | 'l2aas' | string;  // l2aas = any l2aas chain id string
  gasPassthroughUSD: number;
  isL2aaSCustomer: boolean;
}

export interface ContractEstimate {
  address: string;
  bytecodeSizeBytes: number;
  estimatedEventCount: number;
  estimatedStorageSlots: number;
  isComplex: boolean;           // true if bytecode >8KB OR event signatures >50
  blockRange: number;           // block range covered for events
}

// ---------------------------------------------------------------------------
// Pricing constants (all USD)
// ---------------------------------------------------------------------------

/** Per-MB of extracted data. Anchored: The Graph $20/M queries, 1MB ≈ ~8K events → ~$0.16/MB raw.
 *  We charge $0.08/MB — half query cost — because we batch efficiently. */
const PRICE_PER_MB_USD = 0.08;

/** Base per-contract: covers RPC calls, storage scan, ABI decode, packaging. */
const PRICE_PER_CONTRACT_BASE_USD = 2.50;

/** Surcharge for complex contracts (>8KB bytecode or >50 event signatures). */
const PRICE_COMPLEX_CONTRACT_EXTRA_USD = 6.00;

/** Margin: max(flat floor, percentage of data+contract subtotal).
 *  At 18% margin we're still cheaper than comparable QuickNode/Moralis bundles. */
const MARGIN_FLOOR_USD = 10.00;
const MARGIN_PCT = 0.18;

/** ZIP delivery: storage, CDN bandwidth, archive creation. */
const DELIVERY_ZIP_SURCHARGE_USD = 3.00;

/** External chain write: gas budget top-up for deploying contracts on destination. */
const DELIVERY_CHAIN_SURCHARGE_USD = 5.00;

/** Volume discounts applied to data + contract costs (not gas or margin). */
const VOLUME_TIERS: Array<{ minContracts: number; discount: number }> = [
  { minContracts: 100, discount: 0.40 },
  { minContracts:  50, discount: 0.30 },
  { minContracts:  20, discount: 0.20 },
  { minContracts:  10, discount: 0.10 },
  { minContracts:   5, discount: 0.05 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Estimated extracted data in MB for one contract across all extraction types. */
function estimatedDataMB(c: ContractEstimate): number {
  const bytecodeMB   = c.bytecodeSizeBytes / (1024 * 1024);
  // ~128 bytes per log entry (4 topics × 32B + data + metadata)
  const eventsMB     = (c.estimatedEventCount * 128) / (1024 * 1024);
  // 64 bytes per storage slot (32B key hex + 32B value hex)
  const storageMB    = (c.estimatedStorageSlots * 64) / (1024 * 1024);
  return bytecodeMB + eventsMB + storageMB;
}

export function getVolumeDiscount(contractCount: number): number {
  for (const tier of VOLUME_TIERS) {
    if (contractCount >= tier.minContracts) return tier.discount;
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main pricing function
// ---------------------------------------------------------------------------

export function buildQuote(input: EstimationInput): DynamicQuote {
  const {
    estimateId, sourceChainId, contracts, what, delivery,
    gasPassthroughUSD, isL2aaSCustomer,
  } = input;

  const validUntil = Date.now() + 30 * 60 * 1000;
  const lineItems: QuoteLineItem[] = [];

  // --- Free path: L2aaS customers pay nothing except gas passthrough ---
  if (isL2aaSCustomer) {
    const gasRounded = round2(gasPassthroughUSD);
    const total = gasRounded;
    return {
      estimateId, validUntil, sourceChainId,
      contracts: contracts.map(c => c.address),
      what, delivery,
      lineItems: [
        { label: 'L2aaS customer discount', amountUSD: 0, detail: 'Migration is free for L2aaS customers' },
        ...(gasRounded > 0 ? [{ label: 'Gas passthrough', amountUSD: gasRounded, detail: 'Actual gas paid to source chain — non-refundable' }] : []),
      ],
      subtotalUSD: 0, marginUSD: 0, gasPassthroughUSD: gasRounded,
      totalUSD: total, totalUSDC: total,
      isFree: gasRounded === 0,
      freeReason: 'L2aaS customer — migration included',
      message: gasRounded === 0
        ? 'Free migration — L2aaS customers migrate at no cost'
        : `Free migration — you only pay $${total} USDC gas passthrough`,
    };
  }

  // --- Data volume cost ---
  const totalDataMB = contracts.reduce((sum, c) => sum + estimatedDataMB(c), 0);
  const dataCostRaw = round2(totalDataMB * PRICE_PER_MB_USD);
  if (dataCostRaw > 0.01) {
    lineItems.push({
      label: 'Data extraction',
      amountUSD: dataCostRaw,
      detail: `${totalDataMB.toFixed(2)} MB × $${PRICE_PER_MB_USD}/MB`,
    });
  }

  // --- Per-contract base cost ---
  const contractCount = contracts.length;
  lineItems.push({
    label: `Contract processing (${contractCount})`,
    amountUSD: round2(contractCount * PRICE_PER_CONTRACT_BASE_USD),
    detail: `${contractCount} × $${PRICE_PER_CONTRACT_BASE_USD}/contract`,
  });

  // --- Complex contract surcharge ---
  const complexCount = contracts.filter(c => c.isComplex).length;
  if (complexCount > 0) {
    lineItems.push({
      label: `Complex contract surcharge (${complexCount})`,
      amountUSD: round2(complexCount * PRICE_COMPLEX_CONTRACT_EXTRA_USD),
      detail: `${complexCount} contracts with large bytecode or many events × $${PRICE_COMPLEX_CONTRACT_EXTRA_USD}`,
    });
  }

  // --- Volume discount (applied to data+contract costs before delivery/gas) ---
  const discountPct = getVolumeDiscount(contractCount);
  const preDiscountSubtotal = lineItems.reduce((s, li) => s + li.amountUSD, 0);
  let discountAmount = 0;
  if (discountPct > 0) {
    discountAmount = round2(preDiscountSubtotal * discountPct);
    lineItems.push({
      label: `Volume discount (${(discountPct * 100).toFixed(0)}%)`,
      amountUSD: -discountAmount,
      detail: `${contractCount} contracts → ${(discountPct * 100).toFixed(0)}% off data + processing`,
    });
  }

  const subtotalUSD = round2(preDiscountSubtotal - discountAmount);

  // --- Delivery surcharge ---
  if (delivery === 'zip') {
    lineItems.push({
      label: 'ZIP delivery',
      amountUSD: DELIVERY_ZIP_SURCHARGE_USD,
      detail: 'Archive preparation, storage, and download link generation',
    });
  } else if (delivery !== 'l2aas') {
    // Writing to an external chain
    lineItems.push({
      label: 'External chain write',
      amountUSD: DELIVERY_CHAIN_SURCHARGE_USD,
      detail: 'Deploy contracts to target chain (gas budget included separately)',
    });
  }

  // --- Gas passthrough ---
  const gasRounded = round2(gasPassthroughUSD);
  if (gasRounded > 0) {
    lineItems.push({
      label: 'Gas passthrough',
      amountUSD: gasRounded,
      detail: 'Actual gas paid to source chain — non-refundable on failure',
    });
  }

  // --- Margin (on data+contract+delivery, not gas) ---
  const preMargin = lineItems
    .filter(l => l.label !== 'Gas passthrough')
    .reduce((s, l) => s + l.amountUSD, 0);
  const marginUSD = round2(Math.max(MARGIN_FLOOR_USD, preMargin * MARGIN_PCT));
  lineItems.push({
    label: 'Service fee',
    amountUSD: marginUSD,
    detail: `${(MARGIN_PCT * 100).toFixed(0)}% margin or $${MARGIN_FLOOR_USD} minimum`,
  });

  const totalUSD = round2(lineItems.reduce((s, li) => s + li.amountUSD, 0));

  return {
    estimateId, validUntil, sourceChainId,
    contracts: contracts.map(c => c.address),
    what, delivery, lineItems, subtotalUSD, marginUSD,
    gasPassthroughUSD: gasRounded,
    totalUSD, totalUSDC: totalUSD,
    isFree: false,
    message: `${contractCount} contract${contractCount !== 1 ? 's' : ''}, ~${totalDataMB.toFixed(1)} MB — total $${totalUSD} USDC`,
  };
}

// Legacy flat-rate calculator REMOVED (2026-04-16). All pricing must go through
// buildQuote(). Callers: /api/quote in api.ts. Do not re-introduce CONTRACT_PRICES.

export const LIMITS = {
  maxContractsPerOrder: 100,
  jobRetentionDays: 30,
  sampleFirstContractOnly: true,
  quoteValidityMs: 30 * 60 * 1000,
};
