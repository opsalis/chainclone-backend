/**
 * ChainClone — Order Lifecycle
 *
 * An "order" is the payment-gated version of a migration job.
 * Flow:
 *   1. Customer calls POST /api/quote → gets estimateId + price
 *   2. Customer calls POST /api/sample → free preview ZIP (no payment)
 *   3. Customer sends USDC on Demo L2 (chain 845302) or Base (8453)
 *   4. Customer calls POST /api/order with estimateId + paymentTxHash
 *   5. Backend verifies on-chain: tx exists, status=1, amount >= quote total
 *   6. Job starts; customer polls GET /api/order/:id/status
 *   7. When done: GET /api/order/:id/download → ZIP
 *
 * Refund policy:
 *   - Full refund on failure EXCEPT gas passthrough (non-refundable)
 *   - Refunds are manual (operator sends USDC back) — no automated refund contract yet
 */

import path from 'path';
import fs from 'fs';
import { ethers } from 'ethers';
import { DynamicQuote, LIMITS } from './pricing';

// ---------------------------------------------------------------------------
// In-memory quote store
// ---------------------------------------------------------------------------

const quoteStore = new Map<string, DynamicQuote>();

export function storeQuote(quote: DynamicQuote): void {
  quoteStore.set(quote.estimateId, quote);
}

export function getQuote(estimateId: string): DynamicQuote | undefined {
  const quote = quoteStore.get(estimateId);
  if (!quote) return undefined;
  if (Date.now() > quote.validUntil) {
    quoteStore.delete(estimateId);
    return undefined;
  }
  return quote;
}

// Periodic cleanup of expired quotes
setInterval(() => {
  const now = Date.now();
  for (const [id, q] of quoteStore) {
    if (now > q.validUntil) quoteStore.delete(id);
  }
}, 5 * 60 * 1000);

// ---------------------------------------------------------------------------
// Order store (extends job concept with payment tracking)
// ---------------------------------------------------------------------------

export type OrderStatus = 'pending_payment' | 'verifying' | 'queued' | 'running' | 'done' | 'failed' | 'refunded';

export interface Order {
  id: string;                    // order ID (= job ID)
  estimateId: string;
  quote: DynamicQuote;
  paymentTxHash: string | null;  // null for free orders
  paymentChainId: number | null;
  paymentVerified: boolean;
  status: OrderStatus;
  progress: number;              // 0-100
  resultZipPath: string | null;  // path on disk when done
  resultUrl: string | null;      // download URL when done
  error: string | null;
  refundNote: string | null;
  createdAt: number;
  updatedAt: number;
}

const orderStore = new Map<string, Order>();

export function createOrder(params: {
  estimateId: string;
  quote: DynamicQuote;
  paymentTxHash: string | null;
  paymentChainId: number | null;
}): Order {
  const id = crypto.randomUUID();
  const order: Order = {
    id,
    estimateId: params.estimateId,
    quote: params.quote,
    paymentTxHash: params.paymentTxHash,
    paymentChainId: params.paymentChainId,
    paymentVerified: params.quote.isFree,
    status: params.quote.isFree ? 'queued' : 'pending_payment',
    progress: 0,
    resultZipPath: null,
    resultUrl: null,
    error: null,
    refundNote: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  orderStore.set(id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orderStore.get(id);
}

export function updateOrder(id: string, updates: Partial<Order>): void {
  const order = orderStore.get(id);
  if (order) {
    Object.assign(order, updates, { updatedAt: Date.now() });
  }
}

export function listOrders(limit = 50): Order[] {
  return [...orderStore.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

// Auto-cleanup: remove done/failed orders older than 30 days
setInterval(() => {
  const cutoff = Date.now() - LIMITS.jobRetentionDays * 24 * 3600 * 1000;
  for (const [id, o] of orderStore) {
    if ((o.status === 'done' || o.status === 'failed') && o.createdAt < cutoff) {
      // Delete result ZIP if it exists
      if (o.resultZipPath && fs.existsSync(o.resultZipPath)) {
        fs.unlinkSync(o.resultZipPath);
      }
      orderStore.delete(id);
    }
  }
}, 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Payment verification
// ---------------------------------------------------------------------------

/**
 * Payment chain: Demo L2 (845302) for testnet, Base (8453) for mainnet.
 * The USDC contract address must match the chain.
 */
const PAYMENT_CHAIN_RPCS: Record<number, string> = {
  845302: process.env.DEMO_L2_RPC   || 'http://demo-l2-geth:8545',
  845312: process.env.DEMO_L2_RPC   || 'http://demo-l2-geth:8545',   // chain ID from mission spec
  84532:  'https://sepolia.base.org',                                  // Base Sepolia testnet
  8453:   'https://mainnet.base.org',                                  // Base mainnet
};

/** ChainClone revenue wallet — USDC must be sent here */
const REVENUE_WALLET = process.env.CHAINCLONE_REVENUE_WALLET || '0x0000000000000000000000000000000000000001';

/** Minimum USDC amount: quote total (6 decimals for USDC) */
function toUSDCUnits(usd: number): bigint {
  return BigInt(Math.floor(usd * 1_000_000));
}

export interface PaymentVerifyResult {
  ok: boolean;
  reason?: string;
  paidAmountUSDC?: number;
}

export async function verifyPayment(
  txHash: string,
  paymentChainId: number,
  expectedAmountUSD: number,
): Promise<PaymentVerifyResult> {
  // Demo bypass: allow "demo-*" tx hashes in dev
  if (txHash.startsWith('demo-') && process.env.NODE_ENV !== 'production') {
    return { ok: true, paidAmountUSDC: expectedAmountUSD };
  }

  const rpcUrl = PAYMENT_CHAIN_RPCS[paymentChainId];
  if (!rpcUrl) {
    return { ok: false, reason: `Payment chain ${paymentChainId} not supported` };
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // 1. Transaction must exist and be confirmed
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      return { ok: false, reason: 'Transaction not found — may still be pending, try again in 30 seconds' };
    }
    if (receipt.status !== 1) {
      return { ok: false, reason: 'Transaction reverted on-chain' };
    }

    // 2. Check it's a USDC Transfer to our revenue wallet
    //    USDC Transfer event: Transfer(address indexed from, address indexed to, uint256 value)
    //    topic0: keccak256("Transfer(address,address,uint256)")
    const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
    const revenueWalletPadded = '0x000000000000000000000000' + REVENUE_WALLET.slice(2).toLowerCase();

    let paidAmount = 0n;
    for (const log of receipt.logs) {
      if (
        log.topics[0] === TRANSFER_TOPIC &&
        log.topics[2]?.toLowerCase() === revenueWalletPadded.toLowerCase()
      ) {
        paidAmount += BigInt(log.data);
      }
    }

    if (paidAmount === 0n) {
      return { ok: false, reason: `No USDC transfer to ChainClone revenue wallet found in this transaction` };
    }

    const requiredUnits = toUSDCUnits(expectedAmountUSD);
    if (paidAmount < requiredUnits) {
      const paidUSD = Number(paidAmount) / 1_000_000;
      return {
        ok: false,
        reason: `Insufficient payment: received $${paidUSD.toFixed(2)} USDC, required $${expectedAmountUSD.toFixed(2)} USDC`,
        paidAmountUSDC: paidUSD,
      };
    }

    return {
      ok: true,
      paidAmountUSDC: Number(paidAmount) / 1_000_000,
    };
  } catch (err: any) {
    // Network error during verification — don't auto-approve, flag for manual review
    return { ok: false, reason: `Payment verification network error: ${err.message}` };
  }
}
