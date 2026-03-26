#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# PingBase — Secrets Management Script
# Set or rotate Worker secrets without redeploying
# =============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✓${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; exit 1; }
info() { echo -e "  $1"; }

WORKER_NAME="pingbase"

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
echo -e "\n${CYAN}${BOLD}PingBase — Secret Manager${NC}\n"

command -v wrangler >/dev/null 2>&1 || fail "wrangler not found. Install: npm install -g wrangler"
wrangler whoami 2>/dev/null | grep -q "You are logged in" || fail "wrangler not authenticated. Run: wrangler login"

ok "wrangler authenticated"
echo ""

# ---------------------------------------------------------------------------
# Choose mode
# ---------------------------------------------------------------------------
echo -e "  ${BOLD}Which secrets do you want to set?${NC}"
echo ""
echo "    1) All secrets"
echo "    2) JWT_SECRET only (auto-generate)"
echo "    3) Stripe secrets only"
echo "    4) RESEND_API_KEY only"
echo "    5) Pick individually"
echo ""
read -rp "  Choice [1-5]: " CHOICE

set_secret() {
  local name="$1"
  local value="$2"
  echo "$value" | wrangler secret put "$name" --name "$WORKER_NAME" >/dev/null 2>&1
  ok "Secret '$name' set"
}

prompt_and_set() {
  local name="$1"
  local prompt_text="${2:-$name}"
  local allow_empty="${3:-no}"

  read -rp "  $prompt_text: " value
  if [ -n "$value" ]; then
    set_secret "$name" "$value"
  elif [ "$allow_empty" = "no" ]; then
    warn "Skipped $name (empty input)"
  fi
}

set_jwt() {
  read -rp "  JWT_SECRET [press Enter to auto-generate]: " value
  if [ -z "$value" ]; then
    value=$(openssl rand -hex 32)
    info "Auto-generated JWT_SECRET"
  fi
  set_secret "JWT_SECRET" "$value"
}

set_stripe() {
  prompt_and_set "STRIPE_SECRET_KEY" "STRIPE_SECRET_KEY (sk_...)"
  prompt_and_set "STRIPE_WEBHOOK_SECRET" "STRIPE_WEBHOOK_SECRET (whsec_...)"
}

set_resend() {
  prompt_and_set "RESEND_API_KEY" "RESEND_API_KEY (re_...)"
}

echo ""

case "$CHOICE" in
  1)
    set_jwt
    set_stripe
    set_resend
    ;;
  2)
    set_jwt
    ;;
  3)
    set_stripe
    ;;
  4)
    set_resend
    ;;
  5)
    echo -e "\n  ${BOLD}Set each secret individually (press Enter to skip):${NC}\n"
    set_jwt
    set_stripe
    set_resend
    ;;
  *)
    fail "Invalid choice. Run the script again."
    ;;
esac

echo ""
echo -e "${GREEN}${BOLD}Secrets updated.${NC} Changes take effect immediately — no redeploy needed."
echo ""
