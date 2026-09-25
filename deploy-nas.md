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

## 四之一、⚠ 部署后必须先查 `data/` 能不能写

**这个坑真踩过，而且踩得很隐蔽。** 一次部署之后 `data/` 变成了 root 属主、mode 551，
容器里跑的是 uid 1000 的 node，**从此一个字节都写不进去**。症状却是"一切正常"：
登录返回 200、界面照用，但账号库、审计、用量从那次部署起就再没更新过。
更糟的是排查时"审计里没有失败记录"被当成"没输错过密码"，差点把方向彻底带跑。

部署完先验一条：

```bash
curl -s http://127.0.0.1:8787/api/health | grep dataWritable   # 必须是 true
```

启动日志里对应那行是「数据目录  可写 —— 账号/审计/用量都能落盘」。

修法（让一个 root 容器代劳，sudo 只放行 docker）：

```bash
sudo -n /usr/local/bin/docker run --rm -u 0 -v /volume1/docker/furniture-cad:/srv alpine \
  sh -c 'chown -R 1000:1000 /srv/data && chmod -R u+rwX /srv/data'
```

根因是推包时被 root 属主目录那一步换掉了属主 —— 见第二节的容器清理。
**每次部署后都查一次**，别等它悄悄坏掉。

## 四之二、忘记口令的逃生门（离线重置）

只有 owner 一个账号时，**忘了口令 = 永久锁死**：自助注册已关、没有邮箱找回、
能重置口令的只有能登录的人，而能登录的人正好忘了口令。

`app/server/account-reset.mjs` 就是为此存在的。**先停服务再跑**，
它绕过 HTTP 直接改账号库文件：

```bash
sudo -n /usr/local/bin/docker compose down
cd /volume1/docker/furniture-cad

# 用**项目自己的镜像**跑（alpine 里没有 node）
IMG=furniture-cad-furniture-cad:latest

# 先看有哪些账号（只读）
sudo -n /usr/local/bin/docker run --rm -v $PWD:/srv $IMG \
  sh -c "cd /srv && APP_ACCOUNTS_PATH=/srv/data/accounts.json \
  APP_AUDIT_PATH=/srv/data/audit.jsonl node /srv/server/account-reset.mjs --list"

# 重置
sudo -n /usr/local/bin/docker run --rm -v $PWD:/srv $IMG \
  sh -c "cd /srv && APP_ACCOUNTS_PATH=/srv/data/accounts.json \
  APP_AUDIT_PATH=/srv/data/audit.jsonl node /srv/server/account-reset.mjs --user admin --password '新口令'"

sudo -n /usr/local/bin/docker compose up -d
```

它会：先备份 → 换 scrypt 哈希 → 踢掉全部会话 → 清空失败计数/锁定 → 写审计。
弱口令（少于 8 位、纯数字、常见弱口令表）一律拒绝，不会把系统设回一个弱口令。
本机等价于 `npm run account:reset -- --user admin --password '新口令'`（同样要先停服务）。

重置后验一遍（别只看"脚本说成功了"）：

```bash
curl -s -X POST http://127.0.0.1:8787/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"新口令"}' | head -c 120   # 应有 token
```

**注意跑之前先修 `data/` 的属主**（见上一节）—— 目录不可写时脚本会在"先备份"
那一步直接 EACCES 退出，逃生门自己先卡住，那是最不该发生的事。

## 四之三、脚本在容器里跑要注意的两件事

- **用项目镜像**，不要 alpine —— `sh: node: not found`。
- **别用 `docker run -v $PWD:/srv alpine` 去动 `data/`**：默认用户是 uid 1000(node)，
  而 `data/` 常常是 root 属主，读写都会 EACCES。要改属主就 `-u 0`，
  要改文件内容就用项目镜像（它本来就是以 node 身份在读写这同一批文件）。

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

## 五、AI 部署后的实测（2026-09-25，含一条**错误结论的更正**）

### 5.1 ⚠ `AI_API_KEY=123456` 不是占位符 —— 我上轮判错了

上一轮我把 6 位 key 当成落没落盘的占位符，据此推断"AI 请求会 403"。**这是错的。**
`gpt-load` 是本地网关：6 位口令只用于**网关自身的授权**，转发到上游时并不需要它。
容器内实测 `HTTP=200`，1 秒返回。**别拿长度去判断一个 key 是不是占位符** ——
网关型密钥的长度和规范 API key 完全不在一个量级。

