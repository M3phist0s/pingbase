// -- Shared types for PingBase --

export interface Env {
  DB: D1Database;
  STATUS_KV: KVNamespace;
  BUFFER_KV: KVNamespace;
  ALERT_EMAIL_FROM: string;
  RESEND_API_KEY: string;
  JWT_SECRET: string;
  // Stripe billing
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRO_MONTHLY_PRICE: string;
  STRIPE_PRO_ANNUAL_PRICE: string;
  STRIPE_TEAM_MONTHLY_PRICE: string;
  STRIPE_TEAM_ANNUAL_PRICE: string;
  APP_URL: string;
}

export type Tier = 'free' | 'pro' | 'team';
export type MonitorMethod = 'GET' | 'HEAD';
export type CheckStatus = 'up' | 'down' | 'degraded';
export type AlertChannel = 'email' | 'slack' | 'discord' | 'webhook';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  tier: Tier;
  stripe_customer_id: string | null;
  created_at: string;
}

export interface Monitor {
  id: string;
  user_id: string;
  name: string;
  url: string;
  method: MonitorMethod;
  expected_status: number;
  timeout_ms: number;
  interval_seconds: number;
  is_active: number;
  created_at: string;
}

// Monitor joined with user tier for scheduling decisions
export interface MonitorWithTier extends Monitor {
  tier: Tier;
}

export interface CheckResult {
  id: string;
  monitor_id: string;
  status: CheckStatus;
  response_time_ms: number | null;
  status_code: number | null;
  error_message: string | null;
  checked_at: string;
}

export interface Incident {
  id: string;
  monitor_id: string;
  started_at: string;
  resolved_at: string | null;
  cause: string | null;
}

export interface StatusPage {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  custom_domain: string | null;
  monitors: string; // JSON array of monitor IDs
  is_public: number;
  created_at: string;
}

export interface AlertConfig {
  id: string;
  user_id: string;
  monitor_id: string;
  channel: AlertChannel;
  target: string;
  is_active: number;
}

// KV-stored current status for a monitor
export interface MonitorStatus {
  status: CheckStatus;
  response_time_ms: number | null;
  status_code: number | null;
  last_checked: string;
  consecutive_failures: number;
}

// Buffered check result waiting to be flushed to D1
export interface BufferedCheck {
  monitor_id: string;
  status: CheckStatus;
  response_time_ms: number | null;
  status_code: number | null;
  error_message: string | null;
  checked_at: string;
}
