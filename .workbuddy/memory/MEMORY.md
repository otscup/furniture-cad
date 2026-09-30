# 项目长期记忆（已压缩）

## 项目
浏览器端参数化定制家具设计与生产系统。语义模型为真相源，2D/3D/DXF/清单同源派生。自然语言入口，可被 MCP 驱动。**主文档** `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`；**v0.3 路线与阶段实施记录** `docs/Semantic-Model-v2-and-AI-Design-Plan.md`（§23）。**git 仓在项目根**（不是 `app/`）。公开仓库 `otscup/furniture-cad`（默认分支 `master`）。

## 不可违背的设计原则（骨架，逐条都是踩坑换来的）
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
20. 一键修复=承诺→只对修法唯一可判定者开放；设计决定只给诚实话术不给假按钮。
21. "点了错还在"比"没按钮"更糟→一键修复后用真实几何复核。
22. 报错文案唯一真相源 `issueCatalog.buildIssue()`；未登记码直接抛错；设计类给数字、程序缺陷类明说"这是程序缺陷"且不给按钮。
23. **一种形状只许一处判断**：柜体布局 `units`(单行)/`rows`(分层)两形，**只有 `core/layoutModel.ts` 能判谁在**（读折成≥1行；写单行塌 `units`、多行只写 `rows`）。漏一处=该路径静默只看到第一行。
24. 多行柜文件刻意不写 `units` 镜像（旧读者会按全高算板件→不报错地出错误尺寸）→宁可让旧读者明确拒绝。行序**自上而下**，`'fill'` 落最后一行；`schemaVersion` 跟内容走。
25. **验收判据要看"因对的原因失败"**：负样本只断言"被拒了"会被别处检查顶替而假绿 → `rejectWhy(raw, 正则)` 精确到原因。**脚本没接进 `verify:all` 等于不存在**。

## 技术栈
React+TS+Vite；2D=Canvas2D 自研；3D=Three.js。后端 Node20+/Fastify(前后端共享类型)。导出=Python+ezdxf(几何 TS 算好传中立 JSON)。`shared/aiContract.mjs`=AI 契约唯一真源(服务/前端/验收三方 import)。不用 opencascade.js。

## 产品决策
- 先自用后商业化；MVP 只出 DXF 不出 DWG；DWG 须先确认授权(ODA 无 Web/SaaS 权)。
- AI 走 OpenAI 兼容(`POST {baseUrl}/chat/completions` + `response_format:json_object`)→换服务商=填 baseUrl 不改码。
- 账号两模式单向 local-open→accounts；订阅按自然月 token：free20万/pro500万/team3000万/unlimited(PLANS 待拍板)。
- AI 对话通道只问答不产 Command；对话与规划两按钮；历史落 sessionStorage。
- 局域网模型 `HOST=127.0.0.1` 管入站不管出站。分层配置 4 层(platform/factory-tenant/project/user)无 team 层。

## 硬约束/红线
MCP 白名单不暴露 SQL/路径/shell/规则集。交付带"模型+生成器+规则集版本"三件套。首批生产人工全检。所有 factory 默认值显式覆盖(踩过 dimlfac=100)。

