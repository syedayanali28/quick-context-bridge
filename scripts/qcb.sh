#!/usr/bin/env bash
# qcb CLI wrapper:  bash scripts/qcb.sh <command> [args]   (see bridge/qcb.mjs)
exec bash "$(dirname "$0")/node.sh" "$(dirname "$0")/../bridge/qcb.mjs" "$@"
