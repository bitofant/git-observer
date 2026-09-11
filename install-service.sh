#!/usr/bin/env bash
#
# Install git-observer as a systemd *user* service.
#
# A user service (rather than a system one) is the right fit: all GitHub access
# runs through the `gh` CLI, which reads per-user credentials from your home
# directory. With lingering enabled it keeps syncing even when you're logged out.
#
# Usage: ./install-service.sh
#
set -euo pipefail

SERVICE_NAME="git-observer"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/${SERVICE_NAME}.service"

# --- Sanity checks ---------------------------------------------------------
NPM_BIN="$(command -v npm || true)"
if [[ -z "$NPM_BIN" ]]; then
  echo "error: npm not found on PATH" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/config.json" ]]; then
  echo "error: $APP_DIR/config.json missing — run ./config-gen.sh first" >&2
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "warning: gh not found on PATH — the app will start but sync nothing"
elif ! gh auth status >/dev/null 2>&1; then
  echo "warning: gh is not authenticated — run: gh auth login"
fi

if [[ ! -d "$APP_DIR/dist/web" ]]; then
  echo "note: dist/web not found — building production frontend..."
  ( cd "$APP_DIR" && npm run build )
fi

# Build a PATH that includes wherever node/npm and gh live for this user, so
# the service can find them.
SERVICE_PATH="$(dirname "$NPM_BIN")"
for d in "$HOME/.local/bin" "$HOME/.npm-global/bin" /usr/local/bin /usr/bin /bin; do
  case ":$SERVICE_PATH:" in
    *":$d:"*) ;;                       # already present
    *) [[ -d "$d" ]] && SERVICE_PATH="$SERVICE_PATH:$d" ;;
  esac
done

# --- Write the unit --------------------------------------------------------
mkdir -p "$UNIT_DIR"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=git-observer — per-developer GitHub activity dashboards
After=network-online.target
Wants=network-online.target
# Never stop retrying. The default (5 starts / 10s) lets a transient crash-loop
# — e.g. requests arriving mid-rebuild — exhaust the budget and leave the
# service dead for good.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PATH=$SERVICE_PATH
ExecStart=$NPM_BIN start
Restart=always
RestartSec=3
# A hung `gh` in the cgroup mustn't stall the stop half of a restart.
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

echo "wrote $UNIT_FILE"

# --- Enable & start --------------------------------------------------------
# Keep the service alive across logout (no-op if already enabled).
loginctl enable-linger "$USER" >/dev/null 2>&1 || \
  echo "warning: could not enable linger — service may stop when you log out"

systemctl --user daemon-reload
systemctl --user enable --now "${SERVICE_NAME}.service"

echo
echo "git-observer installed and started."
echo "  status:  systemctl --user status ${SERVICE_NAME}"
echo "  logs:    journalctl --user -u ${SERVICE_NAME} -f"
echo "  stop:    systemctl --user stop ${SERVICE_NAME}"
echo "  restart: systemctl --user restart ${SERVICE_NAME}"
