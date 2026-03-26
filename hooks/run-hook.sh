#!/bin/bash
# Cross-platform hook runner for claude-subconscious
# Handles missing CLAUDE_PLUGIN_ROOT on Linux
# Usage: run-hook.sh <script-name.ts>

set -e

SCRIPT_NAME="$1"

# Method 1: Use CLAUDE_PLUGIN_ROOT if set
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
    PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"
else
    # Method 2: Derive from script location
    # This script is at <plugin-root>/hooks/run-hook.sh
    SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || echo "$0")"
    SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
    PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# Verify paths exist
if [ ! -f "$PLUGIN_ROOT/hooks/silent-npx.cjs" ]; then
    echo "Error: Cannot find silent-npx.cjs at $PLUGIN_ROOT/hooks/" >&2
    exit 1
fi

if [ ! -f "$PLUGIN_ROOT/scripts/$SCRIPT_NAME" ]; then
    echo "Error: Cannot find script $SCRIPT_NAME at $PLUGIN_ROOT/scripts/" >&2
    exit 1
fi

# Run the hook
exec node "$PLUGIN_ROOT/hooks/silent-npx.cjs" tsx "$PLUGIN_ROOT/scripts/$SCRIPT_NAME"
