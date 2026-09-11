#!/usr/bin/env bash
#
# config-gen.sh — interactive setup dialog that generates config.json.
# git-observer keeps all configuration in config.json (gitignored); no env vars.

set -euo pipefail

CONFIG_FILE="config.json"

# --- helpers ---------------------------------------------------------------

# ask_yn "Question?" default(y|n) -> echoes "true" or "false"
ask_yn() {
  local prompt="$1" default="$2" reply
  local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
  read -r -p "$prompt $hint " reply || true
  reply="${reply:-$default}"
  case "$reply" in
    [Yy]*) echo "true" ;;
    *)     echo "false" ;;
  esac
}

# ask "Question?" default -> echoes answer (or default if empty)
ask() {
  local prompt="$1" default="$2" reply
  read -r -p "$prompt [$default] " reply || true
  echo "${reply:-$default}"
}

# json_escape <string> -> escapes for embedding in a JSON string
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# json_array <space-separated items> -> echoes ["a", "b"] (or [])
json_array() {
  local out="" item
  for item in $1; do
    [ -n "$item" ] || continue
    [ -n "$out" ] && out="$out, "
    out="$out\"$(json_escape "$item")\""
  done
  printf '[%s]' "$out"
}

# --- guard against clobbering ----------------------------------------------

if [ -f "$CONFIG_FILE" ]; then
  overwrite="$(ask_yn "$CONFIG_FILE already exists. Overwrite?" "n")"
  [ "$overwrite" = "true" ] || { echo "Aborted; existing $CONFIG_FILE kept."; exit 0; }
fi

echo "git-observer setup — writing $CONFIG_FILE"
echo

# --- GitHub ----------------------------------------------------------------
# All GitHub access goes through the `gh` CLI, which brings its own auth — so
# there is no token to put in this file. Verify it up front: an unauthenticated
# gh is the single most common reason the app comes up empty.

GH_COMMAND="$(ask "Command to run the GitHub CLI" "gh")"

if command -v "$GH_COMMAND" >/dev/null 2>&1; then
  if "$GH_COMMAND" auth status >/dev/null 2>&1; then
    echo "  ✓ $GH_COMMAND is authenticated"
  else
    echo "  ! $GH_COMMAND is installed but not authenticated — run: $GH_COMMAND auth login"
  fi
else
  echo "  ! $GH_COMMAND not found on PATH — install it before running the app"
fi

echo
echo "Which repositories should be tracked? (space-separated, owner/repo)"
REPOS="$(ask "  Repos" "")"

echo "Optionally track every repo in one or more orgs (space-separated)."
ORGS="$(ask "  Orgs" "")"

BACKFILL_DAYS="$(ask "How many days of history to backfill on first sync?" "90")"
SYNC_MINUTES="$(ask "Minutes between background syncs" "30")"

# --- LLM provider ----------------------------------------------------------
# Used to classify PR size and write the one-line summaries. Optional: with no
# endpoint the app still shows counts, diffstats and review activity.

echo
echo "Select LLM provider (used to classify PRs and summarize them):"
echo "  1) llama.cpp"
echo "  2) vLLM"
provider=""
while [ -z "$provider" ]; do
  choice="$(ask "Provider" "2")"
  case "$choice" in
    1|llama.cpp) provider="llama.cpp"; default_url="http://localhost:8080/v1" ;;
    2|vLLM|vllm) provider="vLLM";      default_url="http://localhost:8000/v1" ;;
    *) echo "  Please enter 1 or 2." ;;
  esac
done

LLM_BASE_URL="$(ask "  $provider base URL (OpenAI-compatible)" "$default_url")"
LLM_MODEL="$(ask "  Model name" "default")"

# --- server ----------------------------------------------------------------
# There is no authentication, so the default bind address is loopback only.
# Reaching it from elsewhere is a job for an SSH tunnel or a reverse proxy that
# does the authenticating — never a wider bind here.

PORT="$(ask "Port to listen on" "4100")"
HOST="$(ask "Address to bind (loopback unless something else authenticates)" "127.0.0.1")"

# --- write -----------------------------------------------------------------

cat > "$CONFIG_FILE" <<EOF
{
  "github": {
    "command": "$(json_escape "$GH_COMMAND")",
    "repos": $(json_array "$REPOS"),
    "orgs": $(json_array "$ORGS"),
    "backfillDays": ${BACKFILL_DAYS}
  },
  "llm": {
    "provider": "$(json_escape "$provider")",
    "baseUrl": "$(json_escape "$LLM_BASE_URL")",
    "model": "$(json_escape "$LLM_MODEL")"
  },
  "sync": {
    "intervalMinutes": ${SYNC_MINUTES}
  },
  "server": {
    "port": ${PORT},
    "host": "$(json_escape "$HOST")"
  }
}
EOF

echo
echo "Wrote $CONFIG_FILE."
echo "  next:  npm install && npm run dev"
