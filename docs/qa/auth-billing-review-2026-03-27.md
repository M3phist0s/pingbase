# QA Review: Auth & Billing Code -- PingBase

**Reviewer:** QA Agent (James Bach methodology)
**Date:** 2026-03-27
**Scope:** src/auth.ts, src/stripe.ts, src/api.ts, src/db.ts, src/types.ts, src/index.ts, scripts/deploy.sh, scripts/deploy-secrets.sh
**Approach:** Exploratory security review + logic analysis. Not random testing -- systematic heuristic-driven exploration using SFDPOT and risk-based prioritization.

---

## Summary

Found **13 bugs**: 3 Critical, 5 Major, 5 Minor. The most dangerous issues are an authentication bypass via the X-User-Id header fallback, a non-constant-time password comparison, and an incomplete SSRF filter. The Stripe webhook integration has a timestamp replay window issue and a missing negative-age check. The deploy script has a wrong webhook URL in its summary output.

---

## Critical Bugs

### QA-C5-01 -- Authentication Bypass via X-User-Id Header Fallback
- **Severity:** Critical
- **File:** src/api.ts, line 492
- **Description:** The `getUserId()` function falls through to `req.headers.get('X-User-Id')` when no Bearer token is present. This means ANY unauthenticated request can impersonate any user by simply sending `X-User-Id: <target-user-id>` as a header. No JWT, no password needed. The comment says "TODO: Remove X-User-Id fallback after migration period" but this is a live bypass -- an attacker who knows or guesses a user ID can read, modify, or delete that user's monitors and initiate billing actions.
- **Impact:** Full account takeover. An attacker can enumerate user IDs (they are hex UUIDs but predictable format) and access any account's data, change billing, delete monitors.
- **Fix:** Remove lines 491-492 entirely. If migration is still needed, gate it behind an environment variable (e.g., `ALLOW_HEADER_AUTH=true`) that is only set in development, never production. Better yet: finish migration and delete the fallback now.

### QA-C5-02 -- Password Verification Uses Non-Constant-Time String Comparison
- **Severity:** Critical
- **File:** src/auth.ts, line 157
- **Description:** `verifyPassword()` compares the computed hash to the stored hash using `toHex(hash) === hashHex`, which is a standard JavaScript string comparison. This is NOT timing-safe. The comparison short-circuits on the first differing character, leaking information about how many leading characters of the hash match. The irony is that the codebase has a `timingSafeEqual()` function in stripe.ts -- it just is not used here.
- **Impact:** A sophisticated attacker can perform a timing side-channel attack to progressively determine the password hash byte-by-byte. On Cloudflare Workers, timing precision over the network is coarser than localhost, which reduces but does not eliminate the risk. For a security-sensitive operation like password verification, constant-time comparison is a must.
- **Fix:** Export `timingSafeEqual` from stripe.ts (or move it to a shared utils module) and use it in `verifyPassword`:
  ```typescript
  return timingSafeEqual(toHex(hash), hashHex);
  ```

### QA-C5-03 -- Incomplete SSRF Filter: 172.16.0.0/12 Range Not Properly Blocked
- **Severity:** Critical
- **File:** src/api.ts, lines 121-124
- **Description:** The SSRF protection checks `host.startsWith('172.')` which blocks the entire 172.0.0.0/8 range. However, this is both too broad (blocks legitimate public IPs in 172.0-15.x.x and 172.32-255.x.x) AND, more importantly, the check can be trivially bypassed using:
  - IPv6 mapped addresses (e.g., `[::ffff:10.0.0.1]`)
  - Decimal IP notation (e.g., `http://2130706433/` = 127.0.0.1)
  - DNS rebinding (a domain resolving to 127.0.0.1)
  - `[0:0:0:0:0:0:0:1]` (IPv6 loopback)
  The filter only checks the string representation of the hostname, not the resolved IP. A monitor URL like `http://evil.com/` where evil.com DNS-resolves to `169.254.169.254` (cloud metadata endpoint) would pass all checks.
