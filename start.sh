#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=git-observer
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE}.service"
PIDFILE=git-observer.pid
LOGFILE=git-observer.log

# --- dev mode: run the watch server directly (HMR), not under systemd -------
# `tsx watch` forks a child worker, so launch under `setsid` to put the whole
# thing in its own process group. The recorded pid leads that group, letting
# stop.sh reap tsx watch *and* its worker (the process that holds the port).
if [ "${1:-}" = "dev" ]; then
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "git-observer (dev) is already running (pid $(cat "$PIDFILE"))"
    exit 1
  fi
  setsid ./node_modules/.bin/tsx watch server/index.ts --dev \
    < /dev/null >> "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  echo "git-observer started in dev mode (pid $!, log: $LOGFILE)"
  exit 0
fi

# --- production: the systemd user service is the canonical runner ----------
# Serves prebuilt dist/web, so run ./rebuild.sh first (or use ./restart.sh).
if [ ! -f "$UNIT" ]; then
  echo "service not installed — run ./install-service.sh first" \
       "(or ./start.sh dev for the HMR dev server)" >&2
  exit 1
fi
systemctl --user start "$SERVICE"
echo "git-observer started (systemctl --user start $SERVICE)"
