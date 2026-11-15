# 自托管定制版说明

本仓库是 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote) 的**私有定制镜像**，
用于把 Remote 的信令/中继/账号服务从第三方 `dsh.r2049.cn` 换成自己的服务器，
便于自主扩展、固定版本、审计代码。

> 这是独立的社区项目，不是 DeepSeek 官方产品。上游许可证为 MIT，见 [LICENSE](LICENSE)。

## 上游基线

| 项 | 值 |
|---|---|
| 上游 commit | `50e6570299e8a022e191d6d37f968d5833b170ee` |
| 上游仓库版本 | `0.6.5` |
| 本机安装的插件 | `ds-harness-remote@0.6.5`（npm 包，与上游版本一致） |
| 拉取时间 | 2026-11-16 |

版本一致很重要：插件与服务端共用 `@dsh-remote/protocol`，跨版本可能出现载体不兼容。
本仓库同时保留已安装插件的完整产物，确保可以在不重新构建插件的情况下复现当前环境。

## 仓库结构

```
.
├── apps/                        上游：server / android / browser / vscode
├── packages/                    上游：plugin / protocol / crypto / webrtc /
│                                     client-core / tui / tui-plugin
├── docs/ locale/ scripts/       上游文档、多语言、校验脚本
├── README*.md                   上游原文（未改动）
│
├── vendor/
│   └── plugin-0.6.5-installed/   ★ 本机实际安装的 npm 插件包完整留档
│                                   （含 dist/index.js 4MB 打包产物、client.js、清单）
│
└── selfhost/                     ★ 本次自托管定制内容
    ├── README.md                本文件
    ├── deploy/
    │   ├── nginx-8445.conf            nginx 反代样例（8445 → 127.0.0.1:18080）
    │   ├── dsh-remote-server.service.template   systemd unit 模板
    │   └── .env.example              配置模板（密码占位符）
    ├── scripts/
    │   ├── build.sh                  从源码重建 protocol + server
    │   ├── deploy.sh                 一键部署到本机
    │   └── check-secrets.sh          提交前密钥自检
    └── server-dist/              ★ 服务端构建产物（dist/，不含 node_modules）
```

`node_modules/` 不入库——由根目录 `pnpm install` 重建。

## 本次实际部署（2026-11-16）

| 项 | 值 |
|---|---|
| Server 地址 | `https://106.52.246.121:8445` |
| 后端监听 | `127.0.0.1:18080`（不直接暴露） |
| 安装目录 | `/opt/dsh-remote-server` |
| 服务管理 | systemd `dsh-remote-server.service`，开机自启 + 崩溃重启 |
| TLS | 复用现有 ZeroSSL 证书（SAN 含 `IP:106.52.246.121`，2027-02-05 到期） |
| 防火墙 | `ufw allow 8445/tcp` |
| WebSocket | nginx 需支持 `/ws/v1/connect` 的 Upgrade，idle timeout > 75s |
| 插件配置 | 通过回环控制路由 `settings.server.set` **热切换**，无需重启 Harness |
| 配置落盘 | `~/.dsh-rc/profiles/web/cordis.patch.yml` 中 `- id: ds-harness-remote` |
| 身份目录 | `~/.dsh-rc/ds-harness-remote/servers/<sha256(origin)>/{host,client}/` |

验证命令（回环控制路由需带该实例签名的 `dsh-auth` cookie）：

```bash
curl -k https://127.0.0.1:8445/health
# 插件日志出现 serverVersion: "self-hosted/0.1.0" 即表示连的是自建服务
tail ~/.dsh-rc/logs/ds-harness-remote/host.log
```

## 为什么换服务器 = 换账号体系

`serverStorageDirectory()` 用 `sha256(new URL(serverUrl).origin)` 生成目录名。
换 origin 会产生全新的 `device.json` / `device.key` / `trusted-peers.json`，
因此**必须重新登录、重新配对所有设备**，旧的客户端凭据自动失效。
这是预期行为，也是「信任根收回自己手里」的直接体现。

## 切换后仍需自己授权一次

热切换只改地址，Host 在新服务器上还没有账号，需通过控制路由登录：

```
POST /ds-harness-remote/host.account.login
{ "email": "...", "password": "..." }
```

或在 Remote 设置面板用账号密码登录。成功后日志出现
`Host account authorized` 与 `server control connection online`。

## 从源码重建与部署

```bash
./selfhost/scripts/build.sh        # 重建 protocol + server
./selfhost/scripts/check-secrets.sh # 提交前自检
sudo ./selfhost/scripts/deploy.sh   # 部署（不会覆盖已有 .env）
```

`deploy.sh` 会：复制 `server-dist/`、把 `packages/protocol` 挂成
`@dsh-remote/protocol`、复用仓库 `node_modules`、安装 systemd unit（自动填入 node 绝对路径）。
nginx 配置和防火墙规则需按实际环境核对证书路径后手动安装。

## 回滚到上游服务器

1. 调控制路由 `settings.server.set`，`serverUrl` 改回 `https://dsh.r2049.cn`（热切换，立即生效）；
2. 或从 `cordis.patch.yml` 删除 `- id: ds-harness-remote` 覆盖条目，让 bundle 自带配置生效；
3. `sudo systemctl disable --now dsh-remote-server`，删除 nginx 8445 配置并 reload；
4. 用原账号重新登录、重新配对。

## 安全边界（如实说明）

自托管把**账号、设备目录、公钥分发、Relay 转发**从第三方收回到自己机器，
但以下不变：

- 插件代码本身仍是第三方、以 Node 权限运行在 Harness 进程内，能访问工作区、subprocess、settings；
- 插件具备通过官方 `pluginManager.updateBundle` 在线升级的能力（本机已固定 `0.6.5`）；
- `terminal.enabled` 默认开启，且交互式终端**独立于 Agent 审批**、以 Host 用户身份运行；
- 传输内容是 Noise_IK_25519_ChaChaPoly_SHA256 端到端密文，但**身份不是带外可验证的**：
  客户端首次从服务器获取 Host 公钥属于 TOFU，之后变更会被本地 `trusted-peers.json` 拒绝。

若需进一步收紧：关闭终端、锁定插件版本、清空 loopback 端口、给 8445 加 IP 白名单/basic auth、
部署 coturn 以启用 P2P 直连。

## 提交前务必

```bash
./selfhost/scripts/check-secrets.sh
```

严禁入库：`.env`、`state.json`、`device.key`、`trusted-peers.json`、
`server-credentials.json`、`.credentials.yaml`、`.git-credentials`、任何私钥或 token。
`.gitignore` 已覆盖这些路径，但每次提交前仍应自检。
