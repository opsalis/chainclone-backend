import { ethers } from 'ethers';
import { ContractState } from './types';
import { enumerateStorage } from './storage';

/**
 * Read a single contract's complete on-chain state.
 */
export async function readContractState(
  provider: ethers.JsonRpcProvider,
  address: string,
  userSlots?: string[],
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

  return {
    address: checksumAddress,
    bytecode,
    balance,
    nonce,
    storageSlots,
    isContract,
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
): Promise<ContractState[]> {
  const results: ContractState[] = [];

  // Process in batches to avoid overwhelming the RPC
  for (let i = 0; i < addresses.length; i += concurrency) {
    const batch = addresses.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map((addr) => readContractState(provider, addr, userSlots))
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
