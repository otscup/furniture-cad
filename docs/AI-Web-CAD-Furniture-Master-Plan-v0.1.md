# AI 网页版 CAD + 定制家具生产设计系统 — 立项方案 v0.1

> 阶段：Phase 0 之前（纯设计/调研，**不含实现代码**）
> 日期：2026-09-23
> 交付物：PRD + 技术架构 + 技术选型 + 数据模型 + AI Command Schema + 规则系统 + MCP 设计 + 文件格式 + 风险 + MVP 路线
> 文档状态：待决策（文末 K 节有 4 个必须由你拍板的问题）

---

## 0. 结论先行（TL;DR）

调研过程中发现几件事会**直接改变**你原本的假设，先说清楚：

| # | 结论 | 影响 |
|---|---|---|
| 1 | **opencascade.js 已经停滞**：最后稳定版 1.1.1 停在 2020 年（OCCT 7.4.0p1，2019），2.0 只有 2023 年一个 beta，仓库最后一次提交 2023-08-15，三年无更新。**不要把它作为技术底座**。 | 任何"用 OCCT WASM 做内核"的方案，必须换成活跃分支（occt.ts / occt-wasm / libcascade / bitbybit-dev/occt），并先做 Phase 0 实测 |
| 2 | **这个项目不需要 CAD 内核**。柜体是"轴对齐矩形板件的层级装配"，几何复杂度极低（单柜 10–60 个长方体）。真正难的是**拆板逻辑 + 生产规则**，不是 B-rep。引入 OCCT 是"用大炮打蚊子"，代价是 25–67MB WASM、500MB+ 内存、极陡学习曲线，以及语义丢失（B-rep 里改宽度无法自动重算板件）。 | 架构主线定为：**语义参数化模型 + 自研几何生成器**，内核作为后期可选插件 |
| 3 | **真相源必须是"业务模型"，不是几何**。3D 网格、2D 图纸、板件清单、DXF 全部是**派生物**。这与你的第十条要求完全一致，但要在存储层面落实：**派生数据永不写入项目文件**。 | 决定了数据模型、文件格式、版本系统的全部设计 |
| 4 | **DWG 是成本问题，不是技术问题**。ODA 基础商业会员（$3,000/首年）明确标注 **Web/SaaS 使用：否**；要做到浏览器产品，最低需要 Sustaining 会员（**$7,500 首年 / $4,500 续费**）。LibreDWG 是 GPLv3 且写入只稳定到 R2004。 | MVP **只做 DXF**，DWG 走"本地免费转换器"或"付费会员"，Phase 5 再决策 |
| 5 | **DXF 写入用 Python `ezdxf`（MIT）**：R12–R2018 全版本读写、含 DXF→PNG/PDF/SVG 渲染插件、含 `odafc` 插件可直接调 ODA File Converter 读写 DWG、有官方 `audit()` 修图能力。这是整条导出链路上最成熟的一环。 | 导出服务用 Python 微服务，几何计算仍留在 TS（保持与渲染器同源） |
| 6 | **MCP 协议已在 2026-07-28 改为无状态**：去掉 initialize 握手与 session 头，每个请求自带协议版本；TS SDK v2 拆成 `@modelcontextprotocol/server` / `client` / `core`（Node 20+，基于 Web Standards，可跑 Node/Bun/Deno/Workers）。v1 在 v2 发布后至少再维护 6 个月。 | MCP Server 设计用 v2 + Streamable HTTP + stdio 双通道；不要照抄 2025 年之前的教程 |
| 7 | **"AI 不是尺寸的最终权威"必须落到架构上**，不能只是口号：AI 只能写**权威字段（authored）**，且只能通过命令通道；**派生字段（derived）对 AI 只读**，由几何生成器计算，由规则引擎复核。 | 见 B 节数据流、E 节命令信封、F 节规则分级 |
| 8 | **MVP 必须先打通"一条纵切"**：自然语言 → 参数化柜体 → 2D/3D 显示 → 连续修改 → 规则检查 → DXF。纵切打通之前不做任何横向扩张（不做户型识别、不做 CNC、不做报价）。 | 见 J 节路线，Phase 0 就是这条纵切的验证 |

---

## 0.5 决策锁定（2026-09-23 用户确认）

| # | 问题 | 决定 | 对方案的强制约束 |
|---|---|---|---|
| 1 | 自用 vs 产品 | **先自用；效果好再考虑商业化** | MVP 全程不引入 ODA 付费会员、不做多租户、不做账号体系。但**架构不许为"自用"走捷径**（命令通道、规则集配置化、派生不落盘这些不能省），否则商业化时要重写 |
| 2 | 工厂工艺标准 | **暂时没有，用行业默认值，以后有了再换** | RuleSet 必须是**纯配置文件**（`rules/factory-default.json`），换工厂 = 换文件。MVP 阶段规则里的数字**全部标注为"占位值"**，禁止在任何地方硬编码 |
| 3 | 第一阶段谁用 | **自用也必须有真实 UI**：设计师能点鼠标完成修改、拖动、对齐、标注、图层、捕捉、选择、属性面板、3D，以及常用 CAD 快捷键 | **Phase 1 从"极简工作台"升级为"完整 2D/3D 交互工作台"**。详见 §L 交互规格。这一条把 Phase 1 的工作量放大约 3 倍，是本次立项最大的范围变化 |
| 4 | MVP 输出 | **接受只出 DXF（不出 DWG）** | Phase 5 的 DWG 通道降级为可选；DWG 相关授权调研推迟到商业化决策之后 |
| 5 | 核心验收链 | `JSON → Semantic Model → Panel Model → DXF → 真实 CAD 可打开` | **已跑通**，见 `docs/Phase0-Spike-Report.md` |

> ⚠️ 决策 3 的连锁影响：Phase 1 不再是"能画能存"的最小版本，而是**一个真正能给设计师用的 CAD 交互层**。但**交互层绝不能反过来污染领域模型** —— 拖动是"改变 positionAlongWall 这个语义参数"，不是"移动一组线条"。这条边界一旦破了，后面所有 AI 命令都会失效。

---

## A. 产品需求文档（PRD）

### A1. 产品定位

**一句话**：面向室内设计 / 全屋定制从业者的**浏览器端参数化定制家具设计与生产数据系统**，以自然语言为设计入口，以参数化模型 + 生产规则引擎为尺寸权威，输出可交付生产的图纸与数据。

**它是什么**：
- 一个"柜体/固定家具"的专用参数化设计系统（不是通用 CAD）
- 一个把设计意图翻译成**工厂能直接开工的板件数据**的系统
- 一个可以被 AI Agent（Claude Code / Codex / Hermes）通过 MCP 驱动的工作台

**它不是什么**：
- 不是 AutoCAD 替代品（不做通用作图、不做自由曲面）
- 不是渲染出图软件（不做照片级效果图，第一阶段）
- 不是 ERP/MES（不做排产、考勤、应收）
- 不是户型识别 AI（第一阶段不做自动识图）

**差异化立足点**（为什么值得做）：
通用 CAD 里"改一个柜子的宽度"需要人手动改十几条线、重标尺寸、重算板件；本系统里这只是 `Cabinet_001.width = 3000` 一条命令。**价值不在画图，在于"设计即拆板、拆板即生产"的一致性。**

### A2. 目标用户与角色

| 角色 | 诉求 | 关键功能 | 使用频率 |
|---|---|---|---|
| 全屋定制设计师（主要） | 快速出方案、快速改图、现场量房后即时调整 | 参数化柜体、连续对话修改、立面图、立刻报价依据 | 每天 |
| 设计助理 / 绘图员 | 把设计师草图变成规范图纸 | 图纸生成、板件清单、批量改尺寸 | 每天 |
| 工厂拆单员（关键校验者） | 拿到的数据能不能直接开料 | 板件清单、开料清单、封边清单、孔位图 | 每单 |
| 安装师傅 | 现场怎么装 | 安装图、柜体分解图、五金清单 | 每单 |
| 老板 / 项目经理 | 进度与风险 | 问题清单（ERROR/WARNING）、版本历史、导出包 | 每周 |
| **AI Agent（新型用户）** | 无人值守地推进设计任务 | MCP Tools、状态查询、截图自检 | 持续 |

> 注意：**AI Agent 是"用户"，不是"功能"**。这意味着所有能力都必须有稳定的、机器可调用的接口（MCP），而不是只有人类能点的 UI。这一点会反向约束前端设计——先有 API，后有 UI。

### A3. 核心场景

**场景 1：从户型到柜体（主场景）**
1. 上传户型图（PNG / PDF / DXF / DWG）
2. 系统把图纸作为**参考底图**铺在画布上（自动识别范围，MVP **不做**自动识别墙线）
3. 用户手动描出墙体 / 房间边界（或后续用 AI 辅助识别）
4. 用户说："客厅电视墙宽 4260mm。电视柜宽 3200，高 450，深 400。左侧高柜，右侧开放格。18mm 板材，按我的生产规则拆。"
5. 系统创建 `Cabinet_001`，生成 Unit / Panel / 五金，画出 2D 立面 + 3D 预览，跑规则检查，报 issue。

**场景 2：连续对话修改（你反复强调的核心）**
```
用户：做一个 3600 宽衣柜              → create Cabinet_001
用户：左边加两个抽屉                  → Cabinet_001.units[0].drawers += 2
用户：抽屉高度 180                    → 上面两个抽屉 relatedHeight = 180（含 3mm 缝）
用户：上面的门板平均分                → 重算 door 宽度分配
用户：整体高度改 2300                 → height = 2300，级联重算所有依赖高度的板件
用户：不改变总宽                      → 约束保持（width 锁定）
```
**每一步都必须落成对同一个对象的增量修改**，绝不能重新生成。

**场景 3：改错与回退**
```
用户：回到增加抽屉之前的版本
系统：恢复到 Version 002 快照（并可选择：保留/丢弃后续修改）
```

**场景 4：AI Agent 批量作业（未来）**
Taskboard 建任务 → Claude Code 通过 MCP 打开项目 → 修改 → 验证（读 issue）→ 截图自检 → 导出 DXF → 汇报。全程无人工。

### A4. 功能模块（M0–M9）

| 模块 | 名称 | 内容 | MVP 是否包含 |
|---|---|---|---|
| M0 | 项目与文件 | 项目 CRUD、图纸/图片/PDF 上传、底图、保存、快照、导入导出 | ✅ 部分 |
| M1 | 2D 画布 | 视口、缩放平移、捕捉、选择、测量、标注、图层 | ✅ 部分 |
| M2 | 3D 预览 | 正交/透视、剖切、线框/实体、爆炸视图 | ✅ 基础 |
| M3 | 业务对象建模 | Wall / Room / Cabinet / Unit / Panel / Door / Drawer / Shelf / Hardware | ✅ |
| M4 | 参数化与拆板 | 参数约束、派生字段、板件生成、封边、孔位 | ✅ |
| M5 | 规则引擎 | 硬规则校验、ERROR/WARNING/INFO、定位高亮 | ✅ |
| M6 | AI 交互 | 自然语言 → Command、连续对话上下文、指代消解、干跑确认 | ✅ |
| M7 | 导出 | DXF / PDF / 板件清单 / 开料清单 / 封边清单 / 五金清单 | ✅ DXF+CSV |
| M8 | 图纸生成 | 平面/立面/剖面/节点/安装图、尺寸链、图框标题栏 | 🔶 立面优先 |
| M9 | 集成 | MCP Server、REST API、Agent 工作流 | ✅ MCP 精简版 |

### A5. MVP 边界（明确"不做"）

**MVP 做（唯一目标）**：
> 自然语言 → 参数化柜体 → Web 2D/3D 显示 → 连续修改 → 生产规则检查 → **DXF 导出 + 板件/开料清单**

**MVP 明确不做**：
- ❌ 户型自动识别（不解析 DWG 墙线、不做图像识别）
- ❌ DWG 读写（只做 DXF；DWG 只在 Phase 5 决策）
- ❌ 除柜体外的家具类型（床、沙发、桌椅、异形曲面）
- ❌ CNC 加工文件、排版优化、开料优化算法
- ❌ 报价、ERP、MES 对接
- ❌ 照片级渲染、材质贴图库
- ❌ 多用户协作、权限体系（单用户 + 简单 token 即可）
- ❌ 移动端适配（桌面浏览器 1440px+）
- ❌ 完整 CAD 绘图能力（不追求"什么都能画"）

**理由**：这条纵切（NL→柜体→DXF）一旦跑通，"能不能用于生产"这个最大风险就被验证了。反过来，如果先做户型识别和漂亮 UI，最后发现拆板数据工厂不认，全部白做。

### A6. 四条工作流

**A6.1 用户流程**
```
进入项目 → (上传底图) → 创建/选择柜体 → 参数面板微调 或 自然语言指令
   → 看到 2D/3D 实时更新 + 问题面板 → 修正 → 导出（DXF + 清单）→ 送厂
```

**A6.2 AI 工作流（关键：三段式）**
```
① 理解：拿到"当前上下文"(选中对象/会话历史/项目摘要/最近 issue)
② 提案：输出 Command JSON（结构化，不直接改数据）
③ 执行：服务端校验 → 干跑算 diff + 跑规则 → 返回预览 → (自动/人工确认) → 提交
```
任何一步失败都**不改状态**（事务性）。

