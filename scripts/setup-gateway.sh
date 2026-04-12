#!/usr/bin/env bash
# setup-gateway.sh — Configure OpenClaw Gateway to allow ClawTab connections
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/parksben/clawtab/main/scripts/setup-gateway.sh | bash
#
# Or with an explicit config path:
#   bash setup-gateway.sh /path/to/config.json

set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────

ORIGIN="chrome-extension://olfpncdbjlggonplhnlnbhkfianddhmp"
SERVICE_NAMES=("openclaw-gateway" "openclaw")
SEARCH_PATHS=(
  "/etc/openclaw/config.json"
  "$HOME/.openclaw/config.json"
  "/opt/openclaw/config.json"
  "/usr/local/openclaw/config.json"
  "./config.json"
)

# ── Output helpers ────────────────────────────────────────────────────────────

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'
BOLD=$'\033[1m'
NC=$'\033[0m'

info()  { echo -e "  ${GREEN}✓${NC} $*"; }
warn()  { echo -e "  ${YELLOW}!${NC} $*"; }
error() { echo -e "  ${RED}✗${NC} $*" >&2; }
step()  { echo -e "\n${BOLD}$*${NC}"; }

echo ""
echo -e "${BOLD}ClawTab — OpenClaw Gateway Setup${NC}"
echo "──────────────────────────────────────────────────────"
echo " Adds ClawTab's extension origin to allowedOrigins"
echo " and restarts the Gateway service."

# ── Step 1: Locate config ─────────────────────────────────────────────────────

step "Step 1 / 3  Locate Gateway config"

CONFIG_FILE="${1:-}"

if [[ -z "$CONFIG_FILE" ]]; then
  # Check environment variable
  if [[ -n "${OPENCLAW_CONFIG:-}" && -f "$OPENCLAW_CONFIG" ]]; then
    CONFIG_FILE="$OPENCLAW_CONFIG"
    info "Found via \$OPENCLAW_CONFIG: $CONFIG_FILE"
  else
    # Auto-detect from common paths
    for path in "${SEARCH_PATHS[@]}"; do
      if [[ -f "$path" ]]; then
        CONFIG_FILE="$path"
        info "Auto-detected: $CONFIG_FILE"
        break
      fi
    done
  fi
fi

if [[ -z "$CONFIG_FILE" ]]; then
  warn "Could not locate config automatically."
  echo -n "  Enter path to your OpenClaw config.json: "
  read -r CONFIG_FILE
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  error "File not found: $CONFIG_FILE"
  exit 1
fi

info "Config: $CONFIG_FILE"

# ── Step 2: Add origin to allowedOrigins ─────────────────────────────────────

step "Step 2 / 3  Update allowedOrigins"

# Require python3 for safe JSON editing
if ! command -v python3 &>/dev/null; then
  error "python3 is required but not found. Please install it and re-run."
  exit 1
fi

# Validate JSON
if ! python3 -c "import json; json.load(open('$CONFIG_FILE'))" 2>/dev/null; then
  error "Config file contains invalid JSON: $CONFIG_FILE"
  exit 1
fi

# Check if already present
if python3 - "$CONFIG_FILE" "$ORIGIN" <<'PYEOF'
import json, sys
path, origin = sys.argv[1], sys.argv[2]
with open(path) as f:
    c = json.load(f)
origins = c.get("gateway", {}).get("controlUi", {}).get("allowedOrigins", [])
sys.exit(0 if origin in origins else 1)
PYEOF
then
  info "Origin already present — no changes needed."
else
  # Backup original config
  cp "$CONFIG_FILE" "${CONFIG_FILE}.bak"
  info "Backup saved: ${CONFIG_FILE}.bak"

  # Add origin
  python3 - "$CONFIG_FILE" "$ORIGIN" <<'PYEOF'
import json, sys
path, origin = sys.argv[1], sys.argv[2]
with open(path) as f:
    config = json.load(f)
gw = config.setdefault("gateway", {})
cu = gw.setdefault("controlUi", {})
ao = cu.setdefault("allowedOrigins", [])
if origin not in ao:
    ao.append(origin)
with open(path, "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF

  info "Added: $ORIGIN"
fi

# ── Step 3: Restart service ───────────────────────────────────────────────────

step "Step 3 / 3  Restart Gateway service"

RESTARTED=false
for svc in "${SERVICE_NAMES[@]}"; do
  if systemctl list-units --type=service --all 2>/dev/null | grep -q "${svc}.service"; then
    if [[ "$(id -u)" -eq 0 ]]; then
      systemctl restart "$svc"
    else
      sudo systemctl restart "$svc"
    fi
    info "Restarted: $svc"
    RESTARTED=true
    break
  fi
done

if [[ "$RESTARTED" == false ]]; then
  warn "Could not find a systemd service named '${SERVICE_NAMES[*]}'."
  warn "Please restart OpenClaw Gateway manually:"
  echo ""
  echo "    systemctl restart openclaw-gateway"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}${GREEN}Done!${NC} ClawTab is now authorized to connect to your Gateway."
echo ""
echo "  Next: open Chrome, click the ClawTab icon, and fill in:"
echo "    • Gateway URL  — wss://<your-gateway-host>"
echo "    • Access Token — the token from your Gateway config"
echo "    • Channel Name — any name to identify this browser"
echo ""
