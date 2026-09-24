# 部署指南（Docker / 服务器）

> 前提先说清楚：本服务**自身没有 TLS**，账号库/审计是本地 JSON 文件（无多进程并发保护）。
> 这套部署方案的前提是：**容器边界 + 前置反代终止 HTTPS**。三件事缺一不可：
> ① 建第一个账号切到 accounts 模式；② 前置 nginx/caddy 做 HTTPS；③ data 目录只归服务本身写。

## 一、Docker 部署（推荐）

```bash
cd app
mkdir -p data
# 没有 .env 就建一个空的（AI Key / SMTP 都可以在管理后台 UI 里配，会写进 data/.env）
touch data/.env
docker compose up -d --build
curl http://127.0.0.1:8787/api/health   # {"ok":true,...} 即成功
```

浏览器开 `http://服务器IP:8787`，**第一件事：建立第一个账号（自动成为 owner）**。
此后除健康检查/登录/注册外全部接口要求登录，且不可回退到免登录。

### 数据在哪

| 文件 | 位置（容器内 → 宿主机） | 内容 |
|---|---|---|
| 账号库 | `/app/data/accounts.json` → `./data/` | 口令哈希、会话哈希 |
| 审计日志 | `/app/data/audit.jsonl` → `./data/` | 全量操作留痕 |
| 配置 | `/app/data/.env` → `./data/` | AI Key（打码显示）、SMTP 设置 |
| 记忆 | `/app/data/corrections.jsonl` → `./data/` | AI 修正记忆门 |
| 验证码库 | `/app/data/pending-registrations.json` → `./data/` | 注册验证码（只落哈希） |

升级版本：`git pull && docker compose up -d --build` —— 数据在卷里，不动。

### 备份

```bash
tar czf cad-backup-$(date +%F).tgz data/
```

## 二、HTTPS（公网必须）

服务只监听容器内 0.0.0.0 → 宿主机 8787。公网入口请挂反代，示例（caddy 最省事）：

```
cad.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx 等价：`location / { proxy_pass http://127.0.0.1:8787; proxy_set_header Host $host; }` + certbot 证书。

**不要**把 8787 直接暴露到公网：明文 HTTP 会把口令和 AI Key 一起裸奔。

## 三、已有 VPS 时的非 Docker 部署

Node ≥ 22、Python3 + `pip install ezdxf`：

```bash
npm ci && npm run build
mkdir -p data && touch data/.env
APP_HOST=0.0.0.0 \
APP_ENV_PATH=$PWD/data/.env APP_ACCOUNTS_PATH=$PWD/data/accounts.json \
APP_AUDIT_PATH=$PWD/data/audit.jsonl APP_MEM_PATH=$PWD/data/corrections.jsonl \
APP_REGISTRATIONS_PATH=$PWD/data/pending-registrations.json \
PORT=8787 node server/server.mjs
```

用 systemd 托管（`Restart=always`），或用 windows-autostart-service 的思路做计划任务。

## 四、上服务器前的安全自查

- [ ] 建立第一个账号（accounts 模式），确认 `/api/auth/mode` 返回 `mode: "accounts"`
- [ ] HTTPS 反代已就位，`http://` 入口已封
- [ ] `APP_HOST` 只在容器/需要监听外网时才设为 `0.0.0.0`（本地自用保持默认回环）
- [ ] 邮箱注册默认**关闭**（`SIGNUP_OPEN` 不设），要开放时管理员在后台打开——注册接口永远不成为后门
- [ ] `data/` 目录权限 700，定期备份
- [ ] 知道边界：无二次验证、无密码找回（管理员重置）、审计无防篡改——见 `/api/security/policy` 照实自述

## 五、本机没有 Docker？——镜像构建在服务器上做

Dockerfile 采用两阶段构建，构建期需要拉取 npm 依赖与 ezdxf wheel（国内服务器建议配置镜像加速）。
镜像构建完成后 `docker save` / `docker load` 也可以离线搬运。