**A6.3 CAD 工作流**
```
Geometry Generator: 模型 → 2D 线段集(每视图) / 3D 网格 / 板件展开轮廓
Renderer: 2D Canvas + 3D Three.js（共用同一份生成结果）
Exporter: 生成结果 → DXF/PDF/CSV
```
三条下游消费**同一份几何生成结果**，不允许各自算一遍（这是保证"图与料一致"的唯一办法）。

**A6.4 生产工作流**
```
模型 → 拆板(Panel) → 封边(Edge) → 五金(Hardware) → 校验(Rule)
   → 板件图 + 尺寸链 → 开料清单(按板材去重排版前的清单) → 封边清单 → 五金清单 → 打包/运输检查
```

### A7. 体验指标（可验收）

| 指标 | 目标 |
|---|---|
| 自然语言指令首次成功率（常见 30 条指令集） | ≥ 80% |
| 指令执行后 0 个 ERROR 且无需人工修板件 | ≥ 70% |
| 改一个参数到视图刷新 | < 300ms（本地） |
| 项目加载（30 柜体） | < 2s |
| 生成的 DXF 在 AutoCAD/DWG TrueView 打开尺寸误差 | 0（1:1 mm） |
| 板件清单与模型一致性 | 100%（程序化保证，非人工核对）|

---

## B. 技术架构

### B1. 总体架构（分层）

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ① 交互层 Interaction                                                    │
│   Web UI (2D Canvas · 3D Viewer · 参数面板 · 问题面板 · 对话框)           │
│   AI 客户端 (Claude Code · Codex · Hermes · WorkBuddy)                    │
└───────────────┬──────────────────────────────────┬───────────────────────┘
                │ REST / WebSocket                 │ MCP (stdio / Streamable HTTP)
                ▼                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  ② 接入层 Gateway / CommandBus                                            │
│   鉴权 · 限流 · 审计日志 · 会话上下文 · 幂等 · 事务边界                   │
│   ★ 唯一写入口：所有修改（UI / AI / MCP / 脚本）都必须走这里              │
└───────────────┬──────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  ③ 领域层 Domain（唯一真相源）                                            │
│   Design Model：Project/Room/Wall/Cabinet/Unit/Panel*/Hardware/...        │
│   Command Handler：命令 → 领域修改（含级联）                              │
│   Constraint Engine：尺寸约束、比例、对齐、锁定(width/height fixed)        │
│   ★ authored 字段可写；derived 字段只读                                   │
└───────────────┬──────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  ④ 规则层 Rule Engine                                                     │
│   L0 几何硬规则 · L1 工艺规则 · L2 结构规则 · L3 运输安装规则             │
│   → Issue[] { severity: ERROR|WARNING|INFO, target, fixHint }             │
│   ★ 增量失效：规则声明依赖字段路径，改宽度只重跑依赖 width 的规则          │
└───────────────┬──────────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  ⑤ 几何层 Geometry Generator（确定性纯函数，无外部内核依赖）              │
│   model → PanelList(展开尺寸+封边+孔位) · 2D Outline(每视图线段)          │
│         → 3D Mesh(长方体装配) · 尺寸链(DimensionChain)                    │
│   ★ 全链路可单测：柜宽 = 左板厚 + 内净宽 + 右板厚（恒等式断言）           │
│   (可选插件) B-rep 内核后端：OCCT 系列 WASM，Phase 5+ 按需接入            │
└───────┬───────────────────────┬──────────────────────┬───────────────────┘
        ▼                       ▼                      ▼
┌───────────────┐   ┌───────────────────────┐   ┌──────────────────────────┐
│ ⑥A 渲染层     │   │ ⑥B AI 服务层          │   │ ⑥C 导出层 Export Service │
│ 2D: Canvas2D  │   │ LLM Gateway           │   │ 几何结果 → DXF (ezdxf)   │
│ 3D: Three.js  │   │ · 提示词/工具定义     │   │ → DWG (ODA File Conv.)   │
│ 视图/相机/选取│   │ · 结构化输出校验(Zod) │   │ → PDF (ezdxf drawing)    │
│ 高亮/标注     │   │ · 指代消解(确定性)    │   │ → CSV (清单)             │
│               │   │ · 干跑/回滚           │   │ → glTF/PNG (分享用)      │
│               │   │ · 上下文组装          │   │                          │
└───────────────┘   └───────────────────────┘   └──────────────────────────┘
        ┌──────────────────────────┬──────────────────────────────┐
        ▼                          ▼                              ▼
┌──────────────────┐   ┌────────────────────────┐   ┌─────────────────────────┐
│ ⑦ 持久化         │   │ ⑧ 文件存储             │   │ ⑨ 可观测性              │
│ PostgreSQL       │   │ 本地磁盘 / S3 兼容      │   │ 日志·指标·命令审计       │
│ (JSONB 存模型)   │   │ 底图/附件/导出产物      │   │ 每次 AI 修改可追溯       │
│ 命令日志+快照    │   │ 内容寻址 + 哈希去重     │   │                         │
└──────────────────┘   └────────────────────────┘   └─────────────────────────┘
```

### B2. 每层的职责与边界（为什么这样切）

**② 接入层 / CommandBus — 唯一写入口**
这是整个系统的"宪法"。UI 点击、AI 指令、MCP 调用、脚本导入，四条路都必须在同一个入口汇合。收益：
- AI 和人类操作**完全同权同位**，不存在"AI 走了后门改了数据"的情况
- 审计、撤销、权限、限流只需实现一次
- 换 AI 供应商 / 加新的 MCP 客户端，零改动

**③ 领域层 — 唯一真相源**
- 只存**语义参数**（宽高深、材质、布局结构、封边意图），不存线条坐标、不存三角形
- `authored`（人/AI 能写） vs `derived`（程序算，只读）的字段区分，是"AI 不是尺寸权威"的技术实现
- 命令处理器负责**级联**：改高度要重算哪些板件、哪些孔位、哪些门板，是领域知识，不是 AI 的工作

**④ 规则层 — 与领域层分离**
规则会频繁变化（换工厂、换板材、换设备），不能和领域模型耦合。规则通过**字段路径依赖**订阅模型变化，实现增量重算。规则分两级执行：**机器硬规则**（可判定，阻断提交）与 **AI 软建议**（不可判定，仅提示）。

**⑤ 几何层 — 确定性、可测试、无副作用**
这是整个系统最该被严格单测的地方。它是纯函数：`generate(model, ruleContext) => GeometryResult`。同一模型必然产生同一结果（可用内容哈希校验）。**它不知道 Three.js，也不知道 ezdxf**，只产出中立数据结构。

**⑥A/B/C 三个消费者 — 平级，互不知道对方存在**
渲染器只读几何结果；导出器只读几何结果；AI 服务只读写领域层（通过命令）。三者解耦后，你可以把 3D 换成 Babylon.js、把导出换成 ODA SDK，都不影响其他部分。

**⑨ 可观测性的特殊要求**
每次 AI 修改必须落审计记录：`{谁(哪个 Agent)、何时、原始自然语言、生成的 Command、diff、执行结果、产生的 issue}`。这是出生产事故时唯一能复盘的东西。

### B3. 数据流（三条独立通路）

**写通路（命令）**
```
NL / UI / MCP
  → IntentParser（LLM，输出 Command JSON）
  → CommandValidator（JSON Schema + 业务前置校验）
  → DryRun：在模型副本上执行 → 得 diff + issues
  → 返回预览（人/AI 确认）
  → Commit：事务内写入模型 + 追加命令日志 + 失效派生缓存
  → 广播（WebSocket）→ 前端增量刷新
```

**读通路（渲染）**
```
模型版本号/内容哈希变化
  → GeometryGenerator（增量：只重算受影响的柜体）
  → 缓存 GeometryResult（key = model slice hash + rule version）
  → Renderer 拉取 → 2D/3D 绘制
```

**导出通路**
```
用户/Agent 发起 export
  → 校验：issues 中 ERROR 数量 > 0 → 默认阻断（可强制覆盖，需二次确认 + 记录原因）
  → 取/算 GeometryResult
  → 序列化：DXF / PDF / CSV
  → 落文件存储 → 返回下载链接（带过期时间）
