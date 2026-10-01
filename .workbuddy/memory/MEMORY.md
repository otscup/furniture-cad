# 项目长期记忆（骨架 · 2026-10-01）

## 项目
浏览器端参数化定制家具设计与生产系统：**语义模型(JSON)=真相源**，2D/3D/DXF/清单同源派生；自然语言入口，可被 MCP 驱动。
**git 仓在项目根**（不是 `app/`）；公开仓库 `otscup/furniture-cad`（默认 `master`）。
- 主文档 `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`；v0.3 路线 + 逐阶段实施记录 `docs/Semantic-Model-v2-and-AI-Design-Plan.md` §23.x。
- **完整踩坑史 + 阶段细节在日更日志 `.workbuddy/memory/YYYY-MM-DD.md`**；本文件只留骨架与最高频的坑。

## 不可违背的设计原则
1. 真相源=语义模型(JSON)；派生数据(Panel/几何/清单)永不写项目文件，只存 authored。
2. AI 只输出 Command 永不输出几何；只收 `{cabinetId,part,paramPath}` 永不收坐标（模型无"线"对象→"改线"译"改语义部件"）；不能写 derived/删项目/改规则集。
3. 唯一写入口 CommandBus（UI/AI/MCP/脚本同权同位）；两段式 dry-run→确认→commit，失败不改状态；AI 计划原子（一条被拒→整份不执行）。
4. **界面读数="最终会被用到的那个值"**（preview===commit、dryRun===commit 逐字节）；交互结束立即清瞬时状态。
5. 机器硬规则(可判定/可阻断) 与 AI 软建议(仅提示) 分离；"是否需模型"与"用哪个模型"两层→路由要有 `none`。
6. **"点了错还在"比"没按钮"更糟**：一键修复只对修法唯一可判定者开放、修后用真实几何复核；设计决定只给诚实话术。
7. 报错文案唯一真相源 `issueCatalog.buildIssue()`；未登记码直接抛错；程序缺陷类明说且不给按钮。
8. **一种形状/能力只许一处判断**：`units`/`rows` 只有 `core/layoutModel.ts` 判谁在；接触只有 `deriveContacts()`；容差只有 `SPATIAL_TOL`。
9. `schemaVersion` 跟内容走，判据=**旧读者会不会静默做错事**；单位全 mm，禁浮点进生产尺寸；本地优先，无需 VPS。
10. 纠错三通道 Gate(拦)/Prompt(教)/Test(钉)；"测试通过"本身可错→判据须是目标真干成那件事。
11. **注解/来源类数据要持久化，先问它与 dry-run/commit 逐字节不变量是否相容**；不相容只能住状态旁路，在保存/加载边界物化。
12. **验收判据要看"因对的原因失败"**（`rejectWhy(raw,正则)`）；**脚本没接进 `verify:all` 等于不存在**。
13. 多方案对比中间产物=候选语义方案，选定才落地；审计必须与界面说同一件事。

## 技术栈 / 产品 / 红线
- React+TS+Vite；2D=Canvas2D 自研；3D=Three.js；后端 Node20+/Fastify；导出=Python+ezdxf。`shared/aiContract.mjs`=AI 契约唯一真源（三方 import）。
- 先自用后商业化；MVP 只出 DXF 不出 DWG。AI 走 OpenAI 兼容(`POST {baseUrl}/chat/completions`)，换服务商=填 baseUrl；**对话通道只问答不产 Command**。账号两模式 local-open→accounts；订阅按自然月 token；局域网 `HOST=127.0.0.1`。
- MCP 白名单不暴露 SQL/路径/shell/规则集；交付带"模型+生成器+规则集版本"三件套；首批生产人工全检；factory 默认值显式覆盖。

## 最高频的坑（完整清单见日志）
- **nextId 必传 takenIds**（撞 id 只静默共用）；**验收夹具必须深拷贝 + 显式指定 id**；结构性命令必带 `changes:[]`。
- **★ verify 运行期间禁改 `app/` 源文件**（Vite HMR 整页重载→恢复草稿→后续断言连环假红）。
- **★ 不许要求模型输出它拿不到的几何**（模型只出语义意图，坐标由系统定）。
- **断言不可信比失败更危险**：失败先打原始值、先假定自己错；几何 0/±1 须精确；新增回归断言须临时改坏确认真会红；**恒真表达式＝假绿**（判据要挑"变异真能把它变红"的那条）。
- **负样本要精确到原因**；**"带数字"须断言喂进去的值真出现**（`num()` 缺值返 0 会顶替成假绿）。
- **扫源码类断言**：先剥注释行、只扫 import 说明符（扫原文会把字符串当依赖）。
- **逐字节比较先摘时间戳**（`serializeProjectFile.savedAt` / `toNeutralExport.generatedAt`，常嵌套）。
- **`npm run typecheck` 本机可能 OOM**（TS7 是 Go 编译器）→ `GOMEMLIMIT=1500MiB npx tsc --noEmit`（verify:all 同前缀）。
- **verify:ui 是分钟级链**：跑前清 dev server(5273)；提交前 `git checkout -- app/verify/out/`（PNG tracked）。
- **环境代理假失败**：`HTTP_PROXY` 把局域网当外网→502（delete 六个代理变量）。**AI 网关**：R1 系回 `reasoning_content`；`max_tokens` 夹 `[1,65536]`。
- **几何**：两矩形面贴合⇒相对旋转必是 90° 整数倍（非轴对齐不覆盖）；placement=背面左角约定。**DXF**：主交付 R2007、R2000 须 gbk+dwgcodepage、dimlfac 设 1.0。

## 部署（NAS 群晖）
AI 网关 key 非占位符；宿主机测 000 是 DNS 假故障（容器内 node 测 200）；`docker cp /tmp` 用 stdin 法；`AI_TIMEOUT_MS` 改 `data/.env` 不重建镜像。

## 协作方式（2026-09-29 起）
用户只给产品方向 / 架构边界 / 阶段验收，我自主拆解实现测试提交；每阶段一份报告（完成 / 关键决策 / 测试 / 遗留 / commit）。**停在阶段不自动进下一阶段**——除非用户明确"继续"。

## v0.3 路线
P0→P1→P2(`66da2b5`)→P3(`26a7639`)→P4(`6f5541b`)→P5(`8aecd76`)→P6(`a556353`)→P7(`67f6764`)→P8.1(`4290a3a`)→P8.2(`7850046`)→P8.3(`53f20a8`)→P8.4(`bc8284c`)→P8.5(`ec3565b`)→P8.5-B(`99db98e`)→P8.6→P8.7(`c8c01c3`)→P8.8(`d892845`)→P8.9(`0cba2ef`+`b4c62f4`)→P9.0(审查 `985c78b`)→P9.1(`4c50608`)→P9.2(`4c0b74c`)→P9.3(`601faf7`)。**停在 P9.3，等待验收。**
- **P9.2**：纯语义层 `core/designIntent/`（Intent≠Layout）：词表 9 词、模型只装 active、`origin` 无 `system`、`scope` 写不出 wallId、载荷禁数字；`Project.designIntents?`（悬空引用丢弃+警告）；不升 schemaVersion。`verify:design-intent` 158 条。
- **P9.3**：纯临时候选布局层 `core/candidateLayout/`（只到 draft）：`CandidatePlacement` 无 Cabinet；链=`activeDesignIntents→candidateSpots→resolvePlacement(唯一坐标出口)→detectCollisions+事实层`；三档 A/B/C；不进 project.json、无 adopt；AI 只出 `candidateRequest`（无坐标）。`verify:candidate-layout` 69 条。
