#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

SERVICE=git-observer
PIDFILE=git-observer.pid

# --- dev server (pidfile) takes precedence if present ----------------------
if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    # The pid leads its own process group (see start.sh). Signal the whole group
    # (negative pid) so tsx watch's worker dies too — a bare `kill $PID` can
    # orphan the worker, which then keeps holding the port. SIGTERM first so the
    # server's shutdown handler checkpoints the DB, then SIGKILL if it lingers.
    kill -TERM -"$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
    for _ in $(seq 1 50); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.1
    done
    if kill -0 "$PID" 2>/dev/null; then
      kill -KILL -"$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null
      echo "git-observer (dev) force-killed (pid $PID)"
    else
      echo "git-observer (dev) stopped (pid $PID)"
    fi
  else
    echo "git-observer (dev) was not running (stale pidfile)"
  fi
  rm -f "$PIDFILE"
  exit 0
fi

# --- production: stop the systemd user service -----------------------------
systemctl --user stop "$SERVICE"
echo "git-observer stopped (systemctl --user stop $SERVICE)"