```

### B4. 部署形态（考虑你"无 VPS、本地 Windows"的现实约束）

| 形态 | 组成 | 适用 |
|---|---|---|
| **本地单机（推荐起步）** | 一个 Node 进程（API+UI）+ 一个 Python 进程（导出）+ SQLite/Postgres + 本地目录存文件 | 自用、单人、Phase 0–5 全部可跑 |
| 本地 + 云端备份 | 同上，模型 JSON 同步到云盘/Git | 防丢件 |
| 云端 SaaS | 容器化：api / web / export / worker(Postgres, S3) | 多用户产品化后 |

**重要**：因为 AI Agent（Claude Code / Codex）需要**读写本地项目文件**才能高效工作，**本地优先（local-first）**在这个项目里不只是"省钱"，而是架构优势——AI 可以直接编辑 `model.json`、跑 `npm run validate`、看 DXF 生成结果。云端版反而会让 Agent 变笨。

Phase 0–6 全程**不需要 VPS**。这是本方案刻意做出的选择。

---

## C. 技术选型

### C1. 第一性问题：2D？3D？还是参数化 3D 为核心？

你要求"不要因为实现简单而直接选择方案"。所以先拆清楚这三种方案**根本的区别**：不是"几个视图"，而是**谁是真相源**。

#### 方案 A：纯 2D CAD（真相源 = 2D 图纸 + 参数）

| 维度 | 评价 |
|---|---|
| 真相源 | 2D 线条 + 参数标注 |
| 优点 | 实现最快；渲染性能最好；板件天然是 2D，开料/CNC 直接命中；工厂只认 2D 图纸，交付链路最短 |
| 缺点 | 立面与平面是两份独立数据 → **图料不一致风险最高**（改了平面忘了改立面，是行业顽疾）；无法做 3D 碰撞/安装空间检查；业主看方案困难；一旦要 3D 等于重写 |
| 致命点 | "连续对话修改"在纯 2D 里极难做对：AI 改的是一堆线段，而不是柜体语义 |

**结论：不适合本项目。** 因为你 70% 的需求是"对象语义 + 规则 + 拆板"，而纯 2D 的世界里没有对象。

#### 方案 B：语义参数化模型 + 2D/3D 双渲染（**推荐**）

| 维度 | 评价 |
|---|---|
| 真相源 | **领域模型 JSON**（Cabinet/Unit/Panel 语义对象） |
| 优点 | 一份模型 → 2D 图纸 / 3D 预览 / 板件数据 / DXF **同源派生**，图料永远一致；不依赖任何 CAD 内核（无 67MB WASM、无 LGPL 合规、无浏览器内存问题）；AI 操作的是语义对象，天然满足你的第三、四条要求；后期要接 B-rep 内核只需替换第⑤层，业务数据结构不动 |
| 缺点 | 自研几何生成器需要写 + 单测（但柜体是轴对齐长方体，代码量小、可穷举验证）；不适合自由曲面/复杂布尔；真 3D 实体（STEP）输出需要额外内核 |
| 风险 | 几何正确性靠自己保证 → 用"恒等式断言 + 金标准样例"解决 |

#### 方案 C：以参数化 3D（B-rep）为核心，自动投影出 2D

| 维度 | 评价 |
|---|---|
| 真相源 | B-rep 实体（OCCT 的 TopoDS_Shape 等） |
| 优点 | 真实 CAD 精度；倒角/曲面/布尔开洞天然支持；自动 HLR 投影出图（build123d 的 `project_to_viewport` 可一次得到可见线+隐藏线，直接写 DXF/SVG）；可输出 STEP |
| 缺点（严重） | ① **参数化语义丢失**：B-rep 里没有"这是左侧板"的概念，改宽度无法自动重算板件——你最重要的需求（连续修改）反而做不了，除非在内核之上再造一层参数模型（那就等于 B 方案 + 内核，成本翻倍）；② WASM 体积 25–67MB、内存峰值 500MB+、启动秒级；③ 学习曲线极陡（OCCT API 数以千计的类）；④ opencascade.js 已停滞（见 §0-1）；⑤ LGPL 分发合规需要额外处理 |
| 适用 | 复杂造型、节点详图、CNC 3D 加工路径、对外交付 STEP 模型 |

**结论：C 不适合作为 MVP 主线，但值得作为后期"几何后端插件"。**

#### 决策（这是本方案最核心的一条判断）

> **选 B。但把方案 C 做成"可插拔的几何后端"，而不是"另一套系统"。**

理由：
1. **本项目的复杂度不在几何，在业务规则。** 一个柜体最多 60 块板、每块都是长方体（轴对齐、无曲面、无旋转），用 60 个 box 就能表达；而"哪些板要拆成两块""门缝留 3mm 还是 2.5mm""背板要不要卡槽""层板跨度多大要加中立板"，这些**没有任何 CAD 内核对你有帮助**。
2. **参数化优先级高于几何精度。** 你要的是"改一个数，全部自动重算"，这是参数建模解决的问题，不是 B-rep 解决的问题。用 B-rep 当真相源会把这个能力**搞丢**。
3. **验证成本可控。** 自研几何生成器可以被穷举单测：`柜宽 == 左板厚 + 内空净宽 + 右板厚`、`板件总面积 == 各板面积之和`、`门板宽之和 + 缝隙 == 开口宽`。这些恒等式在任何模型上都必须成立，测试成本极低、信心极高。
4. **演进路径干净。** 第⑤层是接口，今天是自研长方体生成器，明天可以挂 `OcctGeometryBackend`（用于出节点详图/STEP），后天可以挂 `CutOptimizer`。领域模型、规则、命令、MCP 全都不用动。

**关于"2D 图纸怎么来"的额外判断**（这点很容易做错）：
不要用"3D 投影 + HLR"来生成柜体立面图/剖面图。对柜体而言，**从参数模型直接推导 2D 视图更准确**——因为系统本来就知道"我要剖在距左侧 600mm 处"，知道哪块板在前、哪块在后，知道哪里该画虚线（被遮挡）哪里该画细实线（封边）。HLR 是从外部"猜"遮挡关系，而参数模型是**内生知识**。所以：
- 柜体内部图纸（板件图、正立面、剖面、门板分格图）→ **参数模型直接生成**
- 房间级视图（房间轴测、3D 透视、与墙体的空间关系）→ 3D 网格渲染 + 截图导出
- 只有将来做异形件/节点详图时，才需要 HLR

### C2. 三套完整技术方案对比（可直接落地的组合）

#### 方案 1：**轻量自研（推荐 MVP）** — TS 全栈 + Python 导出

| 层 | 选型 | 理由 |
|---|---|---|
| 前端 | React + TypeScript + Vite | 生态成熟，AI 生成代码质量高 |
| 2D | **Canvas 2D**（自研渲染器）+ 自研 DXF 解析子集 | 5 万线段无压力；SVG 做同等规模会因 DOM 节点爆掉 |
| 3D | **Three.js**（tree-shaking 后 ~150–200KB） | 包体小、社区最大、柜体量级（≤2000 box）用 InstancedMesh 轻松 60fps |
| 后端 | Node.js 20+ / TypeScript（Fastify 或 Hono） | 与前端同语言，模型类型可共享（**同一份 TS 类型定义前端+后端+MCP**） |
| 领域模型 | 自研 TS 类 + Zod schema | 类型即校验即文档 |
| 几何 | 自研 TS 纯函数生成器 | 见 §C1 决策 |
| 规则 | 自研规则引擎（声明式 DSL + TS 函数逃生舱） | 见 F 节 |
| 导出 | **Python 微服务 + ezdxf（MIT）** | 唯一成熟可靠的 DXF 全版本读写方案；几何数据由 TS 算好传过来，Python 只做序列化 |
| DWG | **ODA File Converter（本地免费工具）** 由导出服务调用 | Phase 0 验证 + 合规确认；不引入会员费 |
| DB | **SQLite**（起步）→ PostgreSQL（多用户） | 单机零运维；模型用 JSONB/JSON 字段 |
| 存储 | 本地目录（内容寻址）→ S3 兼容 | 简单 |
| AI | 任意支持 **结构化输出/function calling** 的 LLM，通过统一网关接入 | 不锁死供应商 |
| MCP | `@modelcontextprotocol/server` v2 + stdio + Streamable HTTP | 见 §0-6 |
| 部署 | 单机 Docker Compose 或直接两个进程 | 无需 VPS |

**总成本**：软件许可 **¥0**（全开源）；只需付 LLM token 费。

#### 方案 2：**OCCT WASM 内核方案**

| 层 | 选型 |
|---|---|
| 几何内核 | occt.ts / occt-wasm / libcascade / bitbybit-dev/occt（**必须 Phase 0 实测**，不要用 opencascade.js） |
| 3D | Three.js 或 Babylon.js（WebGPU 生产可用） |
| 其余 | 同方案 1 |

**代价**：首次加载 +25–67MB；单次布尔运算秒级；移动端/低配机不可用；内核 API 学习成本以月计。
**适用**：要做异形柜、圆弧门、复杂节点详图、STEP 交付。

#### 方案 3：**商业 SDK 方案（工业级）**

| 能力 | 供应商 | 价格（2026 公开报价） |
|---|---|---|
| DWG/DXF 完整读写 | ODA Sustaining 会员 | **$7,500 首年 / $4,500 续费**（含 Web/SaaS 使用权）|
| DWG/DXF（无 Web 权） | ODA Commercial | $3,000 / $2,250 —— **不能用于浏览器产品** |
| 云端 AutoCAD 处理 | Autodesk APS Automation API | 免费 300 处理分钟/月；超出 1 token≈$3（AutoCAD 12 分钟/token）|
| 格式转换/提取 | APS Model Derivative | 免费 60 simple + 20 complex jobs/月 |
| Web 3D 查看 | APS Viewer SDK | 免费调用 |

**适用**：产品化、要卖给工厂、要 DWG 双向无损。**MVP 不需要。**

#### 对比总表

| 维度 | 方案 1 轻量自研 | 方案 2 OCCT WASM | 方案 3 商业 SDK |
|---|---|---|---|
| 开发周期（到 MVP） | **最短** | 长 | 中（集成慢，但能力全）|
| 许可成本 | **0** | 0（LGPL 合规需处理）| $3k–$7.5k/年起 |
| 浏览器性能 | **最优** | 差（内存/启动）| 取决于架构 |
| 参数化连续性修改 | **原生支持** | 需自建上层（等于方案1+C）| 需自建上层 |
| DWG 双向 | 需外挂转换 | 需外挂转换 | **原生** |
| 复杂曲面/布尔 | 不支持 | 支持 | 支持 |
| 风险 | 几何全靠自测 | 内核不稳定/停滞 | 供应商锁定 + 费用 |
| **定位** | **MVP 主线** | Phase 5+ 增强（可插拔）| 产品化后按需 |

### C3. 关键库选型明细（含实测任务）

| 用途 | 首选 | 备选 | 许可 | Phase 0 必须实测 |
|---|---|---|---|---|
| DXF 写 | **ezdxf 1.4.x（Python）** R12–R2018 读写 + `audit()` | `@tarikjabiri/dxf` 等 TS 库（成熟度未验证）| MIT | ✅ 生成的文件在 AutoCAD/TrueView 中单位、字体、线型正确 |
| DXF 读 | `dxf-parser`(JS) 或 ezdxf(Python) | LibreCAD 手工核对 | MIT | ✅ 能否正确读出真实工厂图纸的 LINE/LWPOLYLINE/DIMENSION/TEXT |
| DWG 读/写 | **ODA File Converter（免费工具，DWG↔DXF）** | ODA Drawings SDK（付费）、LibreDWG（GPLv3，写入仅稳到 R2004）、APS | 见各条 | ✅ 命令行批量转换可用性 + **授权条款用于服务端自动化的合规性** |
| 3D 渲染 | **Three.js** | Babylon.js（WebGPU 生产可用、内置 Inspector/GUI，但全量 2MB+）| MIT / Apache-2.0 | ✅ 2000 个 box + 实例化渲染帧率 |
| 2D 渲染 | **Canvas 2D 自研** | Konva（对象管理方便但性能次之）| — / MIT | ✅ 50k 线段 + 缩放平移帧率 |
| 几何内核（可选）| occt.ts（OCCT 7.9.3，活跃）| occt-wasm、libcascade、bitbybit-dev/occt | LGPL-2.1 | ⚠️ 仅 Phase 5 前做 |
| LLM 结构输出 | Function calling / JSON Schema 严格模式 | 文本解析兜底 | — | ✅ 20 次重复同一指令，schema 合法率与语义正确率 |
| MCP | `@modelcontextprotocol/server` v2（Node 20+，2026-07-28 spec）| v1 `@modelcontextprotocol/sdk` | MIT/Apache-2.0 | ✅ 在 Claude Code 中连通并完成一次真实修改 |
| DB | SQLite（单机）→ PostgreSQL（多用户）| — | 公有领域 / PostgreSQL | — |
| 文件存储 | 本地内容寻址目录 | S3 兼容 | — | — |

> ⚠️ **不要选 opencascade.js**。最后稳定版 2020 年，仓库 2023-08 起无提交。要上 OCCT 就选上面列的活跃分支，并自己 fork 固定版本。

---

## D. 数据模型

### D1. 设计原则

1. **单位统一为毫米（mm），全部用整数或 0.1mm 精度定点数**，禁止浮点累加误差进入生产尺寸。
2. **区分 authored（权威）与 derived（派生）**。派生字段**不持久化**（见 §0-3）：加载模型时重算，耗时 <100ms（30 柜体量级）。这样从根本上杜绝"存的板件尺寸和模型对不上"。
3. **ID 稳定可读**：`Cabinet_001`、`Cabinet_001.Unit_L`、`Panel_Cabinet_001_LS`。人类可读，AI 可指代，日志可追溯。
4. **对象只持有语义参数与关系**，不持有坐标（坐标由布局求解器算 → 保证"移动柜体不会让板件数据失效"）。
5. **所有对象带 `schemaVersion`**，为迁移留后路。
6. **几何坐标归"空间层"**：柜体知道自己在房间的位置和朝向；板件知道自己在柜体局部坐标系的位姿，但**这些位姿也是派生的**。

### D2. 对象清单与职责

| 对象 | 归属 | 权威（authored）字段 | 派生（derived）字段 |
|---|---|---|---|
| `Project` | 根 | name, units, schemaVersion, ruleSetId, 当前版本指针 | — |
| `Room` | Project | name, 多边形边界(或引用 Wall), 层高, 地面标高 | 面积、周长 |
| `Wall` | Room | 起点/终点/厚度/高度/类型(承重/隔墙) | 轮廓、面积 |
| `Opening`(门/窗/洞) | Wall | 类型、底标高、宽高、位置(沿墙参数t) | — |
| `Cabinet` | Room | **width, height, depth, 板材材质、背板厚、布局类型、布局参数、见光面标记、封边策略、底部抬高、踢脚高** | boundingBox、板材用量、重量、Unit 分解 |
| `CabinetUnit`(柜内分区) | Cabinet | **type(挂衣/层板/抽屉/开放格/高柜)、宽度(或宽度比例)、内部分配** | 内空净宽、起始X |
| `Panel` | Cabinet / Unit | **override(仅允许有限字段)、封边策略** | type、宽、高、厚、材质、位姿、封边(4边)、孔位、所属关系 |
| `DoorPanel` | Unit | 门型(平开/推拉/上翻)、材质、开启方向、拉手位置 | 门宽（按平均/按分格规则算）、厚、缝、铰链孔位 |
| `Drawer` | Unit | 数量、单高、滑轨类型、面板材质、内部是否有分隔 | 面板尺寸（含缝）、侧板/前后板/底板尺寸、滑轨长度、安装高度 |
| `Shelf` | Unit | 数量、等分或指定高度、是否可调 | 层板尺寸、层板托位置、跨度 |
| `BackPanel` | Cabinet | 厚、安装方式(卡槽/嵌板/背板条) | 尺寸、是否需要分块（超过板材尺寸时） |
| `FillerPanel`(收口) | Cabinet | 类型、宽 | 尺寸、裁切角 |
| `KickBoard`(踢脚) | Cabinet | 高、是否内凹 | 尺寸 |
| `Countertop`(台面) | Cabinet/Group | 材质、厚、前挡水、后挡水、悬挑 | 尺寸、拼缝位置 |
| `Hardware` | Panel/Unit/Cabinet | 类型、品牌型号、规格 | 数量、位置、孔位 |
| `Material`(库) | Library | 名称、编号、厚、材质、**最大开料尺寸、纹理方向、单价、密度** | — |
| `EdgeBanding`(库) | Library | 材质、厚、颜色、卷长 | — |
| `HardwareItem`(库) | Library | 类型、型号、规格参数、安装开孔规则 | — |
| `Rule` | RuleSet | 见 F 节 | — |
| `Constraint` | 模型 | 类型(锁定/等分/对齐/依赖)、目标、表达式 | 是否满足 |
| `Drawing`(图纸定义) | Project | 类型(平面/立面/剖面/板件图)、视图方向、剖切位置、比例、图框 | 生成的线段+标注 |
| `Version`(快照) | Project | 序号、时间、作者(人/Agent)、说明、模型快照引用 | 与父版本的 diff |
| `CommandLog`(审计) | Project | 时间、来源(ui/ai/mcp)、原始 NL、Command JSON、diff、结果 | — |
| `Issue`(规则结果) | 运行时 | severity、ruleId、target、message、fixHint、位置 | — |

### D3. 关键对象 Schema（JSON 示例）

**Cabinet（权威字段，可被 AI 修改的部分）**
```json
{
  "id": "Cabinet_001",
  "schemaVersion": "0.1",
  "type": "Cabinet",
  "name": "主卧衣柜",
  "hostRoom": "Room_bedroom",
  "placement": { "wall": "Wall_001", "positionAlongWall": 1200, "offsetFromWall": 0, "rotation": 0 },
  "params": {
    "width": 3600,
    "height": 2400,
    "depth": 600,
    "boardMaterial": "M_BOARD_18_WOOD_A",
    "backPanel": { "thickness": 9, "method": "groove", "grooveDepth": 8 },
    "bottomLift": 0,
    "kickHeight": 80,
    "kickRecess": 50,
    "visibleSides": ["left", "front"],
    "edgeStrategy": "visible_1mm_others_04mm",
    "doorThickness": 18,
    "doorGap": { "between": 3, "outer": 2 }
  },
  "layout": {
    "type": "row",
    "units": [
      { "id": "Unit_L", "kind": "drawerBank", "width": 600,
        "drawers": [ { "count": 3, "faceHeight": 220, "runner": "HW_RUNNER_450" } ] },
      { "id": "Unit_M", "kind": "hanging", "width": 1200,
        "hangingType": "double", "hangingRodHeight": 1000,
        "shelves": [ { "count": 2, "mode": "equal" } ] },
      { "id": "Unit_R", "kind": "shelves", "width": 600,
        "shelves": [ { "count": 5, "mode": "equal" } ],
        "doors": { "type": "hinged", "count": 2, "mode": "equal", "handle": "HW_HANDLE_A" } }
    ],
    "spacers": []
  },
  "constraints": [
    { "id": "C1", "type": "lock", "field": "params.width", "reason": "用户要求不改变总宽" }
  ],
  "overrides": [],
  "notes": "客厅电视柜同系列"
}
```

**Panel（全部派生，示例：说明派生字段长什么样）**
```json
{
  "id": "Panel_Cabinet_001_LS",
  "belongsTo": "Cabinet_001",
  "role": "LeftSidePanel",
  "material": "M_BOARD_18_WOOD_A",
  "size": { "w": 600, "h": 2400, "t": 18 },
  "grainDirection": "height",
  "edgeBanding": { "top": "E_1MM_WHITE", "bottom": null, "left": "E_1MM_WHITE", "right": "E_1MM_WHITE" },
  "visible": true,
  "transform": { "position": [0, 0, 0], "rotation": [0, 0, 0] },
  "holes": [ { "type": "cam_15", "x": 37, "y": 900, "d": 15 }, { "type": "dowel_8", "x": 37, "y": 900 } ],
  "derivedFrom": { "modelVersion": "v0032", "generator": "core@0.3.1" },
  "warnings": []
}
```

> `derivedFrom.modelVersion` + `generator` 版本号是**可追溯性的关键**：任何一块板出问题，能反查到是哪个模型版本、哪版生成器算出来的。

### D4. 版本与撤销（你是硬要求，这里给完整机制）

采用 **命令日志（event sourcing）+ 周期性快照**：

```
CommandLog: [c1, c2, c3, c4, c5, ...]   每条命令含 inverse（可逆）
Snapshots : v0001(每 20 条命令 或 每次"命名版本") 存完整 model.json
```

| 能力 | 实现 |
|---|---|
| Undo / Redo | 命令指针前后移动 + inverse 命令；跨快照时回滚到最近快照再重放 |
| 命名版本 | 显式快照，附作者/说明。例：`Version 001 初始衣柜` / `002 增加抽屉` / `003 修改高度` |
| 恢复某版本 | 用快照覆盖当前模型，并**追加一条 `restore` 命令**（不销毁历史，历史仍然线性可查） |
| 版本 diff | 结构 diff（对象级 + 字段级），可给 AI 读："v002→v003 改了 height 2400→2300，影响 12 块板" |
| AI 修改记录 | 每条命令的 `source` 区分 `ui / ai / mcp / import`，并保存**原始自然语言** |
| 「回到增加抽屉之前」 | 语义定位：按命令日志里的 `intent` 摘要匹配 → 回到该命令之前的指针位置（确定性，不靠 AI 猜） |

**约束**：`restore` 不删除后续命令，而是分叉记录 —— 用户可看到"从 v003 恢复后又做了哪些修改"，避免"回退后历史神秘消失"。

---

## E. AI Command Schema

### E1. 设计原则

1. **AI 只输出 `Command`，永不输出几何**。这是你第十条要求的实现。
2. **Command 必须小而正交**：一个命令做一件事，便于逆向（undo）、便于审计、便于权限控制。
3. **AI 不解析指代，只输出指代表达式**。"左边那个柜子" → AI 输出 `{"target": {"selector": "unit", "cabinet": "current", "index": 0}}`，由服务端确定性解析"左边"= 按 X 升序 index 0。原因：指代是**几何/布局事实**，不是语言问题，不能让 LLM 猜。
4. **两段式执行**：`dry-run`（算 diff + 跑规则）→ `commit`。默认所有 AI 命令先 dry-run。
5. **数值必须带单位语义**：`{"field":"width","op":"set","value":3000,"unit":"mm"}`，禁止裸数字。
6. **越权即拒**：AI 不能写 `Panel.*`（派生）、不能改 `Project.ruleSetId`、不能删项目。

### E2. 命令信封（统一格式）

```json
{
  "commandId": "cmd_7f3a...",
  "schemaVersion": "0.1",
  "sessionId": "sess_...",
  "projectId": "prj_livingroom",
  "source": "ai",
  "intent": { "nl": "把电视柜宽度从 3200 改成 3000", "confidence": 0.94 },
  "op": "cabinet.update",
  "target": { "type": "Cabinet", "id": "Cabinet_001" },
  "changes": [
    { "path": "params.width", "op": "set", "value": 3000, "unit": "mm" }
  ],
  "assumptions": [
    { "text": "理解为仅修改柜体宽度，不改变房间内其他柜体", "risk": "low" }
  ],
  "options": { "dryRun": true, "autoResolveConstraints": true, "strictRules": true }
}
```

**返回（dry-run 结果）**
```json
{
  "commandId": "cmd_7f3a...",
  "status": "needs_confirmation",
  "diff": {
    "modified": [ { "path": "params.width", "from": 3200, "to": 3000 } ],
    "recomputed": { "panels": 14, "drawers": 4, "doors": 3, "holes": 38 },
    "cascaded": [ { "path": "layout.units[2].width", "from": 800, "to": 600, "reason": "总宽固定，自动压缩最右分区" } ]
  },
  "issues": [
    { "severity": "WARNING", "ruleId": "RULE-SHELF-SPAN", "target": "Panel_Cabinet_001_SH2",
      "message": "层板跨度 1000mm，接近建议上限 900mm，建议加中立板", "fixHint": "add_mid_support" }
  ],
  "blocked": false,
  "preview": { "snapshotUrl": "/preview/cmd_7f3a.svg" }
}
```

### E3. 命令清单（Phase 3 必备 12 条 + 扩展）

| op | 说明 | 关键参数 | 权限 |
|---|---|---|---|
| `cabinet.create` | 创建柜体（含布局） | 宽高深、材质、layout 描述、位置 | write |
| `cabinet.update` | 改柜体参数（**核心**）| path-based changes | write |
| `cabinet.layout.set` | 重设内部分区结构 | units[] | write |
| `unit.add` / `unit.remove` | 增删分区 | side(左/中/右)、kind、width | write |
| `slot.add` | 在分区内加元素 | unitId、kind(drawer/shelf/door/rod)、count、尺寸 | write |
| `slot.update` | 改元素参数 | path-based | write |
| `object.move` | 移动柜体/家具（房间内）| positionAlongWall、offset、rotation | write |
| `object.delete` | 删除对象 | target、cascade 策略 | write(高) |
| `panel.override` | 单块板特例（逃生舱）| panelId、允许字段白名单 | write(高，产生 WARNING) |
| `constraint.set` | 加/解约束 | 类型、目标字段、表达式 | write |
| `design.validate` | 只跑校验 | scope | read |
| `design.undo` / `design.restore` | 撤销 / 恢复版本 | steps / versionId | write |

### E4. 指代消解（确定性，服务端做）

| 用户说法 | 输出 selector | 服务端解析规则（确定性） |
|---|---|---|
| "这个柜子" / "它" | `{"type":"Cabinet","id":"$selected"}` | 取当前选中 |
| "左边" / "右边的分区" | `{"type":"Unit","cabinet":"$current","index":"first_x"}` | 按 X 坐标升序取首/末 |
| "上面的门板" | `{"type":"DoorPanel","unit":"$current","filter":{"z":"top"}}` | 按高度筛选 |
| "第二个抽屉" | `{"type":"Drawer","unit":"$current","index":1}` | 0-based |
| "所有柜体" | `{"type":"Cabinet","scope":"project","all":true}` | 全项目 |
| "电视位" | `{"type":"Unit","nickname":"电视位"}` | 查 `Unit.nickname` 别名表 |

> 别名（nickname）机制很关键：用户会说"电视位""挂衣区""鞋柜区"，系统要能记住这种命名。第一次创建时 AI 应主动写入 `nickname`。

### E5. 连续对话上下文（保证"同一个柜子"）

每次 LLM 调用注入的上下文块（结构化，不靠聊天记录堆叠）：

```json
{
  "session": {
    "activeEntity": "Cabinet_001",
    "recentEntities": ["Cabinet_001", "Unit_M"],
    "lastCommands": [
      { "op": "cabinet.create", "summary": "创建 3600x2400x600 衣柜" },
      { "op": "slot.add", "summary": "左侧分区增加 2 个抽屉" }
    ],
    "pendingConfirmations": []
  },
  "project": {
    "id": "prj_livingroom", "name": "客厅",
    "objectCounts": { "Room": 1, "Cabinet": 2, "Panel": 96 }
  },
  "selected": { "id": "Cabinet_001", "params": { "width": 3600, "height": 2400, "depth": 600 } },
  "openIssues": [ { "severity": "ERROR", "target": "Panel_Cabinet_001_D3", "message": "抽屉面板高度超出滑轨安装空间" } ],
  "rules": { "ruleSetId": "factory_default_v1", "keyLimits": { "maxDoorWidth": 600, "maxPanelSize": [2440, 1220], "boardThicknesses": [9,18,25] } }
}
```

**替代方案（更省 token，Phase 7 可选）**：不让 LLM 看全模型，而是给它一组**工具**（`get_selected_objects` / `get_object` / `get_issues`），由它自己按需查询（这就是 MCP 的思路）。Phase 3 先用注入上下文（简单可靠），Phase 6 起改为工具优先。

### E6. 幻觉与越权的 7 道防线

| # | 防线 | 实现 |
|---|---|---|
| 1 | 输出受约束 | LLM 用 JSON Schema 严格模式 / function calling，禁止自由文本作为命令 |
| 2 | Schema 校验 | Zod 解析失败 → 直接向 LLM 报错并要它重出（最多重试 2 次） |
| 3 | 写权限白名单 | 命令处理器里每个 `op` 明确声明可写字段路径前缀；`Panel.*` 等派生路径一律拒绝 |
| 4 | 值域夹紧 | 数值超出规则允许范围 → 夹紧到边界并**产生 INFO 告知已调整**（不静默改） |
| 5 | 干跑 + diff 预览 | 任何写命令先 dry-run，把 diff/级联影响/issues 返回，用户或 Agent 确认 |
| 6 | 规则复核 | 提交前必跑 ERROR 级规则，有 ERROR 则阻断（除非显式 `force` 并记录原因）|
| 7 | 假设显式化 | LLM 必须填 `assumptions`，写入命令日志与 UI 提示；不确定就问而非猜 |

> 关键原则：**AI 输出的每一个数字都要么是"用户明确说的"，要么是"引用模型现有值"，绝不接受"AI 自己算出来的"**。所有计算由几何生成器完成。

---

## F. 生产规则系统（Rule Engine）

### F1. 最重要的一条边界：硬规则 vs 软建议

你第十九条问得很对，这里给死标准：

| | 机器硬规则（Rule Engine）| AI 软建议（Advisor）|
|---|---|---|
| 判定性 | **可判定**：能写成布尔表达式或代码函数，结果唯一 | 不可判定：好不好看、比例协调不协调 |
| 权威性 | **权威**。ERROR 级可阻断导出 | **参考**。永不阻断，永不写入尺寸 |
| 举例 | 板件超板材最大尺寸、门板超宽、抽屉安装空间不足、板件碰撞、悬空板件、重复板件 | "中间区域视觉比例偏长，考虑加一条横向分割线" |
| 输出 | `Issue{severity: ERROR\|WARNING\|INFO}` | `Suggestion{text, confidence, target}` |
| UI 呈现 | 问题面板（红/黄/蓝），点击定位高亮 | 对话气泡 / 建议卡片，明确标注"AI 建议" |
| 存储 | 规则文件（可版本化、可测试）| 不存（每次重新生成）|

**禁止**：把 AI 的判断包装成 ERROR；也禁止把规则能判定的东西交给 AI（浪费 token 且不稳定）。

### F2. 规则分类与清单

| 级别 | 类别 | 规则示例（≥20 条，覆盖你列的 15 项检查）| 级别 |
|---|---|---|---|
| L0 几何 | 板件尺寸合法 | 1. 单板尺寸 > 0 且不超板材最大开料尺寸（如 2440×1220）<br>2. 单板小于最小可用尺寸（如 <50mm 视为废料）<br>3. 板厚必须是材质库中存在的厚度<br>4. 板件之间体积碰撞<br>5. 板件完全重叠（重复板件）<br>6. 板件无任何连接关系（悬空板件）| ERROR |
| L1 工艺 | 柜体拆分 | 7. 柜体拆分是否符合工厂规则（是否必须拆成上下柜/左右柜）<br>8. 抽屉是否有足够安装空间（滑轨长度 vs 深度、面板高 vs 内空高）<br>9. 门板宽度超限（如 >600mm）<br>10. 门板高度超限（铰链数量需求 vs 实际配置）<br>11. 层板跨度超过建议值（如 >900mm）→ 需中立板<br>12. 封边配置缺失（可见面未封边）<br>13. 背板尺寸超过单块最大尺寸需分块<br>14. 五金安装空间不足（铰链杯孔避让、三合一避让层板）| ERROR / WARNING |
| L2 结构 | 合理性 | 15. 柜体高宽比异常（如高度 >3× 宽度且无背板加强）<br>16. 无背板且跨度大 → 稳定性风险<br>17. 悬空柜体缺少吊码/支撑<br>18. 台面悬挑超限 | WARNING |
| L3 运输安装 | 现场可行 | 19. 单件板重量超限（人工搬运阈值，如 >50kg）<br>20. 包装/运输尺寸超限（电梯、门洞、货车）<br>21. 安装空间不足（柜体前方操作空间、开门半径）<br>22. 柜体总高超过房间层高 | WARNING / ERROR |
| L4 一致性 | 数据 | 23. 布局分区宽度之和 ≠ 柜体宽度（公差 ±0.5mm）<br>24. 门板宽度之和 + 缝隙 ≠ 开口宽<br>25. 抽屉面板高之和 + 缝隙 ≠ 开口高<br>26. 引用的材质/五金库项不存在 | ERROR |

> L4 这一类是**自检规则**，用来保证几何生成器自身没算错——相当于内建断言，价值极高，务必第一批实现。

### F3. 规则的数据结构

**声明式规则**（覆盖约 70%，可直接给工厂配置）
```json
{
  "id": "RULE-DOOR-MAX-WIDTH",
  "version": 1,
  "level": "L1",
  "severity": "ERROR",
  "appliesTo": { "objectType": "DoorPanel" },
  "when": [
    { "field": "size.w", "op": ">", "ref": "params:`$.rules.maxDoorWidth`" }
  ],
  "dependsOn": ["DoorPanel.size.w", "Material.door.type"],
  "message": "门板宽度 {size.w}mm 超过当前生产规则允许的最大值 {max}mm。",
  "fixHint": "split_door",
  "suggestions": [
    { "action": "split_door", "desc": "拆为 2 扇门", "patch": { "doors.count": 2 } },
    { "action": "change_core", "desc": "改用加强芯材（需工厂确认）" }
  ]
}
```

**代码式规则**（复杂逻辑的逃生舱）
```ts
// 复杂判定（如碰撞、安装空间）用代码实现，签名统一
export const rulePanelCollision: Rule = {
  id: 'RULE-PANEL-COLLISION',
  level: 'L0',
  severity: 'ERROR',
  dependsOn: ['*'],  // 全局重算，但只在受影响柜体邻域内执行
  run: (model, ctx) => {
    const issues: Issue[] = [];
    // ... 用包围盒 + 轴向分离判定
    return issues;
  }
};
```

**规则集（RuleSet）**：一组规则的集合，代表一个工厂的能力边界。
```json
{
  "id": "factory_default_v1",
  "name": "通用工厂默认规则",
  "boards": [
    { "id": "M_BOARD_18_WOOD_A", "thickness": 18, "maxSheetSize": [2440, 1220], "grain": true },
    { "id": "M_MDF_18_WHITE",    "thickness": 18, "maxSheetSize": [2440, 1220], "grain": false },
    { "id": "M_BACK_9",          "thickness": 9,  "maxSheetSize": [2440, 1220] }
  ],
  "edges": [ { "id": "E_1MM_WHITE", "thickness": 1 }, { "id": "E_04MM_WHITE", "thickness": 0.4 } ],
  "limits": {
    "maxDoorWidth": 600, "maxDoorHeight": 2400,
    "maxShelfSpan": 900, "shelfSpanNeedMidSupport": 900,
    "minPanelSize": 50, "maxPanelWeightKg": 50,
    "maxCabinetHeightSingle": 2400, "maxCabinetWidthSingle": 2400,
    "defaultDoorGap": 3, "defaultOuterGap": 2,
    "baseboardHeight": 80, "toeKickRecess": 50
  },
  "splitPolicy": {
    "splitWhenHeightOver": 2400,
    "splitWhenWidthOver": 2400,
    "splitMethod": "stacked" 
  },
  "rules": [ "RULE-DOOR-MAX-WIDTH", "RULE-DOOR-MAX-HEIGHT", "RULE-SHELF-SPAN", "..." ]
}
```

> **这是整个系统最该被"配置化"的地方。** 换一个工厂 = 换一个 RuleSet 文件，不改代码。这是产品能否复制到第二家工厂的关键。

### F4. 执行方式

```
模型变更（命令提交）
   ↓
