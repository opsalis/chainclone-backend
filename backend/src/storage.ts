import { ethers } from 'ethers';

/**
 * Storage enumeration strategies.
 * The challenge: Ethereum does not natively expose all storage slots.
 * We use multiple strategies in order of completeness.
 */

// EIP-1967 proxy implementation slot
const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_ADMIN_SLOT = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';

// OpenZeppelin Transparent Proxy (old)
const OZ_IMPL_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';

// Common ERC-20 slot layouts
const ERC20_LAYOUTS = {
  // OpenZeppelin: name(0), symbol(1), decimals(2), totalSupply(3), balances(4), allowances(5)
  openzeppelin: { name: 0, symbol: 1, decimals: 2, totalSupply: 3, balancesSlot: 4, allowancesSlot: 5 },
  // Solidity default: totalSupply(0), balances(1), allowances(2), name(3), symbol(4), decimals(5)
  solidity: { totalSupply: 0, balancesSlot: 1, allowancesSlot: 2, name: 3, symbol: 4, decimals: 5 },
  // USDC-style: various
  usdc: { name: 3, symbol: 4, decimals: 5, totalSupply: 11 },
};

// Standard slots to always check (covers most patterns)
const STANDARD_SLOTS = Array.from({ length: 32 }, (_, i) => i);

/**
 * Detect contract type by checking function selectors in bytecode.
 */
export function detectContractType(bytecode: string): string[] {
  const types: string[] = [];

  // ERC-20 selectors
  if (bytecode.includes('70a08231')) types.push('ERC20'); // balanceOf
  if (bytecode.includes('dd62ed3e')) types.push('ERC20'); // allowance
  if (bytecode.includes('18160ddd')) types.push('ERC20'); // totalSupply

  // ERC-721 selectors
  if (bytecode.includes('6352211e')) types.push('ERC721'); // ownerOf
  if (bytecode.includes('c87b56dd')) types.push('ERC721'); // tokenURI
  if (bytecode.includes('e985e9c5')) types.push('ERC721'); // isApprovedForAll

  // ERC-1155 selectors
  if (bytecode.includes('00fdd58e')) types.push('ERC1155'); // balanceOf
  if (bytecode.includes('4e1273f4')) types.push('ERC1155'); // balanceOfBatch

  // Proxy patterns
  if (bytecode.includes('5c60da1b')) types.push('Proxy'); // implementation()
  if (bytecode.includes('f851a440')) types.push('Proxy'); // admin()

  // Dedupe
  return [...new Set(types)];
}

/**
 * Try debug_storageRangeAt to enumerate ALL storage slots.
 * Only works on archive nodes with debug API enabled.
 */
export async function enumerateStorageDebug(
  provider: ethers.JsonRpcProvider,
  address: string,
  slots: Map<string, string>,
): Promise<boolean> {
  let startKey = '0x' + '0'.repeat(64);
  let hasMore = true;
  let success = false;

  while (hasMore) {
    try {
      const result = await provider.send('debug_storageRangeAt', ['latest', 0, address, startKey, 1024]);
      if (!result || !result.storage) {
        hasMore = false;
        break;
      }

      success = true;
      for (const [_hash, entry] of Object.entries(result.storage)) {
        if (entry && typeof entry === 'object') {
          const { key, value } = entry as { key: string; value: string };
          if (key && value) {
            slots.set(key, value);
          }
        }
      }

      if (result.nextKey) {
        startKey = result.nextKey;
      } else {
        hasMore = false;
      }
    } catch {
      hasMore = false;
    }
  }

  return success;
}

/**
 * Read standard slots (0-31) plus proxy/EIP slots.
 */
