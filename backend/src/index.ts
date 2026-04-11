import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { startMigration, getJob } from './migrator';
import { readContractState, readMultipleContracts } from './reader';
import { getProvider, CHAINS } from './chains';
import { calculatePrice } from './pricing';
import { listJobs } from './jobs';

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

// Start server
app.listen(PORT, () => {
  console.log(`ChainClone backend running on port ${PORT}`);
  console.log(`Supported chains: ${Object.keys(CHAINS).join(', ')}`);
});

export default app;
