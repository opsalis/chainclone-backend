export interface SourceResult {
  source: string;
  sourceType: 'verified' | 'decompiled' | 'bytecode-only';
  compiler?: string;
  contractName?: string;
  license?: string;
}

// Etherscan-compatible API URLs by chain ID
const EXPLORER_API_URLS: Record<number, string> = {
  1: 'https://api.etherscan.io/api',
  8453: 'https://api.basescan.org/api',
  10: 'https://api-optimistic.etherscan.io/api',
  42161: 'https://api.arbiscan.io/api',
  137: 'https://api.polygonscan.com/api',
  43114: 'https://api.snowtrace.io/api',
  56: 'https://api.bscscan.com/api',
  84532: 'https://api-sepolia.basescan.org/api',
  11155111: 'https://api-sepolia.etherscan.io/api',
};

/**
 * Strategy 1: Try Etherscan API for verified source code.
 * Uses free tier (no API key needed for basic calls, rate limited at ~5/sec).
 */
async function fetchVerifiedSource(address: string, chainId: number): Promise<SourceResult | null> {
  const baseUrl = EXPLORER_API_URLS[chainId];
  if (!baseUrl) return null;

  try {
    const url = `${baseUrl}?module=contract&action=getsourcecode&address=${address}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const data: any = await resp.json();

    if (data.status === '1' && data.result?.[0]?.SourceCode) {
      const result = data.result[0];
      if (result.SourceCode && result.SourceCode !== '') {
        return {
          source: result.SourceCode,
          sourceType: 'verified',
          compiler: result.CompilerVersion || undefined,
          contractName: result.ContractName || undefined,
          license: result.LicenseType || undefined,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract 4-byte function selectors from EVM bytecode.
 * Looks for PUSH4 opcodes (0x63) followed by 4 bytes used in selector comparisons.
 */
function extractFunctionSelectors(bytecode: string): Array<{ selector: string; name?: string }> {
  const selectors: Array<{ selector: string; name?: string }> = [];
  const hex = bytecode.replace('0x', '');

  // PUSH4 = 0x63, followed by 4 bytes of selector, then typically EQ (0x14) nearby
  for (let i = 0; i < hex.length - 10; i += 2) {
    if (hex.substring(i, i + 2) === '63') {
      const selector = hex.substring(i + 2, i + 10);
      // Verify it looks like a selector comparison (EQ opcode nearby)
      const nearby = hex.substring(i, Math.min(i + 20, hex.length));
      if (nearby.includes('14')) {
        selectors.push({ selector });
      }
    }
  }

  // Deduplicate
  const unique = [...new Map(selectors.map((s) => [s.selector, s])).values()];
  return unique;
}

/**
 * Strategy 3: Resolve function selectors via 4byte.directory API.
 * Public API with millions of known function signatures.
 */
async function resolveSelectors(selectors: Array<{ selector: string; name?: string }>): Promise<void> {
  // Resolve in parallel with a concurrency limit to avoid hammering the API
  const BATCH_SIZE = 5;
  for (let i = 0; i < selectors.length; i += BATCH_SIZE) {
    const batch = selectors.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (sel) => {
        try {
          const resp = await fetch(
            `https://www.4byte.directory/api/v1/signatures/?hex_signature=0x${sel.selector}&format=json`,
            { signal: AbortSignal.timeout(5_000) },
          );
          const data: any = await resp.json();
          if (data.results?.length > 0) {
            sel.name = data.results[0].text_signature;
          }
        } catch {
          // 4byte.directory might be slow or rate limited — skip
        }
      }),
    );
  }
}

/**
 * Strategy 2: Decompile bytecode using heuristic analysis.
 * Generates pseudo-Solidity from function selectors.
 * This is an approximation — variable names and comments are not recoverable from bytecode.
 */
function decompileBytecode(bytecode: string, selectors: Array<{ selector: string; name?: string }>): SourceResult {
  const byteLen = Math.floor((bytecode.replace('0x', '').length) / 2);

  let source = '// Decompiled by ChainClone\n';
  source += `// Original bytecode: ${byteLen} bytes\n`;
  source += '// WARNING: Variable names and comments are not recoverable from bytecode.\n';
  source += '// This is an approximation of the original source code.\n\n';
  source += 'pragma solidity ^0.8.0;\n\n';
  source += 'contract DecompiledContract {\n\n';

  for (const sel of selectors) {
    source += `    // Function selector: 0x${sel.selector}\n`;
    if (sel.name) {
      source += `    // Known signature: ${sel.name}\n`;
      // Extract just the function name (before the parentheses) for the declaration
      const funcName = sel.name.includes('(') ? sel.name : `${sel.name}()`;
      source += `    function ${funcName} external {\n`;
      source += `        // Decompiled bytecode implementation\n`;
      source += `        // [bytecode analysis required for full decompilation]\n`;
      source += `    }\n\n`;
    } else {
      source += `    function unknown_${sel.selector}() external {\n`;
      source += `        // Unknown function\n`;
      source += `    }\n\n`;
    }
  }

  source += '}\n';

  return {
    source,
    sourceType: 'decompiled',
  };
}

/**
 * Main entry point: get the best source code available for a contract.
 *
 * Tries in order:
 *   1. Etherscan verified source (best quality — original Solidity with comments)
 *   2. Bytecode decompilation with 4byte selector resolution (pseudo-Solidity approximation)
 *   3. Raw bytecode only (always available)
 */
export async function getContractSource(
  address: string,
  bytecode: string,
  chainId: number,
): Promise<SourceResult> {
  // Strategy 1: Try verified source first (best quality)
  const verified = await fetchVerifiedSource(address, chainId);
  if (verified) return verified;

  // Strategy 2: Decompile bytecode (medium quality)
  if (bytecode && bytecode !== '0x' && bytecode.length > 4) {
    const selectors = extractFunctionSelectors(bytecode);

    // Try to resolve function names via 4byte.directory
    if (selectors.length > 0) {
      await resolveSelectors(selectors);
    }

    return decompileBytecode(bytecode, selectors);
  }

  // Strategy 3: Bytecode only (fallback)
  return {
    source: `// No source available\n// Bytecode: ${bytecode?.substring(0, 100)}${bytecode && bytecode.length > 100 ? '...' : ''}`,
    sourceType: 'bytecode-only',
  };
}
