# 项目长期记忆（骨架 · 2026-10-01）

## 项目
浏览器端参数化定制家具设计与生产系统：**语义模型(JSON)=真相源**，2D/3D/DXF/清单同源派生；自然语言入口，可被 MCP 驱动。**git 仓在项目根**（不是 `app/`）；公开仓库 `otscup/furniture-cad`（默认 `master`）。
文档 `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`（主）/ `docs/Semantic-Model-v2-and-AI-Design-Plan.md`（v0.3 §23.x）；**完整踩坑史与阶段细节在日志 `.workbuddy/memory/`**。

## 不可违背的设计原则
1. 真相源=语义模型(JSON)；派生数据(几何/板件/清单)永不写项目文件，只存 authored。
2. AI 只出 Command，永不输出几何/坐标；不能写 derived/删项目/改规则集。
3. 唯一写入口 CommandBus；两段式 dry-run→确认→commit，失败不改状态；AI 计划原子。
4. **界面读数="最终会被用到的那个值"**（preview===commit、dryRun===commit 逐字节）；交互结束即清瞬时状态。
5. 机器硬规则与 AI 软建议分离；"是否需模型"与"用哪个模型"两层→路由要有 `none`。
6. 一键修复只对修法唯一可判定者开放、修后用真实几何复核；设计决定只给诚实说明。
7. 报错文案唯一真相源 `issueCatalog.buildIssue()`；未登记码直接抛错。
8. **一种形状/能力只许一处判断**（`units`/`rows`→`layoutModel.ts`；接触→`deriveContacts()`；容差→`SPATIAL_TOL`）。
9. `schemaVersion` 跟内容走（判据=旧读者会不会静默做错事）；全 mm；本地优先。
10. 纠错三通道 Gate/Prompt/Test；"测试通过"本身可错→判据须是目标真干成那件事。
11. **注解/来源类数据要持久化，先问它与 dry-run/commit 逐字节不变量是否相容**；不相容只能住状态旁路。
12. **验收判据要看"因对的原因失败"**；**脚本没接进 `verify:all` 等于不存在**。
13. 候选语义方案是中间产物，选定才落地；**每阶段只加一块"能读不能写"的上下文**（P9 手法）；动作清单保持 21 条。

## 技术栈 / 产品 / 红线
React+TS+Vite；2D=Canvas2D 自研；3D=Three.js；后端 Node20+/Fastify；导出=Python+ezdxf。`shared/aiContract.mjs`=AI 契约唯一真源（三方 import）。AI 走 OpenAI 兼容(填 baseUrl)，**对话通道只问答不产 Command**；MVP 只出 DXF。MCP 白名单不暴露 SQL/路径/shell/规则集；交付带"模型+生成器+规则集版本"三件套；首批生产人工全检。

## 部署 / 协作
NAS 群晖：网关 key 须非占位符；宿主机测 000 是 DNS 假故障（容器内 node 测 200）；`AI_TIMEOUT_MS` 改 `data/.env` 不重建镜像。
协作（2026-09-29 起）：用户只给产品方向/架构边界/阶段验收，我自主拆解实现测试提交；每阶段一份报告（完成/决策/测试/遗留/commit）。**停在阶段不自动进下一阶段**（除用户明确"继续"）。

