#!/usr/bin/env bash
# Thin wrapper so the CLI can be run as ./a51 from the repository root.
exec node "$(cd "$(dirname "$0")" && pwd)/cli/a51.mjs" "$@"
