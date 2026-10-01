# 项目长期记忆（2026-10-01 精编）

## 项目
浏览器端参数化定制家具设计与生产系统。**语义模型=真相源**，2D/3D/DXF/清单同源派生；自然语言入口，可被 MCP 驱动。
- **git 仓在项目根**（不是 `app/`）；公开仓库 `otscup/furniture-cad`（默认 `master`）。
- 主文档 `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`；v0.3 路线+逐阶段实施记录 `docs/Semantic-Model-v2-and-AI-Design-Plan.md`（§23.x）；架构审查 `docs/P9.0-Architecture-Review.md`。
- 阶段细节落 `docs/…Plan.md` 与 `.workbuddy/memory/YYYY-MM-DD.md`；本文件只留骨架与高频坑。

## 不可违背的设计原则
1. 真相源=语义参数化模型(JSON)，非几何；派生数据(Panel/几何/清单)永不写项目文件，`model.json` 只存 authored。
2. AI 只输出 Command 永不输出几何；不能写 derived、不能删项目、不能改规则集。AI 只收 `{cabinetId,part,paramPath}` 永不收坐标（模型没有"线"对象→"改线"须译"改语义部件"）。
3. 唯一写入口 CommandBus：UI/AI/MCP/脚本同权同位。两段式 dry-run(diff+规则)→确认→commit，失败不改状态。AI 计划原子：一条被拒→整份不执行。
4. **界面读数是"最终会被用到的那个值"**（预览===提交、干跑===提交逐字节）。交互结束立即清瞬时状态(追踪线/捕捉标记/预览徽标/读数)。
5. 机器硬规则(可判定/可阻断) 与 AI 软建议(不可判定/仅提示) 分离。"是否需模型"与"用哪个模型"是两层→路由要有 `none`。
6. **"点了错还在"比"没按钮"更糟**：一键修复只对修法唯一可判定者开放、修后用真实几何复核；设计决定只给诚实话术不给假按钮。
7. 报错文案唯一真相源 `issueCatalog.buildIssue()`；未登记码直接抛错；设计类给数字、程序缺陷类明说"这是程序缺陷"且不给按钮。
8. **一种形状/一种能力只许一处判断**：柜体布局 `units`(单行)/`rows`(分层)只有 `core/layoutModel.ts` 判谁在；接触只有 `deriveContacts()`；容差只有 `SPATIAL_TOL`；跑验收与出图共用 `verify/mock-openai.mjs`。
9. `schemaVersion` 跟内容走，判据=**旧读者会不会静默做错事**（`rows`/`assemblies` 会→升；纯注解无执行体、忽略后逐位相同→不升）。
10. 单位全 mm，禁浮点误差进生产尺寸。本地优先，Phase 0–6 不需 VPS。
11. 纠错三通道：Gate(拦)/Prompt(教,反例 few-shot)/Test(钉,回归断言)。"测试通过"本身可错→判据须是目标真干成那件事。
12. **注解/来源类数据要持久化，先问它与 dry-run/commit 逐字节不变量是否相容**；不相容只能住状态旁路，在保存/加载边界物化（P8.5-B）。
13. **验收判据要看"因对的原因失败"**：负样本只断言"被拒了"会被别处检查顶替而假绿 → `rejectWhy(raw, 正则)` 精确到原因。**脚本没接进 `verify:all` 等于不存在**。
14. 多方案对比中间产物=候选语义方案(非派生视图)，选定才落地。审计必须与界面说同一件事。分层配置 4 层（platform/factory-tenant/project/user）无 team 层。

## 技术栈
React+TS+Vite；2D=Canvas2D 自研；3D=Three.js。后端 Node20+/Fastify（前后端共享类型）。导出=Python+ezdxf（几何 TS 算好传中立 JSON）。`shared/aiContract.mjs`=AI 契约唯一真源（服务/前端/验收三方 import）。不用 opencascade.js。