## 最高频的坑（完整清单见日志）
- **nextId 必传 takenIds**；夹具须深拷贝+显式指定 id；结构性命令必带 `changes:[]`。
- **★ verify 运行期间禁改 `app/` 源文件**（Vite HMR 整页重载→恢复草稿→后续断言连环假红）。
- **★ 不许要求模型输出它拿不到的几何**（坐标由系统定）。
- **断言不可信比失败更危险**：先打原始值、先假定自己错；**新增/改断言须临时改坏确认真会红**；恒真＝假绿。
- **★ 断言可能是瞎的**：在"已被处理过"的对象上取快照→抓不到"处理顺手改了它"→用**全新未碰过**的对象。
- **★ "判不出来"常表现为"这一行不存在"**→消费逐条列表必问"**这一条为什么不在**"；能力只给一半时断言"被闸门拦住"。
- **扫源码类断言必剥注释只扫代码**（文件头常写"本层不 import X"=纪律声明）；容差哨兵认 `_TOL`；`Math.max/min` 是合法夹取。**合法只读事实≠坐标**：`wallId` 是墙名引用，扫"零坐标"要排除。
- **"被拒了"≠"因对的原因被拒"**：只断言 `ok===false` 会假绿，要断言 `code`；**"带数字"须断言喂进去的值真出现**（`num()` 缺值返 0→假绿）；**逐字节比较先摘时间戳**。
- **★ 断言也会因"错的原因"绿**（P9.8 实证）：子串断言**认数字会假绿**——新增文案里的 `99` 意外满足了 `includes('99')&&includes('9')`，把变异 M8 洗成全绿。**子串断言只认特征短语、不认数字**；改完断言立刻用变异复验它会红。
- **★ 夹取/上限要看整条链**：`generate.ts` 的上限写得再对，上游 `normalizePlannerRequest` 早把请求夹掉了 ⇒ 验收必须走**真实管线**（`planCandidates`），不能只直调生成器。
- **真实模型回归必须用应用自带提示词**（`buildSnapshot`+`buildChatRequest`）：自写 system prompt 少一条约束模型就输出契约外值（如 `scope:"kitchen"`→`BAD_SCOPE`），那是探针不全不是系统缺陷。
- **容器内跑 `.ts`**：`/app` 是 `type:module` ⇒ `.ts` 按 ESM 类型剥离直跑；放 `/tmp` 要写 `.mts`（无 package.json 时 `.ts` 落回 CJS）。验收脚本放 `verify/out/` 时相对路径是 `../../src`。
- **写源码的工具要自己兜底**（变异类）：改前落盘备份、`finally` 从磁盘还原、启动时先扫残留备份；锚点**必须唯一命中**。
- **本机 `spawnSync`/`execSync` 一律 EBUSY**→只用**异步 `execFile`**；源码是 **CRLF**，字符串锚点先归一化行尾。
- **`npm run typecheck` 可能 OOM**（TS7 是 Go 编译器）→ `GOMEMLIMIT=1500MiB npx tsc --noEmit`；**verify:ui 分钟级**：跑前清 dev server(5273)、提交前 `git checkout -- app/verify/out/`、长输出别 `| tail -N`。
- **★ 改公共代码块前先 grep `verify/`：有人拿它当变异锚点。** P10.0 安全前置往 `managePaths` 上方插了 `isMemoryWrite`，把 `preflight-bugfixes-acceptance.ts` 的 P0-2/P0-3 锚点（原本延伸到 `managePaths` 结尾）**撑断**⇒旧套件判红。修法=把锚点缩到"那一处赋值"。**变异锚点越长越脆。**
- **★ 验收夹具也会"状态泄漏"**：`security-preflight` 的 ① 段 `PUT /api/settings` 会**真重写 `.env`**，而 server 每请求 `readEnv()` ⇒ 把 baseUrl 写成死地址会让后面所有合法 AI 调用 `fetch failed`（**夹具自造的假故障**，不是产品缺陷）。**写/改全局状态的断言段，要么放最后，要么保证写回的值仍可用。**
- **`ssh nas` 别名在本机不存在**；群晖一律用 `DENG@192.168.2.2` + `SYNOLOGY_PASSWORD` askpass；`sudo -n /usr/local/bin/docker`（全路径）。镜像构建产物 `dist/` 的 hash 会随源码变 ⇒ **别拿"本地 dist 与镜像 dist 同名"当等价证据，要 grep 容器内源码**（本轮正是靠 `grep -c enforceMaxTokens = 0` 才发现生产**没**含安全前置）。
- **几何**：两矩形面贴合⇒相对旋转必是 90° 整数倍；placement=背面左角约定。**DXF**：R2007（R2000 须 gbk+dwgcodepage、dimlfac=1.0）。
- **★★ 生产可能"静默分叉"且验收抓不到**：`app/Dockerfile` 运行阶段只 COPY `dist/server/shared/py` —— **不含 `scripts/` 与 `src/`**；而 `server.mjs` 运行期 spawn `/app/scripts/emit-*.ts`（它们 import `../src/**` 并**按路径读** `src/core/ruleset/factory-default.json`）⇒ **dxf/cutlist/roombook 三端点在生产全坏**。**58 个 verify 脚本零个构建镜像/进容器**（全在宿主机源码树跑，而源码树里这两个目录恰好都在）⇒ **"验收全绿"与"生产全坏"必然同时成立**；`ab9a4c2` 的 P0-4 正是改在一个从未进过镜像的文件上。**判定顺序**：`git log -S "COPY scripts" -- app/Dockerfile` 命中 0 ⇒ 根因是 Dockerfile，**不是"镜像未同步"**（重推重建也修不好）；最小修法 = 补 `COPY scripts` + `COPY src`（闭包实测 35 文件/只需 `src/{core,export}`+`src/ai/memory.ts`，零 npm 依赖），**但规则集 JSON 是按路径读的、不进 import 闭包，必须显式纳入**。**只 build 不冒烟 = 未验证**。
- **NAS 只读取证路径**：`deploy-nas.md` 里有 `DENG@192.168.2.2`，口令从环境变量 `SYNOLOGY_PASSWORD` 取（本机已设）；SSH 需 askpass（`printf '#!/bin/bash\nprintf "%%s" "$SYNOLOGY_PASSWORD"\n' > /tmp/cad-askpass.sh` + `SSH_ASKPASS_REQUIRE=force DISPLAY=`）；非交互 shell 里 `docker` 不在 PATH，**必须 `sudo -n /usr/local/bin/docker`**。**先探"我能不能真的验证"，再决定要不要下结论。**