失效分析：从 CommandLog 的 diff 提取被修改的字段路径集合
   ↓
规则订阅匹配：只挑 dependsOn 与变更路径相交的规则   ← 增量，不全跑
   ↓
依赖重算：派生字段先重算（几何生成器），再跑规则
   ↓
问题定位：Issue.target 绑定到对象 ID；空间类问题绑定到坐标/包围盒（供 UI 高亮）
   ↓
聚合去重：同一 target + ruleId 只保留一条；级联产生的重复压成一条并记 affectedCount
   ↓
输出：Issue[] 排序（ERROR → WARNING → INFO，再按空间位置排序）
```

**性能预期**：30 柜体项目全量跑规则 < 200ms；增量（改一个宽度）< 20ms。完全可以做到"边打字边校验"。

**AI 建议的接入点**：规则跑完后，把 `ERROR/WARNING` 摘要 + 模型摘要交给 LLM，问"有没有规则没覆盖的问题"。产出进 `Suggestion[]`，UI 单独区域展示。**明确标注来源**。

---

## G. MCP API 设计

### G1. 基础决策（基于 2026-07-28 规范）

| 项 | 决策 | 理由 |
|---|---|---|
| SDK | `@modelcontextprotocol/server` v2（Node 20+）| 现行稳定线，基于 Web Standards，可跑 Node/Bun/Deno/Workers |
| 传输 | **stdio（本地）+ Streamable HTTP（远程）双通道** | Claude Code / Codex 本地直连用 stdio；Hermes / 远程 Agent 用 HTTP |
| 状态 | 协议无会话，**项目状态由 `projectId` 显式携带** | 新规范去掉了 session，正好匹配"多项目"场景 |
| 鉴权 | stdio 免鉴权（本机信任）；HTTP 用 Bearer + 项目级 scope | 简单可靠 |
| 工具粒度 | **业务对象级**（cabinet_*）+ 少量读写工具 | 不把 200 个底层操作暴露给 AI，避免它乱来 |
| 危险操作 | 两段式：先 `dry_run=true` 得 diff → 再 `confirm_token` 提交 | 与 E1-4 一致 |

### G2. 工具清单（Phase 6 目标：24 个）

**A 组 · 项目与上下文（只读为主）**

| 工具 | 作用 | 关键参数 | 读/写 |
|---|---|---|---|
| `project_list` | 列出可用项目 | — | 读 |
| `project_open` | 打开/切换当前项目 | projectId | 写(会话) |
| `project_get_state` | 获取项目摘要（对象数、版本、ERROR 数）| projectId, depth | 读 |
| `get_selection` | 当前选中对象及其完整参数 | projectId | 读 |
| `get_object` | 按 ID/路径取对象（支持深路径）| id, path?, expand? | 读 |
| `get_context_snapshot` | 一次性返回"AI 决策所需上下文"（§E5 的结构）| projectId | 读 |
| `get_view_image` | **返回当前视图的 PNG/SVG（AI 做视觉检查）** | view(2d_front/2d_plan/3d), width, highlight? | 读 |

**B 组 · 建模（写操作，走 CommandBus）**

| 工具 | 对应 op | 说明 |
|---|---|---|
| `create_cabinet` | `cabinet.create` | 参数：尺寸/材质/布局/位置 |
| `update_cabinet` | `cabinet.update` | path-based changes（核心）|
| `set_cabinet_layout` | `cabinet.layout.set` | 重设分区结构 |
| `add_unit` / `remove_unit` | `unit.*` | 增删分区 |
| `add_slot` | `slot.add` | 加抽屉/层板/门/挂衣杆（支持 count）|
| `update_slot` | `slot.update` | 改分区内元素 |
| `move_object` | `object.move` | 房间内移动 |
| `delete_object` | `object.delete` | 需 confirm_token |
| `set_constraint` | `constraint.set` | 锁定/等分/对齐 |
| `override_panel` | `panel.override` | 逃生舱，产生 WARNING |

**C 组 · 板件与生产数据（只读）**

| 工具 | 作用 |
|---|---|
| `get_panel_list` | 板件清单（含尺寸/材质/封边/孔位/可见性）|
| `get_panel_geometry` | 单板展开轮廓（供 AI 检查异形/开孔）|
| `get_cutting_list` | 开料清单（按材质×厚度分组，含面积汇总）|
| `get_edge_list` | 封边清单（按封边材料分组，含长度）|
| `get_hardware_list` | 五金清单 |
| `get_dimension_chain` | 尺寸链（供核对与生成标注）|

**D 组 · 校验**

| 工具 | 作用 |
|---|---|
| `validate_design` | 跑规则引擎，返回 Issue[]（支持 scope: project/cabinet/panel）|
| `get_issues` | 取当前未解决问题 |
| `explain_rule` | 查某条规则的定义与依据（AI 解释给用户）|
| `list_rules` | 列出当前 RuleSet 的规则与限值 |

**E 组 · 导出**

| 工具 | 作用 | 备注 |
|---|---|---|
| `export_dxf` | 导出 DXF（可选 scope：柜体/房间/全部；可选视图：板件图/立面/剖面）| MVP 主交付 |
| `export_production_package` | 一次性导出 DXF + 4 张清单（zip）| 工厂交付包 |
| `export_dwg` | 导出 DWG（依赖 DWG 通道可用性）| Phase 5+，可能返回"不可用" |
| `export_pdf` | 导出图纸 PDF | Phase 5 |
| `export_3d_preview` | 导出 glTF/PNG（给客户看）| 可选 |

**F 组 · 版本**

| 工具 | 作用 |
|---|---|
| `list_versions` | 版本历史（含 AI 修改记录）|
| `diff_versions` | 两版本结构 diff |
| `restore_version` | 恢复到某版本（需 confirm_token）|
| `undo` / `redo` | 命令级撤销 |

### G3. 不暴露给 MCP 的东西（很重要）

- ❌ 任意 SQL / 数据库直连
- ❌ 任意文件系统读写（`export_*` 只能写入指定导出目录）
- ❌ 规则集修改（`rule_set` 属于管理面，走独立后台接口 + 人工）
- ❌ 删除项目、删除规则集
- ❌ 执行 shell / 代码

> MCP Server 本质是一个**远程执行面**，一旦工具设计过宽，等于把系统控制权交给 LLM。上面的白名单是底线。

### G4. 与 Codex / Hermes / Taskboard 集成

```
Taskboard（任务编排，人可见）
   │  创建任务：{"project":"prj_livingroom","task":"把主卧衣柜改成 2300 高并重新导出"}
   ▼
