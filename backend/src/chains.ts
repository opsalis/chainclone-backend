import { ethers } from 'ethers';
import { ChainConfig } from './types';

export const CHAINS: Record<string, ChainConfig> = {
  ethereum: {
    name: 'Ethereum',
    chainId: 1,
    rpcUrls: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://ethereum-rpc.publicnode.com'],
    rpcaasUrl: undefined, // TODO: 'http://rpc-proxy:3100/v1/ethereum/internal'
    explorerUrl: 'https://etherscan.io',
    nativeCurrency: 'ETH',
  },
  base: {
    name: 'Base',
    chainId: 8453,
    rpcUrls: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://rpc.ankr.com/base'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://basescan.org',
    nativeCurrency: 'ETH',
  },
  optimism: {
    name: 'Optimism',
    chainId: 10,
    rpcUrls: ['https://mainnet.optimism.io', 'https://rpc.ankr.com/optimism'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://optimistic.etherscan.io',
    nativeCurrency: 'ETH',
  },
  arbitrum: {
    name: 'Arbitrum',
    chainId: 42161,
    rpcUrls: ['https://arb1.arbitrum.io/rpc', 'https://rpc.ankr.com/arbitrum'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://arbiscan.io',
    nativeCurrency: 'ETH',
  },
  polygon: {
    name: 'Polygon',
    chainId: 137,
    rpcUrls: ['https://polygon-rpc.com', 'https://rpc.ankr.com/polygon'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://polygonscan.com',
    nativeCurrency: 'MATIC',
  },
  avalanche: {
    name: 'Avalanche',
    chainId: 43114,
    rpcUrls: ['https://api.avax.network/ext/bc/C/rpc', 'https://rpc.ankr.com/avalanche'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://snowtrace.io',
    nativeCurrency: 'AVAX',
  },
  bsc: {
    name: 'BNB Smart Chain',
    chainId: 56,
    rpcUrls: ['https://bsc-dataseed.binance.org', 'https://rpc.ankr.com/bsc'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://bscscan.com',
    nativeCurrency: 'BNB',
  },
  // Testnets for demo
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrls: ['https://sepolia.base.org'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: 'ETH',
  },
  sepolia: {
    name: 'Sepolia',
    chainId: 11155111,
    rpcUrls: ['https://rpc.sepolia.org', 'https://rpc.ankr.com/eth_sepolia'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: 'ETH',
  },
};

/**
 * Get an ethers provider for a chain.
 * Prefers RPCaaS endpoint when available, falls back to public RPCs.
 * Rotates through fallback RPCs on failure.
 */
export function getProvider(chain: string): ethers.JsonRpcProvider {
  const config = CHAINS[chain];
  if (!config) {
    throw new Error(`Unsupported chain: ${chain}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  const url = config.rpcaasUrl || config.rpcUrls[0];
  return new ethers.JsonRpcProvider(url);
}

/**
 * Get a fallback provider that tries multiple RPCs.
 */
export function getFallbackProvider(chain: string): ethers.FallbackProvider {
  const config = CHAINS[chain];
  if (!config) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  const urls = config.rpcaasUrl ? [config.rpcaasUrl, ...config.rpcUrls] : config.rpcUrls;
  const providers = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url),
    priority: i + 1,
    stallTimeout: 2000,
    weight: i === 0 ? 2 : 1,
  }));

  return new ethers.FallbackProvider(providers, undefined, { quorum: 1 });
}
