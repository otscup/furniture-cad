# 项目长期记忆（骨架版·2026-10-01 压缩）

## 项目
浏览器端参数化定制家具设计与生产系统。**语义模型=真相源**，2D/3D/DXF/清单同源派生。自然语言入口，可被 MCP 驱动。
- 主文档 `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`；v0.3 路线与逐阶段实施记录 `docs/Semantic-Model-v2-and-AI-Design-Plan.md`（§23.x）；架构审查 `docs/P9.0-Architecture-Review.md`。
- **git 仓在项目根**（不是 `app/`）。公开仓库 `otscup/furniture-cad`（默认分支 `master`）。
- 阶段细节一律落 `docs/…Plan.md` 与 `.workbuddy/memory/YYYY-MM-DD.md`；本文件只留骨架与高频坑。

## 不可违背的设计原则（每条都是踩坑换来的）
1. 真相源=语义参数化模型(JSON)，非几何；2D/3D/DXF/清单同源派生。
2. 派生数据(Panel/几何/清单)永不写项目文件，`model.json` 只存 authored。
3. AI 只输出 Command 永不输出几何；不能写 derived、不能删项目、不能改规则集。
4. 唯一写入口 CommandBus：UI/AI/MCP/脚本同权同位。
5. 两段式 dry-run(diff+规则)→确认→commit，任何失败不改状态。
6. 机器硬规则(可判定/可阻断) 与 AI 软建议(不可判定/仅提示) 必须分离。
7. 单位全 mm，禁浮点误差进生产尺寸。
8. 本地优先(local-first)，Phase 0–6 不需 VPS。
9. 界面读数是"最终会被用到的那个值"（预览===提交）。
10. 交互结束立即清瞬时状态(追踪线/捕捉标记/预览徽标/读数)。
11. AI 计划原子：一条被拒→整份不执行。
12. 审计必须与界面说同一件事。
13. "改一次全体失效"的设计第一时间堵(哈希自描述/规则集版本化/三件套)。
14. "动没动数据"由用户点的按钮决定→AI 面板两个入口(对话不改模型/生成编辑计划)。
15. "测试通过"本身可错→判据须是目标真干成那件事。
16. 纠错三通道：Gate(拦)/Prompt(教,反例 few-shot)/Test(钉,回归断言)。
17. "是否需模型"与"用哪个模型"是两层→路由抽象要有 `none`(根本不发请求)。
18. 模型无"线"对象→"改线"须译"改语义部件"；AI 只收 {cabinetId,part,paramPath} 永不收坐标。
19. 多方案对比中间产物=候选语义方案(非派生视图)，选定才落地。
20. 一键修复=承诺→只对修法唯一可判定者开放；**"点了错还在"比"没按钮"更糟**→修复后用真实几何复核；设计决定只给诚实话术不给假按钮。
21. 报错文案唯一真相源 `issueCatalog.buildIssue()`；未登记码直接抛错；设计类给数字、程序缺陷类明说"这是程序缺陷"且不给按钮。
22. **一种形状只许一处判断**：柜体布局 `units`(单行)/`rows`(分层)两形，**只有 `core/layoutModel.ts` 能判谁在**（读折成≥1行；写单行塌 `units`、多行只写 `rows`）。漏一处=该路径静默只看到第一行。多行柜文件**刻意不写 `units` 镜像**（旧读者会按全高算板件→不报错地出错误尺寸）→宁可让旧读者明确拒绝。行序**自上而下**，`'fill'` 落最后一行；`schemaVersion` 跟内容走。
23. **验收判据要看"因对的原因失败"**：负样本只断言"被拒了"会被别处检查顶替而假绿 → `rejectWhy(raw, 正则)` 精确到原因。**脚本没接进 `verify:all` 等于不存在**。
24. **注解/来源类数据要持久化，先问它与 dry-run/commit 逐字节不变量是否相容**；不相容的只能住状态旁路(总线)，在保存/加载边界物化。（P8.5-B 教训）

## 技术栈
React+TS+Vite；2D=Canvas2D 自研；3D=Three.js。后端 Node20+/Fastify(前后端共享类型)。导出=Python+ezdxf(几何 TS 算好传中立 JSON)。`shared/aiContract.mjs`=AI 契约唯一真源(服务/前端/验收三方 import)。不用 opencascade.js。