## 实测踩坑（高频必看）
- **所有 nextId 必传 takenIds**：撞 id 不报错只静默共用记录→批量造对象第一个动作建 takenIds Set 并累加。
- **环境代理假失败**：HTTP_PROXY 把局域网地址当外网→502；服务端/探针 delete 六个代理变量。Node22 fetch 不读代理、Node24 起 NODE_USE_ENV_PROXY=1。
- **推理模型(R1 系)**：回 reasoning_content 非回答；思考吃输出预算；max_tokens 显式下发 DEFAULT 4096、必带回 reasoning_content；空正文按 finish_reason=length。
- **max_tokens 必须夹取**到 `[1,65536]`（本环境 gpt-load 实测硬上限）；"无限/0/非法"映射到 PRACTICAL_MAX_TOKENS=16384；显式数字仍夹 65536。`AI_TIMEOUT_MS` 默认 120000，**生产配 300000**。改这俩值每请求重读，不需重建镜像。
- **markdown `**` 不进 JSX/toast**：加文本卫生断言(.side-right 叶子 textContent 不含 `**`)。
- **命令构造函数防呆**：`new CommandBus(project,rules)` 参数写反照样跑→构造函数做形状校验。
- **undo 也是状态变更(版本+1)**：版本不复原；撤销后执行新命令丢重做尾巴。
- **面板按需挂载→state 卸载**：跨页签留物落 sessionStorage，整份会话一起落；落盘前剪重(每轮 run.draft 是完整 project)；存失败要显示告警。Section 折叠整块不渲染→主入口勿放默认折叠区。
- **★ 不许要求模型输出它拿不到的几何**：模型只出语义意图(rotation/语义关系)，坐标由系统定；AI 硬给坐标撞墙时沿最小位移推到相切(`nudgeOutOfWalls`)并写进 label。
- **负样本断言会随修法失效**：修完回头看这条负例现在证明什么，判据该换就换，别留假绿。
- **断言不可信比失败更危险**：失败时先 JSON.stringify 原始值、先假定自己错、几何 0/±1 须精确(sin(π)=1.22e-16 旋转180°误判干涉)、每个视觉缺陷转永久断言、新增回归断言须临时关修复确认真失败。
- **"带数字"会被兜底值顶替成假绿**：`num()` 缺值返 0→判据必须是喂进去的值真出现在 message(给有辨识度 ctx：gap=137/angle=45/count=3)，不能只断言 `/\d/`。
- **批量改文案别用"顺序 replace + 断言"脚本**：第 N 项对不上整批抛、一字节不写→先 Read 再 Edit 整块替换。
- **verify:ui 是分钟级链**：不加短超时；跑前清手动 dev server(占 5273)；提交前 `git checkout -- app/verify/out/`(PNG tracked)；**长输出别 `| tail -N`**(截掉失败断言列表)。
- **verify:ui 间歇性红**(B15 .env key 时序抖动)：与本轮改动无因果→复跑一次再下结论。
- **DXF**：主交付 R2007(原生 UTF-8)；R2000 须 encoding='gbk'+$DWGCODEPAGE=ANSI_936。EZDXF dimstyle dimlfac=100→设 1.0。ACI 7 白底隐形→用 CTB/STB。模型空间 1:1。
- **"点到直线"别写成"点到线段"**(P8.2 撞出的 P2 真缺陷)：`distPointToLine` 曾 clamp 参数→深 550/600 两柜背面齐并排被判"没连着"。修=去 clamp(重叠由 overlapLen 单独判)；沿接触面滑动不会分开→"拉开"夹具必须背离接触面拉。
- **几何事实：两矩形面贴合⇒相对旋转必是 90° 整数倍**；45°/45° 可解析但 deriveContacts 不覆盖非轴对齐→验收显式"不声称已验证"。
- **结构性命令必带 changes:[]**；createCabinetFromTemplate 必传 takenIds。
- **同一能力只许一份实现**：跑验收与出图共用 verify/mock-openai.mjs。
- **偏好/知识 scope 别挂具体对象名**：观察器顺手存 `scope.cabinet=柜名`→退化成一次性记录且被 scopeMatches 挡掉(静默假失败)。可复用偏好挂"情形/上下文"，哪个对象改的交给 evidence 留痕。

## 部署（NAS 群晖）
AI 网关 6 位 key 非占位符、宿主机测 000 是 DNS 假故障(容器内 node 测 200)、docker cp /tmp 静默失败用 stdin 法、openrouter/free 504=抖动非提示词。AI_TIMEOUT_MS 默认 120s(改 data/.env 加 60000 不重建镜像)。

## 协作方式（2026-09-29 起）
用户不再逐条指定文件/函数/步骤，由我自主拆解、实现、测试、提交；他只给产品方向、架构边界与阶段验收。每阶段给一份报告（完成内容/关键架构决策/测试结果/遗留问题/commit hash）。**停在阶段不自动进下一阶段**——除非用户明确"继续"。

