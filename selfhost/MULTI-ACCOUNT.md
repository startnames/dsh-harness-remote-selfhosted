# 多账号注册与管理（本次新增）

在自托管 Server 基础上增加了**邀请码注册、账号管理后台、按账号严格隔离设备**。
上游原版是单账号（环境变量写死），所有设备全局共享。

## 已部署状态（2026-11-16）

| 项 | 值 |
|---|---|
| 地址 | `https://106.52.246.121:8445` |
| 初始管理员 | `owner@106.52.246.121`（密码在 `.env`，与上游单账号时相同） |
| 自助注册 | 开启，**需要邀请码** |
| 邀请码 | 见本机 `selfhost/deploy/.invite-code.txt`（**绝不入库**） |
| 数据版本 | `state.json` 由 v1 重新初始化为 v2 |
| 测试 | 75/75 通过（含 13 个多账号单测） |

> 重新初始化会清空旧设备注册。本机 Host 已重新登录上线；**其他旧客户端需重新登录配对**。

## 游客怎么用

1. 浏览器打开 `https://106.52.246.121:8445/app/register`
2. 填账号、密码（≥12 位）、邀请码
3. 注册后自动登录，进入 `/app/remote` 设备页
4. Host 和客户端都用**同一账号**登录 Remote 插件即可互通

注册页在「注册关闭」时不显示；邀请码只在服务端配置为空时才免填。

## 管理员功能

管理员登录后，设备页顶部出现「账号管理」，进入 `/app/admin`：

- 账号列表/新增账号/禁用启用/删除/重置任意账号密码
- 查看与删除**全部账号**的设备
- 修改自己的密码（需验旧密码）
- 只读展示注册策略

初始管理员不能被禁用/删除（防止把自己锁在外面）。

## 环境变量

```dotenv
DSH_SERVER_ACCOUNT=owner@example.com       # 初始管理员，启动时按此重置其密码
DSH_SERVER_PASSWORD=...                    # 至少 12 位
DSH_SERVER_REGISTRATION_ENABLED=true       # false = 关闭自助注册
DSH_SERVER_INVITE_CODE=随机值              # 留空 = 注册不需邀请码
```

## 安全设计（严格隔离）

- 每个设备在 `state.json` 里有 `owner` 字段，**只归属一个账号**。
- API 层：`/api/v1/account/devices`、`/api/v1/devices`（列 Host）、设备详情/presence、改名
  都按 owner 过滤；跨账号返回 `MEMBERSHIP_REQUIRED`。
- Gateway 层（`connect.request`）：client 与 host 必须同账号才能建立连接——
  这是最底层的安全网，即使绕过 API 也无法跨账号连接。
- 账号被禁用/删除/改密时，其所有设备 token 立即失效，WebSocket 连接也会被切断。
- 管理员改密、禁用、删除账号会同时清掉该账号所有 Web session。
- 密码用 scrypt + 每账号随机 salt 存 verifier，磁盘不存明文。

## 源码改动

| 文件 | 改动 |
|---|---|
| `apps/server/src/store.ts` | 重写为多账号 v2 state；v1 自动迁移；设备归属；注册策略；账号管理 |
| `apps/server/src/server.ts` | 注册/登录/改密/管理 API；session→账号映射；所有设备路由按账号隔离 |
| `apps/server/src/gateway.ts` | `connect.request` 同账号校验；hello/每帧校验账号仍启用 |
| `apps/server/src/main.ts` | 透传注册策略环境变量 |
| `apps/server/web/src/*` | 注册页、管理后台、路由、管理员入口 |

原始单账号版本完整备份在 `selfhost/upstream-backup/`。

## 恢复单账号原版

1. 停服务，把 `selfhost/upstream-backup/` 里的 8 个文件覆盖回原路径；
2. 用备份的 `state.json.bak-*` 恢复 v1 数据；
3. 删掉 `.env` 里的 `DSH_SERVER_REGISTRATION_ENABLED` / `DSH_SERVER_INVITE_CODE`；
4. `sudo systemctl restart dsh-remote-server`。
