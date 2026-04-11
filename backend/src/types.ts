export interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrls: string[];
  rpcaasUrl?: string;
  explorerUrl: string;
  nativeCurrency: string;
}

export interface ContractState {
  address: string;
  bytecode: string;
  balance: bigint;
  nonce: number;
  storageSlots: Map<string, string>;
  isContract: boolean;
}

export interface DeployedContract {
  originalAddress: string;
  newAddress: string;
  txHash: string;
}

export interface MigrationJob {
  id: string;
  sourceChain: string;
  destChain: string;
  addresses: string[];
  status: 'pending' | 'reading' | 'writing' | 'complete' | 'failed';
  progress: number;
  result?: MigrationResult;
  error?: string;
  createdAt: number;
}

export interface MigrationResult {
  sourceChain: string;
  destChain: string;
  contractsMigrated: number;
  genesisAlloc?: Record<string, any>;
  deployedContracts?: DeployedContract[];
  totalGasUsed?: string;
}

export interface PriceEstimate {
  destChain: string;
  contractCount: number;
  pricePerContract: number;
  discount: string;
  totalUSDC: number;
  message: string;
}