Codex（代码/脚本能力）—— 用于开发 CAD 系统本身（改代码、加规则、写测试）
   │
Hermes（浏览器自动化）—— 用于做 UI 上必须"手点"的事（截图、录制、验证渲染）
   │
MCP Server（本系统的唯一机器接口）
   ▼
CAD Engine（领域模型 + 规则 + 几何 + 导出）
```

分工要点：
- **Codex 改代码，不改模型**。模型修改一律走 MCP，避免绕过校验直接改 JSON（会破坏派生一致性）。
- **Hermes 只做"验证与演示"**，不做数据写入（它的写入不可靠且不可审计）。
- **Taskboard 是唯一的人工可见进度源**，MCP 每次提交把命令 ID 回写任务，实现可追溯。

**给 MCP 的稳定契约**：项目文件（`model.json`）设计成"可被 Agent 直接读的 JSON"，但**写只能通过 MCP**。这样 Codex 能"看懂"项目，但不能"绕过"规则。

---

## H. 文件格式与转换链路

### H1. 项目目录结构

```
project/
├── project.json                 # 元数据 + 版本指针 + 关联的 ruleSetId
├── model/
│   ├── model.json               # ★ 唯一真相源（语义参数，只存 authored 字段）
│   └── snapshots/
│       ├── v0001.json           # 命名版本快照（完整模型）
│       └── v0002.json
├── log/
│   └── commands.ndjson          # 命令日志（append-only，含 inverse + 原始 NL + 来源）
├── rules/
│   ├── industry.json            # 通用行业规则
│   └── factory.v1.json          # 工厂规则（板材/五金/设备限制）
├── library/
│   ├── materials.json           # 板材库
│   ├── edgebanding.json         # 封边库
│   ├── hardware.json            # 五金库（含安装开孔规则）
│   └── templates/               # 柜型模板（挂衣/抽屉/层板/鞋柜…）
├── drawings/                    # 生成的图纸（可重算，可删）
├── exports/                     # 导出产物（带时间戳）
└── assets/
    ├── plans/                   # 上传的户型图 PDF/PNG/DXF/DWG（原始件，只读）
    └── index.json               # 底图元数据（比例、锚点、校准信息）
