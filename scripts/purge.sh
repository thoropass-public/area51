#!/usr/bin/env bash
# scripts/purge.sh — interactive admin purge for AREA 51.
#
# No arguments. Reads CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID + the D1
# / R2 names from the repo-root .env. Offers three options:
#
#   1) Autopilot Endpoints — wipes every /-/* row in `endpoints`, plus the
#                            uploaded file of any file-backed row among them.
#   2) Requests            — deletes `requests` rows older than N days.
#   3) Emails              — deletes `emails` rows older than N days AND
#                            their matching emails/<id>.eml objects from R2.
#
# Every destructive step is gated by a y/N confirmation.
#
# Why this exists: the dashboard's purge UI + /api/purge function were
# removed in favor of admins running queries directly. For requests and
# autopilot endpoints the Cloudflare D1 console is enough, but emails are
# coupled with R2 — a bare D1 DELETE leaves orphaned .eml blobs in the
# bucket. This script handles that coupling so D1 and R2 stay in lockstep.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="$repo_root/.env"

if [ ! -f "$env_file" ]; then
  echo "error: $env_file not found." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$env_file"; set +a

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN missing in .env}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID missing in .env}"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-area51}"
: "${R2_BUCKET_NAME:?R2_BUCKET_NAME missing in .env}"
R2_FILES_BUCKET_NAME="${R2_FILES_BUCKET_NAME:-area51-files}"

command -v python3 >/dev/null || { echo "error: python3 required" >&2; exit 1; }
command -v curl    >/dev/null || { echo "error: curl required"    >&2; exit 1; }
command -v npx     >/dev/null || { echo "error: npx required (install Node.js)" >&2; exit 1; }

# ----- helpers -----

wrangler_d1() {  # passes args straight through to `wrangler d1 execute <DB> --remote ...`
  (cd "$repo_root/worker" && npx --no-install wrangler d1 execute "$D1_DATABASE_NAME" --remote "$@")
}

# Run a D1 SELECT that returns rows with an `id` column; print one id per line.
d1_ids() {  # SQL
  wrangler_d1 --command "$1" --json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); rows=d[0].get('results') or []; [print(r['id']) for r in rows]"
}

# Cutoff timestamp `now - N days` as ISO 8601 UTC. Matches the worker's
# `new Date().toISOString()` format so SQL string-compare works.
iso_cutoff() {  # days
  python3 -c "from datetime import datetime, timedelta, timezone
t = datetime.now(timezone.utc) - timedelta(days=$1)
print(t.strftime('%Y-%m-%dT%H:%M:%S.000Z'))"
}

# Delete one R2 object by key via the Cloudflare REST API.
r2_delete() {  # bucket key (e.g., area51-emails emails/abc.eml)
  local bucket="$1" key="$2" enc
  enc="${key//\//%2F}"
  curl -sf -X DELETE \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/$bucket/objects/$enc" \
    >/dev/null
}

# Run a D1 SELECT returning a single named column; print one value per line.
d1_column() {  # SQL column
  wrangler_d1 --command "$1" --json 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); rows=d[0].get('results') or []; [print(r['$2']) for r in rows if r.get('$2')]"
}

read_days() {  # prompts until a non-negative integer is entered; echoes it
  local d
  while true; do
    read -r -p "Purge data older than how many days? " d
    if [[ "$d" =~ ^[0-9]+$ ]]; then
      echo "$d"
      return
    fi
    echo "  ! must be a non-negative integer" >&2
  done
}

confirm() {  # message → 0 if user typed y/Y, 1 otherwise
  local msg="$1" ans
  read -r -p "$msg (y/N) " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

# ----- options -----

purge_autopilot() {
  local keys count ok=0 fail=0
  echo
  echo "This will DELETE every endpoint under /-/* in the 'endpoints' table."
  echo "Manually-defined endpoints (anything not starting with /-/) are NOT touched."

  # File-backed rows own an object in the uploads bucket. Deleting the rows
  # without deleting those objects leaves orphans nothing can reach — the same
  # invisible leak the emails branch exists to prevent.
  keys=$(d1_column "SELECT r2_key FROM endpoints WHERE uri LIKE '/-/%' AND r2_key IS NOT NULL" r2_key) || keys=""
  if [ -n "$keys" ]; then
    count=$(printf '%s\n' "$keys" | grep -c .)
    echo "$count of them serve an uploaded file; those objects will also be deleted"
    echo "from R2 (bucket $R2_FILES_BUCKET_NAME)."
  fi

  confirm "Proceed?" || { echo "Cancelled."; return; }

  if [ -n "$keys" ]; then
    echo
    echo "Deleting uploaded files from R2..."
    while IFS= read -r key; do
      [ -z "$key" ] && continue
      if r2_delete "$R2_FILES_BUCKET_NAME" "$key"; then
        ok=$((ok + 1))
      else
        fail=$((fail + 1))
        printf "  ✗ %s (delete failed)\n" "$key" >&2
      fi
    done <<< "$keys"
    echo "R2: $ok deleted, $fail failed."
  fi

  wrangler_d1 --command "DELETE FROM endpoints WHERE uri LIKE '/-/%'"
}

purge_requests() {
  local days cutoff
  days=$(read_days)
  cutoff=$(iso_cutoff "$days")
  echo
  echo "This will DELETE every row in 'requests' with ts < $cutoff"
  echo "(keeping only the last $days day(s) of captured requests)."
  confirm "Proceed?" || { echo "Cancelled."; return; }
  wrangler_d1 --command "DELETE FROM requests WHERE ts < '$cutoff'"
}

purge_emails() {
  local days cutoff ids count ok=0 fail=0
  days=$(read_days)
  cutoff=$(iso_cutoff "$days")
  echo
  echo "Looking up emails older than $cutoff..."
  ids=$(d1_ids "SELECT id FROM emails WHERE ts < '$cutoff'") || ids=""
  if [ -z "$ids" ]; then
    echo "Nothing to delete."
    return
  fi
  count=$(printf '%s\n' "$ids" | grep -c .)
  echo
  echo "$count email(s) match. This will:"
  echo "  • Delete $count .eml object(s) from R2 (bucket $R2_BUCKET_NAME)"
  echo "  • Delete $count row(s) from D1 'emails' table"
  confirm "Proceed?" || { echo "Cancelled."; return; }

  echo
  echo "Deleting R2 objects..."
  while IFS= read -r id; do
    [ -z "$id" ] && continue
    if r2_delete "$R2_BUCKET_NAME" "emails/$id.eml"; then
      ok=$((ok + 1))
    else
      fail=$((fail + 1))
      printf "  ✗ emails/%s.eml (delete failed)\n" "$id" >&2
    fi
  done <<< "$ids"
  echo "R2: $ok deleted, $fail failed."

  echo
  echo "Deleting D1 rows..."
  wrangler_d1 --command "DELETE FROM emails WHERE ts < '$cutoff'"
}

# ----- menu -----

main() {
  echo "AREA 51 — purge"
  echo
  echo "  1) Autopilot Endpoints   (wipes every /-/*)"
  echo "  2) Requests              (older than N days)"
  echo "  3) Emails                (older than N days; D1 + R2)"
  echo "  q) Quit"
  echo
  local choice
  read -r -p "Choice: " choice
  case "$choice" in
    1) purge_autopilot ;;
    2) purge_requests ;;
    3) purge_emails ;;
    q|Q|"") echo "bye"; exit 0 ;;
    *) echo "unknown choice: $choice" >&2; exit 1 ;;
  esac
}

main
