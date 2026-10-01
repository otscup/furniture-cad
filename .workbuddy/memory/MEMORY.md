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
- **几何**：两矩形面贴合⇒相对旋转必是 90° 整数倍；placement=背面左角约定。**DXF**：R2007（R2000 须 gbk+dwgcodepage、dimlfac=1.0）。

- **P9.8 已做「前置架构定界」（未编码，仓库停 `936a5fc`）**：`docs/P9.8-Architecture-Scope.md`。核心结论——协调 combos 实际仅 `2 锚点×2 顺序=4`（anchorSpots 每墙只取 SLIDE 前 2 档）；真实厨房 3/3 infeasible 是**覆盖**问题（可行解在左半空白区段，从未采样贴墙端/贴洞口边）；**★ 结构性阻塞**：`resolveAttach` 返 `rotation: target.rotation`（target 保持自己朝向）⇒ 整组换朝向/多墙分组做不到，须单独立项；**generator 只 propose 不 judge**（开口避让只能做提议偏好，不能做沉默过滤器）；最小 scope=区段感知锚点+按组跨度+覆盖式返回配额+探索预算台账。
## v0.3 路线（完整 hash 链见日志）
P0→…→P9.3(`601faf7`)→P9.4(`bd025d0`+`6332b79`)→P9.5(`9e28c84`)→P9.6（Multi-Candidate Compare UI, `38c3830`）→P9.7（Multi-Cabinet Coordinated Candidate Layout `bff57e6`）→P9.8（Multi-Cabinet Candidate Search Coverage，见下）。**停在 P9.8。** P9.6=`candidateCompare.tsx`(渲染)+`candidateCompareLogic.ts`(纯逻辑)；消费 P9.3/9.4/9.5 运行态、不造 winner、不写 project.json、selected 仅 session(`p96:selectedCandidate`)；42 项 compare + 18 项 real-furniture-request(玻璃门衣柜端到端) 均入 verify:all；7 变异全红。
- P9.7：`generate.ts` 协调枚举（行链=锚点×顺序 attach left↔right；L 型=rel90/270 back/front↔left/right）；坐标唯一出口 resolvePlacements、整体克隆整体 detectCollisions、跨路径签名去重、CandidateGenerationStats 如实统计；`verify:multi-candidate-layout` 55 项入 verify:all；8 变异全红。**坑**：候选"替换非追加"（push 追加致三套件假红）；attach 面贴合派生接触是 butt（corner=纯角点，attach 产不出，断言不能造假）；变异补丁器同文件多补丁只备份一次、SIGTERM 跳过 restore 留残留；验收脚本对 0 候选须守卫（crash≠断言红）。
- P9.8 `core/candidateLayout/`+`snapPlace`+`planner/request`（49 项新套件 + 12 变异全红）：只扩**探索覆盖**，判定层一行未改。`freeWallSegments`(authored 洞口补集，unknown 绝不当空白) + `anchorParamsOfSegment`(先定组总宽，起/中/末 3 点) + `coverageOrder`(按族轮转，**不是 slice 不是选优**) + `orderVariants`(≤2n) + `offsetVariants`(`0` + 洞口净宽) + `ATTACH_ALIGNMENTS` start/center/end；台账 `explored/rejected/budget/budgetExhausted`（`explored=generated+Σrejected`、`budget=9×MAX_PLANNER_CABINETS=216`）。同夹具同上限 3：P9.7=1 族 3 条全 infeasible → P9.8=3 族（2 valid/1 infeasible），**冲突候选不许提前过滤**。**§四 真问题在上游**：`planner/request.ts` 的 `clampMax` 把请求夹到 3 ⇒ 生成器看不到更大请求；改夹到 `MAX_CANDIDATES_COORDINATED=9`（来源 3×3），单柜路径仍 3 档但被夹时如实 unresolved。**遗留**：朝向排列/多墙协调仍被 `resolveAttach` 保持 target.rotation 结构性阻塞。
- P9.2 `core/designIntent/`（158）/ P9.3 `core/candidateLayout/`（69）：Intent≠Layout≠Cabinet；只装 active；`scope` 写不出 wallId；候选只到 draft、必过 Resolver、不进 project.json、无 adopt。
- P9.4 `core/designScore/`（133）：来源闭集 `fact|rule|preference`；**Gate 前置**（ERROR⇒`infeasible`）；偏好=`resolveKnowledge().applicable`（永不进 hardFailures）；不选 winner；AI 只读块 `snapshot.candidateScore`。
- P9.5 `core/planner/`（96 + 13 变异）：两阶段（AI 出 `PlannerRequest` → 系统确定性枚举+评分）。**类型层禁几何**（`x?: never`）；`plannerRequest` 是**请求不是动作**（仍 21 条）；`PlannerPlan` **无 winner/adopt**；枚举/坐标/碰撞/评分复用唯一实现（逐字节相同）；Planner 只转发 `entries`。**`MAX_ACTIONS=12` 不改数字** → `$ref` 闭包分批（单组超限如实 `unsplittable`，绝不截断）。
- P9.6 修 **validate.ts 玻璃门假缺陷**：玻璃门走甲购分流不进 geom.panels → 门宽恒等式读到 0 块误报"程序缺陷"；守卫后改验甲购条目（材质/数量）。§二十七 端到端（P8/P9 系验收走 dryRunPlan 真链路）才能逼出 generateCabinet 直连覆盖不到的死角。
- 变异测试纪律：锚点必须落 JSX/实码（首现在头注释=被剥=假绿）；变异崩 exit≠0 ≠ 断言红（用不存在的导出会 import 崩，红得没意义）；**沙箱 node 无法 spawn 子进程（EBUSY 连 bash 也是）** → 变异 harness= node 补丁器(纯文件读写) + bash 驱动(跑验收/判红/还原)。
