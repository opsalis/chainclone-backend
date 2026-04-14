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
  gnosis: {
    name: 'Gnosis Chain',
    chainId: 100,
    rpcUrls: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://gnosisscan.io',
    nativeCurrency: 'xDAI',
  },
  zksync: {
    name: 'zkSync Era',
    chainId: 324,
    rpcUrls: ['https://mainnet.era.zksync.io', 'https://zksync-era-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://era.zksync.network',
    nativeCurrency: 'ETH',
  },
  linea: {
    name: 'Linea',
    chainId: 59144,
    rpcUrls: ['https://rpc.linea.build', 'https://linea-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://lineascan.build',
    nativeCurrency: 'ETH',
  },
  scroll: {
    name: 'Scroll',
    chainId: 534352,
    rpcUrls: ['https://rpc.scroll.io', 'https://scroll-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://scrollscan.com',
    nativeCurrency: 'ETH',
  },
  blast: {
    name: 'Blast',
    chainId: 81457,
    rpcUrls: ['https://rpc.blast.io', 'https://blast-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://blastscan.io',
    nativeCurrency: 'ETH',
  },
  mantle: {
    name: 'Mantle',
    chainId: 5000,
    rpcUrls: ['https://rpc.mantle.xyz', 'https://mantle-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://mantlescan.xyz',
    nativeCurrency: 'MNT',
  },
  'polygon-zkevm': {
    name: 'Polygon zkEVM',
    chainId: 1101,
    rpcUrls: ['https://zkevm-rpc.com', 'https://polygon-zkevm-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://zkevm.polygonscan.com',
    nativeCurrency: 'ETH',
  },
  mode: {
    name: 'Mode',
    chainId: 34443,
    rpcUrls: ['https://mainnet.mode.network', 'https://mode.drpc.org'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://modescan.io',
    nativeCurrency: 'ETH',
  },
  zora: {
    name: 'Zora',
    chainId: 7777777,
    rpcUrls: ['https://rpc.zora.energy', 'https://zora.drpc.org'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://zorascan.xyz',
    nativeCurrency: 'ETH',
  },
  celo: {
    name: 'Celo',
    chainId: 42220,
    rpcUrls: ['https://forno.celo.org', 'https://celo-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://celoscan.io',
    nativeCurrency: 'CELO',
  },
  // Testnets
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrls: ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://sepolia.basescan.org',
    nativeCurrency: 'ETH',
  },
  sepolia: {
    name: 'Ethereum Sepolia',
    chainId: 11155111,
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc.ankr.com/eth_sepolia'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://sepolia.etherscan.io',
    nativeCurrency: 'ETH',
  },
  // Opsalis own chains
  'sertone-l1': {
    name: 'Sertone L1',
    chainId: 845300,
    rpcUrls: [
      process.env.L1_RPC_1 || 'http://node1.zone2serve.top:8545',
      process.env.L1_RPC_2 || 'http://node2.zone2serve.top:8545',
    ],
    rpcaasUrl: undefined,
    explorerUrl: 'https://explorer.l2aas.net',
    nativeCurrency: 'OPSGAS',
  },
  'sertone-demo': {
    name: 'Sertone Demo L2',
    chainId: 845312,
    rpcUrls: [process.env.DEMO_L2_RPC || 'http://demo-l2-geth:8545'],
    rpcaasUrl: undefined,
    explorerUrl: 'https://explorer.l2aas.net/demo',
    nativeCurrency: 'DEMO',
  },
};

/**
 * Get an ethers provider for a chain.
 * Uses the first public RPC URL for the chain (no chainrpc dependency).
 */
export function getProvider(chain: string): ethers.JsonRpcProvider {
  const config = CHAINS[chain];
  if (!config) {
    throw new Error(`Unsupported chain: ${chain}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  // Use configured public RPCs directly — most reliable for cross-cluster access
  const url = config.rpcaasUrl || config.rpcUrls[0];
  return new ethers.JsonRpcProvider(url);
}

/**
 * Get a provider for a custom RPC URL (for custom EVM chains).
 */
export function getCustomProvider(rpcUrl: string): ethers.JsonRpcProvider {
  if (!rpcUrl) throw new Error('Custom RPC URL is required');
  return new ethers.JsonRpcProvider(rpcUrl);
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