export async function readStandardSlots(
  provider: ethers.JsonRpcProvider,
  address: string,
  slots: Map<string, string>,
): Promise<void> {
  const ZERO = '0x' + '0'.repeat(64);

  // Read numbered slots 0-31
  const promises = STANDARD_SLOTS.map(async (i) => {
    const slot = '0x' + i.toString(16).padStart(64, '0');
    try {
      const value = await provider.getStorage(address, slot);
      if (value !== ZERO) {
        slots.set(slot, value);
      }
    } catch { /* skip */ }
  });

  // Also read special slots
  const specialSlots = [
    EIP1967_IMPL_SLOT,
    EIP1967_ADMIN_SLOT,
    EIP1967_BEACON_SLOT,
    OZ_IMPL_SLOT,
  ];

  const specialPromises = specialSlots.map(async (slot) => {
    try {
      const value = await provider.getStorage(address, slot);
      if (value !== ZERO) {
        slots.set(slot, value);
      }
    } catch { /* skip */ }
  });

  await Promise.all([...promises, ...specialPromises]);
}

/**
 * For ERC-20 contracts, try to read balances for known holder addresses.
 * Uses Transfer event logs to discover holders.
 */
export async function readERC20Holders(
  provider: ethers.JsonRpcProvider,
  address: string,
  balancesSlot: number,
  slots: Map<string, string>,
  maxHolders: number = 100,
): Promise<void> {
  const ZERO = '0x' + '0'.repeat(64);
  const transferTopic = ethers.id('Transfer(address,address,uint256)');

  try {
    // Get recent Transfer events to discover holders
    const logs = await provider.getLogs({
      address,
      topics: [transferTopic],
      fromBlock: -10000, // Last 10k blocks
    });

    const holders = new Set<string>();
    for (const log of logs) {
      if (log.topics[1]) holders.add('0x' + log.topics[1].slice(26));
      if (log.topics[2]) holders.add('0x' + log.topics[2].slice(26));
      if (holders.size >= maxHolders) break;
    }

    // Read balance slot for each holder: keccak256(abi.encode(holder, balancesSlot))
    const holderPromises = [...holders].map(async (holder) => {
      const slot = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [holder, balancesSlot])
      );
      try {
        const value = await provider.getStorage(address, slot);
        if (value !== ZERO) {
          slots.set(slot, value);
        }
      } catch { /* skip */ }
    });

    await Promise.all(holderPromises);
  } catch { /* skip — logs may not be available */ }
}

/**
 * Read user-specified storage slots.
 */
export async function readSpecificSlots(
  provider: ethers.JsonRpcProvider,
  address: string,
  userSlots: string[],
  slots: Map<string, string>,
): Promise<void> {
  const ZERO = '0x' + '0'.repeat(64);

  const promises = userSlots.map(async (slot) => {
    const paddedSlot = slot.startsWith('0x') ? slot : '0x' + slot;
    try {
      const value = await provider.getStorage(address, paddedSlot);
      if (value !== ZERO) {
        slots.set(paddedSlot, value);
      }
    } catch { /* skip */ }
  });

  await Promise.all(promises);
}

/**
 * Full storage enumeration pipeline.
 * Tries debug API first, falls back to heuristic reading.
 */
export async function enumerateStorage(
  provider: ethers.JsonRpcProvider,
  address: string,
  bytecode: string,
  userSlots?: string[],
): Promise<Map<string, string>> {
  const slots = new Map<string, string>();

  // Strategy 1: Try debug_storageRangeAt (gets everything)
  const debugSuccess = await enumerateStorageDebug(provider, address, slots);
  if (debugSuccess && slots.size > 0) {
    return slots;
  }

  // Strategy 2: Read standard slots and proxy slots
  await readStandardSlots(provider, address, slots);

  // Strategy 3: Type-specific reading
  const types = detectContractType(bytecode);

  if (types.includes('ERC20')) {
    // Try multiple balances slot positions
    for (const balancesSlot of [1, 2, 4, 51]) {
      await readERC20Holders(provider, address, balancesSlot, slots, 50);
    }
  }

  // Strategy 4: User-specified slots
  if (userSlots && userSlots.length > 0) {
    await readSpecificSlots(provider, address, userSlots, slots);
  }

  return slots;
}