- **P9.8 已做「前置架构定界」（未编码，仓库停 `936a5fc`）**：`docs/P9.8-Architecture-Scope.md`。核心结论——协调 combos 实际仅 `2 锚点×2 顺序=4`（anchorSpots 每墙只取 SLIDE 前 2 档）；真实厨房 3/3 infeasible 是**覆盖**问题（可行解在左半空白区段，从未采样贴墙端/贴洞口边）；**★ 结构性阻塞**：`resolveAttach` 返 `rotation: target.rotation`（target 保持自己朝向）⇒ 整组换朝向/多墙分组做不到，须单独立项；**generator 只 propose 不 judge**（开口避让只能做提议偏好，不能做沉默过滤器）；最小 scope=区段感知锚点+按组跨度+覆盖式返回配额+探索预算台账。
## v0.3 路线（完整 hash 链见日志）
P0→…→P9.3(`601faf7`)→P9.4(`bd025d0`+`6332b79`)→P9.5(`9e28c84`)→P9.6（Multi-Candidate Compare UI, `38c3830`）→P9.7（Multi-Cabinet Coordinated Candidate Layout `bff57e6`）→P9.8（Multi-Cabinet Candidate Search Coverage，`793a08a`，见下）→P9.9（Explanation & Selection，impl `5cf19ed` + docs `279fd42`；报告 `docs/P9.9-Completion-Report.md`）→**P10.0 架构审查（MCP CAD Control Plane + Production Boundary，`docs/P10.0-MCP-Architecture-Review.md`，零代码/零测试/零提交，未 commit）。停在 P10.0，等用户验收，不进 P10.1。** P10.0 关键结论：**推荐方案 A′**（服务端引入 `Workspace` 持久实体 = 持有而非定义 Semantic Model，不夺走浏览器本地所有权，一份 workspace 只有一个可写端点，一致性 = `liveModelVersion` + 结构化 `DRAFT_STALE`，**Phase 1 不建推送通道 ⇒ MCP 改完浏览器须重新载入才可见**）；`DraftSession`/`CommandBus`/core 全可在 Node 复用（`baseVersion` 已是 `baseModelVersion` 原型，**不需要 ServerDraftSession**）；鉴权复用 `AuthStore`+`ROLES`（token scope 只能收窄，**权限判定只许一条路径**）；越权防线复用既有 `STRUCTURAL_OPS`/`WRITABLE`/`DENY`（**不许新增万能命令**）；`MCP session ≠ CAD 项目 session`。**待用户决策 4 项**：①`room.create`/`wall.create` 是否对 AI 开放（那 21 条白名单里没有，但 CommandBus 里有）②`discard_draft` 权限边界 ③MCP SDK（加依赖）vs 手写协议（零依赖）④**S0/S0.5 已执行**（见下）。
- **P10.0 S0/S0.5/安全前置 已执行（`4e18264` = S0 镜像闭包修复；安全前置另 commit）**：
  **S0** = `Dockerfile` run 阶段补 `COPY scripts` + `src/core` + `src/export` + `src/ai/memory.ts`（**故意不 `COPY src ./src`**）；
  闭包实测 **26 文件**（`import type` 被 strip-types 擦除 ⇒ 不传播）；新增 `verify:image-closure`(32) + `…-mutations`(16/10 变异全红)。
  **S0.5** = 群晖 `DENG@192.168.2.2` 真重建（新镜像 `07c74c7b6c1e`，旧 `93f524c627c4` 打标 `:pre-p10s0` 可回退）；
  镜像内 `scripts`/`src/{core,export}`/ruleset JSON 齐全；`data/` 卷一字未动（mtime 早于重建）。
  **三项导出真 HTTP 冒烟**（第二实例 `furniture-cad-smoke` 8791，同镜像、不挂卷）：DXF 66200B `AC1021/169实体/12图层`、
  CSV 29 行带 BOM、RoomBook 12725B；**制造层用图纸自证**（`PANEL_18`/`PANEL_9` 图层 + `左侧板`/`右侧板` 文字只可能来自 manufacturing）；
  生产容器内 `docker exec` 直跑同链**逐项一致**。安全前置 = ①settings 审计（只记布尔/取值、绝不记 key）②`/api/memory` 写要求 `canManage`（GET 仍可读）
  ③④`enforceMaxTokens()` 统一闸（上界=`MAX_OUTPUT_TOKENS_CAP` 唯一真源，`AI_HARD_MAX_TOKENS` **只能收紧**，超顶→400 `MAX_TOKENS_EXCEEDED` 且**闸门在上游之前**）；
  `verify:security-preflight`(48) + `…-mutations`(13/10 变异全红)。**停在 P10.0，不进 P10.1/MCP。** P9.6=`candidateCompare.tsx`(渲染)+`candidateCompareLogic.ts`(纯逻辑)；消费 P9.3/9.4/9.5 运行态、不造 winner、不写 project.json、selected 仅 session(`p96:selectedCandidate`)；42 项 compare + 18 项 real-furniture-request(玻璃门衣柜端到端) 均入 verify:all；7 变异全红。
