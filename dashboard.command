#!/bin/bash
# 雙擊就啟動 Eagle Inspiration Bot dashboard
# 終端機會自動開，會在預設瀏覽器打開 localhost:3030
# 用完按 Ctrl-C 結束、關掉終端機視窗

cd "$(dirname "$0")"

# 找 node：先試 PATH，再試常見的 Homebrew 路徑
if command -v node >/dev/null 2>&1; then
  NODE_BIN=node
elif [ -x /opt/homebrew/bin/node ]; then
  NODE_BIN=/opt/homebrew/bin/node
elif [ -x /usr/local/bin/node ]; then
  NODE_BIN=/usr/local/bin/node
else
  echo "❌ 找不到 node。請先在終端機跑：brew install node"
  echo "按任意鍵結束…"
  read -n 1
  exit 1
fi

echo "啟動 Eagle Inspiration Bot dashboard…"
echo "(這個視窗請保持開著，關掉視窗 = 關掉 dashboard)"
echo ""
exec "$NODE_BIN" bot.js --config-ui
