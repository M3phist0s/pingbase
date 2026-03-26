# PingBase

Uptime monitoring and status pages built on Cloudflare Workers. Fast, affordable, globally distributed.

## Features

- **Uptime Monitoring** — HTTP/HTTPS checks from Cloudflare's global edge network
- **Status Pages** — Public status pages with 90-day uptime history charts
- **Instant Alerts** — Email notifications when your services go down
- **JWT Auth** — Secure email/password authentication with PBKDF2 hashing
- **Stripe Billing** — Free, Pro ($9/mo), and Team ($29/mo) tiers
- **Zero Infrastructure** — Runs entirely on Cloudflare Workers + D1 + KV

## Pricing

| | Free | Pro | Team |
|---|---|---|---|
| **Price** | $0 | $9/mo | $29/mo |
| **Monitors** | 3 | 20 | 50 |
| **Check Interval** | 5 min | 1 min | 1 min |
| **Status Pages** | 1 | 1 | 5 |
| **History** | 24 hours | 90 days | 1 year |
| **Custom Domain** | No | Yes | Yes |

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **Cache:** Cloudflare KV
- **Auth:** JWT + PBKDF2 (Web Crypto API, zero dependencies)
- **Billing:** Stripe Checkout + Customer Portal
- **Frontend:** Vanilla HTML/CSS/JS (no build step)

## Project Structure

```
src/
  index.ts        — Worker entry point (HTTP + Cron)
  api.ts          — REST API routes (auth, monitors, billing)
  auth.ts         — JWT + password hashing (Web Crypto)
  db.ts           — D1 database queries
  kv.ts           — KV status cache + write buffer
  monitor.ts      — Monitoring engine
  alerts.ts       — Alert pipeline
  stripe.ts       — Stripe integration
  status-page.ts  — Public status page renderer
  types.ts        — TypeScript interfaces
dashboard/        — Admin dashboard (vanilla HTML/JS)
landing/          — Marketing landing page
migrations/       — D1 database schema
scripts/          — Deployment automation
```

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- Cloudflare account
- Stripe account (for billing)

### 1. Install dependencies

```bash
cd projects/pingbase
npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Deploy

The deploy script handles everything — D1 database, KV namespaces, secrets, Worker, and Pages:

```bash
./scripts/deploy.sh
```

It will prompt for secrets (JWT_SECRET, Stripe keys, Resend API key). JWT_SECRET auto-generates if left blank.

### 4. Set up Stripe

1. Create products and prices in your [Stripe Dashboard](https://dashboard.stripe.com/products):
   - **Pro Monthly** — $9/month
   - **Pro Annual** — $90/year ($7.50/mo)
   - **Team Monthly** — $29/month
   - **Team Annual** — $288/year ($24/mo)

2. Set price IDs as secrets:
   ```bash
   wrangler secret put STRIPE_PRO_MONTHLY_PRICE
   wrangler secret put STRIPE_PRO_ANNUAL_PRICE
   wrangler secret put STRIPE_TEAM_MONTHLY_PRICE
   wrangler secret put STRIPE_TEAM_ANNUAL_PRICE
   ```

3. Add a webhook endpoint in Stripe pointing to:
   ```
   https://<your-worker>.workers.dev/api/webhooks/stripe
   ```
   Events to subscribe: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`

### 5. Local development

```bash
npm run dev
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/signup` | Create account |
| `POST` | `/api/auth/login` | Sign in |
| `GET` | `/api/auth/me` | Current user |
| `GET` | `/api/monitors` | List monitors |
| `POST` | `/api/monitors` | Create monitor |
| `GET` | `/api/monitors/:id` | Get monitor + status |
| `PATCH` | `/api/monitors/:id` | Update monitor |
| `DELETE` | `/api/monitors/:id` | Delete monitor |
| `GET` | `/api/monitors/:id/checks` | Check history |
| `GET` | `/api/billing/status` | Billing status |
| `POST` | `/api/billing/checkout` | Start Stripe checkout |
| `POST` | `/api/billing/portal` | Stripe billing portal |
| `GET` | `/api/status/:slug` | Public status page data |
| `GET` | `/health` | Health check |

All authenticated endpoints require `Authorization: Bearer <token>` header.

## License

MIT
