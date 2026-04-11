import { ethers } from 'ethers';

/**
 * Verify that a wallet owns or deployed a contract.
 * Used by the free tier to restrict extraction to contracts the user controls.
 */
export async function verifyOwnership(
  provider: ethers.JsonRpcProvider,
  contractAddress: string,
  walletAddress: string,
): Promise<{ isOwner: boolean; reason: string }> {

  // Check 1: Does the contract have owner() that returns this wallet?
  try {
    const contract = new ethers.Contract(contractAddress, [
      'function owner() view returns (address)',
    ], provider);
    const owner = await contract.owner();
    if (owner.toLowerCase() === walletAddress.toLowerCase()) {
      return { isOwner: true, reason: 'Contract owner() matches wallet' };
    }
  } catch {} // Contract may not have owner()

  // Check 2: Ownable pattern — check DEFAULT_ADMIN_ROLE (AccessControl)
  try {
    const contract = new ethers.Contract(contractAddress, [
      'function hasRole(bytes32 role, address account) view returns (bool)',
    ], provider);
    const DEFAULT_ADMIN = ethers.ZeroHash;
    const hasAdmin = await contract.hasRole(DEFAULT_ADMIN, walletAddress);
    if (hasAdmin) {
      return { isOwner: true, reason: 'Wallet has DEFAULT_ADMIN_ROLE' };
    }
  } catch {} // Contract may not have AccessControl

  // Check 3: Check if wallet deployed the contract via block explorer API
  try {
    const apiUrls: Record<number, string> = {
      1: 'https://api.etherscan.io/api',
      8453: 'https://api.basescan.org/api',
      10: 'https://api-optimistic.etherscan.io/api',
      42161: 'https://api.arbiscan.io/api',
      137: 'https://api.polygonscan.com/api',
    };
    const network = await provider.getNetwork();
    const chainId = Number(network.chainId);
    const apiUrl = apiUrls[chainId];
    if (apiUrl) {
      const url = `${apiUrl}?module=contract&action=getcontractcreation&contractaddresses=${contractAddress}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      const data = await resp.json();
      if (data.status === '1' && data.result?.length > 0) {
        const creator = data.result[0].contractCreator;
        if (creator && creator.toLowerCase() === walletAddress.toLowerCase()) {
          return { isOwner: true, reason: 'Wallet is the contract deployer' };
        }
      }
    }
  } catch {} // API may be unavailable or rate-limited

  // Check 4: EIP-1967 proxy admin slot
  try {
    const adminSlot = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
    const adminData = await provider.getStorage(contractAddress, adminSlot);
    if (adminData && adminData !== ethers.ZeroHash) {
      const admin = ethers.getAddress('0x' + adminData.slice(-40));
      if (admin.toLowerCase() === walletAddress.toLowerCase()) {
        return { isOwner: true, reason: 'Wallet is EIP-1967 proxy admin' };
      }
    }
  } catch {}

  return {
    isOwner: false,
    reason: 'Could not verify ownership. Use paid extraction for third-party contracts.',
  };
}