```

**project.json**
```json
{
  "schemaVersion": "0.1",
  "id": "prj_livingroom",
  "name": "客厅方案 A",
  "units": "mm",
  "ruleSetId": "factory_default_v1",
  "currentModel": "model/model.json",
  "currentVersion": "v0003",
  "createdAt": "2026-09-23T08:00:00Z",
  "app": { "name": "awecad", "generatorVersion": "core@0.3.1" }
}
```

### H2. 关键设计约束

| 约束 | 理由 |
|---|---|
| **派生数据（Panel/几何/清单）永不写入 `model.json`** | 保证"模型是唯一真相"，杜绝不一致 |
| **`assets/plans/` 只读** | 原始图纸是证据，不能被程序改写 |
| **`log/commands.ndjson` append-only** | 审计与撤销的基础 |
| **`drawings/`、`exports/` 可随时删除重建** | 它们是缓存，不是数据 |
| **换内核不丢结构** | `model.json` 里没有任何 CAD 内核相关概念（无 B-rep handle、无 brep 引用），所以未来换几何后端零迁移 |
| **`schemaVersion` + 迁移脚本** | 格式演进必备 |

### H3. 转换链路

```
                    model.json（语义参数，唯一真相源）
                              │
                    几何生成器（TS 纯函数）
                              │
        ┌─────────────────────┼──────────────────────┬───────────────────┐
        ▼                     ▼                      ▼                   ▼
  PanelList(展开尺寸)   2D 线段集(每视图)      3D 网格(glTF/内存)   尺寸链/标注
        │                     │                      │                   │
        ▼                     ▼                      ▼                   ▼
  开料/封边/五金清单    DXF (ezdxf)            glTF / PNG          PDF 图纸
   (CSV/Excel)             │                   (Three.js 截图)      (ezdxf drawing)
                           │
                           ▼
                 [ODA File Converter 或 ODA SDK]
                           │
                           ▼
                       DWG（可选，Phase 5+）
```

**格式策略表**

| 格式 | 方向 | 用途 | 实现 | 优先级 |
|---|---|---|---|---|
| **JSON（内部）** | R/W | 项目文件、AI 可读 | 自研 | P0 |
| **DXF R2000/R12** | W | 交付工厂、CAD 编辑 | ezdxf | P0 |
| **DXF** | R | 导入户型/底图 | ezdxf / dxf-parser | P1 |
| **CSV/XLSX** | W | 开料/封边/五金清单 | 自研 | P0 |
| **PDF** | W | 图纸归档、打印、给客户 | ezdxf drawing add-on | P1 |
| **PNG/SVG** | W | 预览、AI 视觉自检 | Three.js / Canvas | P0 |
| **glTF/GLB** | W | 3D 预览分享 | Three.js 导出 | P2 |
| **DWG** | W | AutoCAD 原生交付 | ODA Converter（本地）/ ODA SDK（付费）| P2 |
| **DWG** | R | 导入客户原始图纸 | ODA Converter / APS | P2 |
| **STEP** | W | 3D 模型交付（异形件）| OCCT 后端 | P3 |

**DXF 的 5 个必踩坑（Phase 0 必须实测）**
1. **单位**：必须设 `$INSUNITS = 4`（毫米），否则对方打开尺寸差 25.4 倍。
2. **中文文字**：R12 用 `$DWGCODEPAGE`（ANSI_936/GBK），R2000+ 可 UTF-8；字体风格要指定（如 `txt.shx` 或 `hztxt.shx`），否则中文变问号。
3. **线型/图层**：图层名用中文可能出兼容问题 → 建议中英混合（`PANEL_板件`）或纯英文 + 图例说明。
4. **填充(HATCH)**：ezdxf 生成 HATCH 需要闭合边界，边界不闭合会导致 AutoCAD 报错。
5. **版本选择**：**R2000（AC1015）兼容性最佳**；R12 最兼容但属性少。默认 R2000，提供 R12 导出选项。

### H4. DWG 策略（分阶段）

| 阶段 | 策略 | 成本 |
|---|---|---|
| MVP → Phase 4 | **只做 DXF**。工厂端普遍能接受 DXF，AutoCAD/DWG TrueView/中望/CAXA 都能打开 | ¥0 |
| Phase 5 方案 A | **本地 ODA File Converter**：导出服务生成 DXF 后调用其命令行转 DWG（DWG↔DXF 双向）| ¥0（需确认条款用于服务端自动化的合规性）|
| Phase 5 方案 B | **ODA Sustaining 会员 + Drawings SDK**：原生读写 DWG，可做浏览器产品 | $7,500 首年 / $4,500 续费 |
| Phase 5 方案 C | **Autodesk APS Automation API**：云端 AutoCAD 转图 | 免费 300 分钟/月，超出 1 token≈$3（12 分钟/token）|
| 不建议 | LibreDWG（GPLv3，写入仅稳到 R2004）；直接解析 DWG 二进制 | 风险高 |

**建议**：Phase 5 先做 A（零成本验证真实需求），**只有当客户明确要求且量上来了**再考虑 B。**不要为了"支持 DWG"这五个字先花 $7,500。**

---

## I. 风险评估

| # | 风险 | 等级 | 具体表现 | 对策 |
|---|---|---|---|---|
| 1 | **DWG 授权** | 高 | ODA Commercial（$3,000）明确无 Web/SaaS 使用权；要做到浏览器产品必须 Sustaining（$7,500）。ODA File Converter 免费但服务端自动化调用的条款需自证合规。APS 按量计费且依赖云端 AutoCAD | ① MVP 只出 DXF，把 DWG 变成"可选付费项"；② 若必须 DWG，Phase 5 前书面确认 ODA/ODA Converter 条款；③ 保留"DXF + 一页安装说明"给工厂作为零成本路线 |
| 2 | **CAD 内核许可与稳定性** | 中高 | opencascade.js 已停滞 3 年；OCCT 是 LGPL-2.1 + 例外，WASM 分发需要合规处理（提供构建方式/源码链接）| ① MVP 不用内核（本方案核心决策）；② 若 Phase 5 引入，选活跃分支（occt.ts 等）并 fork 固定版本；③ 上线前做 LGPL 合规检查（动态链接 + 提供源码获取方式）|
| 3 | **浏览器性能** | 中 | OCCT WASM 首屏 25–67MB、内存 500MB+；2D 用 SVG 画 5 万线段会卡死；2000 个 box 若不用 InstancedMesh 会掉帧 | ① 不在浏览器跑内核（几何在后端/纯 TS）；② 2D 用 Canvas 2D，不用 SVG（导出时才生成 SVG）；③ 3D 用 InstancedMesh + 合并几何 + 关闭阴影 |
| 4 | **AI 幻觉** | 高 | 编造尺寸、误理解"左边"、把"加深 50"理解成"高 50"、重复修改 | 见 §E6 七道防线。核心：AI 只输出意图，尺寸由系统算；干跑 + diff 预览；`assumptions` 强制显式；不确定就问 |
| 5 | **几何错误** | 中高 | 拆板算错（少算板厚、缝隙漏算）、孔位偏移、封边漏边 | ① 恒等式断言测试（§F2 L4 那 4 条）；② 金标准样例库（10 个典型柜型，人工核对过尺寸）；③ 几何生成器纯函数 → 可回归；④ 每次生成带 `generatorVersion` |
| 6 | **生产错误（最严重）** | **极高** | 板件尺寸对了但顺序/朝向错；封边封在不可见面；孔位打在封边处；工厂按错数据开料 → 报废 | ① **责任边界必须在产品里写明**：系统提供数据，**首批必须人工全检**；② 输出"板件图 + 尺寸链"供复核，不只是清单；③ ERROR 未清零不允许导出；④ 每条导出记录模型版本 + 生成器版本 + 规则集版本（三件套），可完整复现 |
| 7 | **数据一致性** | 中 | 派生数据与模型不同步；并发修改覆盖；undo 后出现幽灵对象 | ① 派生不落盘（本方案强制）；② 所有写操作经 CommandBus + 事务；③ 命令日志 + 快照；④ 乐观锁（模型版本号），冲突则拒绝并要求重放 |
| 8 | **文件兼容** | 中 | DXF 单位/字体/图层不兼容；客户给的 DWG 版本太新（2018+）读不了；PDF 户型图比例不准 | ① Phase 0 逐一实测（§H3 五个坑）；② 底图必须人工校准比例（提供"两点定比例"工具）；③ 导入失败要有明确报错而非静默丢弃 |
| 9 | **安全** | 中高 | 项目含客户户型（隐私）；MCP 是远程执行面；导出目录写入是文件系统操作；LLM 提示注入（客户图纸里嵌入恶意文字）| ① MCP 工具白名单（§G3），无 shell/无任意路径；② 导出目录固定 + 文件名消毒；③ 上传文件隔离存储、不解析为代码；④ 提示注入防护：模型数据作为"数据"而非"指令"注入，明确分隔；⑤ AI 不能删项目/改规则集 |
| 10 | **成本** | 低中 | LLM token（长上下文 × 频繁调用）；ODA 会员；APS 配额 | ① Phase 3 用"结构化上下文"替代全量模型注入（§E5）；② Phase 6 起改工具按需查询；③ 规则引擎本地跑（不烧 token）；④ 缓存 LLM 常见指令模式 |
| 11 | **范围蔓延（最容易死）** | **极高** | 想同时做户型识别、CNC、报价、效果图 → 两年做不出 MVP | 严格执行 §A5 的"不做清单"；每个 Phase 有验收标准，未达标不进入下一阶段 |
| 12 | **单人开发的持续性** | 高 | 一个人做全栈 + 几何 + AI + 规则，中途失去动力 | 每个 Phase 都交付"能用的东西"（哪怕很小）；Phase 0 就出 DXF，能立刻拿给工厂看，正反馈最快 |

---

## J. MVP 开发路线（Phase 0–7）

### Phase 0 · 技术验证

> **状态：V1 / V2 已完成并通过（2026-09-23）。** 报告见 `docs/Phase0-Spike-Report.md`，代码见 `spike/`，一键复现 `bash spike/run.sh`。
> 结论：`JSON → Semantic → Panel Model → DXF` 全链路跑通，28 种板件尺寸零误差，两套独立解析器交叉验证一致，恒等式 0 ERROR。
> 过程中抓到 4 个真实问题（含会导致整批报废的 `dimlfac=100` 陷阱）；实测定下中文编码方案：**R2007 / UTF-8 主交付**。
> 待做：V3 DWG 通道 · V4 浏览器性能 · V5 LLM 结构化输出 · V6 真实工厂 DXF 回读。

**目标**：用最小代价验证"这条纵切能不能走通"，排除致命技术假设。

| 待验证 | 方法 | 通过标准 |
|---|---|---|
| V1 模型→板件→DXF | 手写一份衣柜 JSON → 几何生成器 → ezdxf 写 DXF | 在 AutoCAD/DWG TrueView 打开，单位 = mm，1:1 量出 2400 正确 |
| V2 DXF 中文与图层 | 生成带中文标注、多图层的 DXF | 中文正常显示不乱码；图层在线型管理器中正确 |
| V3 DWG 通道 | 用 ODA File Converter 命令行把 DXF 转 DWG | 转换成功 + 打开正常；**同时确认授权条款用于服务端自动化是否可行** |
| V4 浏览器性能 | Three.js 渲染 2000 个 box（InstancedMesh）；Canvas 2D 绘 5 万线段 | 3D ≥55fps；2D 缩放平移无卡顿 |
| V5 LLM 结构化输出 | 用你列出的 20 条真实指令，各跑 2 次 | schema 合法率 100%；语义正确率 ≥80%（错了要知道错在哪）|
| V6 DXF 回读 | 读一份真实工厂 DXF | 能提取 LINE/LWPOLYLINE/TEXT/DIMENSION 及坐标，比例正确 |

**交付物**：一份验证报告 + 一个能跑的最小 demo（CLI 脚本级别即可）
**前置**：无
**预计**：1–2 周
**🚧 未通过 V1/V5 就不要继续。** 这两条决定整个项目可行性。

### Phase 1 · Web CAD 完整交互工作台

> 范围已按「决策锁定 #3」升级：**自用也必须是真实可点的 CAD 界面**。详细交互规格见 §L。

| 项 | 内容 |
|---|---|
| 目标 | 一个设计师愿意用它干活的 2D/3D 工作台（还没有 AI、还没有自动拆板，但拖拽/捕捉/标注/图层/属性面板/快捷键全部可用） |
| 功能（2D 画布） | 视口（缩放/平移/框选缩放/全图）、选择（单选/多选/框选/加选/反选/全选）、捕捉系统（见 §L2）、绘制（线/多段线/矩形/圆/弧）、编辑（移动/复制/旋转/镜像/偏移/修剪/延伸/删除）、对齐与吸附（见 §L3）、标注（线性/对齐/连续/角度/半径 + 标注样式）、文字、图层管理、对象捕捉标记与追踪线、夹点编辑、命令输入框、撤销/重做 |
| 功能（3D） | Three.js 视口、轨道相机、正交/透视切换、视图预设（上/前/左/轴测）、实体/线框/半透明、剖切（沿 X/Y/Z）、爆炸视图、2D 选中的对象在 3D 中同步高亮 |
| 功能（面板） | 属性面板（选中对象 → 语义参数可编辑，实时回写模型）、图层面板、对象树（Project→Room→Cabinet→Unit→Panel）、问题面板、命令历史面板 |
| 功能（快捷键） | 见 §L4，覆盖 90% 日常操作，支持左手键盘 + 右键上下文菜单 |
| 功能（数据） | 项目 CRUD、底图导入（PNG/PDF/DXF）+ 两点定比例校准、保存到本地项目目录、Undo/Redo |
| 技术 | React + TS + Vite；**Canvas 2D 自研渲染器**（不用 SVG）；Three.js；Fastify API；命令模式 + 命令日志；SQLite 或文件系统 |
| **关键架构约束** | **所有交互编辑都必须翻译成 Command 走 CommandBus**（拖动 = 改 `positionAlongWall`，不是移动线条）。UI 只是 Command 的一个来源，与 AI / MCP 完全平等。这条守住了，Phase 3 的 AI 才能复用同一套能力 |
| 验收 | ① 上传户型图，两点校准后量墙 = 4260mm（误差 <2mm）；② 用纯鼠标（不用键盘命令）完成"画房间 → 放柜体 → 拖动对齐到墙 → 标注尺寸 → 改尺寸 → 换图层"全流程；③ 刷新/重开项目，一切不丢；④ 2D 选中的柜体在 3D 中同步高亮，改参数两边同时更新；⑤ 2000 个 box 的 3D 场景 ≥55fps，5 万线段的 2D 场景缩放平移无卡顿 |
| 前置 | Phase 0（✅ 已完成主体） |
| 交付价值 | 第一次"能给人看" —— 设计师可以用它出方案草图 |

> **顺序提醒**：Phase 1 的交互能力与 Phase 2 的拆板能力**交替推进**效果最好（先做"放置柜体 + 拖动对齐"，紧接着做"参数化拆板"，再回来做"夹点改宽度"）。不要一次把 §L 全部做完再做 Phase 2 —— 那样会做一堆没有对象的交互空壳。

### Phase 2 · 参数化柜体与拆板（**技术核心**）

| 项 | 内容 |
|---|---|
| 目标 | 柜体从参数自动生成板件、封边、孔位、清单，改一个数全联动 |
| 功能 | Cabinet/Unit/Panel/Door/Drawer/Shelf/Hardware 模型；几何生成器（板件 + 2D 立面 + 3D 网格 + 尺寸链）；材质/封边/五金库；参数编辑面板；板件清单/开料清单/封边清单/五金清单；Undo/Redo + 版本快照 |
| 技术 | 自研几何生成器（纯 TS 函数）+ 恒等式断言测试 + 金标准样例库；命令模式 + 命令日志 |
| 验收 | ① 输入"2400×2400×600、18mm、左 600 抽屉柜、中 1200 挂衣区、右 600 层板柜"→ 板件全部正确生成（人工核对 ≥3 次）；② 高度改 2300 → 所有依赖高度的板件/清单自动更新；③ 改宽度时若与分区宽度冲突 → 按规则自动分配或报错（不静默改）|
| 前置 | Phase 1 |
| 交付价值 | **产品的技术护城河在这里**。此时已经能卖"参数化拆板工具"了 |

### Phase 3 · AI Command

| 项 | 内容 |
|---|---|
| 目标 | 自然语言 → 结构化命令 → 安全执行 → 连续修改同一对象 |
| 功能 | LLM 网关（结构化输出）；Command Schema + 校验；指代消解（确定性）；干跑/diff 预览/确认；会话上下文（§E5）；聊天侧栏 UI（显示 diff、assumptions、cascaded 变更）；命令审计 |
| 技术 | Zod schema + function calling；CommandBus 的 dry-run 模式；WebSocket 推送 |
| 验收 | ① §A3 场景 2 的 5 步连续对话全部成功，且 `Cabinet_001` 的 ID 全程未变；② 20 条指令集首次成功率 ≥80%；③ 故意给幻觉指令（"把柜子改成 5000 高"超层高）→ 被规则拦下并给出解释 |
| 前置 | Phase 2（必须有语义对象给 AI 操作）|
| 交付价值 | **"AI 设计"这个卖点成立** |

### Phase 4 · 生产规则引擎

| 项 | 内容 |
|---|---|
| 目标 | 完备的硬规则校验 + 问题面板 + 定位高亮 + AI 软建议分离 |
| 功能 | 规则引擎（声明式 DSL + 代码式规则）；增量失效；RuleSet 配置化；F2 表格全部 26 条规则；问题面板（点击定位高亮到 2D/3D）；ERROR 阻断导出；AI 建议区（独立标识）|
| 技术 | 规则依赖图 + 增量调度；规则单测（每条规则 2 正 2 反样例）|
| 验收 | ① 人为构造 10 个典型违规（门板超宽/层板跨度过大/板件碰撞/悬空板/尺寸不足），全部检出且无误报；② 全量校验 <200ms，增量 <20ms；③ 换一份 RuleSet 文件即改变校验结果，不改代码 |
| 前置 | Phase 2（Phase 3 可并行）|
| 交付价值 | **"能用于生产"的信任基础** |

### Phase 5 · DXF / DWG 与图纸输出

| 项 | 内容 |
|---|---|
| 目标 | 工厂能直接用的交付包 |
| 功能 | 导出服务（Python + ezdxf）：板件图（含尺寸链、封边标识、孔位）、正立面图、剖面图、平面图；DXF R2000/R12 双版本；PDF 图纸；开料/封边/五金清单（CSV + 可打印 PDF）；一键"生产包"zip；DWG 通道（方案 A/B/C 决策）|
| 技术 | Python FastAPI + ezdxf（+ `odafc` 插件）；TS 几何结果 → 中立交换格式（JSON）→ Python 序列化 |
| 验收 | ① 找一个真实工厂/拆单员看生成包，确认"能直接用"（这是唯一真正的验收标准）；② DXF 在 AutoCAD / 中望 / CAXA / DWG TrueView 四个软件中打开正确 |
| 前置 | Phase 4（必须先能清零 ERROR）|
| 交付价值 | **可以真收钱了** |

### Phase 6 · MCP

| 项 | 内容 |
|---|---|
| 目标 | 系统可被任意 MCP Client 驱动 |
| 功能 | `@modelcontextprotocol/server` v2；§G2 的 24 个工具；stdio + Streamable HTTP；Bearer 鉴权 + 项目 scope；两段式危险操作；审计回写 |
| 技术 | MCP SDK v2；工具入参用 Zod schema；本地 stdio 直连 Claude Code / Codex |
| 验收 | ① 在 Claude Code 里说"打开客厅项目，把主卧衣柜高度改成 2300，跑校验，导出 DXF"，端到端完成；② `get_view_image` 返回的截图能被 AI 用于自检；③ 越权调用（如 `panel.override` 写派生字段）被拒绝并给出原因 |
| 前置 | Phase 5 |
| 交付价值 | **系统变成"可被 Agent 操作的基础设施"** |

### Phase 7 · AI Agent 与自动化

| 项 | 内容 |
|---|---|
| 目标 | 无人值守的批量作业与工作流编排 |
| 功能 | Taskboard 任务队列；Agent 编排（Codex 改代码 / Hermes 做浏览器验证 / MCP 改模型）；批量任务（"把这 20 个柜体统一改 18mm 板材并重新导出"）；AI 视觉自检（截图 → 判断"中间区域比例是否合理"）；失败自动重试与升级上报 |
| 技术 | 任务队列（本地 worker）；上下文工具化（用 MCP 工具按需查询，不再全量注入）；成本监控 |
| 验收 | ① 一个 5 步以上的任务能无人工完成并产出合规交付包；② 出现 ERROR 时 Agent 能自主修正 ≥60%；③ 全流程有审计日志可复盘 |
| 前置 | Phase 6 |
| 交付价值 | **你最初的目标：AI 独立完成设计工作** |

---

## K. 四个关键决策（已于 2026-09-23 确认）

> 决策内容与连锁约束见文首 **§0.5 决策锁定**。此处保留原始选项供回溯。

**1. 这是自用工具还是产品？** → ✅ **先自用，效果好再考虑商业化**
- 只服务你自己 / 一家工厂 → 走"轻量自研"，**永远不需要 ODA 会员**，DXF 足够
- 要做给多家设计公司/工厂用 → Phase 5 起要考虑 DWG 与多租户（成本 +$7,500/年）

**2. 有没有真实工厂的工艺标准？**（板材最大尺寸与常备厚度、设备开料尺寸、封边材料、五金品牌型号、拆柜习惯、门板宽度上限） → ✅ **暂无，先用行业默认值，后续替换**
- 有 → 直接做成 `rules/factory.v1.json`，Phase 4 一步到位
- 没有 → 用行业默认值（F3 已给出，并已落地为 `spike/ruleset/factory-default.json`），但**必须在有真实标准后立刻校准，否则规则是假的**

**3. 第一阶段谁在用、怎么用？** → ✅ **自用，但必须有完整可点鼠标的 CAD 交互界面 + 快捷键**
- 要给设计师点鼠标用 → Phase 1 的 UI 投入翻倍（选择、捕捉、编辑、标注、图层、属性面板、3D）
- **本次已按此升级 Phase 1，详细规格见 §L**

**4. 接受"MVP 只出 DXF，不出 DWG"吗？** → ✅ **接受**
- 零成本、零法律风险；DWG 通道降为可选，授权调研推迟到商业化决策之后

> 四个答案共同指向一条更清晰的主线：**先把"一个人 + AI 就能出生产数据"这件事做到能用，再谈商业化。** 但架构上不做任何"自用捷径"。

---

## L. 交互规格（Phase 1 详细设计）

### L1. 铁律：交互层不许碰几何

设计师在屏幕上做的每一个动作，都必须翻译成**对语义参数的修改命令**，而不是对线条/坐标的修改。

```
鼠标拖动柜子  →  不是"把图元的 x 从 1000 改成 1200"
              →  而是 Command: { op: "object.move",
                                  target: "Cabinet_001",
                                  changes: [{ path: "placement.positionAlongWall", op: "add", value: 200, unit: "mm" }] }
              →  CommandBus → 领域层 → 几何生成器重算 → 渲染器刷新