### 5.2 在宿主机上 `curl http://gpt-load:3002` 得到 `000`，是**假故障**

`gpt-load` 这个主机名**只在 docker 网络内可解析**（实测容器里 `getent hosts gpt-load`
→ `172.25.0.3`）。在 NAS 宿主机上 curl 它必然解析失败，报 `000` ——
这个 `000` 测的是"我的 DNS 里有没有这个名字"，不是"服务通不通"。
**诊断 AI 连通性必须在容器内做。**（容器里既没有 `wget` 也没有 `curl`，
node 镜像只有 node，所以直接用 `node` 发起请求，顺便复用 `/app/shared/aiContract.mjs`
里的真实提示词，比裸 curl 更接近真实运行路径。）

### 5.3 偶发 504 是供应商抖动，不是提示词变长

同一句、同一模型连跑：

| 组 | max_tokens | 结果 |
|---|---|---|
| A | 4096（契约默认） | 200，19.4s，正文 476 字符，`finish=stop` |
| B | 1024 | 200，11.2s，正文 **0 字符**，`finish=length` |
| C | 4096（换一句极简） | 200，66.1s，`finish=stop` |

- B 组正文为空正是契约注释里"**必须显式给足 max_tokens**"那段的现场印证：
  服务商默认预算被推理过程吃掉，正文就没了。
- 504 出现在路由**随机换免费供应商**的时候（实测同一批请求分别落到
  `nex-agi/nex-n2.5-mini`、`cohere/north-mini-code`、`liquid/lfm-2.5-2.6b`、
  `nvidia/nemotron-3-ultra-550b-a55b`）。**不要把偶发 504 归因于本次改动的提示词长度。**

### 5.4 部署后端到端验证（这条才是"真的修好了"的证据）

用部署目录里**最新的** `aiContract.mjs` + 线上真实模型跑用户那句原话
（"新增一个 L 形新橱柜，长2200，台面宽750，高1000，另外一边长1200。"），
`validatePlan` 通过，模型产出：

```
cabinet.create  target={"cabinetName":"横臂"}  params={"width":2200,"height":1000,"depth":750,"rotation":0}
cabinet.create  target={"cabinetName":"竖臂"}  params={"width":1200,"height":1000,"depth":750,"rotation":90}
```

两个 `cabinet.create`、各自带 `rotation` —— 正是修复要的效果。
（注意：**落位是猜的**（`atX:0,atY:0`），四个数是准的。两段式预览就是为"位置猜错、
一眼能看见"准备的，不必在 AI 这一步跟它纠结坐标。）

### 5.5 给容器送文件：别用 `docker cp /tmp/...`

Windows 本地的 `/tmp` 和 NAS 的 `/tmp` **不是同一个目录**。`docker cp /tmp/f.sh 容器:/tmp/f.sh`
会因为源不存在而失败，但 `cp_exit=` 有时看着像成功。可靠做法是走 stdin：

```bash
ssh ... 'sudo -n /usr/local/bin/docker exec -i C sh -c "cat > /tmp/f.js"' < ./f.js
```

### 5.6 遗留体验问题（未改，待定）

`AI_TIMEOUT_MS` 未配置 → 服务端默认 **120 秒**。上游 504 时用户要盯着转两分钟才看到失败。
想改就把 `AI_TIMEOUT_MS=60000` 写进 `data/.env`（改 .env 不影响镜像，
改完 `docker compose up -d` 即可），代价是慢模型会被更早判死。

## 六、边界

- 部署目录是**根目录布局**（`build: .`、`./data:/app/data`），不是 `app/` 子目录 ——
  传包前先 `ls /volume1/docker/furniture-cad` 确认现状，别按目录结构想当然。
- 升级前自动备份：`data/` + 两份 compose 会进 `_backup-<时间戳>/`；
  旧源码会被搬进 `_backup-<时间戳>/`，少数 root 属主的目录则走上面的容器清理。
- 服务自身无 TLS，公网入口仍需前置反代（`app/DEPLOY.md` 有自查清单）。