## 产品决策
- 先自用后商业化；MVP 只出 DXF 不出 DWG（授权未确认；ODA 无 Web/SaaS 权）。
- AI 走 OpenAI 兼容(`POST {baseUrl}/chat/completions` + `response_format:json_object`)→换服务商=填 baseUrl 不改码。**对话通道只问答不产 Command**；对话与规划两按钮；历史落 sessionStorage。
- 账号两模式单向 local-open→accounts；订阅按自然月 token（free20万/pro500万/team3000万/unlimited，PLANS 待拍板）。局域网 `HOST=127.0.0.1` 管入站不管出站。

## 硬约束/红线
MCP 白名单不暴露 SQL/路径/shell/规则集。交付带"模型+生成器+规则集版本"三件套。首批生产人工全检。所有 factory 默认值显式覆盖(踩过 dimlfac=100)。

## 实测踩坑（高频必看）
- **nextId 必传 takenIds**：撞 id 不报错只静默共用→批量造对象先建 takenIds Set 并累加。结构性命令必带 `changes:[]`。
- **环境代理假失败**：`HTTP_PROXY` 把局域网地址当外网→502；服务端/探针 delete 六个代理变量；Node22 fetch 不读代理、Node24 起 `NODE_USE_ENV_PROXY=1`。
- **AI 网关**：推理模型(R1 系)回 `reasoning_content` 非回答、思考吃输出预算、空正文按 `finish_reason=length`；`max_tokens` 夹取 `[1,65536]`，"无限/0/非法"→`PRACTICAL_MAX_TOKENS=16384`；`AI_TIMEOUT_MS` 默认 120000、**生产 300000**（两者每请求重读）。
- **markdown `**` 不进 JSX/toast**：加文本卫生断言（叶子 textContent 不含 `**`）。
- **命令构造函数防呆**：`new CommandBus(project,rules)` 写反照样跑→构造函数做形状校验。
- **undo 也是状态变更(版本+1)**：版本不复原；撤销后执行新命令丢重做尾巴。
- **面板按需挂载→state 卸载**：跨页签留物落 sessionStorage（整份会话一起落、落盘前剪重、存失败要告警）；Section 折叠整块不渲染→主入口勿放折叠区。
- **★ 不许要求模型输出它拿不到的几何**：模型只出语义意图、坐标由系统定；AI 硬给坐标撞墙时沿最小位移推到相切(`nudgeOutOfWalls`)并写进 label。
- **断言不可信比失败更危险**：失败先 `JSON.stringify` 原始值、先假定自己错；几何 0/±1 须精确(sin(π)=1.22e-16)；每个视觉缺陷转永久断言；新增回归断言须临时改坏确认真会红。**负样本断言会随修法失效**，别留假绿。
- **"带数字"会被兜底值顶替成假绿**：`num()` 缺值返 0→判据须是喂进去的值真出现在 message（给有辨识度 ctx：gap=137/angle=45），不能只断言 `/\d/`。**恒真表达式＝假绿**。
- **验收夹具**：必须深拷贝对象（共享引用会让后建用例覆盖先建用例）；**必须显式指定 id** —— 都从空集合取号会都拿 `di_001`，`rejectIntent` 一次带走两条（验收脚本自己就踩过）。
- **扫源码类断言的三个坑**：① 只扫"import 开头的行"会漏掉多行 import **续行**里的 `from '…'` → 先剥注释行再全局匹配 `from\s+'([^']+)'`；② **扫原文**会把"字符串里提到某模块"当成依赖（词表里逐字写着 `core/spatial/derive.ts` 这类**维度名**）→ 只扫 import 说明符并断言**来源数量**；③ 断言"源码里没有 X"必须**只扫代码行**（注释正在讨论 X 时会自欺）。**一条规矩两处入口会误拒**（记录闸门=草案判定+元信息→拒掉所有完整记录）→ 抽独立载荷判定。
- **生成器自带时间戳且常常是嵌套的**：`toNeutralExport` 的 `generatedAt`（与 `serializeProjectFile` 的 `savedAt` 同源）嵌在生成器信息块里 → 逐字节比较前必须**递归**摘掉。
- **`npm run <不存在的脚本>` = 退出码 1 且无输出**：exit=1 先确认脚本名存在（实际名 `verify:draft`/`verify:workflow`/`verify:aigen`/`verify:lshape`）。
- **给快照加新块前先过旧不变量**：B1 派生字段名黑名单（**`derived` 是禁用键名**）、B3 除 `cabinets[*].placement` 外不许 `{x,y}` 且不许长度 2/6 数组、B4 整数、B5 体积 <40KB。
- **结论性 token 的门槛必须绑"前置事实是否可判"**：`floating` 只应在前置事实可判定时给出，否则自相矛盾；退化几何（零长墙/顶点不足）不许编默认值。
- **verify:ui 是分钟级链**：不加短超时；跑前清手动 dev server(占 5273)；提交前 `git checkout -- app/verify/out/`（PNG tracked）；**长输出别 `| tail -N`**（截掉失败列表）。
- **★ verify 运行期间禁改 `app/` 源文件**：Vite HMR 整页重载→应用从 sessionStorage 自动恢复草稿→历史重置/模型回退→**后续断言连环假红**(P8.9 实测 66 条)。判据：源文件 mtime ≈ 日志"恢复本地草稿"时间。
- **`npm run typecheck` 本机可能 OOM**（TS 7 是 Go 编译器，errno=1455）→ `GOMEMLIMIT=1500MiB npx tsc --noEmit`；verify:all 同前缀。
- **几何**：`distPointToLine` 曾 clamp 参数→两柜背面齐并排被判"没连着"（修=去 clamp，重叠由 overlapLen 单独判）；两矩形面贴合⇒相对旋转必是 90° 整数倍，非轴对齐 `deriveContacts` 不覆盖→验收显式"不声称已验证"；90° 柜贴东墙=背 x=3940、身沿 −x（placement=背面左角约定）；`pointInPoly` 射线法交叉乘不等号方向由 (yj−yi) 符号决定；环闭合时起点不重复入列（poly 是纯环）。
- **DXF**：主交付 R2007(原生 UTF-8)；R2000 须 `encoding='gbk'`+`$DWGCODEPAGE=ANSI_936`；EZDXF dimstyle `dimlfac=100`→设 1.0；ACI 7 白底隐形→用 CTB/STB；模型空间 1:1。
- **偏好/知识 scope 别挂具体对象名**：顺手存 `scope.cabinet=柜名`→退化成一次性记录且被 `scopeMatches` 挡掉(静默假失败)。可复用偏好挂"情形/上下文"，对象交给 evidence 留痕。

