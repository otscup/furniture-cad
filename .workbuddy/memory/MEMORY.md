# 项目长期记忆（已压缩）

## 项目
浏览器端参数化定制家具设计与生产系统。语义模型为真相源，2D/3D/DXF/清单同源派生。自然语言入口，可被 MCP 驱动。**主文档** `docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`；**v0.3 路线与阶段实施记录** `docs/Semantic-Model-v2-and-AI-Design-Plan.md`（§23）。**git 仓在项目根**（不是 `app/`）。

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
23. **一种形状只许一处判断**：柜体布局有 `units`(单行)/`rows`(分层)两形，**只有 `core/layoutModel.ts` 能判谁在**（读一律折成 ≥1 行；写单行塌回 `units`、多行只写 `rows`）。漏一处=那条路径静默只看到第一行。
24. 多行柜文件刻意不写 `units` 镜像（旧代码会按全高算板件→不报错地出错误生产尺寸）→宁可让旧读者明确拒绝。行序**自上而下**，`'fill'` 落最后一行；`schemaVersion` 跟着内容走。
25. **验收判据要看"因对的原因失败"**：负样本只断言"被拒了"会被别处检查顶替而假绿 → `rejectWhy(raw, 正则)` 精确到原因。**脚本没接进 `verify:all` 等于不存在**。

## 技术栈
React+TS+Vite；2D=Canvas2D 自研(非 SVG)；3D=Three.js。后端 Node20+/Fastify(前后端共享类型)。导出=Python+ezdxf(几何 TS 算好传中立 JSON)。DB=SQLite→PostgreSQL。`shared/aiContract.mjs` 是 AI 契约唯一真源(服务/前端编译器/验收三方 import)。不用 opencascade.js。

## 产品决策
- 先自用后商业化；无工厂标准用行业默认(RuleSet=配置文件)；必须有可点 CAD UI；MVP 只出 DXF 不出 DWG。
- AI 走 OpenAI 兼容(`POST {baseUrl}/chat/completions` + `response_format:json_object`)→换服务商=填 baseUrl 不改码不重启。
- 分解图默认关；四视图调好后可开关(工具栏/视图面板/命令行 EXPLODE)。
- 账号两模式单向：local-open→accounts(建首账号后全 /api 要 token，删库回不去)。订阅按自然月 token：free20万/pro500万/team3000万/unlimited(PLANS.models 待拍板)。账号安全"已实现/未实现"两栏都摆界面；console error 分两类断言(故意 4xx 单独)。
- AI 对话通道(/api/ai/chat)只问答不产 Command；对话与规划两按钮；历史落 sessionStorage(最近 40，多轮回传 12)。
- 局域网模型 `HOST=127.0.0.1` 管入站不管出站，接内网模型不 bind 0.0.0.0。
- 分层配置 4 层(platform/factory-tenant/project/user)无 team 层；model_suggestions 不进链须标来源；取值带 {key,value,source}。

## 硬约束/红线
DWG 付费/SDK 须先确认授权(ODA 无 Web/SaaS 权)。MCP 白名单不暴露 SQL/路径/shell/规则集。交付带"模型+生成器+规则集版本"三件套。首批生产人工全检。所有 factory 默认值显式覆盖(踩过 dimlfac=100)。

