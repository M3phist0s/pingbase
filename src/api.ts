// -- REST API route handlers --

import type { Env, Monitor, Tier } from './types';
import * as db from './db';
import { getMonitorStatus } from './kv';
import { generateJWT, verifyJWT, hashPassword, verifyPassword, extractBearerToken } from './auth';
import { createCheckoutSession, createBillingPortalSession, constructWebhookEvent, tierFromPriceId } from './stripe';

type Handler = (request: Request, env: Env, params: Record<string, string>) => Promise<Response>;

// Simple router — no framework needed
interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler) {
  // Convert "/api/monitors/:id" to a regex with named groups
  const paramNames: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
}

// --- Auth routes ---

route('POST', '/api/auth/signup', async (req, env) => {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const email = (body.email as string || '').trim().toLowerCase();
  const password = body.password as string || '';

  if (!email || !password) {
    return json({ error: 'email and password are required' }, 400);
  }

  // Basic email format check
  if (!email.includes('@') || !email.includes('.')) {
    return json({ error: 'Invalid email address' }, 400);
  }

  if (password.length < 8) {
    return json({ error: 'Password must be at least 8 characters' }, 400);
  }

  // Check for existing user
  const existing = await db.getUserByEmail(env.DB, email);
  if (existing) {
    return json({ error: 'An account with this email already exists' }, 409);
  }

  const passwordHash = await hashPassword(password);
  const user = await db.createUser(env.DB, email, passwordHash);
  const token = await generateJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);

  return json({ token, user: { id: user.id, email: user.email, tier: user.tier } }, 201);
});

route('POST', '/api/auth/login', async (req, env) => {
  let body: Record<string, unknown>;
  try { body = await req.json() as Record<string, unknown>; } catch { return json({ error: 'Invalid JSON body' }, 400); }
  const email = (body.email as string || '').trim().toLowerCase();
  const password = body.password as string || '';

  if (!email || !password) {
    return json({ error: 'email and password are required' }, 400);
  }

  const user = await db.getUserByEmail(env.DB, email);
  if (!user) {
    return json({ error: 'Invalid email or password' }, 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return json({ error: 'Invalid email or password' }, 401);
  }

  const token = await generateJWT({ sub: user.id, email: user.email }, env.JWT_SECRET);

  return json({ token, user: { id: user.id, email: user.email, tier: user.tier } });
});

route('GET', '/api/auth/me', async (req, env) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const user = await db.getUserById(env.DB, userId);
  if (!user) return json({ error: 'User not found' }, 404);

  return json({ id: user.id, email: user.email, tier: user.tier });
});

// --- Monitor routes ---

route('POST', '/api/monitors', async (req, env) => {
  const body = await req.json() as Record<string, unknown>;
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  if (!body.name || !body.url) {
    return json({ error: 'name and url are required' }, 400);
  }

  // URL validation: only allow http/https, no internal IPs
  const urlStr = body.url as string;
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return json({ error: 'Invalid URL' }, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return json({ error: 'Only http and https URLs are allowed' }, 400);
  }
  const host = parsed.hostname;
  if (isPrivateHost(host)) {
    return json({ error: 'Internal/private URLs are not allowed' }, 400);
  }

  // Tier enforcement: check monitor count limits
  const user = await db.getUserById(env.DB, userId);
  if (!user) return json({ error: 'User not found' }, 404);

  const tierLimits: Record<string, { monitors: number; minInterval: number }> = {
    free: { monitors: 3, minInterval: 300 },
    pro: { monitors: 20, minInterval: 60 },
    team: { monitors: 50, minInterval: 60 },
  };
  const limits = tierLimits[user.tier] || tierLimits.free;
  const existing = await db.getMonitorsByUser(env.DB, userId);
  if (existing.length >= limits.monitors) {
    return json({ error: `${user.tier} tier allows max ${limits.monitors} monitors. Upgrade to add more.` }, 403);
  }

  // Enforce minimum interval for tier
  const requestedInterval = (body.interval_seconds as number) || 300;
  const interval = Math.max(requestedInterval, limits.minInterval);

  const monitor = await db.createMonitor(env.DB, {
    user_id: userId,
    name: body.name as string,
    url: urlStr,
    method: (body.method as string) || undefined,
    expected_status: body.expected_status as number | undefined,
    timeout_ms: body.timeout_ms as number | undefined,
    interval_seconds: interval,
  });

  return json(monitor, 201);
});

route('GET', '/api/monitors', async (req, env) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const monitors = await db.getMonitorsByUser(env.DB, userId);

  // Enrich with current status from KV
  const enriched = await Promise.all(
    monitors.map(async (m) => {
      const status = await getMonitorStatus(env, m.id);
      return { ...m, current_status: status };
    })
  );

  return json(enriched);
});

