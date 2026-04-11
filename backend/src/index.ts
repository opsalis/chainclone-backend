import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { startMigration, getJob } from './migrator';
import { readContractState, readMultipleContracts } from './reader';
import { getProvider, CHAINS } from './chains';
import { calculatePrice, calculateVolumePrice, FREE_TIER_LIMITS, PAID_TIER_LIMITS } from './pricing';
import { listJobs } from './jobs';
import { writeExportFile, getExportFilePath, CONTENT_TYPES } from './exports';
import { ethers } from 'ethers';
import { encryptL2aasFile, L2aasFileContent } from './l2aas-format';
import { verifyOwnership } from './ownership';

const app = express();
const PORT = parseInt(process.env.PORT || '3300', 10);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- Rate limiting and concurrency ---

// Track free extractions per wallet per day
const freeExtractionTracker = new Map<string, number>(); // wallet -> last extraction timestamp

// Clean up daily
setInterval(() => {
  const dayAgo = Date.now() - 86400000;
  for (const [wallet, ts] of freeExtractionTracker) {
    if (ts < dayAgo) freeExtractionTracker.delete(wallet);
  }
}, 3600000);

// Track concurrent jobs
let activeJobs = 0;
const MAX_CONCURRENT = 3;

// --- Routes ---

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', uptime: process.uptime() });
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