## 产品决策
- 先自用后商业化；MVP 只出 DXF 不出 DWG；DWG 须先确认授权(ODA 无 Web/SaaS 权)。
- AI 走 OpenAI 兼容(`POST {baseUrl}/chat/completions` + `response_format:json_object`)→换服务商=填 baseUrl 不改码。AI 对话通道只问答不产 Command；对话与规划两按钮；历史落 sessionStorage。
- 账号两模式单向 local-open→accounts；订阅按自然月 token：free20万/pro500万/team3000万/unlimited(PLANS 待拍板)。
- 局域网模型 `HOST=127.0.0.1` 管入站不管出站。分层配置 4 层(platform/factory-tenant/project/user)无 team 层。

## 硬约束/红线
MCP 白名单不暴露 SQL/路径/shell/规则集。交付带"模型+生成器+规则集版本"三件套。首批生产人工全检。所有 factory 默认值显式覆盖(踩过 dimlfac=100)。

## 实测踩坑（高频必看）
- **nextId 必传 takenIds**：撞 id 不报错只静默共用记录→批量造对象第一个动作建 takenIds Set 并累加。结构性命令必带 `changes:[]`。
- **环境代理假失败**：HTTP_PROXY 把局域网地址当外网→502；服务端/探针 delete 六个代理变量。Node22 fetch 不读代理、Node24 起 `NODE_USE_ENV_PROXY=1`。
- **AI 网关三坑**：推理模型(R1 系)回 reasoning_content 非回答、思考吃输出预算、空正文按 `finish_reason=length`；`max_tokens` 必须夹取到 `[1,65536]`（本环境 gpt-load 实测硬上限），"无限/0/非法"→`PRACTICAL_MAX_TOKENS=16384`；`AI_TIMEOUT_MS` 默认 120000、**生产配 300000**（改这俩值每请求重读，不需重建镜像）。
- **markdown `**` 不进 JSX/toast**：加文本卫生断言(.side-right 叶子 textContent 不含 `**`)。
- **命令构造函数防呆**：`new CommandBus(project,rules)` 参数写反照样跑→构造函数做形状校验。
- **undo 也是状态变更(版本+1)**：版本不复原；撤销后执行新命令丢重做尾巴。
- **面板按需挂载→state 卸载**：跨页签留物落 sessionStorage，整份会话一起落；落盘前剪重(每轮 run.draft 是完整 project)；存失败要显示告警。Section 折叠整块不渲染→主入口勿放默认折叠区。
- **★ 不许要求模型输出它拿不到的几何**：模型只出语义意图(rotation/语义关系)，坐标由系统定；AI 硬给坐标撞墙时沿最小位移推到相切(`nudgeOutOfWalls`)并写进 label。
- **断言不可信比失败更危险**：失败时先 `JSON.stringify` 原始值、先假定自己错、几何 0/±1 须精确(sin(π)=1.22e-16 旋转180°误判干涉)、每个视觉缺陷转永久断言、新增回归断言须临时关修复确认真失败。**负样本断言会随修法失效**，判据该换就换，别留假绿。
- **"带数字"会被兜底值顶替成假绿**：`num()` 缺值返 0→判据必须是喂进去的值真出现在 message(给有辨识度 ctx：gap=137/angle=45/count=3)，不能只断言 `/\d/`。**恒真表达式＝假绿**：`!/…/.test('')`、`&& true`、`x===1===false` 当场改掉。
- **验收夹具必须深拷贝对象**：共享 `Room`/`Project` 引用会让后建用例覆盖先建用例。
- **依赖方向断言要扫"整文件"而不是"以 import 开头的行"**：多行 import 的 `from '…'` 在**续行**上→只扫首行会**漏检并假绿**。修法=先剥注释行，再全局匹配 `from\s+'([^']+)'`，断言**来源数量**而不只是"包含"。
- **`npm run <不存在的脚本>` = 退出码 1 且无输出**：回归循环里看到 exit=1 先确认脚本名存在（实际名：`verify:draft`/`verify:workflow`/`verify:aigen`/`verify:lshape`），再怀疑代码。
- **给快照加新块前先过旧不变量**：B1 派生字段名黑名单（**`derived` 是禁用键名**）、B3 除 `cabinets[*].placement` 外不许 `{x,y}` 且不许长度 2/6 数组、B4 整数、B5 体积 <40KB。
- **结论性 token 的门槛必须绑"前置事实是否可判"**：`floating`（没靠墙）只应在前置事实可判定时给出，否则出现"房间判不出内外"与"这柜悬空"**同时成立**的自相矛盾；退化几何（零长墙/顶点不足）**不许编默认值**（`axis='degenerate'`、不给 `extent`）。
- **批量改文案别用"顺序 replace + 断言"脚本**：第 N 项对不上整批抛、一字节不写→先 Read 再 Edit 整块替换。
- **verify:ui 是分钟级链**：不加短超时；跑前清手动 dev server(占 5273)；提交前 `git checkout -- app/verify/out/`(PNG tracked)；**长输出别 `| tail -N`**(截掉失败断言列表)。
- **★ verify 运行期间禁改 `app/` 源文件**：Vite HMR 整页重载→应用从 sessionStorage 自动恢复草稿(`project.replace`)→历史重置/模型回退→**后续断言连环假红**(P8.9 实测 66 条)。判据：源文件 mtime ≈ 日志"恢复本地草稿"时间。UI 大片红先查这条。
- **`npm run typecheck` 本机可能 OOM**（TS 7 是 Go 编译器，VirtualAlloc errno=1455）→ `GOMEMLIMIT=1500MiB npx tsc --noEmit` 即通过；verify:all 同样前缀。
- **几何**：`distPointToLine` 曾 clamp 参数→两柜背面齐并排被判"没连着"（修=去 clamp，重叠由 overlapLen 单独判）；两矩形面贴合⇒相对旋转必是 90° 整数倍，非轴对齐 `deriveContacts` 不覆盖→验收显式"不声称已验证"；90° 柜贴东墙=背 x=3940、身沿 −x（placement=背面左角约定），直觉放错不是代码错；射线法 `pointInPoly` 交叉乘不等号方向由 (yj−yi) 符号决定；环闭合时起点不重复入列（poly 是纯环）；`serializeProjectFile` 带 `savedAt` 参数，逐字节比较必须显式固定。
- **DXF**：主交付 R2007(原生 UTF-8)；R2000 须 `encoding='gbk'`+`$DWGCODEPAGE=ANSI_936`。EZDXF dimstyle `dimlfac=100`→设 1.0。ACI 7 白底隐形→用 CTB/STB。模型空间 1:1。
- **同一能力只许一份实现**：跑验收与出图共用 `verify/mock-openai.mjs`。
- **偏好/知识 scope 别挂具体对象名**：观察器顺手存 `scope.cabinet=柜名`→退化成一次性记录且被 `scopeMatches` 挡掉(静默假失败)。可复用偏好挂"情形/上下文"，具体对象交给 evidence 留痕。

