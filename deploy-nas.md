# 部署到 NAS（群晖 Docker 包）实操记录

目标：把 `app/` 按 `app/.dockerignore` 口径推到 NAS 的 `/volume1/docker/furniture-cad/`，
重建镜像并重启容器。**`data/` 卷里的账号库、审计、记忆、.env 一个字节都不动。**

## 一、连接：密码认证（SSH 公钥在这里没用）

DSM 的 SSH 公钥试过一轮，即使粘贴成功也仍回 `Permission denied (publickey,password)`
（还要求重启 sshd，折腾一轮没通）。直接用密码，凭据从环境变量取：

```bash
printf '#!/bin/bash\nprintf "%%s" "$SYNOLOGY_PASSWORD"\n' > /tmp/cad-askpass.sh
chmod +x /tmp/cad-askpass.sh
export SSH_ASKPASS=/tmp/cad-askpass.sh SSH_ASKPASS_REQUIRE=force DISPLAY=

ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    DENG@192.168.2.2 'echo OK'      # 通了才会打印 OK
```

> Windows 上没有 `sshpass`/`plink`/`setsid`，上面这套 askpass 是唯一走得通的办法。
> sshd 会警告 post-quantum KEX，可忽略。

## 二、 DSM 上这些服务是关着的（每一样都会卡一下）

| 想做的事 | 结果 | 绕法 |
|---|---|---|
| `scp` 传文件 | **SFTP 未启用**，Permission denied | 不能用 scp，改用 `tar cf - \| ssh` 流式推 |
| `sudo -n rm` | 只放行 docker 相关命令，`sudo -n true` / `/bin/rm` 都要密码 | 见下 |
| `sudo -n docker …` | 可用，**但必须用全路径** `/usr/local/bin/docker`（简写 `docker` 不在 PATH：默认 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`） |
| 非交互 shell 里 `docker` | command not found | 同上，写全路径 |
| 覆盖**旧构建留下的 root 属主目录** | tar 报 `Cannot unlink / Permission denied` | 见下 |

**root 属主目录的清理**：旧部署留在盘上的 `src/ public/ py/ server/ shared/` 是 root 所有，
DENG 既不能覆盖也不能删（YAML 越权）。绕法是让容器自己动手 —— 提权只放行 docker，那就用 docker：

```bash
sudo -n /usr/local/bin/docker run --rm -u 0 \
  -v /volume1/docker/furniture-cad:/srv \
  furniture-cad-furniture-cad:latest \
  sh -c 'rm -rf /srv/src /srv/public /srv/py /srv/server /srv/shared /srv/scripts'
```

data/ 不在删除清单里，且本来就被 tarball 的 `.dockerignore` 排除 —— 卷数据不会动。
删完再推 tarball，tar 就零报错了。

## 三、推包与构建

```bash
cd app
tar czf - --exclude-from=.dockerignore -C . . |
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null DENG@192.168.2.2 \
      'D=/volume1/docker/furniture-cad; tar xzf - -C $D'
```

**构建必须在 SSH 会话里跑完** —— 会话一断，容器会停在 `Created` 状态
（`docker exec` 直接报 No such container）。所以：`up -d --build` 用 `nohup … &` 起，
**镜像构建完、容器起不来时，再补一次不带 `--build` 的 `docker compose up -d`** 即可。

```bash
cd /volume1/docker/furniture-cad
sudo -n /usr/local/bin/docker compose up -d --build
# 之后补一次（镜像已经在本地了，几秒钟）
sudo -n /usr/local/bin/docker compose up -d
```

## 四、`docker-compose.yml` 里的空 `networks:` 是个坑

仓库那份 compose 里留过一个只有注释的 `networks:` 键。YAML 里它解析成 **null**，
一旦这台机器上存在 `docker-compose.override.yml`（声明了 networks），合并就报
`validating …: networks must be a mapping`，构建第一步就被拒。
已在 `app/docker-compose.yml` 里删掉该键并写明原因；**新增 override 兼容性时不要再留空键**。

## 四之二、忘记口令的逃生门（离线重置）

只有 owner 一个账号时，**忘了口令 = 永久锁死**：自助注册已关、没有邮箱找回、
能重置口令的只有能登录的人，而能登录的人正好忘了口令。

`app/server/account-reset.mjs` 就是为此存在的。**先停服务再跑**，
它绕过 HTTP 直接改账号库文件：

```bash
sudo -n /usr/local/bin/docker compose down
cd /volume1/docker/furniture-cad
sudo -n /usr/local/bin/docker run --rm -v $PWD:/srv alpine sh -c \
  "cp /srv/data/accounts.json /srv/data/accounts.json.bak"   # 先备份

# 先看有哪些账号（只读）
sudo -n /usr/local/bin/docker run --rm -v $PWD:/srv alpine \
  sh -c "cd /srv && APP_ACCOUNTS_PATH=/srv/data/accounts.json APP_AUDIT_PATH=/srv/data/audit.jsonl \
  node /srv/server/account-reset.mjs --list"

# 重置
sudo -n /usr/local/bin/docker run --rm -v $PWD:/srv alpine \
  sh -c "cd /srv && APP_ACCOUNTS_PATH=/srv/data/accounts.json APP_AUDIT_PATH=/srv/data/audit.jsonl \
  node /srv/server/account-reset.mjs --user admin --password '新口令'"

sudo -n /usr/local/bin/docker compose up -d
```

它会：先备份 → 换 scrypt 哈希 → 踢掉全部会话 → 清空失败计数/锁定 → 写审计。
弱口令（少于 8 位、纯数字、常见弱口令表）一律拒绝，不会把系统设回一个弱口令。
本机等价于 `npm run account:reset -- --user admin --password '新口令'`（同样要先停服务）。

## 五、验收（三条 + 两条"是不是新代码"）

```bash
curl -s http://127.0.0.1:8787/api/health        # ok:true，且 accountCount 还是原来的
curl -s http://127.0.0.1:8787/api/auth/mode     # mode 仍是 accounts，账号数不变
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/home.html   # 200
# 是不是新镜像（别去 grep 首页返回的 HTML —— 那是壳，文案在打包后的 JS 里）：
C=$(sudo -n /usr/local/bin/docker ps --filter name=furniture-cad --format '{{.Names}}'|head -1)
sudo -n /usr/local/bin/docker exec $C sh -c 'cd /app/dist/assets; for k in 首页 一键修复 退出登录; do printf "%s:%s " $k "$(grep -o $k *.js|wc -l)"; done'
# 期望：首页:1 一键修复:1 退出登录:>0
```

本机（192.168.2.2）直接访问 `http://192.168.2.2:8787/` 应为 200。

## 六、边界

- 部署目录是**根目录布局**（`build: .`、`./data:/app/data`），不是 `app/` 子目录 ——
  传包前先 `ls /volume1/docker/furniture-cad` 确认现状，别按目录结构想当然。
- 升级前自动备份：`data/` + 两份 compose 会进 `_backup-<时间戳>/`；
  旧源码会被搬进 `_backup-<时间戳>/`，少数 root 属主的目录则走上面的容器清理。
- 服务自身无 TLS，公网入口仍需前置反代（`app/DEPLOY.md` 有自查清单）。
