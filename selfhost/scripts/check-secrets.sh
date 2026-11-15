#!/usr/bin/env bash
# 提交前自检：扫描将要入库的内容，发现疑似密钥立即失败。
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
FAILED=0

echo "==> 1. 检查被 git 跟踪的敏感文件名"
# 只匹配真实密钥文件；.env.example / .env.template 属于公开模板，允许入库。
BAD=$(git ls-files | grep -Ei '(^|/)\.env$|(^|/)\.env\.local$|(^|/)\.env\.production$|(^|/)state\.json$|(^|/)\.credentials\.yaml$|(^|/)\.git-credentials$|device\.key$|(^|/)(id_rsa|id_ed25519)[^/]*$|\.pem$|\.p12$|\.pfx$' || true)
if [[ -n "$BAD" ]]; then echo "发现敏感文件被跟踪:"; echo "$BAD"; FAILED=1; else echo "  OK"; fi

echo "==> 2. 检查配置模板之外的真实密码"
BAD=$(grep -rIn --exclude-dir=.git --exclude='*.md' --exclude='*.sh' \
  --exclude='.env.example' --exclude='*.template' \
  -E '^[[:space:]]*DSH_SERVER_PASSWORD[[:space:]]*=' selfhost/ 2>/dev/null \
  | grep -v 'REPLACE_WITH_YOUR_OWN_PASSWORD' || true)
if [[ -n "$BAD" ]]; then echo "疑似真实密码:"; echo "$BAD"; FAILED=1; else echo "  OK"; fi

echo "==> 3. 检查已知 token 前缀（排除本脚本自身的检测正则）"
BAD=$(grep -rIn --exclude-dir=.git --exclude='check-secrets.sh' \
  -E 'ghp_[A-Za-z0-9]{20,}|gitee_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|github_pat_' \
  selfhost/ vendor/ 2>/dev/null | head -20 || true)
if [[ -n "$BAD" ]]; then echo "疑似 token:"; echo "$BAD"; FAILED=1; else echo "  OK"; fi

echo "==> 4. 检查私钥内容是否误入 vendor/ 与 selfhost/"
BAD=$(grep -rIl --exclude-dir=.git -E 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY' vendor/ selfhost/ 2>/dev/null || true)
if [[ -n "$BAD" ]]; then echo "发现私钥内容:"; echo "$BAD"; FAILED=1; else echo "  OK"; fi

echo "==> 5. 检查上游源码中是否夹带 .env 或凭证文件"
BAD=$(git ls-files | grep -Ei '(^|/)\.env$|(^|/)\.git-credentials$|(^|/)\.credentials\.yaml$' || true)
if [[ -n "$BAD" ]]; then echo "发现:"; echo "$BAD"; FAILED=1; else echo "  OK"; fi

if [[ "$FAILED" -ne 0 ]]; then echo "==> 自检失败，请先清理再提交"; exit 1; fi
echo "==> 全部通过"
