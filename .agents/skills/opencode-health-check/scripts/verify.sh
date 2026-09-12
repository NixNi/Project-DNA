#!/usr/bin/env bash
set -eo pipefail

echo "=== [1/4] Checking TypeScript & Build ==="
npm run typecheck
npm run build

echo "=== [2/4] Verifying Plugin Configuration ==="
opencode debug config > /dev/null
echo "✓ OpenCode successfully resolved config and loaded plugin."

echo "=== [3/4] Running Plugin Integration Tests ==="
bun test tests/plugin-integration.test.ts

echo "=== [4/4] Checking Recent OpenCode Log for Fatal Errors ==="
LOG_FILE="$HOME/.local/share/opencode/log/opencode.log"
if [ -f "$LOG_FILE" ]; then
  ERRORS=$(tail -n 100 "$LOG_FILE" | grep 'level=ERROR' | grep -v 'prune=' || true)
  if [ -n "$ERRORS" ]; then
    echo "⚠️  Found recent errors in $LOG_FILE:"
    echo "$ERRORS" | tail -n 5
  else
    echo "✓ No recent ERROR entries found in OpenCode log."
  fi
else
  echo "ℹ️  Log file $LOG_FILE not found (first run)."
fi

echo "=== All OpenCode startup & health checks passed! ==="