## 部署（NAS 群晖）
AI 网关 6 位 key 非占位符；宿主机测 000 是 DNS 假故障（容器内 node 测 200）；`docker cp /tmp` 静默失败用 stdin 法；`openrouter/free` 504=抖动非提示词。`AI_TIMEOUT_MS` 改 `data/.env` 不重建镜像。

## 协作方式（2026-09-29 起）
用户不逐条指定文件/函数/步骤，由我自主拆解、实现、测试、提交；他只给产品方向、架构边界与阶段验收。每阶段一份报告（完成内容/关键架构决策/测试结果/遗留问题/commit hash）。**停在阶段不自动进下一阶段**——除非用户明确"继续"。

## v0.3 路线（每阶段验收后再进下一阶段）
P0→P1→P2(`66da2b5`)→P3(`26a7639`)→P4(`6f5541b`)→P5(`8aecd76`)→P6(`a556353`)→P7(`67f6764`)→P8.1(`4290a3a`)→P8.2(`7850046`)→P8.3(`53f20a8`)→P8.4(`bc8284c`)→P8.5(`ec3565b`)→P8.5-B(`99db98e`)→P8.6→P8.7(`c8c01c3`)→P8.8(`d892845`)→P8.9(`0cba2ef`+`b4c62f4`)→P9.0(审查 `985c78b`)→P9.1(`4c50608`)→P9.2(`4c0b74c`)。**当前停在 P9.2，等待验收。** 详见 `docs/Semantic-Model-v2-and-AI-Design-Plan.md` §23.x。