route('GET', '/api/monitors/:id', async (req, env, params) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const monitor = await db.getMonitorById(env.DB, params.id);
  if (!monitor || monitor.user_id !== userId) {
    return json({ error: 'Not found' }, 404);
  }

  const [status, recentChecks] = await Promise.all([
    getMonitorStatus(env, params.id),
    db.getCheckHistory(env.DB, params.id, 20),
  ]);

  return json({ ...monitor, current_status: status, recent_checks: recentChecks });
});

route('PATCH', '/api/monitors/:id', async (req, env, params) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const monitor = await db.getMonitorById(env.DB, params.id);
  if (!monitor || monitor.user_id !== userId) {
    return json({ error: 'Not found' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  // Validate URL if being changed
  if (body.url) {
    const urlStr = body.url as string;
    let parsed: URL;
    try { parsed = new URL(urlStr); } catch { return json({ error: 'Invalid URL' }, 400); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return json({ error: 'Only http and https URLs are allowed' }, 400);
    }
    if (isPrivateHost(parsed.hostname)) {
      return json({ error: 'Internal/private URLs are not allowed' }, 400);
    }
  }

  // Enforce tier interval limits if interval is being changed
  const updates: Record<string, unknown> = {
    name: body.name as string | undefined,
    url: body.url as string | undefined,
    method: body.method as string | undefined,
    expected_status: body.expected_status as number | undefined,
    timeout_ms: body.timeout_ms as number | undefined,
    interval_seconds: body.interval_seconds as number | undefined,
    is_active: body.is_active as number | undefined,
  };
  if (updates.interval_seconds !== undefined) {
    const user = await db.getUserById(env.DB, userId);
    const tierLimits: Record<string, number> = { free: 300, pro: 60, team: 60 };
    const minInterval = tierLimits[user?.tier || 'free'] ?? 300;
    updates.interval_seconds = Math.max(updates.interval_seconds as number, minInterval);
  }

  await db.updateMonitor(env.DB, params.id, updates as Parameters<typeof db.updateMonitor>[2]);
  const updated = await db.getMonitorById(env.DB, params.id);
  return json(updated);
});

route('DELETE', '/api/monitors/:id', async (req, env, params) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const monitor = await db.getMonitorById(env.DB, params.id);
  if (!monitor || monitor.user_id !== userId) {
    return json({ error: 'Not found' }, 404);
  }

  await db.deleteMonitor(env.DB, params.id);
  return json({ ok: true });
});

route('GET', '/api/monitors/:id/checks', async (req, env, params) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const monitor = await db.getMonitorById(env.DB, params.id);
  if (!monitor || monitor.user_id !== userId) {
    return json({ error: 'Not found' }, 404);
  }

  const url = new URL(req.url);
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const checks = await db.getCheckHistory(env.DB, params.id, Math.min(limit, 200));

  return json(checks);
});

route('GET', '/api/status/:slug', async (_req, env, params) => {
  const page = await db.getStatusPageBySlug(env.DB, params.slug);
  if (!page) return json({ error: 'Not found' }, 404);

  // Get current status for all monitors on this page
  const monitorIds: string[] = JSON.parse((page as Record<string, unknown>).monitors as string || '[]');

  const monitorStatuses = await Promise.all(
    monitorIds.map(async (id) => {
      const [monitor, status] = await Promise.all([
        db.getMonitorById(env.DB, id),
        getMonitorStatus(env, id),
      ]);
      if (!monitor) return null;
      return {
        id: monitor.id,
        name: monitor.name,
        url: monitor.url,
        current_status: status,
      };
    })
  );

  return json({
    name: (page as Record<string, unknown>).name,
    slug: (page as Record<string, unknown>).slug,
    monitors: monitorStatuses.filter(Boolean),
  });
});

// --- Billing routes ---

const TIER_LIMITS: Record<string, number> = { free: 3, pro: 20, team: 50 };

route('POST', '/api/billing/checkout', async (req, env) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const body = await req.json() as { plan?: string; interval?: string };
  const plan = body.plan;
  const interval = body.interval || 'monthly';

  if (plan !== 'pro' && plan !== 'team') {
    return json({ error: 'plan must be pro or team' }, 400);
  }
  if (interval !== 'monthly' && interval !== 'annual') {
    return json({ error: 'interval must be monthly or annual' }, 400);
  }

  const user = await db.getUserById(env.DB, userId);
  if (!user) return json({ error: 'User not found' }, 404);

  try {
    const url = await createCheckoutSession(env, userId, user.email, plan, interval, (user as Record<string, unknown>).stripe_customer_id as string | null);
    return json({ url });
  } catch (e) {
    return json({ error: `Checkout failed: ${(e as Error).message}` }, 500);
  }
});

