import { MigrationJob } from './types';

/**
 * In-memory job store.
 * Production: replace with Redis or PostgreSQL for persistence.
 */
const jobs = new Map<string, MigrationJob>();

// Auto-cleanup: remove completed/failed jobs older than 24h
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const JOB_TTL = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if ((job.status === 'complete' || job.status === 'failed') && now - job.createdAt > JOB_TTL) {
      jobs.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

export function createJob(
  id: string,
  sourceChain: string,
  destChain: string,
  addresses: string[],
): MigrationJob {
  const job: MigrationJob = {
    id,
    sourceChain,
    destChain,
    addresses,
    status: 'pending',
    progress: 0,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

export function getJob(id: string): MigrationJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, updates: Partial<MigrationJob>): void {
  const job = jobs.get(id);
  if (job) {
    Object.assign(job, updates);
  }
}

export function listJobs(limit: number = 50): MigrationJob[] {
  const all = [...jobs.values()];
  all.sort((a, b) => b.createdAt - a.createdAt);
  return all.slice(0, limit);
}

export function deleteJob(id: string): boolean {
  return jobs.delete(id);
}
