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

## 五、容器里访问 NAS 上的其他服务（AI 网关为例）★ 血泪坑

**症状**：「自动拉取」模型列表报 `拉取失败：fetch failed`；此时密钥是对的，NAS 本机 curl 也正常。

**根因**：容器在自己的 bridge 网络里（如 `xxx_default`，网关 192.168.16.x），
**访问 NAS 的局域网 IP（`192.168.2.2`）的发布端口会被丢包**——超时/ECONNRESET。
这不是防火墙没开，也不是密钥问题，是 Docker bridge → 宿主机 LAN IP 的回环 NAT 在群晖上不通。

**解法（三选一，推荐 ①）**：

1. **走 Docker 网桥网关**：把地址换成 `http://172.17.0.1:<端口>/v1`（默认 bridge 的网关地址）。
   容器内实测可达。缺点：IP 是约定俗成的默认值，换环境要重确认。
2. **加入同一张 Docker 网络**：在 compose 里声明外部网络并加入服务，
   之后可用容器名互访（`http://gpt-load:3002/v1`），不受 IP 变化影响：
   ```yaml
   networks:
     gpt-load_default: { external: true }
   services:
     furniture-cad:
       networks: [gpt-load_default]
   ```
3. **`network_mode: host`**：直接用宿主机网络，`127.0.0.1` 即可达；代价是端口占用与隔离变弱。

**配套检查**：拉通之后还要确认**模型名真的在清单里**。
本项目的「自动拉取」会如实显示 `source: live` 与真实模型 id；若配置的 `AI_MODEL`
不在其中（例如填了 `deepseek-reasoner` 而网关只提供 `openrouter/free`），
看得见的模型列表和看不见的对话调用都会失败。

**排障口诀**：容器内 `curl` 通常不存在，用 `docker exec <容器> node -e "fetch(...)"` 代替；
三个变量分别验——网络可达（TCP 通不通）→ 鉴权（401 还是 200）→ 模型名（在不在列表里）。

**改配置不用重启**：服务端每次请求都重读 env 文件（`readEnv()`），改完立即生效。

## 六、本机没有 Docker？——镜像构建在服务器上做

Dockerfile 采用两阶段构建，构建期需要拉取 npm 依赖与 ezdxf wheel（国内服务器建议配置镜像加速）。
镜像构建完成后 `docker save` / `docker load` 也可以离线搬运。