// Preview: read contract state without migrating
app.post('/api/preview', async (req, res) => {
  const { sourceChain, addresses, slots } = req.body;

  if (!sourceChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain and addresses[] required' });
  }

  if (!CHAINS[sourceChain]) {
    return res.status(400).json({ error: `Unsupported chain: ${sourceChain}` });
  }

  if (addresses.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 addresses per preview request' });
  }

  try {
    const provider = getProvider(sourceChain);
    const chainId = CHAINS[sourceChain]?.chainId || 0;
    const states = await readMultipleContracts(provider, addresses, 5, slots, chainId);

    const summary = states.map((s) => ({
      address: s.address,
      isContract: s.isContract,
      bytecodeSize: Math.floor(s.bytecode.length / 2) - 1, // hex chars / 2, minus 0x
      balance: s.balance.toString(),
      nonce: s.nonce,
      storageSlotsFound: s.storageSlots.size,
      sourceAvailable: s.sourceType || 'none',
      contractName: s.contractName || null,
    }));

    // Calculate estimated cost based on data volume
    const estimate = calculateVolumePrice('external', states.map((s) => ({
      bytecodeSize: (s.bytecode.length - 2) / 2,
      storageSize: s.storageSlots.size * 64, // 32 bytes key + 32 bytes value per slot
      isContract: s.isContract,
    })));

    res.json({ sourceChain, contracts: summary, estimate });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Estimate migration cost
app.post('/api/estimate', async (req, res) => {
  const { sourceChain, destChain, addresses } = req.body;

  if (!sourceChain || !destChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain, destChain, and addresses[] required' });
  }

  if (!CHAINS[sourceChain] && sourceChain !== 'l2aas') {
    return res.status(400).json({ error: `Unsupported source chain: ${sourceChain}` });
  }

  // Read contract sizes for volume-based estimate
  try {
    const provider = getProvider(sourceChain);
    const contracts = await Promise.all(addresses.map(async (addr: string) => {
      const code = await provider.getCode(addr);
      const isContract = code !== '0x';
      return {
        address: addr,
        isContract,
        bytecodeSize: isContract ? (code.length - 2) / 2 : 0, // hex to bytes
        storageSize: 0, // Estimated during full extraction
      };
    }));

    const estimate = calculateVolumePrice(destChain, contracts);
    // Also include legacy flat-rate for comparison
    const legacyPrice = calculatePrice(destChain, addresses.length);
    res.json({ ...estimate, legacyPrice });
  } catch (err: any) {
    // Fallback to flat-rate if volume estimate fails
    const price = calculatePrice(destChain, addresses.length);
    res.json(price);
  }
});

// Start migration
app.post('/api/migrate', async (req, res) => {
  const { sourceChain, destChain, addresses, destWalletKey, slots } = req.body;

  if (!sourceChain || !destChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain, destChain, and addresses[] required' });
  }

  if (!CHAINS[sourceChain]) {
    return res.status(400).json({ error: `Unsupported source chain: ${sourceChain}` });
  }

  if (destChain !== 'l2aas' && !CHAINS[destChain]) {
    return res.status(400).json({ error: `Unsupported destination chain: ${destChain}` });
  }

  if (destChain !== 'l2aas' && !destWalletKey) {
    return res.status(400).json({ error: 'destWalletKey required for external chain migration' });
  }

  if (addresses.length > PAID_TIER_LIMITS.maxContracts) {
    return res.status(400).json({ error: `Maximum ${PAID_TIER_LIMITS.maxContracts} addresses per migration job` });
  }

  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy. Please try again in a few minutes.' });
  }

  activeJobs++;
  try {
    const jobId = await startMigration(sourceChain, destChain, addresses, destWalletKey, slots);
    res.json({ jobId, status: 'started' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    activeJobs--;
  }
});

// Check migration status
app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

// List recent jobs
app.get('/api/jobs', (_req, res) => {
  const jobs = listJobs(50);
  res.json({ jobs });
});

// Export job results in CSV, JSON, or XML format
app.get('/api/jobs/:id/export', (req, res) => {
  const format = (req.query.format as string || 'json').toLowerCase();
  if (!['json', 'csv', 'xml'].includes(format)) {
    return res.status(400).json({ error: 'format must be json, csv, or xml' });
  }

  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'complete') {
    return res.status(400).json({ error: 'Job has not completed yet' });
  }

  try {
    const filePath = writeExportFile(job, format as 'json' | 'csv' | 'xml');
    res.setHeader('Content-Type', CONTENT_TYPES[format] || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${job.id}.${format}"`);
    res.sendFile(filePath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Download a previously exported file
app.get('/api/exports/:jobId/:format', (req, res) => {
  const { jobId, format } = req.params;
  if (!['json', 'csv', 'xml'].includes(format)) {
    return res.status(400).json({ error: 'format must be json, csv, or xml' });
  }

  const filePath = getExportFilePath(jobId, format);
  if (!filePath) {
    return res.status(404).json({ error: 'Export file not found or expired (30-min TTL)' });
  }

  res.setHeader('Content-Type', CONTENT_TYPES[format] || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${jobId}.${format}"`);
  res.sendFile(filePath);
});

// Webhook delivery endpoint (POST job results to a customer URL)
app.post('/api/jobs/:id/webhook', async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }

  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'complete') {
    return res.status(400).json({ error: 'Job has not completed yet' });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'migration.complete',
        jobId: job.id,
        sourceChain: job.sourceChain,
        destChain: job.destChain,
        result: job.result,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    res.json({ delivered: true, statusCode: response.status });
  } catch (err: any) {
    res.status(502).json({ error: `Webhook delivery failed: ${err.message}` });
  }
});

// --- Coupon / .l2aas export ---

const VALID_COUPONS: Record<string, { free: boolean; outputFormat: string; extension: string }> = {
  l2aas: { free: true, outputFormat: 'l2aas-encrypted', extension: '.l2aas' },
};

// Validate a coupon code
app.post('/api/validate-coupon', (req, res) => {
  const { couponCode } = req.body;
  const valid = !!(couponCode && VALID_COUPONS[couponCode.toLowerCase()]);
  res.json({
    valid,
    message: valid
      ? 'Free extraction — download as .l2aas file for import into L2aaS'
      : 'Invalid coupon',
  });
});

// Free extraction with coupon — returns encrypted .l2aas file (ECDH per-wallet encryption)
app.post('/api/extract-free', async (req, res) => {
  const { sourceChain, addresses, couponCode, walletAddress, signature, message } = req.body;

  if (!couponCode || !VALID_COUPONS[couponCode.toLowerCase()]) {
    return res.status(400).json({ error: 'Invalid coupon code' });
  }

  // Verify wallet signature (Sign in with Ethereum)
  if (!walletAddress || !signature || !message) {
    return res.status(400).json({ error: 'Wallet signature required — connect your wallet first' });
  }

  // Recover signer from signature and verify it matches the claimed wallet
  let customerPublicKey: string;
  try {
    const recoveredAddress = ethers.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(403).json({ error: 'Invalid signature — wallet mismatch' });
    }
    // Recover the full public key from the signature for ECDH
    customerPublicKey = ethers.SigningKey.recoverPublicKey(
      ethers.hashMessage(message),
      signature,
    );
  } catch {
    return res.status(400).json({ error: 'Invalid wallet signature' });
  }

  if (!sourceChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain and addresses required' });
  }

  if (!CHAINS[sourceChain]) {
    return res.status(400).json({ error: `Unsupported chain: ${sourceChain}` });
  }

  // Free tier limits
  if (addresses.length > FREE_TIER_LIMITS.maxContracts) {
    return res.status(400).json({ error: `Free tier limited to ${FREE_TIER_LIMITS.maxContracts} contracts per extraction` });
  }

  // Rate limit: 1 free extraction per wallet per day
  const walletKey = walletAddress.toLowerCase();
  const lastExtraction = freeExtractionTracker.get(walletKey);
  if (lastExtraction && Date.now() - lastExtraction < 86400000) {
    return res.status(429).json({ error: 'Free tier: 1 extraction per day per wallet. Try again tomorrow.' });
  }

  // Concurrency limit
  if (activeJobs >= MAX_CONCURRENT) {
    return res.status(429).json({ error: 'Server busy. Please try again in a few minutes.' });
  }

  activeJobs++;
  try {
    const provider = getProvider(sourceChain);
    const chainId = CHAINS[sourceChain]?.chainId || 0;

    // Ownership verification: free tier requires you own the contracts
    for (const addr of addresses) {
      const check = await verifyOwnership(provider, addr, walletAddress);
      if (!check.isOwner) {
        return res.status(403).json({
          error: `Cannot verify ownership of ${addr}. Free extraction is limited to contracts you own or deployed. Use paid extraction for third-party contracts.`,
          address: addr,
          reason: check.reason,
        });
      }
    }
    const states = await readMultipleContracts(provider, addresses, 5, undefined, chainId);

    const fileContent: L2aasFileContent = {
      version: 1,
      sourceChain,
      extractedAt: new Date().toISOString(),
      contracts: states.map((s) => ({
        address: s.address,
        bytecode: s.bytecode,
        storage: Object.fromEntries(s.storageSlots),
        balance: s.balance.toString(),
        source: s.source,
        sourceType: s.sourceType,
        contractName: s.contractName,
        compiler: s.compiler,
      })),
      metadata: {
        contractCount: states.filter((s) => s.isContract).length,
        totalStorageSlots: states.reduce((sum, s) => sum + s.storageSlots.size, 0),
        sourceChainId: CHAINS[sourceChain]?.chainId || 0,
      },
    };

    // Encrypt with ECDH using customer's wallet public key
    const encrypted = encryptL2aasFile(fileContent, customerPublicKey);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="chainclone-export-${Date.now()}.l2aas"`,
    );
    // Track successful free extraction
    freeExtractionTracker.set(walletKey, Date.now());

    res.send(encrypted);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  } finally {
    activeJobs--;
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`ChainClone backend running on port ${PORT}`);
  console.log(`Supported chains: ${Object.keys(CHAINS).join(', ')}`);
});

export default app;
