#!/usr/bin/env bash
# Fires on Stop. Nudges reflect() when files changed and reflect not yet done.
set -e
[ -f ".quorum" ] || exit 0
[ -f ".quorum-reflected" ] && exit 0
CHANGES=$( { git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u | wc -l | tr -d '[:space:]')
CHANGES="${CHANGES:-0}"
[ "$CHANGES" -lt "3" ] && exit 0
echo "[QUORUM: ${CHANGES} file(s) changed — reflect() before ending session?]"
