#!/usr/bin/env bash
# Start the local bridge server (keep it running while the agent works):  bash scripts/bridge.sh
exec bash "$(dirname "$0")/node.sh" "$(dirname "$0")/../bridge/server.mjs" "$@"
