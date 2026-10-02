# 家具CAD 项目长期记忆（骨架 · 2026-10-02）
> **完整踩坑史 / 阶段细节在日志 `.workbuddy/memory/YYYY-MM-DD.md`（勿删）**；本文件只留最高价值骨架。

## 项目
浏览器端参数化定制家具设计与生产系统：**语义模型(JSON)=唯一真相源**，2D/3D/DXF/清单同源派生；自然语言入口，可被 MCP 驱动。
git 仓在**项目根**（非 `app/`）：`otscup/furniture-cad`（`master`）。主文档 `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`、`docs/Semantic-Model-v2-and-AI-Design-Plan.md`（v0.3 §23.x）。
Inkstone 知识库「家具CAD」文件夹 `01m3wyv8p6r3cr08atvff31q6n`（MCP `inkstone`）已沉淀全部需求/阶段/专题文档：27 篇 + [[家具CAD-文档总索引]]，带 YAML 属性与双链。

## 不可违背的设计原则
1. 真相源=语义模型；派生数据(几何/板件/清单)**永不写项目文件**，只存 authored。
2. AI 只出 Command、**永不输出几何/坐标**；不能写 derived / 删项目 / 改规则集。
3. 唯一写入口 CommandBus；两段式 dry-run→确认→commit，失败不改状态；AI 计划原子。
4. **界面读数="最终会被用到的那个值"**（preview===commit、dryRun===commit 逐字节）；交互结束即清瞬时状态。
5. 机器硬规则 vs AI 软建议分离；路由必须有 `none`（"是否需模型"与"用哪个模型"两层）。
6. 一键修复只对修法唯一可判定者开放、修后用真实几何复核；设计决定只给诚实说明。
7. 报错文案唯一真相源 `issueCatalog.buildIssue()`；未登记码直接抛错。
8. **一种形状/能力只许一处判断**（`units`/`rows`→`layoutModel.ts`；接触→`deriveContacts()`；容差→`SPATIAL_TOL`；坐标唯一出口 `resolvePlacement(s)`）。
9. `schemaVersion` 跟内容走（判据=旧读者会不会静默做错事）；全 mm；本地优先。
10. 纠错三通道 Gate/Prompt/Test；"测试通过"本身可错→判据须是目标真干成那件事。
11. 注解/来源类数据要持久化，先问它与 dry-run/commit 逐字节不变量是否相容；不相容只能住状态旁路。
12. **验收判据要看"因对的原因失败"**；**脚本没接进 `verify:all` 等于不存在**。
13. 每阶段只加一块"能读不能写"的上下文；AI 动作清单保持 21 条；候选方案是中间产物，选定才落地。

## 技术栈 / 红线
React+TS+Vite；2D=Canvas2D 自研；3D=Three.js；后端 Node20+/Fastify（**dependencies 仅 nodemailer**）；导出=Python+ezdxf。
`shared/aiContract.mjs`=AI 契约唯一真源（三方 import）；AI 走 OpenAI 兼容(填 baseUrl)，对话通道只问答不产 Command；MVP 只出 DXF。
MCP 白名单不暴露 SQL/路径/shell/规则集；交付带"模型+生成器+规则集版本"三件套；首批生产人工全检。

## 部署（唯一真实生产 = 群晖 NAS）
`ssh DENG@192.168.2.2`（**本机无 `nas` 别名**），口令取 env `SYNOLOGY_PASSWORD`，SSH 需 askpass（`printf '#!/bin/bash\nprintf "%%s" "$SYNOLOGY_PASSWORD"\n' > /tmp/cad-askpass.sh` + `SSH_ASKPASS_REQUIRE=force DISPLAY=`）；**SFTP 未启用 ⇒ 用 `tar czf - | ssh`，不能 scp**；非交互 shell 里 docker 不在 PATH ⇒ **必须 `sudo -n /usr/local/bin/docker`**。部署根 `/volume1/docker/furniture-cad`（`./data:/app/data`）；`AI_TIMEOUT_MS` 改 `data/.env` 不重建镜像。**先探"我能不能真的验证"，再决定要不要下结论。**

