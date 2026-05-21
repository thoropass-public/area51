#!/usr/bin/env bash
# Deploys the dashboard Pages project (area51.thoropentests.com).
# - Sources .env for the API token + PAGES_PROJECT_NAME.
# - Runs `wrangler pages deploy` from pages/.

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

cd "$repo_root/pages"
# We run from pages/ so wrangler picks up no parent wrangler.toml.
"$repo_root/worker/node_modules/.bin/wrangler" pages deploy . \
  --project-name "$PAGES_PROJECT_NAME" \
  --branch main \
  --commit-dirty=true "$@"
