#!/usr/bin/env bash
# render-wrangler.sh <worker|agent>
#
# Reads the repo-root .env file and substitutes ${VAR} placeholders in
# <target>/wrangler.toml.template, writing the result to <target>/wrangler.toml.
#
# Exits non-zero on missing .env, missing template, or unsubstituted ${VAR}.

set -euo pipefail

if [ $# -ne 1 ] || ! { [ "$1" = "worker" ] || [ "$1" = "agent" ]; }; then
  echo "usage: $0 <worker|agent>" >&2
  exit 2
fi

target="$1"
case "$target" in
  worker) dir="worker" ;;
  agent)  dir="agent-worker" ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$repo_root/.env"
template="$repo_root/$dir/wrangler.toml.template"
output="$repo_root/$dir/wrangler.toml"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi
if [ ! -f "$template" ]; then
  echo "error: $template not found." >&2
  exit 1
fi

# Load .env into the environment so envsubst can see the values.
set -a
# shellcheck disable=SC1090
. "$env_file"
set +a

# Restrict substitution to known names so an unset/typo'd variable in the
# template doesn't silently become an empty string.
allowed_vars='${CLOUDFLARE_API_TOKEN} ${CLOUDFLARE_ACCOUNT_ID} '\
'${D1_DATABASE_NAME} ${D1_DATABASE_ID} '\
'${WORKER_NAME} ${FALLBACK_ADDRESS} '\
'${PAGES_PROJECT_NAME} '\
'${AGENT_WORKER_NAME} ${AGENT_SECRET}'

envsubst "$allowed_vars" < "$template" > "$output"

# Sanity-check: any ${VAR} left over means an unset variable.
if grep -q '\${' "$output"; then
  echo "error: unsubstituted placeholders in $output:" >&2
  grep -n '\${' "$output" >&2
  rm "$output"
  exit 1
fi

echo "rendered: $output"
