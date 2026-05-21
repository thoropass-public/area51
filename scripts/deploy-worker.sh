#!/usr/bin/env bash
# Deploys the main exploit-server worker (oob.example).
# - Sources .env for the API token + all interpolated values.
# - Renders worker/wrangler.toml from its template.
# - Runs `wrangler deploy` from worker/.

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

"$repo_root/scripts/render-wrangler.sh" worker

cd "$repo_root/worker"
npx wrangler deploy "$@"
