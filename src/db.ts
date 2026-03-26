// -- D1 helpers and write batching --

import type { Env, MonitorWithTier, BufferedCheck, CheckResult, Monitor, Incident, User } from './types';

// Fetch all active monitors with their owner's tier
export async function getActiveMonitors(db: D1Database): Promise<MonitorWithTier[]> {
  const { results } = await db
    .prepare(`
      SELECT m.*, u.tier
      FROM monitors m
      JOIN users u ON m.user_id = u.id
      WHERE m.is_active = 1
    `)
    .all<MonitorWithTier>();
  return results || [];
}

// Batch insert check results from the KV buffer into D1
export async function batchInsertChecks(db: D1Database, checks: BufferedCheck[]): Promise<void> {
  if (checks.length === 0) return;

  // D1 supports batch statements — use them
  const stmt = db.prepare(`
    INSERT INTO check_results (id, monitor_id, status, response_time_ms, status_code, error_message, checked_at)
    VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?)
  `);

  const batch = checks.map(c =>
    stmt.bind(c.monitor_id, c.status, c.response_time_ms, c.status_code, c.error_message, c.checked_at)
  );

  // D1 batch limit is 100 statements — chunk if needed
  for (let i = 0; i < batch.length; i += 100) {
    await db.batch(batch.slice(i, i + 100));
  }
}

// --- Incident management ---

export async function getOpenIncident(db: D1Database, monitorId: string): Promise<Incident | null> {
  const result = await db
    .prepare('SELECT * FROM incidents WHERE monitor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .bind(monitorId)
    .first<Incident>();
  return result;
}

export async function createIncident(db: D1Database, monitorId: string, cause: string): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, '');
  await db
    .prepare('INSERT INTO incidents (id, monitor_id, cause) VALUES (?, ?, ?)')
    .bind(id, monitorId, cause)
    .run();
  return id;
}

export async function resolveIncident(db: D1Database, incidentId: string): Promise<void> {
  await db
    .prepare("UPDATE incidents SET resolved_at = datetime('now') WHERE id = ?")
    .bind(incidentId)
    .run();
}

// --- User lookup and creation ---

export async function getUserById(db: D1Database, userId: string) {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string; tier: string }>();
}

export async function getUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<User>();
}

export async function createUser(db: D1Database, email: string, passwordHash: string): Promise<User> {
  const id = crypto.randomUUID().replace(/-/g, '');
  await db
    .prepare('INSERT INTO users (id, email, password_hash, tier) VALUES (?, ?, ?, ?)')
    .bind(id, email, passwordHash, 'free')
    .run();
  return (await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>())!;
}

// --- Billing / tier management ---

export async function updateUserTier(db: D1Database, userId: string, tier: string): Promise<void> {
  await db.prepare('UPDATE users SET tier = ? WHERE id = ?').bind(tier, userId).run();
}

export async function updateUserStripeCustomer(db: D1Database, userId: string, stripeCustomerId: string): Promise<void> {
  await db.prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?').bind(stripeCustomerId, userId).run();
}

export async function getUserByStripeCustomer(db: D1Database, stripeCustomerId: string): Promise<User | null> {
  return db.prepare('SELECT * FROM users WHERE stripe_customer_id = ?').bind(stripeCustomerId).first<User>();
}

export async function getMonitorCountByUser(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) as count FROM monitors WHERE user_id = ?').bind(userId).first<{ count: number }>();
  return row?.count ?? 0;
}

// --- Monitor CRUD ---

export async function getMonitorsByUser(db: D1Database, userId: string): Promise<Monitor[]> {
  const { results } = await db
    .prepare('SELECT * FROM monitors WHERE user_id = ? ORDER BY created_at DESC')
    .bind(userId)
    .all<Monitor>();
  return results || [];
}

export async function getMonitorById(db: D1Database, monitorId: string): Promise<Monitor | null> {
  return db.prepare('SELECT * FROM monitors WHERE id = ?').bind(monitorId).first<Monitor>();
}

export async function createMonitor(db: D1Database, data: {
  user_id: string;
  name: string;
  url: string;
  method?: string;
  expected_status?: number;
  timeout_ms?: number;
  interval_seconds?: number;
}): Promise<Monitor> {
  const id = crypto.randomUUID().replace(/-/g, '');
  await db
    .prepare(`
      INSERT INTO monitors (id, user_id, name, url, method, expected_status, timeout_ms, interval_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      id,
      data.user_id,
      data.name,
      data.url,
      data.method || 'GET',
      data.expected_status || 200,
      data.timeout_ms || 10000,
      data.interval_seconds || 300,
    )
    .run();

  return (await getMonitorById(db, id))!;
}

export async function updateMonitor(db: D1Database, monitorId: string, data: {
  name?: string;
  url?: string;
  method?: string;
  expected_status?: number;
  timeout_ms?: number;
  interval_seconds?: number;
  is_active?: number;
}): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) {
      fields.push(`${key} = ?`);
      values.push(val);
    }
  }
  if (fields.length === 0) return;
  values.push(monitorId);
  await db.prepare(`UPDATE monitors SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
}

export async function deleteMonitor(db: D1Database, monitorId: string): Promise<void> {
  await db.prepare('DELETE FROM monitors WHERE id = ?').bind(monitorId).run();
}

export async function getCheckHistory(db: D1Database, monitorId: string, limit = 50): Promise<CheckResult[]> {
  const { results } = await db
    .prepare('SELECT * FROM check_results WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?')
    .bind(monitorId, limit)
    .all<CheckResult>();
  return results || [];
}

// --- Status pages ---

export async function getStatusPageBySlug(db: D1Database, slug: string) {
  return db.prepare('SELECT * FROM status_pages WHERE slug = ? AND is_public = 1').bind(slug).first();
}
