#!/usr/bin/env bash
# Publishes the last 200 bot log lines (without player chat) to the "logs" branch.
[ -f /tmp/bot.log ] || exit 0
D=$(mktemp -d); cd "$D"
grep -v -E ' CHAT' /tmp/bot.log | tail -n 200 > live.log
git init -q; git checkout -q -b logs
git add live.log
git -c user.name="log-bot" -c user.email="log-bot@users.noreply.github.com" commit -qm "log $(date -u +%H:%M:%S)"
git push -q -f "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" logs 2>/dev/null || true
