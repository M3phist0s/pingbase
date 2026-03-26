// -- Stripe integration: raw fetch, no SDK, no dependencies --

import type { Env } from './types';

// Tier-to-price mapping resolved from env at runtime
function getPriceId(env: Env, plan: 'pro' | 'team', interval: 'monthly' | 'annual'): string {
  const map: Record<string, string> = {
    pro_monthly: env.STRIPE_PRO_MONTHLY_PRICE,
    pro_annual: env.STRIPE_PRO_ANNUAL_PRICE,
    team_monthly: env.STRIPE_TEAM_MONTHLY_PRICE,
    team_annual: env.STRIPE_TEAM_ANNUAL_PRICE,
  };
  return map[`${plan}_${interval}`];
}

// Reverse lookup: price ID -> tier name
function tierFromPriceId(env: Env, priceId: string): 'pro' | 'team' | null {
  if (priceId === env.STRIPE_PRO_MONTHLY_PRICE || priceId === env.STRIPE_PRO_ANNUAL_PRICE) return 'pro';
  if (priceId === env.STRIPE_TEAM_MONTHLY_PRICE || priceId === env.STRIPE_TEAM_ANNUAL_PRICE) return 'team';
  return null;
}

// --- Stripe API helpers ---

async function stripeRequest(env: Env, path: string, params: Record<string, string>): Promise<unknown> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Stripe API error ${res.status}: ${err}`);
  }
  return res.json();
}

export async function createCustomer(env: Env, email: string, userId: string): Promise<string> {
  const customer = (await stripeRequest(env, '/customers', {
    email,
    'metadata[user_id]': userId,
  })) as { id: string };
  return customer.id;
}

export async function createCheckoutSession(
  env: Env,
  userId: string,
  email: string,
  plan: 'pro' | 'team',
  interval: 'monthly' | 'annual',
  stripeCustomerId?: string | null,
): Promise<string> {
  const priceId = getPriceId(env, plan, interval);
  if (!priceId) throw new Error(`No price configured for ${plan}_${interval}`);

  const params: Record<string, string> = {
    'mode': 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': '1',
    'success_url': `${env.APP_URL}/billing?success=true`,
    'cancel_url': `${env.APP_URL}/billing?canceled=true`,
    'metadata[user_id]': userId,
  };

  if (stripeCustomerId) {
    params['customer'] = stripeCustomerId;
  } else {
    params['customer_email'] = email;
  }

  const session = (await stripeRequest(env, '/checkout/sessions', params)) as { url: string };
  return session.url;
}

export async function createBillingPortalSession(env: Env, stripeCustomerId: string): Promise<string> {
  const session = (await stripeRequest(env, '/billing_portal/sessions', {
    customer: stripeCustomerId,
    return_url: `${env.APP_URL}/billing`,
  })) as { url: string };
  return session.url;
}

// --- Webhook signature verification (Web Crypto API) ---

export async function constructWebhookEvent(
  rawBody: string,
  signatureHeader: string,
  webhookSecret: string,
): Promise<{ type: string; data: { object: Record<string, unknown> } }> {
  // Parse Stripe signature header: t=timestamp,v1=signature
  const parts: Record<string, string> = {};
  for (const pair of signatureHeader.split(',')) {
    const [key, value] = pair.split('=', 2);
    if (key && value) parts[key.trim()] = value.trim();
  }

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) {
    throw new Error('Invalid Stripe signature header');
  }

  // Reject events older than 5 minutes or with future timestamps (replay protection)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (age > 300 || age < -60) {
    throw new Error('Webhook timestamp out of range');
  }

  // Compute expected signature
  const payload = `${timestamp}.${rawBody}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(webhookSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const expectedBuf = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expectedHex = Array.from(new Uint8Array(expectedBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Timing-safe comparison
  if (!timingSafeEqual(expectedHex, signature)) {
    throw new Error('Webhook signature verification failed');
  }

  return JSON.parse(rawBody);
}

// Constant-time string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// --- Webhook event handler ---

export { tierFromPriceId };
