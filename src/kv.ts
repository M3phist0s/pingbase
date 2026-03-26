// -- KV helpers: caching and buffering --

import type { Env, MonitorStatus, MonitorWithTier, BufferedCheck } from './types';

const MONITOR_LIST_KEY = 'monitors:active';
const MONITOR_LIST_TTL = 300; // 5 minutes

// --- Monitor list cache ---

export async function getCachedMonitors(env: Env): Promise<MonitorWithTier[] | null> {
  const cached = await env.STATUS_KV.get(MONITOR_LIST_KEY, 'json');
  return cached as MonitorWithTier[] | null;
}

export async function setCachedMonitors(env: Env, monitors: MonitorWithTier[]): Promise<void> {
  await env.STATUS_KV.put(MONITOR_LIST_KEY, JSON.stringify(monitors), {
    expirationTtl: MONITOR_LIST_TTL,
  });
}

// --- Monitor status (hot path for dashboard reads) ---

function statusKey(monitorId: string): string {
  return `status:${monitorId}`;
}

export async function getMonitorStatus(env: Env, monitorId: string): Promise<MonitorStatus | null> {
  return env.STATUS_KV.get(statusKey(monitorId), 'json');
}

export async function setMonitorStatus(env: Env, monitorId: string, status: MonitorStatus): Promise<void> {
  // TTL of 10 minutes — if cron stops, status goes stale rather than lying
  await env.STATUS_KV.put(statusKey(monitorId), JSON.stringify(status), {
    expirationTtl: 600,
  });
}

// --- Write buffer: accumulate check results, flush to D1 in batches ---
// Uses KV list() instead of a shared index key to avoid race conditions.
// Each check is stored as its own key with a common prefix.

const BUFFER_PREFIX = 'buffer:check:';

export async function bufferCheckResult(env: Env, check: BufferedCheck): Promise<void> {
  // Use a unique key per check — no shared index to race on
  const key = `${BUFFER_PREFIX}${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
  await env.BUFFER_KV.put(key, JSON.stringify(check), { expirationTtl: 300 });
}

export async function flushBuffer(env: Env): Promise<BufferedCheck[]> {
  // List all buffered keys by prefix — no shared index needed
  const listed = await env.BUFFER_KV.list({ prefix: BUFFER_PREFIX });
  if (listed.keys.length === 0) return [];

  // Read all buffered checks
  const checks: BufferedCheck[] = [];
  const keysToDelete: string[] = [];
  for (const { name } of listed.keys) {
    const check = await env.BUFFER_KV.get(name, 'json') as BufferedCheck | null;
    if (check) checks.push(check);
    keysToDelete.push(name);
  }

  // Return checks first — caller writes to D1, THEN calls confirmFlush to delete
  return checks;
}

export async function confirmFlush(env: Env, keys?: string[]): Promise<void> {
  // Delete buffer keys only after D1 write succeeds
  const listed = keys
    ? keys.map(k => ({ name: k }))
    : (await env.BUFFER_KV.list({ prefix: BUFFER_PREFIX })).keys;
  for (const { name } of listed) {
    await env.BUFFER_KV.delete(name);
  }
}
