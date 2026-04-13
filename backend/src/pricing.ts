// Exact prices per contract in USDC by destination chain
// These are deliberately odd numbers — they look calculated, not rounded
export const CONTRACT_PRICES: Record<string, number> = {
  l2aas:    0,       // Always free — incentive to use L2aaS
  zip:      47.50,   // Export to ZIP file
  base:     97.53,   // Base L2
  arbitrum: 97.53,   // Arbitrum One
  optimism: 97.53,   // Optimism
  polygon:  97.53,   // Polygon
  bsc:      31.17,   // BNB Chain
  ethereum: 478.21,  // Ethereum L1 (includes mainnet gas budget)
};

export interface PriceEstimate {
  destChain: string;
  contractCount: number;
  pricePerContract: number;
  discountPct: number;
  subtotal: number;
  discountAmount: number;
  totalUSDC: number;
  isFree: boolean;
  message: string;
}

/**
 * Volume discount tiers
 */
export function getDiscountPct(contractCount: number): number {
  if (contractCount >= 100) return 0.40;
  if (contractCount >= 50)  return 0.30;
  if (contractCount >= 20)  return 0.20;
  if (contractCount >= 10)  return 0.10;
  if (contractCount >= 5)   return 0.05;
  return 0;
}

/**
 * Calculate total price for a migration order.
 * contractCount should be the number of valid (non-error) contracts.
 */
export function calculatePrice(destChain: string, contractCount: number): PriceEstimate {
  const pricePerContract = CONTRACT_PRICES[destChain] ?? 97.53;
  const isFree = pricePerContract === 0;

  if (isFree) {
    return {
      destChain,
      contractCount,
      pricePerContract: 0,
      discountPct: 0,
      subtotal: 0,
      discountAmount: 0,
      totalUSDC: 0,
      isFree: true,
      message: 'Free migration to your L2aaS chain',
    };
  }

  const discountPct = getDiscountPct(contractCount);
  const discountedPricePerContract = pricePerContract * (1 - discountPct);
  const subtotal = Math.round(pricePerContract * contractCount * 100) / 100;
  const discountAmount = Math.round(pricePerContract * contractCount * discountPct * 100) / 100;
  const totalUSDC = Math.round(discountedPricePerContract * contractCount * 100) / 100;

  return {
    destChain,
    contractCount,
    pricePerContract: Math.round(discountedPricePerContract * 100) / 100,
    discountPct,
    subtotal,
    discountAmount,
    totalUSDC,
    isFree: false,
    message: `${contractCount} contract${contractCount !== 1 ? 's' : ''} to ${destChain}: $${totalUSDC} USDC${discountPct > 0 ? ` (${(discountPct * 100).toFixed(0)}% volume discount)` : ''}`,
  };
}

// Limits
export const LIMITS = {
  maxContractsPerOrder: 100,
  jobRetentionDays: 30,
  sampleFirstContractOnly: true,
};
