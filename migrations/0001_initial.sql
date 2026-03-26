-- PingBase initial schema
-- Tables: users, monitors, check_results, incidents, status_pages, alert_configs

CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'pro', 'team')),
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE monitors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET' CHECK (method IN ('GET', 'HEAD')),
  expected_status INTEGER NOT NULL DEFAULT 200,
  timeout_ms INTEGER NOT NULL DEFAULT 10000,
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE check_results (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('up', 'down', 'degraded')),
  response_time_ms INTEGER,
  status_code INTEGER,
  error_message TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE incidents (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  cause TEXT
);

CREATE TABLE status_pages (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  custom_domain TEXT,
  monitors TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE alert_configs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'slack', 'discord', 'webhook')),
  target TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Indexes for hot queries
CREATE INDEX idx_monitors_active ON monitors(is_active) WHERE is_active = 1;
CREATE INDEX idx_monitors_user ON monitors(user_id);
CREATE INDEX idx_check_results_monitor ON check_results(monitor_id, checked_at DESC);
CREATE INDEX idx_incidents_monitor ON incidents(monitor_id, started_at DESC);
CREATE INDEX idx_incidents_open ON incidents(monitor_id) WHERE resolved_at IS NULL;
CREATE INDEX idx_status_pages_slug ON status_pages(slug);
CREATE INDEX idx_alert_configs_monitor ON alert_configs(monitor_id) WHERE is_active = 1;
