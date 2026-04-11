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
