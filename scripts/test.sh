#!/usr/bin/env bash
# Run the test suite. Uses `node` if installed, otherwise VS Code's bundled Electron in Node mode.
set -euo pipefail
cd "$(dirname "$0")/.."
if command -v node >/dev/null 2>&1; then
  exec node --test tests/*.test.js
fi
for exe in "${LOCALAPPDATA:-}/Programs/Microsoft VS Code/Code.exe" "${LOCALAPPDATA:-}/Programs/cursor/Cursor.exe"; do
  if [ -x "$exe" ] || [ -f "$exe" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$exe" --test tests/*.test.js
  fi
done
echo "No Node.js runtime found. Install Node 20+ or VS Code." >&2
exit 1
