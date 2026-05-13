#!/bin/bash
# 移除 launchd 排程
set -e

PLIST_NAME="com.user.eagle-inspiration.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ ! -f "$PLIST_TARGET" ]; then
  echo "排程未安裝，無需移除"
  exit 0
fi

launchctl unload "$PLIST_TARGET" 2>/dev/null || true
rm "$PLIST_TARGET"

echo "✓ 已移除排程"
