import { ethers } from 'ethers';
import { ContractState, DeployedContract } from './types';

/**
 * Deploy a contract's bytecode to a destination chain.
 * NOTE: Storage cannot be set externally after deployment.
 * For full state migration, use genesis alloc (L2aaS) or proxy pattern.
 */
export async function deployContract(
  wallet: ethers.Wallet,
  state: ContractState,
): Promise<DeployedContract> {
  // Deploy by sending a transaction with bytecode as data
  // This deploys the runtime bytecode as a contract
  const tx = await wallet.sendTransaction({
    data: state.bytecode,
    gasLimit: 8_000_000n, // High limit, will be estimated down
  });

  const receipt = await tx.wait();
  if (!receipt || !receipt.contractAddress) {
    throw new Error(`Deployment failed for ${state.address}: no contract address in receipt`);
  }

  return {
    originalAddress: state.address,
    newAddress: receipt.contractAddress,
    txHash: tx.hash,
  };
}

/**
 * For L2aaS destination: generate genesis alloc with all contract state.
 * This is the ideal path — we control the chain genesis, so we can
 * inject bytecode + storage + balance directly.
 */
export function generateGenesisAlloc(states: ContractState[]): Record<string, any> {
  const alloc: Record<string, any> = {};

  for (const state of states) {
    const entry: any = {};

    if (state.balance > 0n) {
      entry.balance = '0x' + state.balance.toString(16);
    }

    if (state.isContract && state.bytecode !== '0x') {
      entry.code = state.bytecode;
    }

    if (state.nonce > 0) {
      entry.nonce = '0x' + state.nonce.toString(16);
    }

    if (state.storageSlots.size > 0) {
      entry.storage = {};
      for (const [slot, value] of state.storageSlots) {
        // Pad slot and value to 32 bytes
        const paddedSlot = slot.startsWith('0x') ? slot : '0x' + slot.padStart(64, '0');
        entry.storage[paddedSlot] = value;
      }
    }

    alloc[state.address.toLowerCase()] = entry;
  }

  return alloc;
}

/**
 * For external chain destination: deploy contracts via transactions.
 * Limitations:
 * - Storage slots cannot be set externally (only via genesis)
 * - Contract addresses will differ from source
 * - Constructor logic won't re-run (we deploy runtime bytecode)
 */
export async function deployToExternalChain(
  wallet: ethers.Wallet,
  states: ContractState[],
  onProgress?: (deployed: number, total: number) => void,
): Promise<DeployedContract[]> {
  const deployed: DeployedContract[] = [];
  const contracts = states.filter((s) => s.isContract);

  for (let i = 0; i < contracts.length; i++) {
    const state = contracts[i];
    try {
      const result = await deployContract(wallet, state);
      deployed.push(result);
    } catch (err: any) {
      // Log but continue with remaining contracts
      console.error(`Failed to deploy ${state.address}: ${err.message}`);
      deployed.push({
        originalAddress: state.address,
        newAddress: '0x0000000000000000000000000000000000000000',
        txHash: `FAILED: ${err.message}`,
      });
    }

    if (onProgress) {
      onProgress(i + 1, contracts.length);
    }
  }

  return deployed;
}

/**
 * Generate a mapping file showing original → new addresses.
 * Useful for updating references in frontend code, etc.
 */
export function generateAddressMapping(deployed: DeployedContract[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  for (const d of deployed) {
    if (d.newAddress !== '0x0000000000000000000000000000000000000000') {
      mapping[d.originalAddress] = d.newAddress;
    }
  }
  return mapping;
}
