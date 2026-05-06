#!/usr/bin/env bash
# Fires on PostToolUse: Write/Edit. Emits knowledge-source-updated for
# memory files and CLAUDE.md only. Silent for all other writes.
set -e
[ -f ".quorum" ] || exit 0
# CLAUDE_TOOL_INPUT contains the JSON input — extract file_path
INPUT="${CLAUDE_TOOL_INPUT:-}"
# Note: grep-based JSON extraction; does not handle escaped quotes in file paths
FILE=$(echo "$INPUT" | grep -o '"file_path":"[^"]*"' | cut -d'"' -f4)
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *memory/*.md|*/CLAUDE.md)
    echo "[QUORUM: knowledge-source-updated]"
    echo "file: $FILE"
    ;;
  *)
    exit 0
    ;;
esac