## 部署（NAS 群晖）
AI 网关 6 位 key 非占位符、宿主机测 000 是 DNS 假故障(容器内 node 测 200)、docker cp /tmp 静默失败用 stdin 法、openrouter/free 504=抖动非提示词。AI_TIMEOUT_MS 默认 120s(改 data/.env 加 60000 不重建镜像)。

## 协作方式（2026-09-29 起）
用户不逐条指定文件/函数/步骤，由我自主拆解、实现、测试、提交；他只给产品方向、架构边界与阶段验收。每阶段给一份报告（完成内容/关键架构决策/测试结果/遗留问题/commit hash）。**停在阶段不自动进下一阶段**——除非用户明确"继续"。

## v0.3 路线（每阶段验收后再进下一阶段）
P0→P1→P2(`66da2b5`)→P3(`26a7639`)→P4(`6f5541b`)→P5(`8aecd76`)→P6(`a556353`)→P7(`67f6764`)→P8.1(`4290a3a`)→P8.2(`7850046`)→P8.3(`53f20a8`)→P8.4(`bc8284c`)→P8.5(`ec3565b`)→P8.5-B(`99db98e`)→P8.6→P8.7(`c8c01c3`)→P8.8(`d892845`)→P8.9(`0cba2ef`+`b4c62f4`)→P9.0(只审查 `985c78b`)→**P9.1 Spatial Context for AI（`4c50608`）**。**当前停在 P9.1，等待验收。** 详见 `docs/Semantic-Model-v2-and-AI-Design-Plan.md` §23.x。

