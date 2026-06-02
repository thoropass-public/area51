#!/usr/bin/env bash
# Deploys the area51-cleanup worker (the scheduled D1 + R2 retention trimmer).
# - Sources .env for the API token + all interpolated values.
# - Renders cleanup-worker/wrangler.toml from its template.
# - Runs `wrangler deploy` from cleanup-worker/.
#
# No secret install and no Custom Domain step: the worker has only a
# scheduled() handler, driven by the cron declared in its wrangler.toml.
# Deploying registers the cron trigger automatically.

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

"$repo_root/scripts/render-wrangler.sh" cleanup

cd "$repo_root/cleanup-worker"
npx wrangler deploy "$@"
