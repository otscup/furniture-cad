# 项目长期记忆（已压缩）

## 项目
浏览器端参数化定制家具设计与生产系统。语义模型为真相源，2D/3D/DXF/清单全部同源派生。自然语言入口，可被 MCP 驱动。**主文档**：`docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`。**git 仓在项目根**（不是 `app/`）。

## 不可违背的设计原则（骨架，逐条都是踩坑换来的）
1. 真相源=语义参数化模型(JSON)，非几何；2D/3D/DXF/清单同源派生。
2. 派生数据(Panel/几何/清单)永不写项目文件，`model.json` 只存 authored。
3. AI 只输出 Command 永不输出几何；不能写 derived、不能删项目、不能改规则集。
4. 唯一写入口 CommandBus：UI/AI/MCP/脚本同权同位。
5. 两段式：dry-run(diff+规则)→确认→commit，任何失败不改状态。
6. 机器硬规则(可判定/可阻断) 与 AI 软建议(不可判定/仅提示) 必须分离。
7. 顶岗单位全 mm，禁浮点误差进生产尺寸。
8. 本地优先(local-first)，Phase 0–6 不需 VPS。
9. 所见即所得：界面读数是"最终会被用到的那个值"（预览===提交）。
10. 交互结束立即清瞬时状态(追踪线/捕捉标记/预览徽标/读数)。
11. AI 计划原子：一条被拒→整份一条不执行。
12. 审计必须与界面说同一件事。
13. "改一次全体失效"的设计第一时间堵(哈希自描述/规则集版本化/三件套)。
14. "动没动数据"由用户点的按钮决定→AI 面板两个入口(对话不改模型/生成编辑计划)。
15. "测试通过"本身可错→判据须是目标真的干成那件事。
16. 纠错三通道：Gate(拦)/Prompt(教,反例few-shot)/Test(钉,回归断言)。
17. "是否需模型"与"用哪个模型"是两层→路由抽象要有 `none`(根本不发请求)。
18. 模型无"线"对象→"改线"须译"改语义部件"；PickLine{part,paramPath}由生成器同产，AI 只收 {cabinetId,part,paramPath} 永不收坐标。
19. 多方案对比中间产物=候选语义方案(非派生视图)，选定才落地。
20. 一键修复=承诺→只对修法唯一可判定的规则开放；设计决定只给诚实话术不给假按钮。
21. "点了错还在"比"没按钮"更糟→一键修复后用真实几何复核。
22. 报错文案唯一真相源 `issueCatalog.ts` 的 `buildIssue()`；未登记码直接抛错；设计类给数字、程序缺陷类明说"这是程序缺陷"且不给按钮。

## 技术栈
React+TS+Vite；2D=Canvas2D 自研(非SVG)；3D=Three.js。后端 Node20+/Fastify(前后端共享类型)。导出=Python+ezdxf(几何TS算好传中立JSON)。DB=SQLite→PostgreSQL。`shared/aiContract.mjs` 是 AI 契约唯一真源(服务/前端编译器/验收三方 import)。不用 opencascade.js。

## 产品决策（按时间）
- 先自用后商业化；无工厂标准用行业默认(RuleSet=配置文件)；必须有可点 CAD UI；MVP 只出 DXF 不出 DWG。
- AI 走 OpenAI 兼容(`POST {baseUrl}/chat/completions` + `response_format:json_object`)→换服务商=填 baseUrl 不改码不重启。
- 分解图默认关；四视图调好后可开可关(工具栏/视图面板/命令行 EXPLODE)。
- 账号两模式单向：local-open→accounts(建首账号后全 /api 要 token，删库回不去)。
- 订阅按自然月 token：free20万/pro500万/team3000万/unlimited(PLANS.models 待拍板)。
- 账号安全"已实现/未实现"两栏都摆界面；console error 分两类断言(故意4xx单独)。
- AI 对话通道(/api/ai/chat)只问答不产Command；对话与规划两按钮；历史落 sessionStorage(最近40，多轮回传12)。
- 局域网模型 `HOST=127.0.0.1` 管入站不管出站，接内网模型不 bind 0.0.0.0。
- 分层配置 4 层(platform/factory-tenant/project/user)无 team 层；model_suggestions 不进链须标来源；取值带 {key,value,source}。

## 硬约束/红线
DWG 付费/SDK 须先确认授权(ODA 无 Web/SaaS 权)。MCP 白名单不暴露 SQL/路径/shell/规则集。交付带"模型+生成器+规则集版本"三件套。首批生产人工全检。所有 factory 默认值显式覆盖(踩过 dimlfac=100)。

