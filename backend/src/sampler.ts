/**
 * ChainClone — Sample Retrieval
 *
 * Returns a ZIP containing REAL on-chain data for the first contract in an order.
 * Purpose: prove we're real before the customer pays.
 *
 * Contents of sample ZIP:
 *   - analysis.txt          — human-readable summary
 *   - bytecode.hex          — raw deployed bytecode
 *   - abi.json              — ABI if contract is verified (else stub)
 *   - events_sample.json    — first 10 actual log entries (real data)
 *   - storage_sample.json   — first 20 non-zero storage slots (real data)
 *   - metadata.json         — chain, address, block, timestamp
 *
 * Rule: no fake data. All data fetched live from the chain.
 */

import archiver from 'archiver';
import { ethers } from 'ethers';
import { Writable } from 'stream';
import { getProvider, getCustomProvider, CHAINS } from './chains';
import { enumerateStorage } from './storage';
import { getContractSource } from './decompiler';

export interface SampleRequest {
  sourceChain: string;
  address: string;
  customRpc?: string;
}

export interface SampleResult {
  filename: string;
  buffer: Buffer;
  bytecodeSizeBytes: number;
  eventCount: number;
  storageSlots: number;
}

export async function buildSampleZip(req: SampleRequest): Promise<SampleResult> {
  const { sourceChain, address, customRpc } = req;

  const provider = sourceChain === 'custom'
    ? getCustomProvider(customRpc!)
    : getProvider(sourceChain);

  const chainConfig = CHAINS[sourceChain];
  const chainId = chainConfig?.chainId ?? 0;
  const checksumAddr = ethers.getAddress(address);

  // Read contract state in parallel
  const [bytecode, balance, nonce, blockNumber] = await Promise.all([
    provider.getCode(checksumAddr),
    provider.getBalance(checksumAddr),
    provider.getTransactionCount(checksumAddr),
    provider.getBlockNumber(),
  ]);

  if (bytecode === '0x') {
    throw new Error(`${address} is not a contract (EOA or empty account)`);
  }

  const bytecodeSizeBytes = Math.floor((bytecode.length - 2) / 2);

  // Storage: heuristic scan (first 32 slots + EIP-1967 proxy slots)
  const storageMap = await enumerateStorage(provider, checksumAddr, bytecode, undefined);
  const storageEntries = [...storageMap.entries()].slice(0, 20);

  // Events: fetch last 50 real log entries
  let events: any[] = [];
  try {
    const fromBlock = Math.max(0, blockNumber - 10000);
    const rawProvider = provider as any;
    const logs = await rawProvider.send('eth_getLogs', [{
      address: checksumAddr,
      fromBlock: ethers.toBeHex(fromBlock),
      toBlock: ethers.toBeHex(blockNumber),
    }]);
    events = Array.isArray(logs) ? logs.slice(0, 10) : [];
  } catch {
    events = [];
  }

  // Source code
  let sourceType = 'bytecode-only';
  let contractName: string | null = null;
  let abi: any[] = [];
  let compiler: string | null = null;

  if (chainId) {
    try {
      const src = await getContractSource(checksumAddr, bytecode, chainId);
      sourceType = src.sourceType || 'bytecode-only';
      contractName = src.contractName || null;
      compiler = src.compiler || null;
      // ABI is embedded in the verified source response from Etherscan
      // getContractSource returns source as string — we only expose metadata here
    } catch {
      // best-effort
    }
  }

  // Build file contents
  const metadataJson = JSON.stringify({
    chainId,
    chain: sourceChain,
    address: checksumAddr,
    blockNumber,
    sampledAt: new Date().toISOString(),
    bytecodeSizeBytes,
    nonce,
    balanceWei: balance.toString(),
  }, null, 2);

  const storageJson = JSON.stringify({
    note: 'First 20 non-zero storage slots (partial scan — full scan requires paid order)',
    slots: storageEntries.map(([slot, value]) => ({ slot, value })),
  }, null, 2);

  const eventsJson = JSON.stringify({
    note: `First ${events.length} log entries from block ${Math.max(0, blockNumber - 10000)} to ${blockNumber}`,
    count: events.length,
    logs: events,
  }, null, 2);

  const abiJson = JSON.stringify({
    note: sourceType === 'verified'
      ? 'ABI available — full ABI included in paid order package'
      : 'Contract is not verified on-chain. ABI not available. Full bytecode included.',
    contractName,
    sourceType,
    compiler,
    abi,
  }, null, 2);

  const explorerUrl = chainConfig?.explorerUrl || `https://etherscan.io`;

  const analysisLines = [
    'ChainClone — Free Sample',
    '========================',
    '',
    `Address:       ${checksumAddr}`,
    `Chain:         ${chainConfig?.name || sourceChain} (ID: ${chainId})`,
    `Analyzed at:   ${new Date().toISOString()}`,
    `Block:         ${blockNumber}`,
    `Explorer:      ${explorerUrl}/address/${checksumAddr}`,
    '',
    'Contract Facts',
    '--------------',
    `Bytecode size: ${bytecodeSizeBytes.toLocaleString()} bytes`,
    `Balance:       ${ethers.formatEther(balance)} ${chainConfig?.nativeCurrency || 'ETH'}`,
    `Nonce:         ${nonce}`,
    `Source:        ${sourceType}`,
    `Name:          ${contractName || 'Unknown'}`,
    `Compiler:      ${compiler || 'Unknown'}`,
    '',
    'Sample Data',
    '-----------',
    `Storage slots found: ${storageMap.size} (showing first ${storageEntries.length})`,
    `Events sampled:      ${events.length} (last 10,000 blocks)`,
    '',
    'Files in this ZIP',
    '-----------------',
    '  bytecode.hex         — deployed runtime bytecode',
    '  abi.json             — ABI metadata (full ABI in paid order)',
    '  storage_sample.json  — first 20 non-zero storage slots',
    '  events_sample.json   — up to 10 actual log entries',
    '  metadata.json        — chain and contract metadata',
    '',
    'To get the complete extraction (all events, all storage, deployment package)',
    'purchase a full order at chainclone.opsalis.com',
  ];

  const analysisText = analysisLines.join('\n');

  // Build ZIP in memory
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); cb(); },
  });

  await new Promise<void>((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    writable.on('finish', resolve);
    archive.pipe(writable);

    archive.append(bytecode, { name: 'bytecode.hex' });
    archive.append(abiJson, { name: 'abi.json' });
    archive.append(storageJson, { name: 'storage_sample.json' });
    archive.append(eventsJson, { name: 'events_sample.json' });
    archive.append(metadataJson, { name: 'metadata.json' });
    archive.append(analysisText, { name: 'analysis.txt' });

    archive.finalize();
  });

  const buffer = Buffer.concat(chunks);
  const filename = `chainclone-sample-${checksumAddr.slice(0, 10)}-${sourceChain}.zip`;

  return {
    filename,
    buffer,
    bytecodeSizeBytes,
    eventCount: events.length,
    storageSlots: storageMap.size,
  };
}
