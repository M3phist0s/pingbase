// -- Monitoring engine: the core of PingBase --

import type { Env, MonitorWithTier, CheckStatus, MonitorStatus, BufferedCheck } from './types';
import { getCachedMonitors, setCachedMonitors, getMonitorStatus, setMonitorStatus, bufferCheckResult } from './kv';
import { getActiveMonitors, getOpenIncident, createIncident, resolveIncident } from './db';
import { processStatusChange } from './alerts';

// Confirmed-down threshold: 2 consecutive failures
const CONFIRMED_DOWN_THRESHOLD = 2;

// Degraded threshold: response time > 5 seconds
const DEGRADED_THRESHOLD_MS = 5000;

// Run all monitoring checks for this cron tick
export async function runChecks(env: Env): Promise<void> {
  // Get monitor list (cached in KV, refreshed every 5 min)
  let monitors = await getCachedMonitors(env);
  if (!monitors) {
    monitors = await getActiveMonitors(env.DB);
    await setCachedMonitors(env, monitors);
  }

  if (monitors.length === 0) return;

  const now = new Date();
  const currentMinute = now.getMinutes();

  // Filter monitors that should run this tick
  // Free tier: every 5 min (interval_seconds = 300)
  // Pro/Team: every 1 min (interval_seconds = 60)
  const monitorsToCheck = monitors.filter(m => {
    const intervalMinutes = Math.max(1, Math.floor(m.interval_seconds / 60));
    return currentMinute % intervalMinutes === 0;
  });

  // Run checks in parallel, but cap concurrency to avoid hitting subrequest limits
  // Workers allow 50 subrequests per invocation — be conservative
  const BATCH_SIZE = 40;
  for (let i = 0; i < monitorsToCheck.length; i += BATCH_SIZE) {
    const batch = monitorsToCheck.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(m => checkMonitor(env, m)));
  }
}

// Flush the KV write buffer to D1
// Called on a separate schedule or when buffer is large enough
export async function flushCheckBuffer(env: Env): Promise<void> {
  const { flushBuffer, confirmFlush } = await import('./kv');
  const { batchInsertChecks } = await import('./db');

  const checks = await flushBuffer(env);
  if (checks.length > 0) {
    // Write to D1 first, then delete from KV buffer
    await batchInsertChecks(env.DB, checks);
    await confirmFlush(env);
    console.log(`[flush] Wrote ${checks.length} check results to D1`);
  }
}

// Check a single monitor
async function checkMonitor(env: Env, monitor: MonitorWithTier): Promise<void> {
  const startTime = Date.now();
  let status: CheckStatus = 'up';
  let statusCode: number | null = null;
  let errorMessage: string | null = null;
  let responseTime: number | null = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), monitor.timeout_ms);

    const response = await fetch(monitor.url, {
      method: monitor.method,
      signal: controller.signal,
      headers: {
        'User-Agent': 'PingBase/1.0 (uptime monitor)',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);
    responseTime = Date.now() - startTime;
    statusCode = response.status;

    if (statusCode !== monitor.expected_status) {
      status = 'down';
      errorMessage = `Expected status ${monitor.expected_status}, got ${statusCode}`;
    } else if (responseTime > DEGRADED_THRESHOLD_MS) {
      status = 'degraded';
    }
  } catch (err: unknown) {
    responseTime = Date.now() - startTime;
    status = 'down';
    errorMessage = err instanceof Error ? err.message : 'Unknown error';

    if (errorMessage.includes('abort')) {
      errorMessage = `Timeout after ${monitor.timeout_ms}ms`;
    }
  }

  // Get previous status for confirmed-down logic
  const prevStatus = await getMonitorStatus(env, monitor.id);
  const prevFailures = prevStatus?.consecutive_failures || 0;

  let confirmedStatus = status;
  let consecutiveFailures = 0;

  if (status === 'down') {
    consecutiveFailures = prevFailures + 1;
    // Only mark as confirmed down after threshold
    if (consecutiveFailures < CONFIRMED_DOWN_THRESHOLD) {
      // Not yet confirmed — record as the previous known status or 'up'
      confirmedStatus = prevStatus?.status === 'down' ? 'down' : (prevStatus?.status || 'up');
    }
  }
  // If status is up or degraded, reset failure count
  // confirmedStatus stays as-is

  const checkedAt = new Date().toISOString();

  // Update KV with current status (real-time dashboard reads)
  const newMonitorStatus: MonitorStatus = {
    status: confirmedStatus,
    response_time_ms: responseTime,
    status_code: statusCode,
    last_checked: checkedAt,
    consecutive_failures: consecutiveFailures,
  };
  await setMonitorStatus(env, monitor.id, newMonitorStatus);

  // Buffer the check result for batch D1 write
  const bufferedCheck: BufferedCheck = {
    monitor_id: monitor.id,
    status: confirmedStatus,
    response_time_ms: responseTime,
    status_code: statusCode,
    error_message: errorMessage,
    checked_at: checkedAt,
  };
  await bufferCheckResult(env, bufferedCheck);

  // Handle status transitions for alerting and incidents
  const oldStatus = prevStatus?.status || null;
  const statusChanged = oldStatus !== confirmedStatus;

  if (statusChanged) {
    // Incident management
    if (confirmedStatus === 'down') {
      const existingIncident = await getOpenIncident(env.DB, monitor.id);
      if (!existingIncident) {
        await createIncident(env.DB, monitor.id, errorMessage || 'Monitor is down');
      }
    } else if (confirmedStatus === 'up' && oldStatus === 'down') {
      const incident = await getOpenIncident(env.DB, monitor.id);
      if (incident) {
        await resolveIncident(env.DB, incident.id);
      }
    }

    // Alert pipeline
    await processStatusChange(env, monitor.id, monitor.name, monitor.url, oldStatus, confirmedStatus);
  }
}