## 实测踩坑（高频必看）
- **AI 密钥勿用长度判占位符**：gpt-load 是本地网关，6位口令只授权网关自身，转发上游不需 key→实测200。
- **部署诊断在容器内**：gpt-load 仅 docker 网络可解析，宿主机 curl 得000(假故障)；容器无 wget/curl 用 node fetch。
- **送文件进容器别 docker cp /tmp**：Win/NAS /tmp 不同，静默失败→`ssh ... "docker exec -i C sh -c 'cat > /tmp/f.js'" < f.js`。
- **openrouter/free 504 是供应商抖动**：随机路由不同免费模型，非提示词变长。
- **所有 nextId 必传 takenIds**：撞 id 不报错只静默共用记录(房间/板件/AI 分区 id 全 unit_001→清单少板→下错料)。批量造对象第一个动作建 takenIds Set 并累加。
- **派生量取值唯一来源**：探针从 proto.layout.boardT 取板厚(undefined→NaN→静默过关)，加"拿到了值"前置闸门。
- **环境代理假失败**：HTTP_PROXY 把局域网地址当外网→fetch/curl 502；服务端与探针 delete 六个代理变量。Node22 fetch 不读代理、Node24 起 NODE_USE_ENV_PROXY=1。
- **推理模型(R1系)**：回 reasoning_content 非回答；思考吃输出预算(实测89%)；max_tokens 显式下发(DEFAULT 4096)；reasoning_content 必带回；界面显示"已等N秒"；空正文按 finish_reason=length 说明预算用完。
- **max_tokens 必须夹取**：服务商有硬上限（本环境 gpt-load 实测 `[1, 65536]`）。用户填 819200 / "100m" 若不夹取就发 → HTTP 400。规则：`resolveMaxTokens()` 统一夹到 `[1, MAX_OUTPUT_TOKENS_CAP=65536]`，并支持 k/m 后缀（`8k`=8192 与预设对齐）。概念上：`max_tokens` 是**单次回复**上限（几万级），"百万 token"是**上下文/总用量**概念，不是这个字段。
- **max_tokens 与 AI_TIMEOUT_MS 联动（"无限"别映射到硬上限）**：预算越大模型写得越久 —— 实测 4096 要 19~66 秒，65536 必然超过超时 → 报"调用超时"。所以「无限/unlimited/0/非法值」映射到 `PRACTICAL_MAX_TOKENS=16384`（能跑完的实用值）而非硬上限；用户显式填的具体数字仍夹到 65536（自选档位后果自负）。`AI_TIMEOUT_MS` 默认仅 120000，**生产务必显式配 300000**。改这两个值（readEnv 每请求重读）**不需要重建镜像**，只有改代码才要 rebuild。
- **markdown `**` 不进 JSX/toast**：与文档同形，只比文本内容的断言查不出→加文本卫生断言(.side-right 叶子 textContent 不含 **)。
- **命令构造函数防呆**：`new CommandBus(project,rules)` 参数写反照样跑(把规则当项目存，远处才炸)→构造函数做形状校验。
- **undo 也是状态变更(版本+1)**：版本不复原；撤销后执行新命令丢重做尾巴(entries.slice(0,pointer+1))。
- **面板按需挂载→state 卸载**：跨页签留物落 sessionStorage。**整份会话一起落**（对话+草案+干跑预览），只落对话=等几十秒跑出来的草案切页即丢。Section 折叠整块不渲染→主入口勿放默认折叠区，断言先展开再取。
- **会话按房间分格存**：共用一段历史时"这个柜子再高一档"失去指代，模型会拿别的房间的话来改对象。
- **落盘前剪重**：每轮的 `run.draft` 是完整 project，几轮就撑爆 sessionStorage；必须剪掉，且存失败要显示告警（静默不存＝骗人说记住了）。
- **缩略图不要画整项目平面图**：房间 4000×3000 会把 2200×850 的新柜挤成两条细边，用户会以为"AI 把房间的图形复制出来了"。缩略图默认画**正视图**、不画本次不改的对象（墙）、按房间范围只画该房间柜体；本房间没有要明说"在别的房间"。
- **一轮有没有真的并进草案要显示在会话里**：画面与上一轮相同时，**toast 不算数**（会消失），必须有一条留在消息上的"第 N 轮 · 已并入/未并入 + 原因"。
- **`.panel-scroll` 三属性缺一不可**：flex:1;overflow:auto;min-height:0，否则长内容溢出滚不到。
- **断言不可信比失败更危险**：失败时先 JSON.stringify 原始值、先假定自己错、去掉什么要有理由、每个视觉缺陷转永久断言、不变量从图元实际坐标推不许读声明 bbox、新增回归断言须临时关修复确认真失败、几何 0/±1 须精确(sin(π)=1.22e-16 旋转180°误判干涉)。
- **verify:ui 是分钟级链**：不加短超时(命令 SIGINT 让 exit=130 像工程失败)；跑前清手动 dev server(占5273连真.env假失败)；提交前 git checkout 还原 verify/out/*.png。
- **DXF**：主交付 R2007(原生UTF-8)；R2000 须 encoding='gbk'+$DWGCODEPAGE=ANSI_936(兼容备用)。EZDXF dimstyle dimlfac=100→须设1.0。ACI 7 白底隐形→用CTB/STB。模型空间1:1，打印靠图纸空间。
- **结构性命令必带 changes:[]**：记忆门读 cmd.changes，漏了 uncaught 崩门；createCabinetFromTemplate 必传 takenIds。
- **同一能力只许一份实现**：跑验收与出图共用 verify/mock-openai.mjs。

## 部署（NAS 群晖 2026-09-25）
AI 网关6位key非占位符、宿主机测000是DNS假故障(容器内 node 测200)、docker cp /tmp 静默失败用 stdin 法、openrouter/free 504=抖动非提示词、AI_TIMEOUT_MS 默认120s(改 data/.env 加 60000 不重建镜像)。

## 核心文档
docs/ 下：Master-Plan-v0.1、Phase0-Spike-Report、Phase1/2/3-Delivery-Report、Architecture-Review-Routing-Correction-Loop、Design-Local-Pick-Edit-and-Staged-Generation。spike/ 一键复现 `bash spike/run.sh`。

## 本会话进行中（2026-09-25 · 已交付两件）
- **AI 对话框草案**已提交 `6a91374`：draftSession + DraftPreview + AIPanel 草案段 + 样式 + 37 断言验收。
- **房间独立管理页**已提交 `1e423c4`：commandBus 加 room.delete/room.resize（含 resizeRoom 副作用 + 含柜体拒删）；RoomsPanel（列表/新建/改名/改尺寸/删除/聚焦）；Viewport focusRoom 取景；28 断言验收。
- 两个功能 typecheck + 全 node 验收链 + verify:ui 645/645 均通过。本会话两大诉求已闭环。