- **层次纪律（P2 起逐层加固）**：关系层 `core/relations.ts`（不产几何 / 接触只有 `deriveContacts()` 一处 / authored 与 inferred 分开、只校验声明）；空间层 `core/spatial/` 只出事实；设计语义层 `core/designValidation/` **只组合不重判**（`report.placement`/`report.spatial` 与单独调用逐字节相同）；落位引擎 `placement.ts`/`placementDesign.ts` 纯函数(不改 Model/不调 AI/不依赖 UI/不出 DXF)。
- **provenance（P8.5/P8.5-B/P8.6）**：`PlacementIntentDecl` + 总线单点 authority 四态 + live/superseded 与 undo/redo 原子。`Cabinet.placementProvenance?` **只住总线旁路**，保存经 `bus.toFileSnapshot()` 物化、加载后剥字段；replaceProject=整批载入重置；`invalidated` 不持久化（现算）。P8.6 属性面板「落位意图」Section=唯一 Resolver 入口；Knowledge 闭环：UI 意图→alignment candidate→确认→active→digest（拖拽/unknown/system/absolute 不产）。
- **P8.7-P8.9（空间事实链）关键规则**：`Room.walls`=中心线回路即边界；`Opening` 挂 `Wall.openings?`（世界坐标纯派生不落盘）；`SPATIAL_TOL` 容差唯一出处；穿墙硬错误归 `RULE-CABINET-IN-WALL` 不重复报；**全程零三角函数**。`DesignValidationReport` **只组合不重判**、不进 deriveFor、零一键修复、判不出就沉默；`WallAttachDecl` **故意没有 wallId**。门扇 `Opening.hinge?`+`swingDirection?` 各自可缺省，绝存包络/半径/开启角度；unknown → 不画不发不产、**绝不默认向内开**。`SPATIAL-CABINET-OPENING`(600 通行带=人流) 与 `DESIGN-CABINET-DOOR-SWING`(90° 扇区=门扫过面积)**互不替代**。**遗留**：柜宽恰等于洞口净宽且贴墙齐平时 footprint 与影响带逐边重合→检不出"挡门口"（两条判定在此边角互补）。
- **P9.0（只审查）**：缺的不是算法是输入与载体；**不需要 ConstraintGraph**（三层是函数 `f(Project)→facts` 非图；耦合约束放**候选枚举器**不放 `resolvePlacement`）；候选布局=**临时运行对象**（先例 `VariantDraft`）；**LLM 不作评分裁判**；`MAX_ACTIONS=12` 与整屋布局冲突。
- **P9.1**（`4c50608`）：`AiSnapshot` 增独立顶层块 `spatialContext`(`readOnly:true`)，纯投影读 `deriveSpatial()`+`roomLoop`，零新判定/零新字段/`schemaVersion` 不变。**零坐标**；`concerns`=10 闭集 token；零长墙 `axis='degenerate'`；`floating` 门槛收紧到 `roomRelation==='inside'`（否则"房间判不出"与"这柜悬空"同时成立）。契约动作 21 条未改。
- **P9.2**（`4c0b74c`）：新增**纯语义层** `core/designIntent/`（`DesignIntent`=用户设计目标，**Intent≠Layout**，不进 Resolver、不产坐标）。词表 9 词（3 取舍方向 `fact:null` + 6 空间条件必须给 `producer{file,signal}`，验收**去真实文件逐字核对信号串**）；三态，**模型只装 active**（candidate 只活在提案对象里）；`origin` 无 `system`、`scope` 写不出 wallId/openingId（**都在类型层**）；**载荷禁一切数字**（比"禁 x/y"强一档，数字筛子刻意排第一）；载体 `Project.designIntents?`（悬空引用**丢弃**+警告，与 `Cabinet.roomId` 悬空拒绝文件**故意不同**）；**不升 schemaVersion**；`snapshot.designIntent` 与 `spatialContext` **分两块互不嵌套**。`verify:design-intent` **158 条**入 verify:all；变异测试 6 次全先红再还原。
