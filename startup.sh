#!/bin/sh
# Revive contract: the platform runs this after a hibernate/restore and expects
# the dev server back on 0.0.0.0:8080. It must be idempotent and return fast.
#
# `cd /workspace` was wrong for this checkout — the path only exists in the
# hosted sandbox, so a restore on any other checkout died on `cd` before
# starting anything. Resolve the script's own directory instead.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

# Free a stale preview server (ignore "nothing to stop").
node scripts/preview.mjs stop >/dev/null 2>&1 || true

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi

npm run dev >>/tmp/app-startup.log 2>&1 &