- **Impact:** Server-Side Request Forgery. An attacker can create a monitor pointing to internal cloud metadata endpoints (169.254.169.254 on most clouds), internal services, or localhost via DNS rebinding. On Cloudflare Workers the blast radius is somewhat limited since Workers don't have a traditional VPC, but cloud metadata and internal Cloudflare endpoints could still be reachable.
- **Fix:** (1) Add `169.254.` to the blocklist. (2) Check for IPv6 loopback. (3) For robust SSRF prevention, resolve the hostname and check the resolved IP rather than the hostname string. On Workers, you may need to use a DNS-over-HTTPS lookup before allowing the URL. (4) Alternatively, restrict the 172.x check to only the actual private range: `172.16.` through `172.31.`.

---

## Major Bugs

### QA-C5-04 -- Webhook Timestamp Allows Negative Age (Future-Dated Replays)
- **Severity:** Major
- **File:** src/stripe.ts, lines 109-111
- **Description:** The replay protection checks `if (age > 300)` but does not check for negative age. An attacker with a captured webhook payload could set a timestamp far in the future, making `age` negative, and the check would pass. While the HMAC signature still must be valid (so this requires a compromised webhook secret), defense-in-depth says we should reject timestamps that are unreasonably far in the future too.
- **Fix:** Change to: `if (age > 300 || age < -60)` to reject timestamps more than 60 seconds in the future.

### QA-C5-05 -- PATCH /api/monitors/:id Bypasses URL Validation and Tier Interval Limits
- **Severity:** Major
- **File:** src/api.ts, lines 193-215
- **Description:** The POST /api/monitors route performs URL validation (SSRF checks, protocol enforcement) and tier-based interval enforcement. The PATCH route does NOT. An attacker can create a valid monitor, then PATCH it to change the URL to `http://localhost/admin` or `http://169.254.169.254/latest/meta-data/`, bypassing all SSRF protections. They can also PATCH `interval_seconds` to a lower value than their tier allows.
- **Fix:** Apply the same URL validation logic and tier-based interval clamping in the PATCH handler. Extract the validation into a shared function.

