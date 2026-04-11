import { ethers } from 'ethers';
import { readContractState } from './reader';
import { generateGenesisAlloc, deployToExternalChain } from './writer';
import { getProvider } from './chains';
import { createJob, getJob, updateJob } from './jobs';
import { MigrationJob, MigrationResult, ContractState } from './types';

/**
 * Start a new migration job.
 * Returns job ID immediately; migration runs asynchronously.
 */
export async function startMigration(
  sourceChain: string,
  destChain: string,
  addresses: string[],
  destWalletKey?: string,
  userSlots?: string[],
): Promise<string> {
  const jobId = crypto.randomUUID();

  const job = createJob(jobId, sourceChain, destChain, addresses);

  // Run migration async — don't await
  runMigration(job, destWalletKey, userSlots).catch((err) => {
    updateJob(jobId, { status: 'failed', error: err.message });
  });

  return jobId;
}

/**
 * Execute the full migration pipeline.
 */
async function runMigration(
  job: MigrationJob,
  destWalletKey?: string,
  userSlots?: string[],
): Promise<void> {
  const sourceProvider = getProvider(job.sourceChain);

  // Phase 1: Read all contract states from source chain
  updateJob(job.id, { status: 'reading' });

  const states: ContractState[] = [];
  for (let i = 0; i < job.addresses.length; i++) {
    try {
      const state = await readContractState(sourceProvider, job.addresses[i], userSlots);
      states.push(state);
    } catch (err: any) {
      console.error(`Failed to read ${job.addresses[i]}: ${err.message}`);
      // Continue with remaining addresses
    }
    updateJob(job.id, { progress: Math.round(((i + 1) / job.addresses.length) * 50) });
  }

  if (states.length === 0) {
    throw new Error('No contracts could be read from source chain');
  }

  // Phase 2: Write to destination
  updateJob(job.id, { status: 'writing' });

  let result: MigrationResult;

  if (job.destChain === 'l2aas') {
    // Free tier: generate genesis alloc for customer's L2aaS chain
    const alloc = generateGenesisAlloc(states);
    result = {
      sourceChain: job.sourceChain,
      destChain: 'l2aas',
      contractsMigrated: states.filter((s) => s.isContract).length,
      genesisAlloc: alloc,
    };
  } else {
    // Paid tier: deploy to external chain
    if (!destWalletKey) {
      throw new Error('Destination wallet key required for external chain migration');
    }

    const destProvider = getProvider(job.destChain);
    const wallet = new ethers.Wallet(destWalletKey, destProvider);

    const deployed = await deployToExternalChain(wallet, states, (done, total) => {
      const writeProgress = Math.round((done / total) * 50);
      updateJob(job.id, { progress: 50 + writeProgress });
    });

    result = {
      sourceChain: job.sourceChain,
      destChain: job.destChain,
      contractsMigrated: deployed.filter((d) => !d.txHash.startsWith('FAILED')).length,
      deployedContracts: deployed,
    };
  }

  updateJob(job.id, { progress: 100, status: 'complete', result });
}

export { getJob } from './jobs';
