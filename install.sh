#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$ROOT/scripts/install.mjs"
if command -v cygpath >/dev/null 2>&1; then
  SCRIPT="$(cygpath -w "$SCRIPT")"
fi
exec node "$SCRIPT" "$@"
