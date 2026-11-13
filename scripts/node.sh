#!/usr/bin/env bash
# Run Node: the real `node` if installed, otherwise VS Code's (or Cursor's) bundled Electron in Node mode.
if command -v node >/dev/null 2>&1; then exec node "$@"; fi
for exe in "${LOCALAPPDATA:-}/Programs/Microsoft VS Code/Code.exe" "${LOCALAPPDATA:-}/Programs/cursor/Cursor.exe"; do
  if [ -f "$exe" ]; then ELECTRON_RUN_AS_NODE=1 exec "$exe" "$@"; fi
done
echo "No Node.js runtime found. Install Node 20+ or VS Code." >&2
exit 1
