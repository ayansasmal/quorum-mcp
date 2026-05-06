#!/usr/bin/env bash
# Fires on PostToolUse: TodoWrite. Emits task-completed when status is "completed".
set -e
[ -f ".quorum" ] || exit 0
OUTPUT=$(cat)
echo "$OUTPUT" | grep -qE '"status"\s*:\s*"completed"' || exit 0
echo "[QUORUM: task-completed]"
echo "extract knowledge from recently completed task(s)"
