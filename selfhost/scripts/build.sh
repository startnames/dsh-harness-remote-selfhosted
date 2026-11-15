#!/usr/bin/env bash
# 从源码重建 @dsh-remote/protocol 与 server 的构建产物。
# 需要 Node.js >=22、pnpm >=9。产物输出到 selfhost/server-dist/。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

echo "==> 安装工作区依赖"
pnpm install --ignore-scripts

echo "==> 构建 protocol"
pnpm --filter @dsh-remote/protocol build

echo "==> 构建 server"
pnpm --filter @dsh-remote/server build

echo "==> 同步产物到 selfhost/server-dist/"
rm -rf selfhost/server-dist
mkdir -p selfhost/server-dist
cp -a apps/server/dist/. selfhost/server-dist/

echo "==> 完成。可用 deploy.sh 部署。"
