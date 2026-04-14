import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import archiver from 'archiver';
import { startMigration, getJob } from './migrator';
import { readMultipleContracts, readSingleContract } from './reader';
import { getProvider, getCustomProvider, CHAINS } from './chains';
import { calculatePrice, LIMITS, CONTRACT_PRICES } from './pricing';
import { listJobs } from './jobs';
import { ethers } from 'ethers';
import { apiRouter } from './api';

const app = express();
const PORT = parseInt(process.env.PORT || '3300', 10);

// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- v2 API routes (quote / order / sample / download) ---
app.use('/api', apiRouter);

// Track concurrent jobs
let activeJobs = 0;
const MAX_CONCURRENT = 3;

// --- Routes ---

// Health check
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '2.0.0',
    uptime: process.uptime(),
    activeJobs,
    supportedChains: Object.keys(CHAINS),
    destinations: Object.keys(CONTRACT_PRICES),
  });
});

// List supported chains
app.get('/api/chains', (_req, res) => {
  const chains = Object.entries(CHAINS).map(([key, config]) => ({
    id: key,
    name: config.name,
    chainId: config.chainId,
    explorer: config.explorerUrl,
    nativeCurrency: config.nativeCurrency,
  }));
  res.json({ chains });
});

// List destination options with prices
app.get('/api/destinations', (_req, res) => {
  const destinations = Object.entries(CONTRACT_PRICES).map(([key, price]) => ({
    id: key,
    pricePerContract: price,
    isFree: price === 0,
  }));
  res.json({ destinations });
});

// --- NEW API: Analyze a single contract (used for step-by-step streaming) ---

/**
 * POST /api/analyze
 * Analyze a single contract address.
 * Returns: contractType, bytecodeSize, storageSlots, isProxy, implementation, verified
 */
