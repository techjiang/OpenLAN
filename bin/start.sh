#!/usr/bin/env sh
# OpenLAN 启动脚本（macOS / Linux）
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 Node.js，请先安装 Node 18+ (https://nodejs.org)"
  exit 1
fi

if [ ! -d "node_modules/qrcode" ]; then
  echo "[初始化] 首次运行正在安装依赖，请稍候..."
  npm install --no-audit --no-fund
fi

exec node server/index.js "$@"