## 实测踩坑（高频必看）
- **AI 密钥勿用长度判占位符**：gpt-load 是本地网关，6 位口令只授权网关自身，转发上游不需 key→实测 200。
- **部署诊断在容器内**：gpt-load 仅 docker 网络可解析，宿主机 curl 得 000(假故障)；容器无 wget/curl 用 node fetch。
- **送文件进容器别 docker cp /tmp**（Win/NAS /tmp 不同，静默失败）→`ssh ... "docker exec -i C sh -c 'cat > /tmp/f.js'" < f.js`。
- **openrouter/free 504 = 供应商抖动**（随机路由免费模型），非提示词变长。
- **所有 nextId 必传 takenIds**：撞 id 不报错只静默共用记录(房间/板件/AI 分区 id 全 unit_001→清单少板→下错料)。批量造对象第一个动作建 takenIds Set 并累加。
- **派生量取值唯一来源**：探针曾从 proto 取板厚(undefined→NaN→静默过关)→加"拿到了值"前置闸门。
- **环境代理假失败**：HTTP_PROXY 把局域网地址当外网→fetch/curl 502；服务端与探针 delete 六个代理变量。Node22 fetch 不读代理、Node24 起 NODE_USE_ENV_PROXY=1。
- **推理模型(R1 系)**：回 reasoning_content 非回答；思考吃输出预算(实测 89%)；max_tokens 显式下发(DEFAULT 4096)、必带回 reasoning_content、界面显示"已等 N 秒"、空正文按 finish_reason=length 说明预算用完。
- **max_tokens 必须夹取**：服务商有硬上限（本环境 gpt-load 实测 `[1,65536]`），不夹取就发→HTTP 400。`resolveMaxTokens()` 夹到 `[1,65536]` 并支持 k/m 后缀。`max_tokens` 是**单次回复**上限（几万级），"百万 token"是上下文/总用量概念，不是这个字段。
- **max_tokens 与 AI_TIMEOUT_MS 联动**：预算越大写得越久（4096 实测 19~66s，65536 必超时）→「无限/0/非法值」映射到 `PRACTICAL_MAX_TOKENS=16384`；显式数字仍夹 65536。`AI_TIMEOUT_MS` 默认仅 120000，**生产配 300000**。改这两个值(每请求重读)**不需重建镜像**。
- **markdown `**` 不进 JSX/toast**：与文档同形，只比文本内容的断言查不出→加文本卫生断言(.side-right 叶子 textContent 不含 `**`)。
- **命令构造函数防呆**：`new CommandBus(project,rules)` 参数写反照样跑→构造函数做形状校验。
- **undo 也是状态变更(版本+1)**：版本不复原；撤销后执行新命令丢重做尾巴。
- **面板按需挂载→state 卸载**：跨页签留物落 sessionStorage。**整份会话一起落**(对话+草案+干跑预览)；**落盘前剪重**(每轮 `run.draft` 是完整 project，几轮撑爆)；存失败要显示告警(静默不存=骗人)。Section 折叠整块不渲染→主入口勿放默认折叠区。
- **★ 不许要求模型输出它拿不到的几何**：曾要求 L 形第二臂给 atX/atY→AI 没有墙坐标只能猜→扎墙 60mm→记忆门整份拒收。规则：**模型只出语义意图(rotation 这类)，坐标由系统定**；AI 硬给坐标撞墙时沿最小位移推到相切(`nudgeOutOfWalls`，判据仍交 detectCollisions)，并把"挪了多少"写进 label。
- **系统自动落位不许覆盖 AI 的朝向**：`pickFreeSpot` 曾丢掉 AI 给的 rotation→两臂并排贴同一面墙。给了 rotation 必须优先挑同朝向的墙。
- **负样本断言会随修法失效**：修完回头看这条负例现在证明什么，判据该换就换，别留假绿。
- **会话按房间分格存**：共用历史时"这个柜子再高一档"失去指代。
- **偏好/知识的 scope 别挂具体对象名**：观察器顺手存 `scope.cabinet=柜名`，结果变成"这只柜喜欢 270°"——换柜子就不算数，还在真正该生效时被 `scopeMatches` 挡掉（表现为"确认了却读不到"，静默假失败）。**可复用偏好挂在"情形/上下文"上，挂对象名就退化成一次性记录**；哪个对象改的交给 evidence 留痕。
- **缩略图画正视图**：画整项目平面图会把新柜挤成细边(像"复制了房间图形")；只画本房间、不画本次不改的对象(墙)；本房间没有要明说"在别的房间"。
- **"有没有并进草案"要留在消息上**：画面与上一轮相同时 **toast 不算数**（会消失）。
- **`.panel-scroll` 三属性缺一不可**：flex:1;overflow:auto;min-height:0。
- **断言不可信比失败更危险**：失败时先 JSON.stringify 原始值、先假定自己错、去掉什么要有理由、每个视觉缺陷转永久断言、不变量从图元实际坐标推(不许读声明 bbox)、新增回归断言须临时关修复确认真失败、几何 0/±1 须精确(sin(π)=1.22e-16 会让 180° 旋转误判干涉)。
- **"带数字"会被兜底值顶替成假绿**：`num()` 缺值返回 0 →"成员数 0 个"也算带数字。fixhint 判据必须是**喂进去的那个值真出现在 message 里**(给有辨识度 ctx：gap=137/angle=45/count=3/hA=900…)，不能只断言 `/\d/`。
- **批量改文案别用"顺序 replace + 断言"脚本**：第 N 项对不上就整批抛、一字节不写。先 Read 再 Edit 整块替换。
- **verify:ui 是分钟级链**：不加短超时(SIGINT 让 exit=130 像工程失败)；跑前清手动 dev server(占 5273 连真 .env 假失败)；提交前 `git checkout -- app/verify/out/`(PNG 是 tracked)。**长输出别 `| tail -N`**(会截掉失败断言列表，只剩退出码)。
- **verify:ui 间歇性红**（B15 .env key 时序抖动）：与本轮改动无因果 → **复跑一次**再下结论，别急着改代码。
- **DXF**：主交付 R2007(原生 UTF-8)；R2000 须 encoding='gbk'+$DWGCODEPAGE=ANSI_936。EZDXF dimstyle dimlfac=100→设 1.0。ACI 7 白底隐形→用 CTB/STB。模型空间 1:1，打印靠图纸空间。
- **"点到直线"别写成"点到线段"**（P8.2 撞出的 P2 真缺陷）：`distPointToLine` 曾 clamp 参数→深 550/600 两柜背面齐并排(共面、重叠 550mm、真相接)被判"没连着"，Placement 说贴上、Relations 说没连。修=去 clamp(重叠由 `overlapLen` 单独判)。连带：**沿接触面滑动不会分开两柜**(角接变 40mm 续接)→"拉开一点"的夹具必须背离接触面拉。
- **几何事实：两矩形面贴合 ⇒ 相对旋转必是 90° 整数倍**（外法线 R(Δ)u = -v，u/v 轴向）。45°/45° 可解析但 deriveContacts 不覆盖非轴对齐→验收显式写"不声称已验证"。
- **结构性命令必带 changes:[]**（记忆门读 cmd.changes，漏了 uncaught 崩门）；createCabinetFromTemplate 必传 takenIds。
- **同一能力只许一份实现**：跑验收与出图共用 verify/mock-openai.mjs。