route('POST', '/api/billing/portal', async (req, env) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const user = await db.getUserById(env.DB, userId);
  if (!user) return json({ error: 'User not found' }, 404);

  const stripeCustomerId = (user as Record<string, unknown>).stripe_customer_id as string | null;
  if (!stripeCustomerId) {
    return json({ error: 'No billing account. Subscribe to a plan first.' }, 400);
  }

  try {
    const url = await createBillingPortalSession(env, stripeCustomerId);
    return json({ url });
  } catch (e) {
    return json({ error: `Portal failed: ${(e as Error).message}` }, 500);
  }
});

route('POST', '/api/webhooks/stripe', async (req, env) => {
  // No auth — verified by Stripe webhook signature
  const signature = req.headers.get('stripe-signature');
  if (!signature) return json({ error: 'Missing signature' }, 400);

  const rawBody = await req.text();
  let event: { type: string; data: { object: Record<string, unknown> } };

  try {
    event = await constructWebhookEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return json({ error: `Webhook verification failed: ${(e as Error).message}` }, 400);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = (session.metadata as Record<string, string>)?.user_id;
        const customerId = session.customer as string;

        if (userId && customerId) {
          // Look up the subscription to find the price and determine the tier
          await db.updateUserStripeCustomer(env.DB, userId, customerId);

          // Determine tier from the subscription's price
          const subId = session.subscription as string;
          if (subId) {
            const tier = await getTierFromSubscription(env, subId);
            if (tier) {
              await db.updateUserTier(env.DB, userId, tier);
            }
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const customerId = sub.customer as string;
        const items = sub.items as { data: Array<{ price: { id: string } }> } | undefined;
        const priceId = items?.data?.[0]?.price?.id;

        if (customerId && priceId) {
          const user = await db.getUserByStripeCustomer(env.DB, customerId);
          const tier = tierFromPriceId(env, priceId);
          if (user && tier) {
            await db.updateUserTier(env.DB, user.id, tier);
          }
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer as string;
        if (customerId) {
          const user = await db.getUserByStripeCustomer(env.DB, customerId);
          if (user) {
            await db.updateUserTier(env.DB, user.id, 'free');
          }
        }
        break;
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', (e as Error).message);
    return json({ error: 'Webhook processing failed' }, 500);
  }

  // Always return 200 for Stripe, even for unhandled event types
  return json({ received: true });
});

route('GET', '/api/billing/status', async (req, env) => {
  const userId = await getUserId(req, env);
  if (!userId) return json({ error: 'Unauthorized' }, 401);

  const user = await db.getUserById(env.DB, userId);
  if (!user) return json({ error: 'User not found' }, 404);

  const monitorCount = await db.getMonitorCountByUser(env.DB, userId);
  const tier = user.tier as Tier;
  const limit = TIER_LIMITS[tier] ?? TIER_LIMITS.free;

  return json({
    tier,
    monitors_used: monitorCount,
    monitors_limit: limit,
    has_billing: !!(user as Record<string, unknown>).stripe_customer_id,
  });
});

// Helper: fetch subscription from Stripe to determine tier from price
async function getTierFromSubscription(env: Env, subscriptionId: string): Promise<Tier | null> {
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) return null;
  const sub = (await res.json()) as { items: { data: Array<{ price: { id: string } }> } };
  const priceId = sub.items?.data?.[0]?.price?.id;
  if (!priceId) return null;
  return tierFromPriceId(env, priceId);
}

// --- Router ---

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // CORS headers for dashboard frontend
  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = path.match(r.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    r.paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });

    const response = await r.handler(request, env, params);
    // Add CORS headers to all responses
    for (const [k, v] of Object.entries(corsHeaders())) {
      response.headers.set(k, v);
    }
    return response;
  }

  return json({ error: 'Not found' }, 404);
}

// --- Helpers ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// SSRF prevention: block private/internal hosts
function isPrivateHost(host: string): boolean {
  // Strip IPv6 brackets
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' ||
      h === '::1' || h === '::' || h === '[::1]') return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;
  if (h.startsWith('169.254.')) return true; // Link-local / cloud metadata
  // 172.16.0.0 – 172.31.255.255
  if (h.startsWith('172.')) {
    const second = parseInt(h.split('.')[1], 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (h.endsWith('.local') || h.endsWith('.internal')) return true;
  return false;
}

// Authenticate request via JWT Bearer token
async function getUserId(req: Request, env: Env): Promise<string | null> {
  const token = extractBearerToken(req);
  if (!token) return null;
  const payload = await verifyJWT(token, env.JWT_SECRET);
  return payload ? payload.sub : null;
}
