#!/bin/bash
# 安裝 launchd 排程：每週一 9:00 自動執行 bot.js
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"

if [ -z "$NODE_PATH" ]; then
  echo "❌ 找不到 node，請先確認 Node.js 已安裝"
  exit 1
fi

NODE_DIR="$(dirname "$NODE_PATH")"
PLIST_NAME="com.user.eagle-inspiration.plist"
PLIST_TARGET="$HOME/Library/LaunchAgents/$PLIST_NAME"
TEMPLATE="$PROJECT_DIR/$PLIST_NAME.template"

mkdir -p "$PROJECT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"

# 從 template 生成實際的 plist（把路徑塞進去）
sed -e "s|__NODE_PATH__|$NODE_PATH|g" \
    -e "s|__NODE_DIR__|$NODE_DIR|g" \
    -e "s|__PROJECT_DIR__|$PROJECT_DIR|g" \
    "$TEMPLATE" > "$PLIST_TARGET"

# 如果之前已載入，先卸載
launchctl unload "$PLIST_TARGET" 2>/dev/null || true

# 載入
launchctl load "$PLIST_TARGET"

echo "✓ 已安裝排程：每週一早上 9:00 自動執行"
echo "  plist 位置：$PLIST_TARGET"
echo "  log 位置：$PROJECT_DIR/logs/bot.log"
echo ""
echo "查看排程狀態：launchctl list | grep eagle-inspiration"
echo "立即觸發測試：launchctl start com.user.eagle-inspiration"