```

**为什么这条不能破**：一旦允许交互层直接改坐标，就出现了"绕过规则的修改路径"。设计师把柜子拖进墙里，规则引擎不知道；AI 再读模型时，模型里是自相矛盾的数据。届时要修的不是 bug，是架构。

**推论**：
- 前端**没有**"当前图形数据"这个概念，只有"当前几何生成结果（只读缓存）"
- 前端**没有**"脏标记/待保存"概念，任何交互立即提交命令
- 拖动过程用**本地临时预览**（视觉跟手），鼠标松开才提交命令（保证 60fps 且不产生垃圾命令历史）

### L2. 捕捉系统（Object Snap）

| 捕捉类型 | 别名 | 说明 |
|---|---|---|
| 端点 | END | 线段/墙/板件端点 |
| 中点 | MID | |
| 交点 | INT | 两线交叉 |
| 圆心/象限点 | CEN/QUA | 圆、弧 |
| 垂足 | PER | 到目标线的垂足 |
| 切点 | TAN | 弧的切点 |
| 最近点 | NEA | 线上任意点 |
| 延长线 | EXT | 线段延长方向上的点 |
| 外观交点 | APP | 在屏幕上相交但空间不相交 |
| 平行 | PAR | 与目标线平行方向 |
| 插入点 | INS | 块/柜体的定位基点 |

- **优先级**（同时命中时）：端点 > 中点 > 交点 > 圆心 > 垂足 > 象限点 > 最近点。命中后显示图标 + 文字提示。
- **两种模式**：`固定捕捉`（栅格/正交，F8/F9）与 `对象捕捉`（F3，默认开常用 4 种：端点/中点/交点/垂足）
- **追踪线**：启用对象捕捉追踪（F11）后，从捕捉点引出对齐虚线，与其他点的对齐关系实时显示**间距数值**（这是设计师最依赖的功能，比"捕捉到点"更重要）

### L3. 对齐与吸附（Smart Align）

除了传统捕捉，必须有一层**语义对齐**（这是专业软件与"画图工具"的分水岭）：

| 场景 | 行为 |
|---|---|
| 拖动柜体靠近墙 | 吸附到墙面，显示"贴墙"提示；提交时改的是 `placement.offsetFromWall = 0` |
| 拖动柜体靠近另一柜体 | 边缘对齐，显示对齐虚线 + 两柜间距数值（如 `间距 120`）；按 Tab 可锁定间距 |
| 拖动柜体靠近房间中线 | 吸附到中线（显示中轴线） |
| 拖动层板 | 吸附到相邻层板的等分位置，并显示"当前分格 380 / 相邻 380" |
| 拖动门缝分格线 | 自动等分提示（显示"等分"标记），松手即为等分 |
| 按住 Shift 拖动 | 临时正交约束 |
| 按住 Ctrl 拖动 | 临时忽略所有吸附（自由移动） |

### L4. 快捷键表（对齐 AutoCAD 习惯，降低设计师学习成本）

**通用 / 视图**

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| `Esc` | 取消当前命令 / 清除选择 | `Z` → `A` | 缩放到全图 |
| `空格` / `Enter` | 重复上一个命令 / 确认 | `Z` → `W` | 框选缩放 |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 | `P`（空格） | 平移 |
| `Ctrl+A` | 全选 | `F3` | 对象捕捉开关 |
| `Ctrl+1` | 属性面板 | `F8` | 正交开关 |
| `Ctrl+L` | 图层面板 | `F9` | 栅格开关 |
| `Ctrl+E` | 3D / 2D 视图切换 | `F10` | 极轴追踪 |
| `Delete` | 删除选中 | `F11` | 对象捕捉追踪 |

**绘图**

| 别名 | 命令 | 别名 | 命令 |
|---|---|---|---|
| `L` | 直线 | `REC` | 矩形 |
| `PL` | 多段线 | `C` | 圆 |
| `A` | 圆弧 | `H` | 填充 |
| `T` / `MT` | 文字 | `XL` | 构造线 |
| `WALL` | 绘制墙体（自定义） | `CAB` | 放置柜体（自定义） |

**修改**

| 别名 | 命令 | 别名 | 命令 |
|---|---|---|---|
| `M` | 移动 | `CO` / `CP` | 复制 |
| `RO` | 旋转 | `MI` | 镜像 |
| `O` | 偏移 | `S` | 拉伸 |
| `TR` | 修剪 | `EX` | 延伸 |
| `E` | 删除 | `X` | 分解 |
| `MA` | 特性匹配 | `AR` | 阵列 |

**标注（定制家具最常用）**

| 别名 | 命令 | 别名 | 命令 |
|---|---|---|---|
| `DLI` | 线性标注 | `DAL` | 对齐标注 |
| `DCO` | 连续标注 | `DAN` | 角度标注 |
| `DDI` | 直径标注 | `DRA` | 半径标注 |
| `DIMCAB` | **一键标注柜体尺寸链**（自定义，核心效率功能） | `DIMDOOR` | **一键标注门板分格**（自定义） |

**专属（本系统的差异化快捷键）**

| 键 | 功能 |
|---|---|
| `F4` | 切换抽屉面板/门板 显隐 |
| `F5` | 切换内部结构（层板/立板/背板）显隐 |
| `F6` | 线框 / 实体 / 半透明 视图循环 |
| `F7` | 剖切平面开关 |
| `Ctrl+Shift+V` | 打开 AI 对话侧栏 |
| `Ctrl+Shift+D` | 运行规则校验 |
| `Ctrl+Shift+X` | 打开 3D 爆炸视图 |

> 实现方式：`命令输入框 + 单键别名 + 快捷键映射表`。别名表可配置（`config/aliases.json`），设计师可以改成自己习惯的。

### L5. 选择与选择集

| 操作 | 行为 |
|---|---|
| 单击 | 单选；命中多个重叠对象时弹候选列表（按 `Tab` 循环切换） |
| 框选（左→右） | 窗选（完全包含才选中） |
| 框选（右→左） | 交叉选（碰到就选中） |
| `Shift` + 单击 | 加选/减选 |
| 双击 | 进入下一层（柜体 → 分区 → 板件），配合对象树 |
| 右键空白 | 撤销选择 + 上下文菜单（重复/粘贴/全部取消选择） |
| 选择过滤 | 按对象类型/图层/材质筛选（如"选中所有门板"） |

**选择语义**：选中的是**业务对象**（Cabinet / Unit / Panel），不是线条。悬停时显示语义提示（"主卧衣柜 · 宽 2400"），而不是"直线 #1024"。

### L6. 属性面板

面板按对象的**authored / derived** 分两块，视觉上必须明确区分：

| 区块 | 内容 | 可编辑 |
|---|---|---|
| **参数（可编辑）** | 宽/高/深、材质、背板方式、封边策略、见光面、抬高、分区配置、门/抽屉配置 | ✅ 直接改，立即提交命令 |
| **派生（只读，灰底 + 🔒）** | 板件数、内空尺寸、板材面积、重量、截面尺寸 | ❌ 灰显，点击弹出解释："该值由几何生成器计算，请修改上方参数" |
| **规则状态** | 关联的 ERROR / WARNING / INFO | ❌ 只读，点击定位 |

**这条设计直接对应「AI 不是尺寸权威」**：人类设计师和 AI 面对的是同一套可写字段、同一套只读派生值。人类也没有特权去改派生值。

### L7. 标注系统

- 标注对象是 **`Drawing` 层的表现元素**，不属于模型真相源；但**标注的数值永远从模型实时取**（不允许手动覆盖数值）
- 支持：线性、对齐、连续、基线、角度、半径、直径、引线
- **一键尺寸链**（`DIMCAB`）：选中柜体 → 自动生成"总宽 + 各分区净宽 + 板厚"的完整尺寸链，这是拆单员核对时唯一想看的图
- 标注样式集中配置（字高、箭头、精度、单位），存在 `rules/` 或项目配置里，不散落在代码中
- **改动模型后所有标注自动更新**（因为数值是派生的），这是自研渲染器相对"导出 DXF 再标"的最大优势

### L8. 图层策略

| 层级 | 图层 | 说明 |
|---|---|---|
| 建筑 | `A-WALL` `A-DOOR` `A-WIN` `A-DIM` `A-TEXT` | 墙/门窗/标注/文字 |
| 家具结构 | `F-CAB-STRUCT` | 侧板/顶底板/立板/踢脚 |
| 家具门板 | `F-CAB-FRONT` | 门板/抽屉面板 |
| 家具五金 | `F-CAB-HW` | 五金符号 |
| 家具标注 | `F-DIM` `F-TEXT` | |
| 辅助 | `F-REFA`（底图）`F-CENTER`（中心线）`F-HIDDEN`（隐藏线） | 底图默认锁定 + 半透明 |
| 导出专用 | `PANEL_xx` `EDGE_1MM` `EDGE_04MM` `ELEV_xxx` `DIM` | 仅在导出 DXF 时生成，屏幕上不显示 |

> **重要区分**：屏幕上的图层是"给人看的"，DXF 里的图层是"给工厂看的"。两者不要混。Phase 0 已实测出 `EDGE_1MM`（粗红线）这类工厂识别图层，只在导出时出现。
> **颜色注意**：不要在屏幕上使用 ACI 颜色 7（黑白反转色）作为唯一区分手段 —— 白底预览时它会隐形（Phase 0 实测踩到，见报告问题 3）。

### L9. 3D 视口与 2D/3D 联动

| 能力 | 实现 |
|---|---|
| 相机 | 轨道旋转/平移/缩放；正交 ↔ 透视切换；视图预设（上/前/左/右/轴测） |
| 显示模式 | 实体 / 线框 / 半透明 / 隐藏线 |
| 剖切 | 沿柜体局部 X/Y/Z 三方向剖切，可拖动剖切面 |
| 爆炸视图 | 按"柜体 → 分区 → 板件"层级向外偏移，用于给客户/安装工讲解 |
| **双向联动** | 2D 选中 → 3D 高亮；3D 点选 → 2D 选中并定位；参数改动 → 两边同时更新（都从同一份几何结果渲染） |
| 性能 | 柜体 ≤2000 个 box 用 `InstancedMesh` + 几何合并；关阴影；只在脏时重绘 |
| 输出 | 截图（供 AI 视觉自检 / 给客户看）、导出 glTF |

### L10. 拖动 → 语义字段映射表（**Phase 1 最关键的设计产物**）

| 交互动作 | 提交的命令（改的字段） | **严禁** |
|---|---|---|
| 拖动柜体 | `object.move` → `placement.positionAlongWall` / `offsetFromWall` | 改任何坐标 |
| 拖柜体侧面夹点 | `cabinet.update` → `params.width` | 拉伸板件线条 |
| 拖柜体顶部夹点 | `cabinet.update` → `params.height` | |
| 拖柜体深度夹点 | `cabinet.update` → `params.depth` | |
| 拖动中立板 | `unit.update` → 相邻两个 unit 的 `width`（按比例或等分，可配置） | 移动立板图形 |
| 拖动层板 | `slot.update` → `shelves[].positionFromBottom`（若原为等分则自动切换为"自定义 + 提示"） | |
| 拖动门缝分格线 | `slot.update` → `doors[].width`（联动相邻门，保持总宽不变） | |
| 拖动抽屉分隔线 | `slot.update` → `drawers[].faceHeight`（联动相邻抽屉） | |
| 拖动墙端点 | `wall.update` → `start` / `end`（房间边界级联更新） | |
| 拖动门/窗 | `opening.update` → `positionAlongWall` | |
| 移动标注 | 只改 `Drawing` 层的标注位置（表现元素，不入模型） | 改标注数值 |
| 改材质 | `cabinet.update` → `params.boardMaterial`（触发规则全量重跑 + 打开料清单重算） | |

> **验收这条表的办法**：Phase 1 完成后，随便拖动几下，然后导出 DXF 并跑校验 —— 如果恒等式仍然 0 ERROR，说明交互层没有绕过领域层。

### L11. 性能预算

| 指标 | 目标 | 手段 |
|---|---|---|
| 2D 重绘 | ≤ 8ms（保 60fps） | 脏区重绘 + 分层缓存（底图图层单独缓存为位图，不参与重绘） |
| 拖动跟手 | 视觉延迟 ≤ 16ms | 拖动期间只做局部平移变换，不重新生成几何 |
| 3D | ≥ 55fps（2000 box） | InstancedMesh、几何合并、关闭阴影与抗锯齿（可选） |
| 参数改动 → 视图刷新 | ≤ 300ms（本地） | 只重算受影响的柜体（几何缓存按柜体粒度失效） |
| 项目加载（30 柜体） | ≤ 2s | 派生数据不落盘 + 加载时并行重算 |
| 命令历史 | 无上限但可压缩 | 每 100 条命令做一次快照，旧命令可折叠 |

### L12. Phase 1 建议实现顺序（避免做出"空壳交互"）

```
1. 命令基础设施：CommandBus + 命令日志 + Undo/Redo + 几何缓存失效   ← 没有这个，后面全是返工
2. 2D 视口与坐标系：缩放/平移/网格/正交 + 世界↔屏幕坐标转换
3. Wall / Room 绘制 + 选择 + 属性面板（先拿最简单的对象把交互链路跑通）
4. 底图导入 + 两点定比例校准
5. Cabinet 雏形（先只画外框体块）→ 拖动 / 吸附到墙 / 对齐到相邻柜体
6. ★ 接入 Phase 2 的拆板生成器：柜体变成真的板件（2D + 3D）
7. 捕捉系统（先 4 种常用）→ 夹点编辑（宽度/高度/深度）
8. 标注系统（`DLI` + `DIMCAB` 一键尺寸链）
9. 图层管理 + 快捷键表 + 右键菜单
10. 3D 视口 + 2D/3D 联动 + 剖切/爆炸
11. 补齐修改命令（M/CO/RO/MI/O/TR/EX）+ 高级捕捉
12. 全量验收：跑 §L10 映射表 + 导出 DXF 校验恒等式
```

> 第 1 步和第 6 步是关键路径上仅有的两个"不可跳过、不可延后"的点。

---

## 附：本方案对你自己那份需求的几处"不同意"

| 你的原始设想 | 我的判断 | 理由 |
|---|---|---|
| 重点调查 OpenCascade / OpenCascade.js 作为内核 | **opencascade.js 不要用**（停滞 3 年）；且整个项目 MVP 阶段**不需要内核** | §0-1、§C1 |
| "二维 CAD 和三维模型"三选一 | 都不是。选第四个：**语义参数化模型为唯一真相源，2D/3D/DXF 都是它的派生视图** | §C1 |
| AI 操作业务对象（第七条） | 完全同意，但要加强：**AI 连"业务对象的派生字段"也不能写**，只能写 authored 参数 | §E1-6、§E6 |
| Validator 返回 ERROR/WARNING/INFO（第六条） | 同意，但必须区分**机器硬规则**与**AI 软建议**两套通道，不能混在一个返回值里 | §F1 |
| 需要 MCP Server（第十三、十四条） | 同意，但**按 2026-07-28 新规范设计**（无状态），不要照旧教程 | §G1 |
| 项目文件用 `project/` 目录 + `project.json`（第十五条） | 同意，但补一条硬约束：**派生数据（板件/几何/清单）绝不落盘** | §H2 |
| 第二十条"不要写代码" | 已遵守。本文档零实现代码，只有 Schema 与流程 | — |

---

**下一步建议**：先回答 K 节的 4 个问题。确认后我可以立刻产出 **Phase 0 的最小验证脚手架**（一个能跑通"JSON → 板件 → DXF"的 200 行脚本 + 验证清单），用最低成本把最大风险试掉。