### QA-C5-06 -- CORS Wildcard Allows Any Origin
- **Severity:** Major
- **File:** src/api.ts, line 475
- **Description:** `Access-Control-Allow-Origin: *` allows any website to make authenticated API calls to PingBase if the user has a valid JWT. Combined with the fact that JWTs are typically stored in localStorage and sent via Authorization header, this means a malicious page cannot directly exploit this (browser won't send Authorization headers cross-origin without CORS). However, with `X-User-Id` in the allowed headers AND the auth bypass in QA-C5-01, any website can impersonate any user by setting `X-User-Id`. Even after QA-C5-01 is fixed, wildcard CORS is a risk if any future auth mechanism uses cookies.
- **Fix:** Set `Access-Control-Allow-Origin` to the specific dashboard domain (e.g., `env.APP_URL`) rather than `*`. This is especially important for a billing/auth API.

### QA-C5-07 -- getUserById Returns Incomplete Type (Missing stripe_customer_id)
- **Severity:** Major
- **File:** src/db.ts, line 67
- **Description:** `getUserById` is typed as `first<{ id: string; email: string; tier: string }>()` which does not include `stripe_customer_id` or `password_hash`. The API code then uses `(user as Record<string, unknown>).stripe_customer_id` with unsafe casts (api.ts lines 299, 313, 415) to access the field. The `SELECT *` query DOES return it from the database, so the data is there at runtime, but the type erasure means TypeScript cannot protect against typos or missing fields. This is not a runtime bug today but it is a maintenance trap.
- **Fix:** Change `getUserById` to return `User | null` (the full User type), matching the pattern used by `getUserByEmail`.

### QA-C5-08 -- signup and login Routes Do Not Handle Malformed JSON Body
- **Severity:** Major
- **File:** src/api.ts, lines 34, 65
- **Description:** Both `req.json()` calls will throw an unhandled exception if the request body is not valid JSON (e.g., empty body, form-encoded data, plain text). This will result in a 500 Internal Server Error with a stack trace leaking implementation details, rather than a clean 400 response.
- **Fix:** Wrap `req.json()` in try-catch and return `json({ error: 'Invalid JSON body' }, 400)` on parse failure. Apply the same fix to all routes that call `req.json()`.

---

## Minor Bugs

### QA-C5-09 -- Deploy Script Prints Wrong Webhook URL Path
- **Severity:** Minor
- **File:** scripts/deploy.sh, line 295
- **Description:** The deploy summary says to set up Stripe webhook pointing to `<worker-url>/stripe/webhook`. The actual route defined in api.ts is `/api/webhooks/stripe`. A user following the deploy instructions will configure the wrong URL and all Stripe webhooks will 404.
- **Fix:** Change line 295 to: `${WORKER_URL:-'<worker-url>'}/api/webhooks/stripe`

### QA-C5-10 -- Email Validation Is Insufficient
- **Severity:** Minor
- **File:** src/api.ts, lines 43-45
- **Description:** The email check `!email.includes('@') || !email.includes('.')` accepts many invalid emails like `@.`, `a@b`, `user@.com`, and `foo.bar` (no @ at all still requires @, but `@.` passes). It also does not check for spaces or other invalid characters. While strict RFC 5322 validation is overkill, a minimal regex like `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` would catch the worst cases.
- **Fix:** Use a basic regex: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` for email validation.

### QA-C5-11 -- Stripe Webhook Silently Swallows All Handler Errors
- **Severity:** Minor
- **File:** src/api.ts, lines 391-394
- **Description:** The catch block around the webhook event handler logs the error but returns 200 to Stripe. This means if there is a persistent bug in the handler (e.g., a schema change in Stripe's event format), Stripe will never retry, and tier assignments will silently fail. Users could pay for Pro but remain on Free tier with no error visible anywhere except Worker logs (which have limited retention on Workers).
- **Fix:** Consider returning 500 for unexpected errors so Stripe will retry. Only return 200 for known-unhandled event types (the `default` case in the switch). Structure it as: try each case, catch returns 500; for unmatched event.type, return 200.

### QA-C5-12 -- Status Page Endpoint Leaks Monitor URLs to Public
- **Severity:** Minor
- **File:** src/api.ts, line 263
- **Description:** The public status page endpoint `/api/status/:slug` returns `monitor.url` in the response. This exposes the user's internal monitoring URLs to anyone who knows the status page slug. These URLs might reveal internal service names, staging environments, or API endpoints that should not be public.
- **Fix:** Remove `url` from the status page monitor response, or make it opt-in per monitor.

### QA-C5-13 -- Deploy Script Uses grep -oP (Perl Regex) Which Fails on macOS
- **Severity:** Minor
- **File:** scripts/deploy.sh, line 72
- **Description:** `grep -oP 'database_id\s*=\s*"\K[^"]+'` uses Perl-compatible regex (`-P` flag), which is not supported by the default macOS `grep` (BSD grep). The script will fail on macOS unless GNU grep is installed. The script does have a fallback regex on line 76, but the `-P` line may produce an error message to stderr even though the script continues.
- **Fix:** Replace the `-oP` grep with a `sed` or `awk` command, or use `grep -oE` with a POSIX extended regex. For example: `sed -n 's/.*database_id[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p'`

---

## Risk Assessment Summary

| Area | Risk Level | Notes |
|------|-----------|-------|
| Authentication | HIGH | X-User-Id bypass is a live vulnerability |
| Password Security | MEDIUM-HIGH | Timing attack is real but harder to exploit over network |
| SSRF Protection | HIGH | DNS rebinding and metadata endpoints are unprotected |
| Stripe Webhooks | MEDIUM | Silent error swallowing could cause billing inconsistencies |
| Data Integrity | MEDIUM | PATCH bypass allows tier limit evasion |
| Deploy Scripts | LOW | Wrong URL in summary, macOS grep compat |

## Recommended Priority Order

1. **Immediately:** Remove X-User-Id fallback (QA-C5-01) -- this is a live auth bypass
2. **Immediately:** Fix CORS to specific origin (QA-C5-06) -- amplifies QA-C5-01
3. **Before launch:** Fix password timing comparison (QA-C5-02)
4. **Before launch:** Add URL validation to PATCH route (QA-C5-05)
5. **Before launch:** Improve SSRF filter (QA-C5-03)
6. **Before launch:** Add JSON parse error handling (QA-C5-08)
7. **Soon:** Fix webhook error handling strategy (QA-C5-11)
8. **Soon:** Fix webhook timestamp negative age (QA-C5-04)
9. **Soon:** Fix deploy script webhook URL (QA-C5-09)
10. **Backlog:** Remaining minor issues
