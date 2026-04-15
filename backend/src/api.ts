/**
 * ChainClone — New API endpoints (v2)
 *
 * Mounts on the existing Express app (imported from index.ts).
 *
 * Endpoints:
 *   POST /api/quote               — dynamic price estimate (<5 sec)
 *   POST /api/sample              — free sample ZIP (real data)
 *   POST /api/order               — place order after payment
 *   GET  /api/order/:id/status    — poll order progress
 *   GET  /api/order/:id/download  — ZIP download when done
 *
 * The older endpoints in index.ts remain unchanged for backward compat.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

import { getProvider, getCustomProvider, CHAINS } from './chains';
import { estimateContracts, estimateWriteGasUSD } from './estimator';
import { buildQuote, LIMITS, EstimationInput } from './pricing';
import {
  storeQuote, getQuote,
  createOrder, getOrder, listOrders,
  verifyPayment, updateOrder,
} from './orders';
import { buildSampleZip } from './sampler';
import { executeOrder, isAtCapacity } from './executor';
import { ethers } from 'ethers';

export const apiRouter = Router();

// ---------------------------------------------------------------------------
// POST /api/quote
// Body: { sourceChainId, sourceContracts: string[], what, delivery, isL2aaSCustomer? }
// Response: DynamicQuote with itemized cost breakdown
// ---------------------------------------------------------------------------

apiRouter.post('/quote', async (req: Request, res: Response) => {
  const {
    sourceChainId,
    sourceContracts,
    what = 'full',
    delivery = 'zip',
    isL2aaSCustomer = false,
    customRpc,
  } = req.body;

  // Validate
  if (!sourceChainId || !sourceContracts?.length) {
    return res.status(400).json({ error: 'sourceChainId and sourceContracts[] required' });
  }
  if (!Number.isInteger(sourceChainId)) {
    return res.status(400).json({ error: 'sourceChainId must be an integer' });
  }
  if (!['storage', 'events', 'history', 'full'].includes(what)) {
    return res.status(400).json({ error: 'what must be one of: storage, events, history, full' });
  }
  if (sourceContracts.length > LIMITS.maxContractsPerOrder) {
    return res.status(400).json({ error: `Maximum ${LIMITS.maxContractsPerOrder} contracts per quote` });
  }
  const invalid = sourceContracts.find((a: string) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (invalid) {
    return res.status(400).json({ error: `Invalid address format: ${invalid}` });
  }

  // Resolve chain
  const chainKey = Object.entries(CHAINS).find(([, c]) => c.chainId === sourceChainId)?.[0];
  if (!chainKey && !customRpc) {
    return res.status(400).json({
      error: `Chain ${sourceChainId} not supported. Provide customRpc for unlisted chains.`,
    });
  }

  try {
    const provider = customRpc ? getCustomProvider(customRpc) : getProvider(chainKey!);

    // Run estimation heuristics (~2-4 seconds, no full data read)
    const estimation = await estimateContracts(provider, sourceContracts, sourceChainId, what);

    // Gas passthrough only applies when writing to an external destination chain
    const isExternalWrite = delivery !== 'zip' && delivery !== 'l2aas';
    const gasPassthroughUSD = isExternalWrite
      ? estimateWriteGasUSD(sourceChainId, sourceContracts.length)
      : 0;

    const estimateId = crypto.randomUUID();

    const input: EstimationInput = {
      estimateId,
      sourceChainId,
      contracts: estimation.estimates,
      what: what as any,
      delivery,
      gasPassthroughUSD,
      isL2aaSCustomer: Boolean(isL2aaSCustomer),
    };

    const quote = buildQuote(input);

    // Cache quote for 30 min (needed to validate order later)
    storeQuote(quote);

    return res.json({
      ...quote,
      estimationDurationMs: estimation.durationMs,
      currentBlock: estimation.currentBlock,
    });
  } catch (err: any) {
    console.error('[Quote] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/sample
// Body: { estimateId } OR { sourceChain, address, customRpc? }
// Response: ZIP binary stream with real on-chain data
// ---------------------------------------------------------------------------

apiRouter.post('/sample', async (req: Request, res: Response) => {
  let sourceChain: string;
  let address: string;
  let customRpc: string | undefined;

  // Support two call styles: estimateId-based or direct address
  if (req.body.estimateId) {
    const quote = getQuote(req.body.estimateId);
    if (!quote) {
      return res.status(404).json({ error: 'Estimate not found or expired (valid for 30 minutes)' });
    }
    if (!quote.contracts?.length) {
      return res.status(400).json({ error: 'Quote has no contracts' });
    }
    address = quote.contracts[0];
    const chainKey = Object.entries(CHAINS).find(([, c]) => c.chainId === quote.sourceChainId)?.[0];
    if (!chainKey) {
      return res.status(400).json({ error: `Chain ${quote.sourceChainId} not in supported list` });
    }
    sourceChain = chainKey;
  } else {
    sourceChain = req.body.sourceChain;
    address = req.body.address;
    customRpc = req.body.customRpc;

    if (!sourceChain || !address) {
      return res.status(400).json({ error: 'Either estimateId or {sourceChain, address} required' });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      return res.status(400).json({ error: `Invalid address format: ${address}` });
    }
    if (sourceChain !== 'custom' && !CHAINS[sourceChain]) {
      return res.status(400).json({ error: `Unsupported chain: ${sourceChain}` });
    }
    if (sourceChain === 'custom' && !customRpc) {
      return res.status(400).json({ error: 'customRpc required for custom chain' });
    }
  }

  try {
    const result = await buildSampleZip({ sourceChain, address, customRpc });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
    res.setHeader('Content-Length', result.buffer.length);
    res.setHeader('X-Bytecode-Size', result.bytecodeSizeBytes);
    res.setHeader('X-Event-Count', result.eventCount);
    res.setHeader('X-Storage-Slots', result.storageSlots);

    return res.send(result.buffer);
  } catch (err: any) {
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/order
// Body: { estimateId, paymentTxHash, paymentChainId? }
// Response: { orderId, status }
// ---------------------------------------------------------------------------

apiRouter.post('/order', async (req: Request, res: Response) => {
  const {
    estimateId,
    paymentTxHash,
    paymentChainId = 845312,   // default: Demo L2
    customRpc,
  } = req.body;

  if (!estimateId) {
    return res.status(400).json({ error: 'estimateId required' });
  }

  const quote = getQuote(estimateId);
  if (!quote) {
    return res.status(404).json({ error: 'Estimate not found or expired. Request a new quote.' });
  }

  // Free order (L2aaS customer with no gas)
  if (quote.isFree) {
    if (isAtCapacity()) {
      return res.status(429).json({ error: 'Server busy. Please retry in a few minutes.' });
    }
    const order = createOrder({ estimateId, quote, paymentTxHash: null, paymentChainId: null });
    executeOrder(order, customRpc);
    return res.status(202).json({
      orderId: order.id,
      status: order.status,
      message: 'Free order queued. Poll /api/order/:id/status for progress.',
    });
  }

  // Paid order: payment tx hash required
  if (!paymentTxHash) {
    return res.status(400).json({ error: 'paymentTxHash required for paid orders' });
  }

  if (isAtCapacity()) {
    return res.status(429).json({ error: 'Server busy. Please retry in a few minutes.' });
  }

  // Create order in pending_payment state
  const order = createOrder({ estimateId, quote, paymentTxHash, paymentChainId });
  updateOrder(order.id, { status: 'verifying' });

  // Verify payment asynchronously — start job only after verification
  verifyPaymentAndStart(order.id, paymentTxHash, paymentChainId, quote.totalUSDC, customRpc);

  return res.status(202).json({
    orderId: order.id,
    status: 'verifying',
    message: 'Payment verification in progress. Poll /api/order/:id/status for updates.',
  });
});

async function verifyPaymentAndStart(
  orderId: string,
  txHash: string,
  chainId: number,
  expectedUSDC: number,
  customRpc?: string,
): Promise<void> {
  try {
    const result = await verifyPayment(txHash, chainId, expectedUSDC);
    if (!result.ok) {
      updateOrder(orderId, {
        status: 'failed',
        error: `Payment rejected: ${result.reason}`,
      });
      return;
    }
    updateOrder(orderId, { paymentVerified: true, status: 'queued' });
    const order = getOrder(orderId);
    if (order) executeOrder(order, customRpc);
  } catch (err: any) {
    updateOrder(orderId, { status: 'failed', error: `Payment verification error: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// GET /api/order/:id/status
// Response: { orderId, status, progress, resultUrl, error }
// ---------------------------------------------------------------------------

apiRouter.get('/order/:id/status', (req: Request, res: Response) => {
  const order = getOrder(String(req.params.id));
  if (!order) {
    return res.status(404).json({ error: 'Order not found or expired' });
  }

  const eta = order.status === 'running'
    ? `~${Math.round((100 - order.progress) / 10)} minutes remaining`
    : null;

  return res.json({
    orderId: order.id,
    status: order.status,
    progress: order.progress,
    resultUrl: order.resultUrl,
    error: order.error,
    paymentVerified: order.paymentVerified,
    refundNote: order.refundNote,
    eta,
    createdAt: new Date(order.createdAt).toISOString(),
    updatedAt: new Date(order.updatedAt).toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /api/order/:id/download
// Response: ZIP file stream
// ---------------------------------------------------------------------------

apiRouter.get('/order/:id/download', (req: Request, res: Response) => {
  const order = getOrder(String(req.params.id));
  if (!order) {
    return res.status(404).json({ error: 'Order not found or expired' });
  }
  if (order.status !== 'done') {
    return res.status(400).json({ error: `Order not ready (status: ${order.status})` });
  }
  if (!order.resultZipPath || !fs.existsSync(order.resultZipPath)) {
    return res.status(404).json({ error: 'Result file not found on disk. Contact support.' });
  }

  const ext = path.extname(order.resultZipPath);
  const filename = ext === '.json'
    ? `chainclone-${order.id}-genesis.json`
    : `chainclone-${order.id}.zip`;

  res.setHeader('Content-Type', ext === '.json' ? 'application/json' : 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const stream = fs.createReadStream(order.resultZipPath);
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });
  stream.pipe(res);
});

// ---------------------------------------------------------------------------
// POST /api/order/:id/refund
// Refund the non-gas portion of a failed order to the original customer.
// Gas already paid on-chain is NEVER refundable (on-chain consumed).
//
// Idempotent: safe to call multiple times; re-runs only if status == 'failed'
// and refundTxHash is not yet set.
// ---------------------------------------------------------------------------

apiRouter.post('/order/:id/refund', async (req: Request, res: Response) => {
  const order = getOrder(String(req.params.id));
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'failed') {
    return res.status(400).json({ error: `Order status is ${order.status}, refund only available for failed orders` });
  }
  if (order.refundNote?.startsWith('refunded tx=')) {
    return res.json({ ok: true, note: order.refundNote });
  }
  if (!order.paymentVerified || !order.paymentTxHash) {
    return res.status(400).json({ error: 'Order has no verified payment to refund' });
  }

  const refundAmountUSD = order.quote.totalUSDC - order.quote.gasPassthroughUSD;
  if (refundAmountUSD <= 0) {
    updateOrder(order.id, { refundNote: 'no refundable amount (gas-only)', status: 'refunded' });
    return res.json({ ok: true, note: 'no refundable amount (gas-only)' });
  }

  const RPC = process.env.DEMO_L2_RPC || 'http://l2-rpc.opsalis-l2-demo.svc.cluster.local:8545';
  const USDC = process.env.USDC_ADDRESS || '0xb081d16D40e4e4c27D6d8564d145Ab2933037111';
  const REVENUE_KEY = process.env.CHAINCLONE_REVENUE_PRIVATE_KEY;
  if (!REVENUE_KEY) {
    return res.status(500).json({ error: 'Refund unavailable: revenue wallet key not configured' });
  }

  try {
    // Look up original customer from the Paid event
    const provider = new ethers.JsonRpcProvider(RPC);
    const receipt = await provider.getTransactionReceipt(order.paymentTxHash);
    if (!receipt) throw new Error('payment tx receipt missing');
    const BILLING = (process.env.OPSALIS_BILLING_ADDRESS || '0xCEfD64724E6EAbD3372188d3b558b1e74dD27Bc6').toLowerCase();
    const PAID_TOPIC = ethers.id('Paid(bytes32,bytes32,address,uint256,uint256)').toLowerCase();
    let customer: string | undefined;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === BILLING && log.topics[0]?.toLowerCase() === PAID_TOPIC) {
        customer = '0x' + (log.topics[3] || '').slice(26);
        break;
      }
    }
    if (!customer) throw new Error('could not resolve customer from payment tx');

    const wallet = new ethers.Wallet(REVENUE_KEY, provider);
    const usdc = new ethers.Contract(
      USDC,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      wallet,
    );
    const amt = BigInt(Math.floor(refundAmountUSD * 1_000_000));
    const tx = await usdc.transfer(customer, amt);
    const r = await tx.wait();

    updateOrder(order.id, {
      refundNote: `refunded tx=${tx.hash} amount=$${refundAmountUSD.toFixed(2)} gas_withheld=$${order.quote.gasPassthroughUSD.toFixed(2)}`,
      status: 'refunded',
    });

    return res.json({
      ok: true,
      refundTxHash: tx.hash,
      refundAmountUSD,
      gasWithheldUSD: order.quote.gasPassthroughUSD,
      customer,
      blockNumber: r?.blockNumber,
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Refund failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /api/orders — list recent orders (admin)
// ---------------------------------------------------------------------------

apiRouter.get('/orders', (_req: Request, res: Response) => {
  const orders = listOrders(50).map(o => ({
    id: o.id,
    status: o.status,
    progress: o.progress,
    contracts: o.quote.contracts.length,
    totalUSDC: o.quote.totalUSDC,
    delivery: o.quote.delivery,
    createdAt: new Date(o.createdAt).toISOString(),
    updatedAt: new Date(o.updatedAt).toISOString(),
  }));
  return res.json({ orders });
});