## 部署（NAS 群晖 2026-09-25）
AI 网关 6 位 key 非占位符、宿主机测 000 是 DNS 假故障(容器内 node 测 200)、docker cp /tmp 静默失败用 stdin 法、openrouter/free 504=抖动非提示词、AI_TIMEOUT_MS 默认 120s(改 data/.env 加 60000 不重建镜像)。

## 代码托管（GitHub）
公开仓库 `otscup/furniture-cad` https://github.com/otscup/furniture-cad （2026-09-29 由私有改公开）。默认分支 `master`，push 走 HTTPS PAT（推完立即 `git remote set-url` 抹掉 token，`.git/config` 不留凭证）。本机 SSH 22 端口被代理拦→用 HTTPS；发布前查 `.gitignore` 排除 `.env`/`accounts.json`/`audit.jsonl`/运行时 data。

## 核心文档
docs/：Master-Plan-v0.1、Phase0-Spike-Report、Phase1/2/3-Delivery-Report、Architecture-Review-Routing-Correction-Loop、Design-Local-Pick-Edit-and-Staged-Generation、**Semantic-Model-v2-and-AI-Design-Plan（v0.3 路线图 + §15~§19 + §23 P7/P7.1/P7.2/P7.3/P8.1/P8.2/P8.3 实施记录）**、Special-Cabinets-and-Sales-Drawing-Plan。spike/ 一键复现 `bash spike/run.sh`。

