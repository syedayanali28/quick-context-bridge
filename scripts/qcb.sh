#!/usr/bin/env bash
# qcb CLI wrapper:  bash scripts/qcb.sh <command> [args]   (see bridge/qcb.mjs)
export MSYS_NO_PATHCONV=1  # keep /api/paths intact under Git Bash
exec bash "$(dirname "$0")/node.sh" "$(dirname "$0")/../bridge/qcb.mjs" "$@"
