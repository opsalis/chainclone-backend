import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { getJob } from './migrator';
import { readMultipleContracts, readSingleContract } from './reader';
import { getProvider, getCustomProvider, CHAINS, refreshChainCatalog } from './chains';
import { listJobs } from './jobs';
import { apiRouter } from './api';

const app = express();
const PORT = parseInt(process.env.PORT || '3300', 10);

// --- Middleware ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// --- v2 API routes (quote / order / sample / download) — canonical ---
app.use('/api', apiRouter);

// --- Health ---
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '2.1.0',
    uptime: process.uptime(),
    supportedChains: Object.keys(CHAINS),
    chainCount: Object.keys(CHAINS).length,
  });
});

// --- Chain list (sources + destinations are the same: the full ChainRPC catalog) ---
app.get('/api/chains', (_req, res) => {
  const chains = Object.entries(CHAINS).map(([key, config]) => ({
    id: key,
    name: config.name,
    chainId: config.chainId,
    explorer: config.explorerUrl,
    nativeCurrency: config.nativeCurrency,
  }));
  res.json({ chains, count: chains.length });
});

// --- Analyze a single contract ---
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

    let isProxy = false;
    let implementation: string | null = null;
    const eip1967Slot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    try {
      const implSlot = await provider.getStorage(address, eip1967Slot);
      if (implSlot !== '0x' + '0'.repeat(64)) {
        isProxy = true;
        implementation = '0x' + implSlot.slice(26);
      }
    } catch (_) {}

    const bytecode = state.bytecode.toLowerCase();
    let contractType = 'Contract';
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

    const bytecodeSize = (state.bytecode.length - 2) / 2;
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

// --- Job inspection ---
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

app.get('/api/job/:id/export', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'complete') return res.status(400).json({ error: 'Job not yet complete' });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="chainclone-${req.params.id}.json"`);
  res.json(job.result);
});

// --- Legacy preview (kept for UI compat; cheap eth_getCode fan-out) ---
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

// --- Boot ---
(async () => {
  await refreshChainCatalog();
  app.listen(PORT, () => {
    console.log(`ChainClone backend v2.1.0 on port ${PORT}`);
    console.log(`Chains: ${Object.keys(CHAINS).length} (via ChainRPC internal catalog)`);
  });
})();

export default app;
