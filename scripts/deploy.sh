#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# PingBase — One-Click Deployment Script
# Deploys Worker (D1 + KV + Secrets) and Dashboard (Pages) to Cloudflare
# Idempotent: safe to run multiple times
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WRANGLER_TOML="$PROJECT_DIR/wrangler.toml"

# ---------------------------------------------------------------------------
# Colors and helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

step()    { echo -e "\n${CYAN}${BOLD}[$1]${NC} $2"; }
ok()      { echo -e "  ${GREEN}✓${NC} $1"; }
warn()    { echo -e "  ${YELLOW}!${NC} $1"; }
fail()    { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info()    { echo -e "  $1"; }

# ---------------------------------------------------------------------------
# [1/8] Pre-flight checks
# ---------------------------------------------------------------------------
step "1/8" "Pre-flight checks"

command -v wrangler >/dev/null 2>&1 || fail "wrangler not found. Install: npm install -g wrangler"
ok "wrangler installed ($(wrangler --version 2>/dev/null || echo 'unknown version'))"

command -v jq >/dev/null 2>&1 || fail "jq not found. Install: brew install jq"
ok "jq installed"

if ! wrangler whoami 2>/dev/null | grep -q "You are logged in"; then
  fail "wrangler not authenticated. Run: wrangler login"
fi
ok "wrangler authenticated"

[ -f "$WRANGLER_TOML" ] || fail "wrangler.toml not found at $WRANGLER_TOML"
ok "wrangler.toml found"

[ -d "$PROJECT_DIR/dashboard" ] || fail "dashboard/ directory not found"
ok "dashboard/ directory found"

[ -f "$PROJECT_DIR/migrations/0001_initial.sql" ] || fail "migrations/0001_initial.sql not found"
ok "migration file found"

# ---------------------------------------------------------------------------
# [2/8] Create D1 database (if not exists)
# ---------------------------------------------------------------------------
step "2/8" "Creating D1 database..."

D1_NAME="pingbase-db"
D1_ID=""

# Check if database already exists
D1_LIST=$(wrangler d1 list --json 2>/dev/null || echo "[]")
D1_ID=$(echo "$D1_LIST" | jq -r --arg name "$D1_NAME" '.[] | select(.name == $name) | .uuid // empty' 2>/dev/null || true)

if [ -n "$D1_ID" ]; then
  ok "D1 database '$D1_NAME' already exists (ID: $D1_ID)"
else
  info "Creating D1 database '$D1_NAME'..."
  D1_OUTPUT=$(wrangler d1 create "$D1_NAME" 2>&1)
  D1_ID=$(echo "$D1_OUTPUT" | grep -oP 'database_id\s*=\s*"\K[^"]+' || true)

  # Fallback: try alternate output format
  if [ -z "$D1_ID" ]; then
    D1_ID=$(echo "$D1_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
  fi

  [ -n "$D1_ID" ] || fail "Could not parse D1 database ID from output:\n$D1_OUTPUT"
  ok "D1 database created (ID: $D1_ID)"
fi

# Update wrangler.toml with real D1 ID
if grep -q "PLACEHOLDER_D1_ID" "$WRANGLER_TOML"; then
  sed -i.bak "s/PLACEHOLDER_D1_ID/$D1_ID/" "$WRANGLER_TOML" && rm -f "$WRANGLER_TOML.bak"
  ok "Updated wrangler.toml with D1 database_id"
elif ! grep -q "$D1_ID" "$WRANGLER_TOML"; then
  # ID exists but is different — update it
  sed -i.bak "s/database_id = \"[^\"]*\"/database_id = \"$D1_ID\"/" "$WRANGLER_TOML" && rm -f "$WRANGLER_TOML.bak"
  ok "Updated wrangler.toml with correct D1 database_id"
else
  ok "wrangler.toml already has correct D1 database_id"
fi

# ---------------------------------------------------------------------------
# [3/8] Create KV namespaces (if not exist)
# ---------------------------------------------------------------------------
step "3/8" "Creating KV namespaces..."

KV_LIST=$(wrangler kv namespace list --json 2>/dev/null || echo "[]")

create_or_find_kv() {
  local binding="$1"
  local placeholder="$2"
  local kv_id=""

  # The title wrangler creates is "<worker_name>-<binding>"
  local expected_title="pingbase-$binding"

  kv_id=$(echo "$KV_LIST" | jq -r --arg title "$expected_title" '.[] | select(.title == $title) | .id // empty' 2>/dev/null || true)

  if [ -n "$kv_id" ]; then
    ok "KV namespace '$binding' already exists (ID: $kv_id)"
  else
    info "Creating KV namespace '$binding'..."
    KV_OUTPUT=$(wrangler kv namespace create "$binding" 2>&1)
    kv_id=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{32}' | head -1 || true)

    # Fallback: try UUID format
    if [ -z "$kv_id" ]; then
      kv_id=$(echo "$KV_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1 || true)
    fi

    [ -n "$kv_id" ] || fail "Could not parse KV namespace ID for '$binding' from output:\n$KV_OUTPUT"
    ok "KV namespace '$binding' created (ID: $kv_id)"
  fi

  # Update wrangler.toml
  if grep -q "$placeholder" "$WRANGLER_TOML"; then
    sed -i.bak "s/$placeholder/$kv_id/" "$WRANGLER_TOML" && rm -f "$WRANGLER_TOML.bak"
    ok "Updated wrangler.toml with $binding ID"
  else
    ok "wrangler.toml already has $binding ID"
  fi
}

create_or_find_kv "STATUS_KV" "PLACEHOLDER_STATUS_KV_ID"
create_or_find_kv "BUFFER_KV"  "PLACEHOLDER_BUFFER_KV_ID"

# ---------------------------------------------------------------------------
# [4/8] Run D1 migration
# ---------------------------------------------------------------------------
step "4/8" "Running D1 migrations..."

cd "$PROJECT_DIR"
MIGRATION_OUTPUT=$(wrangler d1 migrations apply "$D1_NAME" --remote 2>&1) || true

if echo "$MIGRATION_OUTPUT" | grep -qi "nothing to migrate\|already applied\|no migrations"; then
  ok "Migrations already applied"
elif echo "$MIGRATION_OUTPUT" | grep -qi "applied\|success"; then
  ok "Migrations applied successfully"
else
  # Print output for debugging but don't necessarily fail
  # (wrangler may change its output format)
  warn "Migration output — verify manually:"
  echo "$MIGRATION_OUTPUT" | head -20
fi

# ---------------------------------------------------------------------------
# [5/8] Set secrets
# ---------------------------------------------------------------------------
step "5/8" "Setting Worker secrets..."

set_secret() {
  local name="$1"
  local value="$2"
  echo "$value" | wrangler secret put "$name" --name pingbase >/dev/null 2>&1
  ok "Secret '$name' set"
}

echo ""
info "Secrets are set interactively. Press Enter to skip any secret (keeps current value)."
echo ""

# JWT_SECRET — offer to auto-generate
read -rp "  JWT_SECRET [press Enter to auto-generate]: " JWT_SECRET
if [ -z "$JWT_SECRET" ]; then
  JWT_SECRET=$(openssl rand -hex 32)
  info "Auto-generated JWT_SECRET"
fi
set_secret "JWT_SECRET" "$JWT_SECRET"

# STRIPE_SECRET_KEY
read -rp "  STRIPE_SECRET_KEY [press Enter to skip]: " STRIPE_SECRET_KEY
if [ -n "$STRIPE_SECRET_KEY" ]; then
  set_secret "STRIPE_SECRET_KEY" "$STRIPE_SECRET_KEY"
else
  warn "Skipped STRIPE_SECRET_KEY (set later with: scripts/deploy-secrets.sh)"
fi

# STRIPE_WEBHOOK_SECRET
read -rp "  STRIPE_WEBHOOK_SECRET [press Enter to skip]: " STRIPE_WEBHOOK_SECRET
if [ -n "$STRIPE_WEBHOOK_SECRET" ]; then
  set_secret "STRIPE_WEBHOOK_SECRET" "$STRIPE_WEBHOOK_SECRET"
else
  warn "Skipped STRIPE_WEBHOOK_SECRET"
fi

# RESEND_API_KEY
read -rp "  RESEND_API_KEY [press Enter to skip]: " RESEND_API_KEY
if [ -n "$RESEND_API_KEY" ]; then
  set_secret "RESEND_API_KEY" "$RESEND_API_KEY"
else
  warn "Skipped RESEND_API_KEY"
fi

# ---------------------------------------------------------------------------
# [6/8] Deploy Worker
# ---------------------------------------------------------------------------
step "6/8" "Deploying Worker..."

cd "$PROJECT_DIR"
DEPLOY_OUTPUT=$(wrangler deploy 2>&1)
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^ ]+\.workers\.dev' | head -1 || true)

if [ -z "$WORKER_URL" ]; then
  # Try alternate URL format
  WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[^ ]+' | head -1 || true)
fi

if [ -n "$WORKER_URL" ]; then
  ok "Worker deployed at: $WORKER_URL"
else
  warn "Worker deployed but could not parse URL from output"
  echo "$DEPLOY_OUTPUT" | tail -5
fi

# ---------------------------------------------------------------------------
# [7/8] Deploy Dashboard to Cloudflare Pages
# ---------------------------------------------------------------------------
step "7/8" "Deploying Dashboard to Cloudflare Pages..."

PAGES_PROJECT="pingbase-dashboard"

# Create Pages project if it doesn't exist
PAGES_LIST=$(wrangler pages project list 2>&1 || true)
if echo "$PAGES_LIST" | grep -q "$PAGES_PROJECT"; then
  ok "Pages project '$PAGES_PROJECT' already exists"
else
  info "Creating Pages project '$PAGES_PROJECT'..."
  wrangler pages project create "$PAGES_PROJECT" --production-branch main 2>/dev/null || true
  ok "Pages project created"
fi

PAGES_OUTPUT=$(wrangler pages deploy "$PROJECT_DIR/dashboard/" --project-name "$PAGES_PROJECT" 2>&1)
PAGES_URL=$(echo "$PAGES_OUTPUT" | grep -oE 'https://[^ ]+\.pages\.dev' | head -1 || true)

if [ -z "$PAGES_URL" ]; then
  PAGES_URL=$(echo "$PAGES_OUTPUT" | grep -oE 'https://[^ ]+' | tail -1 || true)
fi

if [ -n "$PAGES_URL" ]; then
  ok "Dashboard deployed at: $PAGES_URL"
else
  warn "Dashboard deployed but could not parse URL"
  echo "$PAGES_OUTPUT" | tail -5
fi

# ---------------------------------------------------------------------------
# [8/8] Post-deploy verification
# ---------------------------------------------------------------------------
step "8/8" "Post-deploy verification..."

if [ -n "$WORKER_URL" ]; then
  HEALTH_URL="${WORKER_URL}/health"
  info "Checking $HEALTH_URL ..."
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    ok "Health check passed (HTTP $HTTP_CODE)"
  elif [ "$HTTP_CODE" = "000" ]; then
    warn "Health check timed out — Worker may still be propagating (give it 30s)"
  else
    warn "Health check returned HTTP $HTTP_CODE — verify manually: curl $HEALTH_URL"
  fi
else
  warn "Skipping health check — no Worker URL detected"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo -e "${GREEN}${BOLD}=========================================${NC}"
echo -e "${GREEN}${BOLD}  PingBase deployment complete${NC}"
echo -e "${GREEN}${BOLD}=========================================${NC}"
echo ""
echo -e "  ${BOLD}Worker API:${NC}     ${WORKER_URL:-'(check Cloudflare dashboard)'}"
echo -e "  ${BOLD}Dashboard:${NC}      ${PAGES_URL:-'(check Cloudflare dashboard)'}"
echo -e "  ${BOLD}D1 Database:${NC}    $D1_NAME ($D1_ID)"
echo ""
echo -e "  ${BOLD}Next steps:${NC}"
echo -e "    1. Set any skipped secrets:  ${CYAN}./scripts/deploy-secrets.sh${NC}"
echo -e "    2. Configure custom domain in Cloudflare dashboard"
echo -e "    3. Set up Stripe webhook pointing to ${WORKER_URL:-'<worker-url>'}/stripe/webhook"
echo ""
