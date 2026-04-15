import fs from 'fs';
import path from 'path';
import { MigrationJob, DeployedContract } from './types';

const EXPORT_DIR = process.env.EXPORT_DIR || './data/exports';
const FILE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Ensure export directory exists
fs.mkdirSync(EXPORT_DIR, { recursive: true });

// --- Cleanup: delete files older than TTL ---
const cleanupInterval = setInterval(() => {
  try {
    const files = fs.readdirSync(EXPORT_DIR);
    const now = Date.now();
    for (const file of files) {
      const filePath = path.join(EXPORT_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > FILE_TTL_MS) {
        fs.unlinkSync(filePath);
      }
    }
  } catch (_) { /* ignore cleanup errors */ }
}, 60_000); // Check every minute
cleanupInterval.unref();

// --- Format converters ---

interface ExportRow {
  originalAddress: string;
  newAddress: string;
  txHash: string;
  source?: string;
  sourceType?: string;
  contractName?: string;
  compiler?: string;
}

function jobToRows(job: MigrationJob): ExportRow[] {
  if (!job.result?.deployedContracts?.length) return [];
  return job.result.deployedContracts.map((c: DeployedContract) => ({
    originalAddress: c.originalAddress,
    newAddress: c.newAddress,
    txHash: c.txHash,
    source: (c as any).source,
    sourceType: (c as any).sourceType,
    contractName: (c as any).contractName,
    compiler: (c as any).compiler,
  }));
}

export function toJSON(job: MigrationJob): string {
  return JSON.stringify({
    id: job.id,
    sourceChain: job.sourceChain,
    destChain: job.destChain,
    status: job.status,
    contractsMigrated: job.result?.contractsMigrated || 0,
    contracts: jobToRows(job).map(r => ({
      ...r,
      source: r.source || null,
      sourceType: r.sourceType || null,
      contractName: r.contractName || null,
      compiler: r.compiler || null,
    })),
    genesisAlloc: job.result?.genesisAlloc || null,
    totalGasUsed: job.result?.totalGasUsed || null,
    createdAt: new Date(job.createdAt).toISOString(),
  }, null, 2);
}

export function toCSV(job: MigrationJob): string {
  const rows = jobToRows(job);
  const header = 'originalAddress,newAddress,txHash,sourceType,contractName,compiler';
  const lines = rows.map(r => {
    // CSV-escape source fields (contract names and compilers may contain commas)
    const name = r.contractName ? `"${r.contractName.replace(/"/g, '""')}"` : '';
    const comp = r.compiler ? `"${r.compiler.replace(/"/g, '""')}"` : '';
    return `${r.originalAddress},${r.newAddress},${r.txHash},${r.sourceType || ''},${name},${comp}`;
  });
  // Note: Full source code is omitted from CSV due to length. Use JSON or XML for full source.
  return ['# Source code omitted from CSV — use JSON or XML export for full source', header, ...lines].join('\n');
}

export function toXML(job: MigrationJob): string {
  const rows = jobToRows(job);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<migration id="${job.id}" sourceChain="${job.sourceChain}" destChain="${job.destChain}">\n`;
  xml += `  <status>${job.status}</status>\n`;
  xml += `  <contractsMigrated>${job.result?.contractsMigrated || 0}</contractsMigrated>\n`;
  xml += '  <contracts>\n';
  for (const r of rows) {
    xml += `    <contract>\n`;
    xml += `      <originalAddress>${r.originalAddress}</originalAddress>\n`;
    xml += `      <newAddress>${r.newAddress}</newAddress>\n`;
    xml += `      <txHash>${r.txHash}</txHash>\n`;
    if (r.sourceType) xml += `      <sourceType>${r.sourceType}</sourceType>\n`;
    if (r.contractName) xml += `      <contractName>${escapeXml(r.contractName)}</contractName>\n`;
    if (r.compiler) xml += `      <compiler>${escapeXml(r.compiler)}</compiler>\n`;
    if (r.source) xml += `      <source><![CDATA[${r.source}]]></source>\n`;
    xml += `    </contract>\n`;
  }
  xml += '  </contracts>\n';
  xml += '</migration>\n';
  return xml;
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function writeExportFile(job: MigrationJob, format: 'json' | 'csv' | 'xml'): string {
  let content: string;
  let ext: string;
  let contentType: string;

  switch (format) {
    case 'csv':
      content = toCSV(job);
      ext = 'csv';
      contentType = 'text/csv';
      break;
    case 'xml':
      content = toXML(job);
      ext = 'xml';
      contentType = 'application/xml';
      break;
    default:
      content = toJSON(job);
      ext = 'json';
      contentType = 'application/json';
      break;
  }

  const filename = `${job.id}.${ext}`;
  const filePath = path.resolve(EXPORT_DIR, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

export function getExportFilePath(jobId: string, format: string): string | null {
  const filename = `${jobId}.${format}`;
  const filePath = path.resolve(EXPORT_DIR, filename);
  if (fs.existsSync(filePath)) return filePath;
  return null;
}

export const CONTENT_TYPES: Record<string, string> = {
  json: 'application/json',
  csv: 'text/csv',
  xml: 'application/xml',
};
