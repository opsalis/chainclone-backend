import { ethers } from 'ethers';
import { ContractState } from './types';
import { enumerateStorage } from './storage';
import { getContractSource } from './decompiler';

/**
 * Read a single contract's complete on-chain state.
 */
export async function readContractState(
  provider: ethers.JsonRpcProvider,
  address: string,
  userSlots?: string[],
  chainId?: number,
): Promise<ContractState> {
  // Validate address
  if (!ethers.isAddress(address)) {
    throw new Error(`Invalid address: ${address}`);
  }

  const checksumAddress = ethers.getAddress(address);

  // Read basic state in parallel
  const [bytecode, balance, nonce] = await Promise.all([
    provider.getCode(checksumAddress),
    provider.getBalance(checksumAddress),
    provider.getTransactionCount(checksumAddress),
  ]);

  const isContract = bytecode !== '0x';
  let storageSlots = new Map<string, string>();

  if (isContract) {
    storageSlots = await enumerateStorage(provider, checksumAddress, bytecode, userSlots);
  }

  // Fetch source code for contracts (verified source, decompiled, or bytecode-only)
  let source: string | undefined;
  let sourceType: string | undefined;
  let contractName: string | undefined;
  let compiler: string | undefined;

  if (isContract && chainId) {
    try {
      const sourceResult = await getContractSource(checksumAddress, bytecode, chainId);
      source = sourceResult.source;
      sourceType = sourceResult.sourceType;
      contractName = sourceResult.contractName;
      compiler = sourceResult.compiler;
    } catch {
      // Source recovery is best-effort — never block the extraction
      sourceType = 'bytecode-only';
    }
  }

  return {
    address: checksumAddress,
    bytecode,
    balance,
    nonce,
    storageSlots,
    isContract,
    source,
    sourceType,
    contractName,
    compiler,
  };
}

/**
 * Read multiple contracts in parallel with concurrency limit.
 */
export async function readMultipleContracts(
  provider: ethers.JsonRpcProvider,
  addresses: string[],
  concurrency: number = 5,
  userSlots?: string[],
  chainId?: number,
): Promise<ContractState[]> {
  const results: ContractState[] = [];

  // Process in batches to avoid overwhelming the RPC
  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((addr) => readContractState(provider, addr, userSlots, chainId))
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Quick check: is this address a contract or EOA?
 */
export async function isContract(provider: ethers.JsonRpcProvider, address: string): Promise<boolean> {
  const code = await provider.getCode(address);
  return code !== '0x';
}

/**
 * Alias for readContractState — used in the analyze endpoint.
 */
export const readSingleContract = readContractState;