## v0.3 路线（每阶段验收后再进下一阶段）
P0→P1→P2(Assembly/Connection `66da2b5`)→P3(AI DesignProposal `26a7639`)→P4(Import `6f5541b`)→P5(图片识别 `8aecd76`)→P6(设计知识 `a556353`)→P7(P7/P7.1/P7.2/P7.3 Manufacturing Semantics `67f6764`)→P8.1(确定性落位基础设施 `4290a3a`)→P8.2(语义面接触 attach `7850046`)→P8.3(设计语义验证 `53f20a8`)→P8.4(落位偏好接入 `bc8284c`)。
- **P2 关系层三纪律**（`core/relations.ts` 唯一实现）：① 不产生几何；② "接不接触"只有 `deriveContacts()` 一处；③ 声明 `authored` 与推断 `inferred` 分开——只校验声明。
- **P8 落位四纪律**：① canonical=`Cabinet.placement{x,y,rotation}`，ResolvedPlacement 只是管道中间产物；② 引擎纯函数(不改 Model/不调 AI/不依赖 UI/不出 DXF/不改 Geometry)；③ attach 不是 adjacent+gap=0(两面各有其名、朝向对不上即报错不退化)；④ 设计语义层只判断不重算、只提示不拦截、不替用户选朝向。
- **P8.5 已完成**（C1 命令层 provenance，commit `ec3565b`）：`PlacementIntentDecl`(DistributiveOmit)+`Command.placementIntent`/`confirmedPlan`+总线单点 `derivePlacementAuthority`(四态)+`recomputeProvenance`(live/superseded 与 undo/redo 原子)+导入清空；观察者改读 authority、`alignment` 谓词可学；`placementProvenance` 全仓仅 commandBus.ts+App.tsx，派生层零读取。
- **P8.5-B 已完成**（Persistent Provenance 方案 A，commit `99db98e`）：`Cabinet.placementProvenance?{intent,authority,byOp,atVersion}` 随柜体进 project.json，不升 schemaVersion 不加 migration，缺失=unknown 不伪造。**provenance 只住总线（provById/baselineProv），内存模型永远干净**——干跑沙盒未确认(unknown) vs 真提交(user-confirmed) 是真实语义差异，进模型必破「预览===提交」「F3 干跑===提交逐字节」两条核心不变量；保存经 `bus.toFileSnapshot()` 物化、加载/replaceProject 种子化后剥字段。replaceProject=「整批载入重置」：自家格式恢复、外来天然 unknown，undo/redo 快照双向带 provenance 原子恢复。`invalidated` 不持久化（重解析几何现算）；reload 不回放观察（防 Knowledge 自我强化）。`verify:provenance-persistent` 63 断言已入 verify:all。基线审查报告 `docs/Placement-Intent-Provenance-Persistent-Architecture-Review.md`。
- **踩坑教训（P8.5-B）**：凡"注解/来源类"数据要持久化，先问它与 dry-run/commit 的逐字节不变量是否相容——dry-run 与 commit 对同一命令的语义注解可能天然不同（authority），这类数据只能住状态旁路（总线/独立存储），在保存/加载边界物化，绝不能进被比对的模型状态。
- **P8.6 已完成**（语义落位意图 UI，基线 `99db98e`）：属性面板「落位意图（对齐/贴合）」Section（align 五向 + attach 两面/对齐/缝隙，界面无 x/y 输入）；`src/ui/placementIntent.ts` 纯逻辑层 `commitPlacementIntent`=唯一 Resolver→P8.3 报告→`CMD.placeCabinet(...,'ui',decl)`（user-authored intent 真实进 provenance）；Knowledge 闭环打通（UI 意图→alignment candidate→确认→active→digest；拖拽/unknown/system/absolute 一律不产）。`verify:placement-intent-ui` 62 断言入 verify:all；tsc 0；非 UI 回归 41/41 绿；schemaVersion 不变；旧测试零删除零放宽。**停在 P8.6**。
- **P8.7 已完成**（Spatial Semantics Foundation，基线 `c8c01c3`）：Room/Wall 已存在且**墙即边界**（Room.walls=中心线回路），只新增 `Opening{id,kind:'door'|'window',offset,width,name?}` 挂 `Wall.openings?`（世界坐标纯派生不落盘，不升 schemaVersion）。新层 `core/spatial/`：容差唯一出处 `SPATIAL_TOL{TOUCH:1,NEAR:50,OPENING_ZONE:600}`；facts 三类关系（柜↔房间/墙/洞口）+6 个 SPATIAL-* 码经 buildIssue；**零三角函数**（复用 footprint/wallPolygon）；穿墙硬错误仍归 RULE-CABINET-IN-WALL 不重复报；deriveFor 接线。**洞口影响带**：纯空腔几何检不出贴墙挡门（只贴线）→ span×室内侧 600mm 通行带，室内侧由回路采样点确定性判定。opening 三命令（结构性 op+sideEffect 最小可逆）；parse 校形状、span 越界由空间校验报 issue 不拒文件；AI 契约不开放空间实体。`verify:spatial` 60 断言入 verify:all；tsc 0；非 UI 回归 42/42；零删除零放宽。**停在 P8.7**。
- **踩坑（P8.7）**：① 射线法 pointInPoly 交叉乘不等号方向由 (yj−yi) 符号决定，写成 xj>xi 全盘判反；② 环闭合时起点不重复入列（poly 是纯环）；③ 90° 柜贴东墙=背 x=3940、身沿 −x（placement=背面左角约定），直觉放错不是代码错；④ serializeProjectFile 带 savedAt 参数，逐字节比较必须显式固定。
