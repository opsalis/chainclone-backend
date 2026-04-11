import { PriceEstimate } from './types';

// Base price per contract in USDC by destination chain
const BASE_PRICES: Record<string, number> = {
  ethereum: 50,    // Expensive gas
  base: 5,
  optimism: 5,
  arbitrum: 5,
  polygon: 5,
  avalanche: 5,
  bsc: 3,
  sepolia: 0.01,          // Testnet — nearly free
  'base-sepolia': 0.01,   // Testnet — nearly free
};

/**
 * Calculate migration price based on destination chain and contract count.
 * L2aaS migrations are always free (incentive to use our chain).
 */
export function calculatePrice(destChain: string, contractCount: number): PriceEstimate {
  // L2aaS is free — we want customers on our chain
  if (destChain === 'l2aas') {
    return {
      destChain,
      contractCount,
      pricePerContract: 0,
      discount: '0%',
      totalUSDC: 0,
      message: 'FREE — migrate to your own L2aaS blockchain',
    };
  }

  const pricePerContract = BASE_PRICES[destChain] || 10;

  // Volume discount tiers
  let discount = 0;
  if (contractCount >= 100) discount = 0.40;
  else if (contractCount >= 50) discount = 0.30;
  else if (contractCount >= 20) discount = 0.20;
  else if (contractCount >= 10) discount = 0.10;
  else if (contractCount >= 5) discount = 0.05;

  const discountedPrice = pricePerContract * (1 - discount);
  const total = Math.round(discountedPrice * contractCount * 100) / 100;

  return {
    destChain,
    contractCount,
    pricePerContract: Math.round(discountedPrice * 100) / 100,
    discount: (discount * 100) + '%',
    totalUSDC: total,
    message: `Migration to ${destChain}: $${total} USDC (${contractCount} contracts)`,
  };
}

/**
 * Estimate gas cost for deploying contracts on destination chain.
 * Used for internal cost analysis, not shown to customer directly.
 */
export function estimateGasCost(
  destChain: string,
  totalBytecodeBytes: number,
  gasPrice: bigint,
): bigint {
  // Rough estimate: 200 gas per byte of bytecode + 32000 base
  const gasPerContract = 32000n;
  const gasPerByte = 200n;
  const estimatedGas = gasPerContract + (BigInt(totalBytecodeBytes) * gasPerByte);
  return estimatedGas * gasPrice;
}

// --- Volume-based pricing ---

export interface VolumeEstimate {
  contracts: number;
  totalBytecodeBytes: number;
  totalStorageBytes: number;
  totalDataMB: number;
  baseFee: number;          // $5 per contract
  storageFeeMB: number;     // $2 per MB of storage
  bytecodeFeeMB: number;    // $1 per MB of bytecode
  totalUSDC: number;
  breakdown: string;
}

export function calculateVolumePrice(
  destChain: string,
  contracts: Array<{ bytecodeSize: number; storageSize: number; isContract: boolean }>,
): VolumeEstimate {
  const contractCount = contracts.filter(c => c.isContract).length;
  const totalBytecodeBytes = contracts.reduce((sum, c) => sum + c.bytecodeSize, 0);
  const totalStorageBytes = contracts.reduce((sum, c) => sum + c.storageSize, 0);
  const totalDataMB = (totalBytecodeBytes + totalStorageBytes) / (1024 * 1024);

  // Base fee per contract
  const baseFeePerContract = destChain === 'l2aas' ? 0 : 5;
  const baseFee = contractCount * baseFeePerContract;

  // Storage fee: $2 per MB
  const storageMB = totalStorageBytes / (1024 * 1024);
  const storageFee = Math.ceil(storageMB * 2 * 100) / 100;

  // Bytecode fee: $1 per MB
  const bytecodeMB = totalBytecodeBytes / (1024 * 1024);
  const bytecodeFee = Math.ceil(bytecodeMB * 1 * 100) / 100;

  // Minimum charge: $5 (even for tiny contracts)
  const rawTotal = baseFee + storageFee + bytecodeFee;
  const totalUSDC = destChain === 'l2aas' ? 0 : Math.max(5, rawTotal);

  return {
    contracts: contractCount,
    totalBytecodeBytes,
    totalStorageBytes,
    totalDataMB: Math.round(totalDataMB * 100) / 100,
    baseFee,
    storageFeeMB: storageFee,
    bytecodeFeeMB: bytecodeFee,
    totalUSDC,
    breakdown: destChain === 'l2aas'
      ? 'FREE with l2aas coupon'
      : `Base: $${baseFee} (${contractCount} contracts x $5) + Storage: $${storageFee} (${storageMB.toFixed(2)} MB x $2) + Bytecode: $${bytecodeFee} (${bytecodeMB.toFixed(2)} MB x $1) = $${totalUSDC}`,
  };
}

// Free tier limits
export const FREE_TIER_LIMITS = {
  maxContracts: 50,
  maxDataMB: 10,           // 10 MB max for free extraction
  maxExtractionsPerDay: 1, // 1 free extraction per wallet per day
};

// Paid tier limits (still need limits to prevent abuse)
export const PAID_TIER_LIMITS = {
  maxContracts: 500,
  maxDataMB: 1000,         // 1 GB max per extraction
  maxConcurrentJobs: 3,
  jobTimeoutMinutes: 10,
};