- **层次纪律（P2 起逐层加固）**：关系层 `core/relations.ts`（不产几何 / 接触只有 `deriveContacts()` 一处 / authored 与 inferred 分开、只校验声明）；空间层 `core/spatial/` 只出事实；设计语义层 `core/designValidation/` **只组合不重判**（`report.placement`/`report.spatial` 与单独调用逐字节相同）；落位引擎 `placement.ts`/`placementDesign.ts` 纯函数(不改 Model/不调 AI/不依赖 UI/不出 DXF)。
- **provenance（P8.5/P8.5-B/P8.6）**：`PlacementIntentDecl` + 总线单点 authority 四态 + live/superseded 与 undo/redo 原子。`Cabinet.placementProvenance?{intent,authority,byOp,atVersion}` 随柜体进 project.json，**只住总线旁路**，保存经 `bus.toFileSnapshot()` 物化、加载后剥字段；replaceProject=整批载入重置；`invalidated` 不持久化（现算）。P8.6 属性面板「落位意图」Section = 唯一 Resolver 入口（`src/ui/placementIntent.ts` → `CMD.placeCabinet(...,'ui',decl)`）；Knowledge 闭环：UI 意图→alignment candidate→确认→active→digest（拖拽/unknown/system/absolute 一律不产）。
- **P8.7**：`Room.walls`=中心线回路即边界；`Opening` 挂 `Wall.openings?`（世界坐标纯派生不落盘）；`SPATIAL_TOL{TOUCH:1,NEAR:50,OPENING_ZONE:600}` 是容差唯一出处（**洞口影响带 ≠ 柜间通道**）；穿墙硬错误仍归 `RULE-CABINET-IN-WALL` 不重复报；零三角函数。
- **P8.8**：`DesignValidationReport` 只把事实翻译成设计语义（不改事实、**不进 deriveFor**、零一键修复、判不出就沉默）。`WallAttachDecl` **故意没有 wallId**（哪面墙是派生事实）。
- **P8.9**：门扇两字段 `Opening.hinge?` + `Opening.swingDirection?`（**各自可缺省**——"知道铰链在哪、还没想好往哪开"是真状态）；绝存包络/半径/开启角度（90° 是规则不是几何）；零三角函数（弧=±墙方向 u 与 ±法线 n 的**向量加法二分角平分线**）；unknown 四因 `no-swing/open-room/bad-wall/bad-span` → 不画不发不产，**绝不默认向内开、绝不从柜位反推**；`SPATIAL-CABINET-OPENING`(600mm 通行带=人流) 与 `DESIGN-CABINET-DOOR-SWING`(90° 扇区=门扇扫过的面积)**互不替代**。**遗留（已钉在 `verify:door-swing`，未越界修）**：柜宽**恰等于**洞口净宽且贴墙齐平时 footprint 与洞口影响带**逐边重合**→`polysOverlapInterior` 检不出"挡门口"；同一只柜在扇区判定里仍会被报 —— 两条判定在此边角**互补**。
- **P9.0（只审查，不改码）**：结论=骨架已具备六条不变量，**缺的不是算法，是输入与载体**；`AiSnapshot.rooms` 只有 `{index,id,name,wallCount}` = **AI 看不见空间**（阻塞级）；**不需要 ConstraintGraph**（现有三层是函数 `f(Project)→facts` 非图；耦合约束应放**候选枚举器**不放 `resolvePlacement`）；候选布局=**临时运行对象**（先例 `core/variants.ts` 的 `VariantDraft`："候选不是模型，选定才成为模型"）；**LLM 不作评分裁判**（三源=Blocking⊗Facts⊗PreferenceMatch）；"Geometry Truth"应从一级改为**事实层/判定层的分割线**；`MAX_ACTIONS=12` 与整屋布局冲突。→ **先做 P9.1，再谈接 LLM**。
- **P9.1**（`4c50608`）：`AiSnapshot` 增**独立顶层块** `spatialContext`（`readOnly:true`），实现 `src/ai/spatialContext.ts` —— **纯投影**：全部读 `deriveSpatial()` 的 `facts`/`doors`/`clearances` + `roomLoop`，**零新判定、零新模型字段、`schemaVersion` 不变、Resolver 未触碰**。内容：rooms(`boundary{closed,status,wallCount,cornerCount}`+`extent{width,depth}`，**无 area 实现故只给包围范围**)/walls(`name` 投影 authored 人话 + `length`/`axis` 派生)/openings(`kind/offset/width` + 门 `swing{status,hinge?,direction?,unknownReason?}`)/cabinetFacts(`roomRelation`+`wallContacts`+`openingProximity`+`doorClearances`+`concerns`)。**零坐标**（无 {x,y}、无长度 2/6 数组、无 envelope，门扇只给"判得出/判不出"）；`concerns`=10 个**闭集 token**（不搬规则码与文案，"问题列表"仍不给 AI）；零长墙 `axis='degenerate'`；`floating` 门槛收紧到 `roomRelation==='inside'`。契约动作 21 条一字未改，只在 `buildUserMessage` 加一句读法说明。