## v0.3 路线（每阶段验收后再进下一阶段）
P0 冻结形状+迁移护栏 ✅ → P1 垂直 rows ✅ `12e1290` → P2 Assembly/Connection ✅ `66da2b5` → P3 AI DesignProposal ✅ `26a7639` → P4 Import 骨架 ✅ `6f5541b` → P5 图片识别闭环 ✅ `8aecd76` → P6 设计知识系统 ✅ `a556353` → P7 Manufacturing Semantics ✅ `2552072` → P7.1 Rule Hardening+Test Integrity ✅ `0ec9c77` → P7.2 Rule 架构审视+层板托孔 ✅ `a867f98` → P7.3 箱体连接孔 ✅ `67f6764` → P8.1 确定性落位基础设施（PlacementIntent→纯函数引擎→`cabinet.place`；canonical= `Cabinet.placement` 不变；adjacent/align/absolute(authored)；静态成环检测）✅ `4290a3a` → P8.2 语义面接触落位（attach 具名面贴合、复用 P2 `EDGE_ORDER`、FACE-NOT-OPPOSING）✅ `7850046` → P8.3 设计语义验证（见下）✅ `53f20a8` → P8.4 落位偏好接入（见下）✅ `P84HASH`。**停在 P8.4，不自动进 P8.5。**
- **P2 关系层三条纪律**（`core/relations.ts` 唯一实现）：① 关系层**不产生几何**；② "接不接触"只有 `deriveContacts()` 一处；③ 声明 `authored` 与推断 `inferred` 分开——**只校验声明**。`stack` 无 Z 可核→允许声明但报 `ASSEMBLY-STACK-UNVERIFIED`(INFO)。
- **P8 落位四条纪律**：① canonical 仍是 `Cabinet.placement{x,y,rotation}`，ResolvedPlacement 只是管道中间产物；② 引擎纯函数(不改 Model/不调 AI/不依赖 UI/不出 DXF/不改 Geometry)；③ attach 不是 adjacent+gap=0(两面各有其名、朝向对不上即报错不退化)；④ **设计语义层只判断不重算、只提示不拦截、不替用户选朝向**。
- **协作方式（2026-09-29 起）**：用户不再逐条指定文件/函数/步骤，由我自主拆解、实现、测试、提交；他只把产品方向、架构边界与阶段验收。每阶段给一份报告（完成内容/关键架构决策/测试结果/遗留问题/commit hash）。

## 本会话进行中（P8.3 · 落位后的设计语义验证，已完成验收）
- **基线 `7850046`（P8.2）**。要解决的问题：**几何合法 ≠ 设计合理**（副臂 rotation=90 能严丝合缝贴住主臂右端，但贴的是它的门脸）。
- **① 审查**：`FurnitureAssembly` **没有 kind 字段**（kind 在 `Connection` 上）——不新增 Assembly.kind，不重定义已有事实。可复用：`deriveContacts`（唯一接触）、`validateAssemblies`（声明 vs 派生的硬校验）、`EDGE_ZH`/`KIND_ZH`、以及"角接角点归属两条边**本身有歧义**"的态度。
- **② 分层**：Resolver=能不能放 / Design=合不合理 / Geometry=算几何 / Manufacturing=派生制造。**Validator 不重算 Placement、不改 rotation**。结论三档：valid / warning / error（error = 透传 P2 已证明的硬冲突 或 解析失败）。
- **③ facing 派生不落模型**：`frontDirection/backDirection/leftDirection/rightDirection`（placement.ts）复用唯一面几何 `faceSegmentOf`；不加 `Cabinet.facing`（rotation 的第二份真相）。`cornerTurnSide()` 给左/右转角**事实**。
- **④ 只写唯一可判定的事实**：门脸中点沿外法线射线 vs 邻居 bbox（slab 法），**只对接接的柜对**（P8.2 那类"面接触"）。不用"接触边是 front"判——角接时角点属于两条边，会假警报（P2 自己就声明了这份歧义）。
- **⑤ 不替用户选**：可疑 → `DESIGN-FRONT-BLOCKED`/`DESIGN-ORIENTATION-SUSPECT`(WARNING) + `alternatives`(当前原点下四个轴向朝向里门脸不朝内的全部候选) + `ambiguous`；每个候选写明"位置需按新朝向重新解析"；**无 autoFix**（转哪个方向是设计决定）。
- **⑥ 接入**：`CompileResult.design`、`PlanRun.design`（干跑预览即带结论）；**不新增写入命令**、**warning 不拦截提交**、preview===commit 照旧。**刻意不进主规则链**（设计语义是提示，进了主链会把"可能合理"报成项目错误，也会挤掉 P6 的 Hard Rule > Design Knowledge > User Preference）。
- **⑦ 验收**：tsc 0；`verify:placement-design` 107/107；placement 82/82、attach 105/105、relations 82/82、proposal 90/90、import 59/59、manufacturing 101/101、fixhint 27/27（两新码进 NUM_CTX）；全量 verify:all EXIT=0。
- 文档 §23.11；commit `53f20a8`。

