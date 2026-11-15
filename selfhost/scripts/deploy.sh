#!/usr/bin/env bash
# 部署自托管 Server 到本机。需要 sudo。
# 用法: ./deploy.sh [安装目录]  默认 /opt/dsh-remote-server
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="${1:-/opt/dsh-remote-server}"
NODE="$(readlink -f "$(command -v node)")"

echo "==> 目标目录: $DEST"
echo "==> node: $NODE"
sudo mkdir -p "$DEST/data"
sudo cp -a "$REPO/selfhost/server-dist" "$DEST/dist"

# protocol 作为 @dsh-remote/protocol 提供给 server 运行时。
sudo mkdir -p "$DEST/node_modules/@dsh-remote"
sudo cp -a "$REPO/packages/protocol" "$DEST/_protocol"
sudo ln -sfn "$DEST/_protocol" "$DEST/node_modules/@dsh-remote/protocol"

# 依赖：优先复用仓库已安装的 node_modules，否则从锁文件安装。
if [[ -d "$REPO/node_modules" ]]; then
  sudo cp -a "$REPO/node_modules" "$DEST/"
else
  echo "==> 仓库无 node_modules，先在仓库执行 pnpm install"
  (cd "$REPO" && pnpm install --ignore-scripts)
  sudo cp -a "$REPO/node_modules" "$DEST/"
fi
sudo ln -sfn "$DEST/_protocol" "$DEST/node_modules/@dsh-remote/protocol"

# 配置：仅在不存在时生成，绝不覆盖已有 .env（避免丢失密码）。
if [[ ! -f "$DEST/.env" ]]; then
  sudo cp "$REPO/selfhost/deploy/.env.example" "$DEST/.env"
  sudo chmod 600 "$DEST/.env"
  echo "==> 已生成 $DEST/.env —— 请立即修改账号密码和 PUBLIC_URL"
else
  echo "==> 保留已有 $DEST/.env"
fi
sudo chown -R "$(id -u):$(id -g)" "$DEST"

# systemd unit（修正 node 绝对路径）
sudo sed "s|__NODE__|$NODE|g; s|__DEST__|$DEST|g; s|__USER__|$(id -un)|g" \
  "$REPO/selfhost/deploy/dsh-remote-server.service.template" \
  > /tmp/dsh-remote-server.service
sudo cp /tmp/dsh-remote-server.service /etc/systemd/system/dsh-remote-server.service

# nginx 反代（需要已有 TLS 证书；按实际证书路径调整后手动安装）
echo "==> nginx 配置样例: selfhost/deploy/nginx-8445.conf"
echo "    证书路径 /etc/nginx/ssl/zerossl-fullchain.crt 与 zerossl.key 需按你的环境核对。"
echo "    安装后: sudo nginx -t && sudo nginx -s reload"
echo "    防火墙: sudo ufw allow 8445/tcp"

sudo systemctl daemon-reload
sudo systemctl enable --now dsh-remote-server
sleep 2
sudo systemctl is-active dsh-remote-server
echo "==> 验证: curl -k https://\$(hostname -I | awk '{print \$1}'):8445/health"
