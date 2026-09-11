#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=git-observer
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE}.service"

# An agent editing this repo may itself be running inside a session that lives
# in the cgroup systemd is about to tear down. Anything still running here when
# the stop lands dies mid-flight — an interrupted build leaves a broken
# dist/web, and the start half never gets confirmed. So hand the whole
# rebuild+restart to a transient unit outside our cgroup.
if [ -f "$UNIT" ] && command -v systemd-run >/dev/null; then
  systemd-run --user --collect --quiet \
    --unit="${SERVICE}-restart" \
    --description="rebuild + restart ${SERVICE}" \
    --working-directory="$PWD" \
    -- bash -c "
      set -o pipefail
      ./rebuild.sh || exit 1
      systemctl --user reset-failed '${SERVICE}' 2>/dev/null || true
      systemctl --user restart '${SERVICE}'
      # Safety net: confirm it really came back, and start it if it didn't.
      for _ in \$(seq 1 20); do
        systemctl --user is-active --quiet '${SERVICE}' && exit 0
        sleep 1
      done
      systemctl --user reset-failed '${SERVICE}' 2>/dev/null || true
      systemctl --user start '${SERVICE}'
    "
  echo "rebuild + restart handed to ${SERVICE}-restart.service (detached)."
  echo "  watch:  journalctl --user -u ${SERVICE}-restart -f"
  exit 0
fi

# --- Fallbacks: no systemd-run, or the service isn't installed -------------
./rebuild.sh
if [ -f "$UNIT" ]; then
  systemctl --user restart "$SERVICE"
  echo "git-observer restarted (systemctl --user restart $SERVICE)"
else
  ./stop.sh
  ./start.sh
fi