- P9.9 定界结论（`docs/P9.9-Architecture-Review.md`）：**★ `satisfies`(`generate.ts:178`) 与 `components`(`score.ts:146`) 是两套口径**
  （门脸朝墙：satisfies=true 但 hit=no；房间级意图：评分层只有 unavailable）—— 解释层若拿 satisfies 当"满足了什么"就造第二套判定；
  **★ 候选 id 是位置性的**（`taken=new Set()` 每轮从 `cl_001` 起）⇒ 重新生成后旧 `selectedCandidateId` 会**错指**到另一份候选
  （修法：导出既有 `candidateSignature` 作内容键，selection 存 `{id,key}`，失配即**清除**不回退）；
  `DesignScoreComponent` 本身已是解释 token ⇒ P9.9 是 reshape 不是补判定；Selection=A(compare session 运行态)，
  非 Proposal/非 Command/不新增持久实体；**LLM 不参与解释**；UI 补渲染 `score.explanations`/偏好明细/`generation` 台账。
- P9.7：`generate.ts` 协调枚举（行链=锚点×顺序 attach left↔right；L 型=rel90/270 back/front↔left/right）；坐标唯一出口 resolvePlacements、整体克隆整体 detectCollisions、跨路径签名去重、CandidateGenerationStats 如实统计；`verify:multi-candidate-layout` 55 项入 verify:all；8 变异全红。**坑**：候选"替换非追加"（push 追加致三套件假红）；attach 面贴合派生接触是 butt（corner=纯角点，attach 产不出，断言不能造假）；变异补丁器同文件多补丁只备份一次、SIGTERM 跳过 restore 留残留；验收脚本对 0 候选须守卫（crash≠断言红）。
- P9.8 `core/candidateLayout/`+`snapPlace`+`planner/request`（49 项新套件 + 12 变异全红）：只扩**探索覆盖**，判定层一行未改。`freeWallSegments`(authored 洞口补集，unknown 绝不当空白) + `anchorParamsOfSegment`(先定组总宽，起/中/末 3 点) + `coverageOrder`(按族轮转，**不是 slice 不是选优**) + `orderVariants`(≤2n) + `offsetVariants`(`0` + 洞口净宽) + `ATTACH_ALIGNMENTS` start/center/end；台账 `explored/rejected/budget/budgetExhausted`（`explored=generated+Σrejected`、`budget=9×MAX_PLANNER_CABINETS=216`）。同夹具同上限 3：P9.7=1 族 3 条全 infeasible → P9.8=3 族（2 valid/1 infeasible），**冲突候选不许提前过滤**。**§四 真问题在上游**：`planner/request.ts` 的 `clampMax` 把请求夹到 3 ⇒ 生成器看不到更大请求；改夹到 `MAX_CANDIDATES_COORDINATED=9`（来源 3×3），单柜路径仍 3 档但被夹时如实 unresolved。**遗留**：朝向排列/多墙协调仍被 `resolveAttach` 保持 target.rotation 结构性阻塞。
- P9.9 = **只做消费侧**（`core/candidateLayout/explain.ts` 新 + `candidateCompareLogic/tsx` + `AIPanel` selection；**62 项 A–J 段 + 17 变异全红 + 23 项 harness**）：把 P9.3 候选 + P9.4 评分 + P9.8 台账**投影**成只读解释；**生产侧一行未改**（真实厨房三柜台账 `requested:6/generated:24/returned:6/truncated:18/explored:90/rejected{0,18,48}/budget:216` 与 P9.8 报告**逐项一致**可证）。
  · 只读投影的性质判据：`status` 恒等 `score.status`；`blocking` 与 `hardFailures` **五项逐条**一致；`items+crossCutting` 的 code **恰好等于** `components.map(id)`；`generationNotes` **逐字节**等于 `layout.explanations`；`satisfies` 只进 `generatorSignals` 并标"生成期粗判…非最终结论"；`unknown` 一律写"**判不出来**"（不写"未满足"）。
  · **Selection 身份**：`candidateSignature` → 导出 `candidateKey`（唯一实现）；session 存 `{candidateId,key}`；恢复=`id 在 且 key 逐字符相同`，失配**清除不回退**（位置性 id `cl_001` 在重生成后会**错指**另一份）。
  · 决策：**D1 不给 `CandidateLayout` 加 `searchFamily`**（会把 `verify:candidate-layout` 第 6 项键集断言**静默弄红**，而封板套件不许放宽）⇒ 搜索族仍整串透传；**D2** component→柜归因取**路①**（只用 `hardFailures[].target` / `preferenceMatches[].cabinetId`，其余进 `crossCutting`），不动 P9.4 模型；**D3** 表外字段取 **WARNING 不阻塞** + 进 `notes`（判据只一处 `validateProposal`，白名单 = `Object.keys(UNIT_INTENT_ITEM)`，`compileProposal` 只转述）。
  · 约束一（静默丢字段）：补 `doorMaterial`(proposal/stripUnit)、`rodHeight`/`openingDepth`(vision)、`doors.material`(snapshot)；表外字段（`customHardware`）**显式拒绝** → `PROPOSAL-UNIT-FIELD`。