## 本会话进行中（P8.4 · 落位偏好与设计知识接入，已完成验收）
- **基线 `6d46812`（P8.3）**。目标：观察→candidate→确认→active→提案上下文→语义意图→确定性解析→P8.3 校验。**边界一句话：偏好只影响"建议什么"，绝不影响"几何怎么算"。**
- **① 审查结论**：P6 `PredicateKind` 维度名够用但**上下文不够**——`{kind,op,value}`+`KnowledgeScope{cabinet,room}` 表达不了"corner/右转角"，裸 `{orientation:270}` 正是被禁止的"corner 永远 270"。最小扩展=在 `KnowledgePredicate` 上加**封闭** `context?: PlacementContext{contact,turnSide}`（不新增 scope、不另造知识系统）。层=**userPreference**。注入口**已存在且唯一**：AIPanel→`knowledgeDigest(resolveKnowledge())`→aiContract。
- **② 不新增语义字段**：`ProposalCabinet.rotation`（"朝向意图，落位由系统定"）P3 就有并编译进 create 参数，直接复用。模型零新增（`Cabinet.placement` 仍 `{x,y,rotation}`，无 facing/orientation 第二真相）。
- **③ 观察门禁极严**：仅 op∈{rotate,update,create} 且路径 `placement.rotation` 且 source 是**人**（ui/mcp）且值真变（-90≡270 不算）且**拿得到上下文**，才产生 candidate。AI(source='ai') 一条都不产生；system(撤销) 不产生；**`cabinet.place` 整类排除**（Resolver 输出当证据=自我强化闭环）；纯 x/y 移动不产生；无上下文（孤立柜/stack）不产生。
- **④ 真问题（实现中抓到）**：观察原本把 `scope.cabinet=柜名` 一起存 → 偏好只在"叫这名字的柜"上生效，既不可复用又在真正该生效时被 `scopeMatches` 挡掉（applicable 恒 0，症状是"确认了却读不到偏好"）。**落位偏好挂在情形上，不挂柜名**；是哪只柜改的由 evidence.cabinetId 留痕。
- **⑤ 上下文不同=两类情形**：`contextKey` 分格——右转角 270 与左转角 90 **不冲突、不合并**（否则被迫二选一）；同上下文不同值才是真冲突（双方都保留人工裁决）。`turnSide` 以**对方柜**为视角，转自己时不变才沉淀得出知识。
- **⑥ 优先级证据三条**：硬规则冲突→进 suppressed 且不进 applicable；`preferredOrientation()` 只读 applicable（未确认/被压制→null，"没依据就别说"）；流水线层偏好在而 P8.3 结论**逐值不变**（error 不消失、warning 不抹平、alternatives/ambiguous 一个不少）。
- **⑦ 硬性边界**：`placement.ts`/`placementDesign.ts` **不 import knowledge**（源码扫描）；有/无偏好同一 intent 解析结果逐值相同；偏好只变提案 rotation，x/y 仍由 Resolver 算（偏好换 90 时位置随之重算）；不新增写入命令；preview===commit。
- **⑧ 主动缩小范围（并写明原因）**：只落地 `orientation` 一类。corner turn side 与 orientation 同源证据无法区分"偏好右转"vs"房间只能右转"；alignment 类因**模型不存落位意图**（placement 只有 x/y/rotation，"按背面齐还是中心齐"落盘即消失），而对齐偏好只能从 x/y 观察——与"普通移动不产生偏好"直接冲突，硬造 relation 字段=拿猜测当证据。
- **⑨ 验收**：tsc 0；`verify:placement-preference` 96/96；knowledge 61/61、placement 82/82、attach 105/105、placement-design 107/107、relations、proposal、import 59/59、manufacturing 101/101、fixhint 全绿；全量 verify:all EXIT=0。
- 文档 §23.12；commit `P84HASH`。
- **明确不做**：自动改 rotation、自动选方案、Z 轴、上下叠放、贴墙/房间边界/门窗、碰撞优化、全屋布局、P8.4。
