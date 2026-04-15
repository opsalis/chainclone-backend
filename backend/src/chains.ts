/**
 * ChainClone — Chain catalog
 *
 * Production mode: fetches the live chain list from the internal ChainRPC
 * service (`http://chainrpc.chainrpc.svc.cluster.local:3100/health`). Every
 * chain ChainRPC supports is usable as source OR target. Refresh hourly.
 *
 * A hardcoded fallback list is kept ONLY so the service can still boot if the
 * internal ChainRPC service is unreachable at startup — production must log
 * a warning when that happens.
 *
 * All RPC calls route through the internal ChainRPC ClusterIP, bypassing
 * per-request billing. Routing uses a Host-header trick:
 *   POST http://chainrpc.chainrpc.svc.cluster.local:3100/
 *   Host: <chain>.chainrpc.net
 */
import { ethers } from 'ethers';
import { ChainConfig } from './types';

const CHAINRPC_INTERNAL_URL =
  process.env.CHAINRPC_INTERNAL_URL || 'http://chainrpc.chainrpc.svc.cluster.local:3100';

const CATALOG_REFRESH_MS = 60 * 60 * 1000; // 1 hour

/** Hardcoded boot fallback — only used if catalog fetch fails at startup. */
const FALLBACK_CHAINS: Record<string, ChainConfig> = {
  ethereum: mk('Ethereum', 1, 'ethereum', 'https://etherscan.io', 'ETH'),
  base: mk('Base', 8453, 'base', 'https://basescan.org', 'ETH'),
  optimism: mk('Optimism', 10, 'optimism', 'https://optimistic.etherscan.io', 'ETH'),
  arbitrum: mk('Arbitrum One', 42161, 'arbitrum', 'https://arbiscan.io', 'ETH'),
  polygon: mk('Polygon PoS', 137, 'polygon', 'https://polygonscan.com', 'POL'),
  bsc: mk('BNB Chain', 56, 'bsc', 'https://bscscan.com', 'BNB'),
  'base-sepolia': mk('Base Sepolia', 84532, 'base-sepolia', 'https://sepolia.basescan.org', 'ETH'),
  sepolia: mk('Ethereum Sepolia', 11155111, 'sepolia', 'https://sepolia.etherscan.io', 'ETH'),
};

function mk(
  name: string,
  chainId: number,
  subdomain: string,
  explorerUrl: string,
  nativeCurrency: string,
): ChainConfig {
  return {
    name,
    chainId,
    // Public URL is kept only for metadata / explorer links. All internal reads go through
    // the ChainRPC ClusterIP with a Host header (see getProvider below).
    rpcUrls: [`https://${subdomain}.chainrpc.net`],
    rpcaasUrl: `https://${subdomain}.chainrpc.net`,
    rpcaasSubdomain: subdomain,
    explorerUrl,
    nativeCurrency,
  };
}

export let CHAINS: Record<string, ChainConfig> = { ...FALLBACK_CHAINS };

interface ChainRpcHealthChain {
  id: string;
  name: string;
  chainId: number;
  subdomain: string;
  fqdn: string;
  gasToken: string;
  isOwn: boolean;
}

async function fetchChainCatalog(): Promise<Record<string, ChainConfig> | null> {
  try {
    const res = await fetch(`${CHAINRPC_INTERNAL_URL}/health`, {
      // Node 22 global fetch; 3s abort
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.warn(`[chains] catalog fetch HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { chains?: ChainRpcHealthChain[] };
    if (!data.chains?.length) {
      console.warn('[chains] catalog returned no chains');
      return null;
    }
    const out: Record<string, ChainConfig> = {};
    for (const c of data.chains) {
      out[c.id] = {
        name: c.name,
        chainId: c.chainId,
        rpcUrls: [`https://${c.fqdn}`],
        rpcaasUrl: `https://${c.fqdn}`,
        rpcaasSubdomain: c.subdomain,
        explorerUrl: '',
        nativeCurrency: c.gasToken,
      };
    }
    return out;
  } catch (err: any) {
    console.warn(`[chains] catalog fetch failed: ${err?.message || err}`);
    return null;
  }
}

export async function refreshChainCatalog(): Promise<void> {
  const fresh = await fetchChainCatalog();
  if (fresh) {
    CHAINS = fresh;
    console.log(`[chains] catalog refreshed — ${Object.keys(CHAINS).length} chains`);
  } else {
    console.warn(
      '[chains] using fallback catalog — ChainRPC internal service unreachable. ' +
        'This SHOULD NOT happen in production.',
    );
  }
}

// Boot + hourly refresh — fire-and-forget (backend still comes up if catalog is down)
void refreshChainCatalog();
setInterval(() => { void refreshChainCatalog(); }, CATALOG_REFRESH_MS);

/**
 * Get an ethers provider for a chain.
 * Routes through the ChainRPC ClusterIP with a Host header matching the chain's
 * FQDN. This bypasses per-request billing (we are the provider).
 */
export function getProvider(chain: string): ethers.JsonRpcProvider {
  const config = CHAINS[chain];
  if (!config) {
    throw new Error(`Unsupported chain: ${chain}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  const subdomain = config.rpcaasSubdomain || chain;
  const hostFqdn = `${subdomain}.chainrpc.net`;

  const req = new ethers.FetchRequest(CHAINRPC_INTERNAL_URL);
  req.setHeader('Host', hostFqdn);
  req.setHeader('content-type', 'application/json');
  return new ethers.JsonRpcProvider(req, config.chainId, { staticNetwork: true });
}

/**
 * Get a provider for a custom RPC URL (bring-your-own-RPC).
 * Used for contracts on chains not yet in the ChainRPC catalog.
 */
export function getCustomProvider(rpcUrl: string): ethers.JsonRpcProvider {
  if (!rpcUrl) throw new Error('Custom RPC URL is required');
  return new ethers.JsonRpcProvider(rpcUrl);
}

/** Fallback provider across all configured RPC URLs for a chain. */
export function getFallbackProvider(chain: string): ethers.FallbackProvider {
  const config = CHAINS[chain];
  if (!config) throw new Error(`Unsupported chain: ${chain}`);
  const urls = config.rpcUrls;
  const providers = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url),
    priority: i + 1,
    stallTimeout: 2000,
    weight: i === 0 ? 2 : 1,
  }));
  return new ethers.FallbackProvider(providers, undefined, { quorum: 1 });
}
