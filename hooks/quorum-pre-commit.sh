#!/usr/bin/env bash
# Fires on PreToolUse: Bash. Emits pre-commit signal with staged file list.
# Hook script checks if the bash command is a git commit.
set -e
[ -f ".quorum" ] || exit 0
# CLAUDE_TOOL_INPUT contains the JSON input — check for git commit
INPUT="${CLAUDE_TOOL_INPUT:-}"
COMMAND=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | cut -d'"' -f4)
echo "$COMMAND" | grep -q "^git commit" || exit 0
STAGED=$(git diff --cached --name-only 2>/dev/null)
[ -z "$STAGED" ] && exit 0
COUNT=$(echo "$STAGED" | wc -l | tr -d '[:space:]')
echo "[QUORUM: pre-commit]"
echo "staged ($COUNT files): $(echo "$STAGED" | tr '\n' ' ')"
