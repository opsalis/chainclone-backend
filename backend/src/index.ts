import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { startMigration, getJob } from './migrator';
import { readContractState, readMultipleContracts } from './reader';
import { getProvider, CHAINS } from './chains';
import { calculatePrice } from './pricing';
import { listJobs } from './jobs';
import { writeExportFile, getExportFilePath, CONTENT_TYPES } from './exports';
import { encryptL2aasFile, L2aasFileContent } from './l2aas-format';

const app = express();
const PORT = parseInt(process.env.PORT || '3300', 10);

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

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
    const states = await readMultipleContracts(provider, addresses, 5, slots);

    const summary = states.map((s) => ({
      address: s.address,
      isContract: s.isContract,
      bytecodeSize: Math.floor(s.bytecode.length / 2) - 1, // hex chars / 2, minus 0x
      balance: s.balance.toString(),
      nonce: s.nonce,
      storageSlotsFound: s.storageSlots.size,
    }));

    res.json({ sourceChain, contracts: summary });
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

  const price = calculatePrice(destChain, addresses.length);
  res.json(price);
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

  if (addresses.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 addresses per migration job' });
  }

  try {
    const jobId = await startMigration(sourceChain, destChain, addresses, destWalletKey, slots);
    res.json({ jobId, status: 'started' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
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

// Free extraction with coupon — returns encrypted .l2aas file
app.post('/api/extract-free', async (req, res) => {
  const { sourceChain, addresses, couponCode } = req.body;

  if (!couponCode || !VALID_COUPONS[couponCode.toLowerCase()]) {
    return res.status(400).json({ error: 'Invalid coupon code' });
  }

  if (!sourceChain || !addresses?.length) {
    return res.status(400).json({ error: 'sourceChain and addresses required' });
  }

  if (!CHAINS[sourceChain]) {
    return res.status(400).json({ error: `Unsupported chain: ${sourceChain}` });
  }

  if (addresses.length > 100) {
    return res.status(400).json({ error: 'Maximum 100 addresses per extraction' });
  }

  try {
    const provider = getProvider(sourceChain);
    const states = await readMultipleContracts(provider, addresses, 5);

    const fileContent: L2aasFileContent = {
      version: 1,
      sourceChain,
      extractedAt: new Date().toISOString(),
      contracts: states.map((s) => ({
        address: s.address,
        bytecode: s.bytecode,
        storage: Object.fromEntries(s.storageSlots),
        balance: s.balance.toString(),
      })),
      metadata: {
        contractCount: states.filter((s) => s.isContract).length,
        totalStorageSlots: states.reduce((sum, s) => sum + s.storageSlots.size, 0),
        sourceChainId: CHAINS[sourceChain]?.chainId || 0,
      },
    };

    const encrypted = encryptL2aasFile(fileContent);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="chainclone-export-${Date.now()}.l2aas"`,
    );
    res.send(encrypted);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`ChainClone backend running on port ${PORT}`);
  console.log(`Supported chains: ${Object.keys(CHAINS).join(', ')}`);
});

export default app;