- P9.2 `core/designIntent/`（158）/ P9.3 `core/candidateLayout/`（69）：Intent≠Layout≠Cabinet；只装 active；`scope` 写不出 wallId；候选只到 draft、必过 Resolver、不进 project.json、无 adopt。
- P9.4 `core/designScore/`（133）：来源闭集 `fact|rule|preference`；**Gate 前置**（ERROR⇒`infeasible`）；偏好=`resolveKnowledge().applicable`（永不进 hardFailures）；不选 winner；AI 只读块 `snapshot.candidateScore`。
- P9.5 `core/planner/`（96 + 13 变异）：两阶段（AI 出 `PlannerRequest` → 系统确定性枚举+评分）。**类型层禁几何**（`x?: never`）；`plannerRequest` 是**请求不是动作**（仍 21 条）；`PlannerPlan` **无 winner/adopt**；枚举/坐标/碰撞/评分复用唯一实现（逐字节相同）；Planner 只转发 `entries`。**`MAX_ACTIONS=12` 不改数字** → `$ref` 闭包分批（单组超限如实 `unsplittable`，绝不截断）。
- P9.6 修 **validate.ts 玻璃门假缺陷**：玻璃门走甲购分流不进 geom.panels → 门宽恒等式读到 0 块误报"程序缺陷"；守卫后改验甲购条目（材质/数量）。§二十七 端到端（P8/P9 系验收走 dryRunPlan 真链路）才能逼出 generateCabinet 直连覆盖不到的死角。
- 变异测试纪律：锚点必须落 JSX/实码（首现在头注释=被剥=假绿）；**判红标准 = 汇总行出现且 ✗>0（"验收跑完了且判红"）——只看 exit≠0 是错的，未捕获异常也返 1，那种"红"说明变异本身写坏了**；同文件多补丁只备份一次；`finally` 从磁盘还原 + **锚点在文件里必须恰好命中 1 次**（0 次或 2 次都判这条变异失败，不静默跳过）。
  · **harness 用 `spawn(process.execPath, ['--experimental-strip-types', 脚本])` 起子进程是可行的**（P9.9 实测；旧记录"沙箱 node 无法 spawn 子进程 EBUSY"已过时——但 `spawnSync`/`execSync` 仍会 EBUSY，只用异步）。
  · **★ 变异 harness 被 `| head` / SIGKILL 掐死会在 `finally` 之前退出 ⇒ 源码停在变异态**（实测命中）。补法不是"记得清理"，而是 harness **启动时用已知的 `to` 文本反推还原**（CRLF 版与 LF 版各试一次，保留原行尾），并打印还原条数。**跑变异套件时别把输出管道给 `head`**。
  · **把"不许出现的标识符"塞进实码用 `typeof x === 'undefined' ? '' : 'x'`**：`typeof 未声明变量`不抛错 ⇒ 既能被源码扫描断言抓住，又不会因 `ReferenceError` 把"崩溃"误判成"判红"。
  · **`?? []` 不是多余防御**：解释/投影层必须容忍上游**手工构造的最小对象**（`verify:candidate-compare` 第 7 项就没有 `satisfies`）；且"没有信号"要当 `[]`，**绝不能当 `false`**（那会把"没被问过"读成"不满足"）。
  · **第三方 API 凭记忆写必翻车**：写前先在 venv 里 `inspect.signature` / 读 `site-packages` 源码（`ezdxf.audit` 是**模块**，模块级 `audit(entity, doc)` 只审单实体，无 `renumber`；正确是 `from ezdxf.audit import Auditor` + `Auditor(doc).run()`）。
  · **提交前固定动作**：`git checkout -- app/verify/out/`（`verify:ui` 会重写几十个截图，不还原就把二进制 diff 带进提交）。
