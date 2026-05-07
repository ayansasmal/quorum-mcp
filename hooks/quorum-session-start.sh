#!/usr/bin/env bash
# Fires on UserPromptSubmit. Emits session_start_required once per calendar day.
set -e
[ -f ".quorum" ] || exit 0
TODAY=$(date +%Y%m%d)
if [ -f ".quorum-session" ]; then
  [ "$(cat .quorum-session 2>/dev/null)" = "$TODAY" ] && exit 0
fi
echo "$TODAY" > .quorum-session
echo "[QUORUM: session_start_required]"
echo "Project: $(head -1 ".quorum" 2>/dev/null || echo 'unknown')"