app.post('/api/analyze', async (req, res) => {
  const { sourceChain, address, customRpc } = req.body;

  if (!address || !sourceChain) {
    return res.status(400).json({ error: 'sourceChain and address required' });
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

  try {
    const provider = sourceChain === 'custom'
      ? getCustomProvider(customRpc)
      : getProvider(sourceChain);

    const chainId = CHAINS[sourceChain]?.chainId || 0;
    const state = await readSingleContract(provider, address, undefined, chainId);

    if (!state.isContract) {
      return res.status(422).json({ error: `${address} is not a contract (EOA or empty account)` });
    }

    // Detect proxy patterns
    let isProxy = false;
    let implementation: string | null = null;

    // EIP-1967 implementation slot
    const eip1967Slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    try {
      const implSlot = await provider.getStorage(address, eip1967Slot);
      if (implSlot !== '0x' + '0'.repeat(64)) {
        isProxy = true;
        implementation = '0x' + implSlot.slice(26); // last 20 bytes
      }
    } catch (_) {}

    // Determine contract type from bytecode patterns
    const bytecode = state.bytecode.toLowerCase();
    let contractType = 'Contract';

    // Check for known ERC-20 selectors
    if (bytecode.includes('18160ddd') && bytecode.includes('70a08231') && bytecode.includes('a9059cbb')) {
      contractType = 'ERC-20 Token';
    } else if (bytecode.includes('6352211e') && bytecode.includes('b88d4fde') && bytecode.includes('23b872dd')) {
      contractType = 'ERC-721 NFT';
    } else if (bytecode.includes('f242432a') && bytecode.includes('00fdd58e')) {
      contractType = 'ERC-1155 Multi-Token';
    } else if (isProxy) {
      contractType = 'Proxy (EIP-1967)';
    } else if (bytecode.includes('6080604052') && state.bytecode.length < 300) {
      contractType = 'Minimal Proxy (Clone)';
    }

    const bytecodeSize = (state.bytecode.length - 2) / 2; // minus "0x", hex to bytes

    res.json({
      address,
      contractType,
      bytecodeSize,
      storageSlots: state.storageSlots.size,
      isProxy,
      implementation,
      verified: state.sourceType === 'verified',
      sourceType: state.sourceType || 'bytecode-only',
      contractName: state.contractName || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- NEW API: Get a quote based on analysis results ---

/**
 * POST /api/quote
 * Input: contracts[] (from analysis), destination
 * Returns: per-contract pricing, volume discount, grand total
 */
app.post('/api/quote', (req, res) => {
  const { contracts, destination } = req.body;

  if (!contracts?.length || !destination) {
    return res.status(400).json({ error: 'contracts[] and destination required' });
  }

  if (!Object.keys(CONTRACT_PRICES).includes(destination)) {
    return res.status(400).json({
      error: `Unknown destination: ${destination}. Valid: ${Object.keys(CONTRACT_PRICES).join(', ')}`,
    });
  }

  const validContracts = contracts.filter((c: any) => !c.error && c.bytecodeSize > 0);
  const estimate = calculatePrice(destination, validContracts.length);

  const lineItems = contracts.map((c: any) => {
    if (c.error) return { address: c.address, error: c.error, price: null };
    return {
      address: c.address,
      contractType: c.contractType,
      bytecodeSize: c.bytecodeSize,
      storageSlots: c.storageSlots,
      priceUSDC: estimate.isFree ? 0 : estimate.pricePerContract,
    };
  });

  res.json({
    destination,
    lineItems,
    contractCount: validContracts.length,
    pricePerContract: estimate.pricePerContract,
    discountPct: estimate.discountPct,
    discountAmount: estimate.discountAmount,
    subtotal: estimate.subtotal,
    totalUSDC: estimate.totalUSDC,
    isFree: estimate.isFree,
    message: estimate.message,
  });
});

// --- NEW API: Free sample download ---

/**
 * POST /api/sample
 * Returns a ZIP archive with the first contract's bytecode + structure analysis.
 * This is the "free tier" — proves quality without enabling self-deployment.
 */
app.post('/api/sample', async (req, res) => {
  const { sourceChain, address, customRpc } = req.body;

  if (!address || !sourceChain) {
    return res.status(400).json({ error: 'sourceChain and address required' });
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: `Invalid address format: ${address}` });
  }

  if (sourceChain !== 'custom' && !CHAINS[sourceChain]) {
    return res.status(400).json({ error: `Unsupported chain: ${sourceChain}` });
  }

  try {
    const provider = sourceChain === 'custom'
      ? getCustomProvider(customRpc)
      : getProvider(sourceChain);

    const chainId = CHAINS[sourceChain]?.chainId || 0;
    const state = await readSingleContract(provider, address, undefined, chainId);

    if (!state.isContract) {
      return res.status(422).json({ error: `${address} is not a contract` });
    }

    const bytecodeSize = (state.bytecode.length - 2) / 2;

    // Build analysis text
    const analysisText = [
      'ChainClone — Free Sample Analysis',
      '====================================',
      '',
      `Address:      ${address}`,
      `Source Chain: ${sourceChain}`,
      `Chain ID:     ${chainId}`,
      `Analyzed:     ${new Date().toISOString()}`,
      '',
      'Contract Information',
      '--------------------',
      `Bytecode size:    ${bytecodeSize.toLocaleString()} bytes`,
      `Storage slots:    ${state.storageSlots.size} non-zero slots found (partial scan)`,
      `Source type:      ${state.sourceType || 'bytecode-only'}`,
      `Contract name:    ${state.contractName || 'Unknown'}`,
      `Compiler:         ${state.compiler || 'Unknown'}`,
      '',
      'Note: This sample contains bytecode and structural analysis only.',
      'Full storage state and deployment package require purchasing the migration.',
      '',
      'Storage Layout (first 20 non-zero slots)',
      '-----------------------------------------',
      ...[...state.storageSlots.entries()].slice(0, 20).map(
        ([slot, value]) => `Slot ${slot}: ${value}`,
      ),
      state.storageSlots.size > 20 ? `... and ${state.storageSlots.size - 20} more slots (not included in sample)` : '',
    ].join('\n');

    // Build ABI JSON (empty if not available)
    const abiJson = JSON.stringify(
      { note: 'ABI available for verified contracts only', contractName: state.contractName || null },
      null,
      2,
    );

    // Stream ZIP
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="chainclone-sample-${address.slice(0, 10)}.zip"`,
    );

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    archive.append(state.bytecode, { name: 'bytecode.hex' });
    archive.append(abiJson, { name: 'abi.json' });
    archive.append(analysisText, { name: 'analysis.txt' });

    await archive.finalize();
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// --- NEW API: Execute migration after payment ---

/**
 * POST /api/execute
 * Verifies payment on-chain, then starts migration.
 * Input: sourceChain, addresses[], destination, paymentTx, customRpc?, l2aasChainId?
 */
app.post('/api/execute', async (req, res) => {
  const { sourceChain, addresses, destination, paymentTx, customRpc, l2aasChainId } = req.body;

  if (!sourceChain || !addresses?.length || !destination) {
    return res.status(400).json({ error: 'sourceChain, addresses[], and destination required' });
  }

  if (addresses.length > LIMITS.maxContractsPerOrder) {
    return res.status(400).json({ error: `Maximum ${LIMITS.maxContractsPerOrder} contracts per order` });
  }

  const invalidAddr = addresses.find((a: string) => !/^0x[0-9a-fA-F]{40}$/.test(a));
  if (invalidAddr) {
    return res.status(400).json({ error: `Invalid address: ${invalidAddr}` });
  }

  if (destination !== 'l2aas' && !paymentTx) {
    return res.status(400).json({ error: 'paymentTx required for paid destinations' });
  }

  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy. Please try again in a few minutes.' });
  }

  // For paid destinations, verify payment on-chain
  if (destination !== 'l2aas' && paymentTx && !paymentTx.startsWith('demo-')) {
    try {
      // Use Base or Demo L2 RPC to check the payment transaction
      // Demo L2 (845302) for testing, Base (8453) for mainnet
      const paymentChainRpc = process.env.PAYMENT_CHAIN_RPC || 'https://mainnet.base.org';
      const paymentProvider = new ethers.JsonRpcProvider(paymentChainRpc);
      const receipt = await paymentProvider.getTransactionReceipt(paymentTx);
      if (!receipt || receipt.status !== 1) {
        return res.status(402).json({ error: 'Payment transaction not confirmed or failed. Please wait for confirmation and retry.' });
      }
    } catch (e: any) {
      // Allow on payment check failure (network issue) — log but proceed
      console.warn('Payment verification failed (network error):', e.message);
    }
  }

  activeJobs++;
  try {
    // Map destination to internal chain name for migrator
    const destChain = destination === 'zip' ? 'zip-export' : destination;

    const jobId = await startMigration(
      sourceChain,
      destChain,
      addresses,
      undefined, // destWalletKey — managed internally
      undefined, // storage slots — auto-detected
      { customRpc, l2aasChainId, paymentTx },
    );

    res.json({ jobId, status: 'started', message: 'Migration started. Poll /api/job/:id for status.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    activeJobs--;
  }
});

// --- Job status ---

app.get('/api/job/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired (jobs are kept for 30 days)' });
  }
  res.json(job);
});

app.get('/api/jobs', (_req, res) => {
  const jobs = listJobs(50);
  res.json({ jobs });
});

// Export job results
app.get('/api/job/:id/export', (req, res) => {
  const { format = 'json' } = req.query;
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'complete') return res.status(400).json({ error: 'Job not yet complete' });

  // Return JSON by default
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="chainclone-${req.params.id}.json"`);
  res.json(job.result);
});

// Legacy endpoints (keep for backwards compat)

app.post('/api/preview', async (req, res) => {
  const { sourceChain, addresses } = req.body;
  if (!sourceChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain and addresses[] required' });
  }
  if (!CHAINS[sourceChain]) {
    return res.status(400).json({ error: `Unsupported chain: ${sourceChain}` });
  }
  try {
    const provider = getProvider(sourceChain);
    const chainId = CHAINS[sourceChain]?.chainId || 0;
    const states = await readMultipleContracts(provider, addresses.slice(0, 10), 5, undefined, chainId);
    res.json({
      sourceChain,
      contracts: states.map(s => ({
        address: s.address,
        isContract: s.isContract,
        bytecodeSize: (s.bytecode.length - 2) / 2,
        storageSlots: s.storageSlots.size,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/estimate', async (req, res) => {
  const { sourceChain, destChain, addresses } = req.body;
  if (!sourceChain || !destChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain, destChain, and addresses[] required' });
  }
  const estimate = calculatePrice(destChain, addresses.length);
  res.json(estimate);
});

// Start server
app.listen(PORT, () => {
  console.log(`ChainClone backend running on port ${PORT}`);
  console.log(`Supported chains: ${Object.keys(CHAINS).join(', ')}`);
  console.log(`Destinations: ${Object.keys(CONTRACT_PRICES).join(', ')}`);
});

export default app;