## 阶段路线与停点
P0→…→P9.6(`38c3830`)→P9.7(`bff57e6`)→P9.8(`793a08a`)→P9.9(impl `5cf19ed`+docs `279fd42`)→**P10.0 架构审查 → S0(`4e18264`)+安全前置(`0d50e73`)+报告(`7f04121`)。停在 P10.0，等验收，不进 P10.1/MCP。**
- **P10.0 推荐 A′**：服务端引入 `Workspace` 持久实体（**持有而非定义** Semantic Model，不夺走浏览器本地所有权），一份 workspace 只有一个可写端点，一致性=`liveModelVersion`+结构化 `DRAFT_STALE`；Phase 1 无推送通道 ⇒ MCP 改完浏览器须重载。鉴权复用 `AuthStore`+`ROLES`（token scope 只能收窄）；越权防线复用既有 `STRUCTURAL_OPS`/`WRITABLE`/`DENY`（不许新增万能命令）。待决策：①`room.create`/`wall.create` 是否对 AI 开放 ②`discard_draft` 权限边界 ③MCP SDK vs 手写协议。
- **S1 已执行**（`be08596`，Workspace 持久实体 + 进程内串行写队列修复账号库并发丢写）：持有实体/乐观锁/DRAFT_STALE/复用现有 CommandBus 全部落地，红线全守。**S1-0 生产安全前置部署已完成**（NAS 真重建：旧 `07c74c7b6c1e` 打标 `pre-p10s1` → 新镜像 `eabc39ff37a5`/容器 `a07ee6a24d3b`；容器内 `enforceMaxTokens` grep 0→**7**；三大闸真实 HTTP 验证 T1 400/T2 403/T3 审计落盘；生产 `audit.jsonl` 57 行；FS 未启用只能 `tar|ssh`、docker 用 `sudo -n /usr/local/bin/docker`）。**停在 S1 等 Codex 验收，未进 S2~S6**。
- **S0**：`Dockerfile` run 阶段补 `COPY scripts`+`src/core`+`src/export`+`src/ai/memory.ts`（故意不 `COPY src ./src`）；闭包实测 26 文件；`verify:image-closure`(32)+变异(10 全红)。**S0.5**：NAS 真重建（新 `07c74c7b6c1e`，旧 `93f524c627c4` 打标 `:pre-p10s0` 可回退）；三项导出真 HTTP 冒烟通过。**遗留（生产镜像未含安全前置）已由 S1-0 关闭**（新容器 `grep -c enforceMaxTokens`=7）。

## 最高频的坑（完整见日志）
- **断言不可信比失败更危险**：先打原始值、先假定自己错；新增/改断言须临时改坏确认真会红。**子串断言只认特征短语、认数字会假绿**；**别在"已被处理过"的对象上取快照**（用全新对象）。
- **"被拒了"≠"因对的原因被拒"**（须断言 `code`）；"带数字"须断言值真出现；逐字节比较先摘时间戳；扫源码类断言必剥注释。
- **"判不出来"常表现为"这一行不存在"** → 消费逐条列表必问"这一条为什么不在"。
- **夹取/上限看整条链**：验收走真实管线（`planCandidates`），不能只直调生成器；真实模型回归用应用自带提示词（`buildSnapshot`+`buildChatRequest`）。
- **变异 harness**：判红=汇总行出现且 **✗>0**（`exit≠0` 不够）；锚点须恰好命中 1 次；被掐死会停在变异态。**改公共代码块前先 grep `verify/`**（有人拿它当锚点，越长越脆）。
- **夹具状态泄漏**：`PUT /api/settings` 会**真重写 `.env`**（server 每请求 `readEnv()`）⇒ 写全局状态的断言段放最后或写回可用值。**verify 运行期间禁改 `app/` 源文件**（HMR 假红）；提交前 `git checkout -- app/verify/out/`。
- **本机 `spawnSync`/`execSync` 一律 EBUSY** ⇒ 只用异步 `execFile`；源码 **CRLF**，锚点先归一化行尾；`typecheck` 可能 OOM ⇒ `GOMEMLIMIT=1500MiB npx tsc --noEmit`。
- **★★生产可能"静默分叉"且验收抓不到**：判定看 `git log -S "COPY scripts" -- app/Dockerfile`，**不是"镜像未同步"**。**只 build 不冒烟 = 未验证**；**别拿"本地 dist 与镜像 dist 同名"当等价证据，要 grep 容器内源码**。
- **几何**：两矩形面贴合 ⇒ 相对旋转必是 90° 整数倍；placement=背面左角约定。**DXF**：R2007/UTF-8 主交付。
