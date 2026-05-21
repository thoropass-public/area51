#!/usr/bin/env bash
# Deploys the agent worker (agent-a51.thoropentests.com).
# - Sources .env for the API token + all interpolated values.
# - Renders agent-worker/wrangler.toml from its template.
# - Installs AGENT_SECRET as a Worker Secret (idempotent — overwrites).
# - Runs `wrangler deploy` from agent-worker/.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$repo_root/.env"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

if [ -z "${AGENT_SECRET:-}" ]; then
  echo "error: AGENT_SECRET is empty in .env. Generate with: openssl rand -hex 32" >&2
  exit 1
fi

"$repo_root/scripts/render-wrangler.sh" agent

cd "$repo_root/agent-worker"

# Install the secret first (idempotent — overwrites existing value).
# Piped via stdin so the value never appears in argv / shell history.
echo "==> Installing AGENT_SECRET..."
printf '%s' "$AGENT_SECRET" | npx wrangler secret put AGENT_SECRET

echo "==> Deploying agent-worker..."
npx wrangler deploy "$@"
