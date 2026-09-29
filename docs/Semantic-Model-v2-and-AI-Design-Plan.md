# 柜体语义模型 v2 与 AI 设计能力升级 —— 架构审查与实施计划

> 日期：2026-09-29 ｜ 状态：**架构审查 + 实施计划（未动一行实现代码）**
> 前置阅读：`docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md`、`docs/Special-Cabinets-and-Sales-Drawing-Plan.md`
> 本文件只回答问题、给方案、排阶段；编码从 P0 起，逐阶段验收通过再进下一阶段。

---

## 0. 结论先行

**当前架构不需要推倒重写。** 语义模型为唯一真相源、派生管线单源、CommandBus 唯一写入口、AI 只出命令不出几何 —— 这四条地基是对的，且已被 25 个验收脚本 + 661 条浏览器断言钉住。真正缺的是语义模型上的**两个维度**：

| 缺口 | 现状 | 本质 |
|---|---|---|
| **① 柜体内部只有"左右"一个维度** | `CabinetLayout.units` 是一维数组（左右并排） | 表达不了"上部通顶储物 + 下部三分区"、"上下嵌套分区" |
| **② 柜体之间没有"关系"对象** | 柜体是 `Project.cabinets[]` 里的平铺对象，只有 `roomId` | "L 型/U 型/拼接"只是**空间事实**（靠包围盒猜），不是**语义事实** |

其余诉求（AI 设计阶段、Import Adapter、效果图识别 + 确认、设计知识记忆）都建立在这两个维度的扩展之上，属于**新增层**，不是改建地基。

**一句话路线**：给柜体内部加"行（Row）"这个垂直维度（缺省单行 = 完全等价旧模型），给柜体之间加"组合（Assembly）/关系（Connection）"这个语义层（缺省无组合 = 完全等价旧模型）；两者都设计成**可选、向后兼容、单源派生**，旧的 2400 三分区衣柜逐位不变。

---

## 1. 当前 semantic model 架构分析

### 1.1 真相源与派生链（已核实）

```
model.json (authored only)
  Project { schemaVersion, id, name, ruleSetId, rooms[], cabinets[] }
    Room { id, name, walls[] }              Wall { start, end, thickness, height }
    Cabinet { id, name, roomId, placement{x,y,rotation}, params, layout }
      CabinetParams { width,height,depth,boardMaterial,backPanel{},bodyLift,shelfFrontClearance,finishedEnds? }
      CabinetLayout { type:'row'|'double', widthMode, units: UnitSpec[], backUnits? }
        UnitSpec { id, kind, requestedWidth, nickname?, drawers?, shelves?, doors?, rod?, appliance? }
        kind ∈ { drawerBank | hanging | shelves | open | appliance }
        │
        │  core/geometry/layout.ts  computeCabinetLayout(cab, rules) → CabinetDerived
        ▼                          （唯一派生骨架：boardT/innerW/innerH/nets/unitX0/shelfDepth/double{}）
        │  core/geometry/generate.ts  generateCabinet() → CabinetGeometry
        ▼                          （panels[] / hardware[] / purchased[] / plan[] / elevation[] / stats / layout）
        │  views.ts / bodies3d.ts / explode.ts / export/neutralSheet.ts / export/roomBook.ts
        ▼
      2D 四视图 · 3D 体块 · 分解图 · DXF · 板件/五金/甲购清单
```

**关键事实（都从代码读出，不是假设）：**

1. **`Cabinet.layout.units` 是严格一维的**：`layout.ts` 只做**宽度**分配（`netTotal = innerW - (n-1)*t`，`allocateWidths` 按比例摊净宽，`unitX0` 累加起点）。**没有任何"高度方向怎么分"的表达**。
2. **`type:'double'` 不是"两个维度"，是"前后两排"**：岛台的背面排 `backUnits` 与前排共用同一套 `UnitSpec`，中间一块共用中板；本质是"两个并排的 row 柜背靠背"，仍是左右一维 × 2 排。
3. **`round-1` 的"上下分体"是唯一的垂直痕迹**，且是**特例硬编码**：`appliance.topDrawers` 通过 `unitNetH = innerH - openingHeight - t` 把洞口上方让出一段净高给抽屉。它证明"垂直分层"这个需求真实存在，但当前只能在这一种柜型上表达。
4. **柜体之间无任何关系对象**：`Project.cabinets[]` 平铺，唯一归属是 `roomId`。L 型转角靠 `rules/corner.ts` 的 `validateCornerInterference` **从包围盒反推**（轴对齐、共角点、垂直轴线），"转角"是**被推断出来的**，不是**被声明的**。
5. **`placement` 只有 0/90/180/270**：`aiContract` 里 `rotation` 是枚举；异形（斜切/弧形结构）走的是"图元扩展"（`shelves.tilt`、`finishedEnds` R36），不引入第二套几何。

### 1.2 写入门禁（已核实，必须保留）

- **CommandBus 唯一写入口**：`plan()` 干跑 → `execute()` 提交，`STRUCTURAL_OPS` 走 payload，其余走 `WRITABLE` 路径白名单；`DENY` 前缀（`panels/geometry/issues/stats/id/schemaVersion/ruleSetId`）是派生字段的物理防线；`OPTIONAL_AUTHORED` 是"允许从无到有"的可选 authored 白名单。
- **undo/redo 用 `SideEffect` 声明式逆运算**（含 `replaceProject` 这种换对象引用的特例）。
- **id 唯一性靠 `nextId(prefix, takenIds)`**，板件 id 是字符串拼出来的（`P_{cab}_{unit}_…`）—— **新增垂直维度时 id 必须带上行号，否则跨行撞 id = 清单下错料**。
- **AI 三层防线**：`shared/aiContract.mjs`（词汇表 + 校验器）→ `src/ai/compile.ts`（动作编译成 Command）→ CommandBus 白名单。契约与编译器**一一对应**由 `verify/ai-acceptance.ts` 常驻断言。
- **两段式**：`planRunner.dryRunPlan`（沙盒总线）→ `commitPlan`（版本一致 + 逐条同一 Command）；`draftSession` 是"多轮累积的草稿桌"，`finalizeDraft` 复用 `commitPlan`。
- **规则/记忆分层**：`validate.ts` 只有"恒等式断言 + 生产硬规则"；AI 软建议在 `corner.ts`（WARNING）；记忆门来自 `memory.ts` 的 `Correction → compileCorrections → Gate`，挂在 CommandBus 提交前，**只拦"本次新引入"的违规**。
- **快照白名单投影**：`snapshot.ts` 一个字段一个字段手写，`AiUnitView`/`AiCabinetView` 是 AI 唯一能看到的世界。

---

## 2. 当前模型能表达什么

| 诉求 | 现状 | 证据 |
|---|---|---|
| **Case 1** 普通三分区衣柜 | ✅ 完整 | `defaultUnits` 2:4:2；`sampleProject` 就是 2400 三分区 |
| 单面柜任意左右分区 | ✅ | `UnitSpec[]` 任意序列 + `allocateWidths` 比例分配 |
| 抽屉区 / 挂衣区 / 层板区 / 空区 | ✅ | `kind` + `drawers/shelves/rod` 子规格 |
| 分区带门 / 玻璃门 / 见光门开向 | ✅ | `doors{count,style,hingeSide,material}`；玻璃门走 `purchased` |
| 岛台（双面、共用中板、无背板） | ✅ | `type:'double'` + `backUnits` + `double{}` 派生骨架 |
| **Case 7** 电器洞口 + 上部抽屉 | ✅（在此特例内） | `ApplianceSpec.openingWidth/Height/Depth + topDrawers`；`unitNetH` 让出净高 |
| 斜层板 / 圆弧见光板 / 灯带 | ✅（图元扩展） | `shelves.tilt`、`finishedEnds`、`shelves.ledStrip` |
| **Case 5** 两模块拼 L 型 | ⚠️ **空间上可行，语义上缺失** | 多个 `cabinet.create` + `rotation` + `joinSpots` 共用角点；但斜接关系**未在模型里声明**，靠 `corner.ts` 反推 |
| **Case 6** 不同深度模块组合 | ⚠️ 同上 | 两个独立柜体各自 `params.depth` 即可；柜体内部不支持变深 |

---

## 3. 当前模型不能表达什么（这是本次要解决的）

### 3.1 柜体内部（垂直维度缺失）

- ❌ **Case 2：上部连续顶柜 + 下部三分区** —— `layout` 没有"行"的概念。今天只能建**两个柜体**（顶柜 + 地柜）在空间上叠放，中间那块横板是各自顶/底板，**语义上不是"一个柜的上下两层"**。
- ❌ **Case 4：上下嵌套分区** —— 没有 `Section` 树，`units` 是平的。表达不了"左列上半是层板、下半是抽屉"。
- ❌ **一条贯通全宽的横隔板**作为一等语义（`贯通顶柜/腰线/台面下开口`）。
- ❌ 分区级 / 行级的**变深**（上浅下深、上翻门浅柜）—— 因为 `params.depth` 是柜体级单值。

### 3.2 柜体之间（关系维度缺失）

- ❌ **`Connection` / 组合关系对象**：没有"这两段共用这个角点、这条边贴这条边"的声明。
- ❌ **`FurnitureAssembly` / 模块层级**：一屋子柜子没有"这是同一组电视墙、那三个是同一组衣帽间"的语义分组。
- ❌ **U 型/三面围合/整墙组合**作为可声明、可校验、可整体操作的对象。
- ❌ **组合级约束**（对齐/等高/等深/必须共面）作为一等对象。

### 3.3 设计流程与外部输入

- ❌ **设计阶段（Requirement → Design Proposal）**：AI 目前是"参数修改器"，没有"先给方案、用户确认、再落模型"的中间态。（`draftSession` 是**模型级**草稿，不是**需求级**方案。）
- ❌ **Import Adapter**：没有 `External Design → Normalized Design → Semantic Model` 的通道。
- ❌ **识别置信度语义**：`detected / inferred / unknown / confidence` 无处安放。
- ❌ **设计知识记忆**：`Correction` 目前只承载"可判定的硬检查"，没有"偏好/习惯"这一层（且**不该**和硬规则混）。

---

## 4. 哪些代码可以复用（不动）

| 模块 | 复用方式 |
|---|---|
| `commandBus.ts`（plan/execute/undo/redo/SideEffect/白名单/DENY） | **原样保留**。只新增 `STRUCTURAL_OPS` 成员 + `SideEffect` 变体 + 路径白名单条目 |
| `allocate.ts`（`allocateWidths`/`splitEqual`/`equalSpacing`） | **原样保留**。高度分配直接复用 `splitEqual`/`allocateWidths`（同一套取整余量算法） |
| `ids.ts`（`nextId` + `takenIds`） | **原样保留**，新对象（row/assembly/connection）同样走它 |
| `rules/issueCatalog.ts`（`buildIssue` 唯一文案源） | **原样保留**，新规则只加 `code`，文案仍从目录出 |
| `rules/validate.ts` 的**恒等式断言范式** | **原样保留并扩充**（加"高度链"断言） |
| `ai/snapshot.ts` 白名单投影 | 原样保留，`AiCabinetView` 增加 `rows` 视图字段 |
| `ai/planRunner.ts` / `ai/draftSession.ts` | 原样保留，Design Proposal 复用同一套干跑/定稿 |
| `ai/memory.ts`（Correction → Gate） | 原样保留，偏好记忆**另开一层**，不塞进 `Correction.status` |
| `core/templates.ts` 声明式模板注册表 | 原样保留，模板的 `units` 就地升级为可选的 `rows`（缺省仍是 `units`） |
| `core/snapPlace.ts`（`joinSpots`/`pickFreeSpot`/`nudgeOutOfWalls`） | 原样保留，`Connection` 落位**复用**它，不写第二套坐标 |
| `verify/*.ts` 验收范式 | 原样保留，作为 v2 的**回归基线**（旧脚本必须持续全绿） |

---

## 5. 哪些代码需要扩展（点名到文件/函数）

| 文件 | 扩展内容 | 风险 |
|---|---|---|
| `core/types.ts` | 新增 `CabinetRow`、`Section`（=升级后的 `UnitSpec` 别名语义）、`FurnitureAssembly`、`Connection`、`Provenance`、轻量 `Constraint` | 低（纯类型 + 可选字段） |
| `core/geometry/layout.ts` | `computeCabinetLayout` 支持**多行**：先按行分高度（`innerH = Σ rowNetH + (r-1)t`），每行内再按宽度分（现有逻辑**下沉为"行内分配"**）。单行时逐位等价旧结果 | **高**（这是唯一真正动核心的地方） |
| `core/geometry/generate.ts` | 行间横隔板（`RowDivider`）、行内立板、行内门/抽/层板；id 带行号 | 中 |
| `core/rules/validate.ts` | 新增"高度链"恒等式：`Σ行净高 + (r-1)t = 内空高`；单行回归 | 中 |
| `core/commandBus.ts` | `STRUCTURAL_OPS` + 新 `SideEffect`（`splitRow/insertRow/removeRow/insertAssembly/...`）+ `WRITABLE` 路径 + `OPTIONAL_AUTHORED` | 中 |
| `core/docFactory.ts` | `makeRow`、`createAssembly`；`makeUnit` **不动**（它继续是"分区叶节点"唯一构造点） | 低 |
| `shared/aiContract.mjs` | 新增 `design.*` / `section.*` / `assembly.*` 动作 + `DesignProposal` 校验器；扩 `UNIT_INTENT` 为 `ROW_INTENT` | 中 |
| `src/ai/compile.ts` | 新动作 → Command 实现；`COMPILED_ACTIONS` 同步 | 中 |
| `src/ai/snapshot.ts` | `AiCabinetView.layout.rows`、`AiAssemblyView`、`AiProposalView` | 低 |
| `core/geometry/views.ts` / `bodies3d.ts` / `explode.ts` | 消费 `CabinetDerived.rows` 增量绘制（**不重算尺寸**） | 中 |
| `src/core/projectFile.ts` | `schemaVersion 0.2 → 0.3` 的 `normalizeLayout` 读写（单行序列化回 `units`，保持旧文件逐字节不变） | **高**（迁移正确性） |

**唯一真正"动核心"的文件是 `layout.ts`。** 其余都是"加法"。这也是本计划的控制点：`layout.ts` 的单行回归一旦不绿，就地停下。

---

## 6. 新模型建议（具体到形状，不是口号）

### 6.1 设计取舍：为什么加"行"而不是加"Section 树"

你的目标树是 `Module → Section → Component`。本系统里：

- **`UnitSpec` 已经等价于 `Section`**：它是叶区域，带 `kind` + 一组功能子规格。
- **`drawers/shelves/doors/rod/appliance` 已经等价于 `Component`**：它们是 Section 内部的功能件，且**已经由 `makeUnit` 统一构造**。
- 真正缺的是：**Section 之间除了"左右"以外的第二个组织维度**。

所以**不新增一套"Section/Component 类"**（那会形成第二真相源），而是：

> 把 `UnitSpec` **重新定位为 Section 叶节点**（语义不变，术语对齐），
> 新增 **`CabinetRow`（垂直行）** 作为"一行 Section 的容器"，
> **`Component` 就是 UnitSpec 上已有的子规格对象**。

这样满足你的"标准模块 + 分区 + 组件 + 关系 + 约束"组合式要求，且**不引入巨型 if/else**（新柜型 = 行的组合，不是新的分支）。

### 6.2 目标模型（v0.3 形状 —— **`rows` 部分已被 P0 冻结，见 §15**）

```
Project
├─ Room
│  └─ FurnitureAssembly?          # 新增（可选，P2 冻结）：一组柜体的语义分组 + 关系
│     ├─ memberIds: string[]      #   指向 cabinets[] 的 id
│     └─ connections: Connection[] #   关系（角接/续接/叠放），给语义不给坐标
├─ Cabinet ( = CabinetModule )
│  └─ layout
│     ├─ units: UnitSpec[]        # 保留：单行柜的唯一真相；多行柜存盘时被省略（见下）
│     ├─ rows?: CabinetRow[]      # 新增（可选，>1 行才出现）
│     │   └─ CabinetRow { id, height: number | 'fill', units: UnitSpec[] }
│     └─ backUnits?: UnitSpec[]   # 保留（岛台）
└─ constraints?: Constraint[]     # 新增（可选）：轻量、非几何（lock/equal/align/derive）
```

**兼容铁律**：`rows` 缺省时，模型与 v0.2 **逐位等价**；`core/layoutModel.ts` 在**读写两侧**统一口径（**P0 已实现**）：

- 读：无 `rows` ⇒ 视为 `rows: [{ id:'row_001', height:'fill', units }]`（单行，行 id 固定不变）。
- 写：单行 ⇒ 序列化回 `units`（**旧文件保存后仍逐字节相同**）；多行 ⇒ **只写 `rows`、刻意省略 `units`**。
  省略不是偷懒：若多行时仍写 `units = rows[0].units`，旧版本代码会把**第一行当整柜**、按全高算出板件而不报错 —— 安静地产出错误生产尺寸。省略后旧读者在 `parseProjectFile` 明确拒绝该文件（"缺少 layout.units"）。**宁可打不开，不可下错料。**
- **行序固定自上而下**：`rows[0]` 在最上面，`'fill'` 必须落在最后一行（于是"定死上层通顶柜、剩下全给下层"天然成立）。
- **`schemaVersion` 本阶段不升版**（仍 `0.2`）：P0 写出的文件形状与 v0.2 完全一致，没有 rows 落盘就没有新格式；等 P1 真的写出 `rows` 时再升 `0.3`（且旧文件读进来保存后仍是 `0.2`，保证逐字节往返）。

### 6.3 每个 Case 怎么用新模型表达（证明"组合式"成立）

| Case | v0.3 表达 |
|---|---|
| **1** 三分区衣柜 | `rows` 缺省，`units` 三分区 —— **与今天完全一致** |
| **2** 上部通顶柜 + 下部三分区 | `rows: [ {height:480, units:[{kind:'shelves',count:2}]}, {height:'fill', units:[三分区]} ]`，两行之间**自动派生一块贯通横隔板** |
| **3** 左长衣 + 中抽 + 右短衣 + 开放格 | 单行四分区：`hanging / drawerBank / hanging / open`（今天就能做，作为回归） |
| **4** 上下嵌套分区 | `rows` 多行，每行各自 `units` 不同 —— 行内仍是 Section 叶 |
| **5** 两模块成 L 型 | `Assembly { memberIds:[臂A, 臂B], connections:[{kind:'corner', a:{cab:臂A,edge:'right'}, b:{cab:臂B,edge:'back'}}] }` —— 关系**被声明**，落位仍由 `joinSpots` 算 |
| **6** 不同深度模块 | `Assembly` 内两个 `Cabinet` 各自 `depth`（**跨柜变深天然支持**）；**柜内变深暂不做**（见 §11 风险 R4） |
| **7** 电器洞口 + 上部抽屉 | 今天已能表达（`appliance.topDrawers`）；v0.3 可改为 `rows` 表达以统一口径（**可选，非必须**，保持旧柜型不回归） |

> **重要边界**：`Row` 是**水平分层（上下）**；Section 在行内是**左右**。两维正好覆盖"上下嵌套 + 左右分区"。**任意三维网格/自由摆放不在本阶段**。

---

## 7. AI Action Contract 如何扩展

### 7.1 分层（不破坏现有 18 个动作）

```
第一层：参数微调（已有，全部保留）
  cabinet.resize / move / nudge / rotate / setBodyLift / setWidthMode /
  setUnitWidth / setUnitParam / renameUnit / addUnit / removeUnit /
  setBoardMaterial / setBackMaterial / create / duplicate / delete / rename

第二层：结构设计（新增，全走 CommandBus，仍只出语义）
  design.splitRow      把一个柜体在高度上切成两行（给比例/固定高）
  design.addRow        新增一行（通顶储物/腰线格）
  design.removeRow     删除一行
  design.setRowHeight  改行高（比例或 mm）
  section.split        行内加一道立板（把一列拆成两列）
  section.merge        行内合并相邻两列
  section.setKind      改分区功能（层板↔抽屉↔挂衣↔空↔电器格）
  section.setComponent 改子规格（门扇数/层板数/抽屉数/挂衣杆高/洞口尺寸）

第三层：组合关系（新增）
  assembly.create       建一个组合（电视墙/衣帽间/岛台组）
  assembly.addMember    把柜体纳入组合
  assembly.connect      声明关系：kind = corner | inline | stack（给"哪条边对哪条边"，不给坐标）
  assembly.disconnect   解除关系

第四层：设计阶段（新增，见 §7.2）
  design.proposePlan    产出 Design Proposal（**不产生任何模型改动**）
  design.validateProposal  请求确定性校验（AI 请求校验，不自己做校验）
```

### 7.2 Design Proposal —— 需求级方案（不是模型级草稿）

**与 `draftSession` 的区别**：`draftSession` 是"模型级草稿"（已经能落模型的东西）；`DesignProposal` 是**需求级方案**（还落不了、需要用户拍板的东西）。

```
用户需求（大白话）
   │  POST /api/ai/design   （generation=true，走额度"生成次数"）
   ▼
DesignProposal {                     # 会话态产物，**不写 model.json**
   requirement: string
   cabinets: [ {name, width,height,depth, rows:[{height, sections:[{kind,count,...}]}], doorPlan} ]
   assumptions: string[]             # 我替你定的（例如"进深按 600"）
   unknowns: string[]                # 需要你补的
   risks: string[]                   # 约束风险（超幅面/门宽超限/净空不足）
   confidence: 'high'|'medium'|'low'
}
   │  用户确认（可编辑：改数、删行、换 kind）
   ▼
compileProposal() → AiAction[]（落成 §7.1 的第二/三层动作）
   ▼
现有两段式：dryRunPlan → 预览 → commitPlan（或 draftSession 累积）
```

**关键纪律**：
- `DesignProposal` 是**中间产物**，不是派生视图，也不是模型 —— 与项目已有的"多方案对比中间产物 = 候选语义方案"原则一致（记忆 #19）。
- 提案阶段的 `unknowns` 允许 AI **反问**（这正是契约里唯一允许反问的场景：会丢信息）；但 `cabinet.create` 那类已经给了数字的场景**仍不许反问**。
- 提案 → 动作的编译由**我们的代码**做（`compileProposal`），AI 不产出 `AiAction`。

---

## 8. Import Adapter 如何接入

### 8.1 目录与数据边界

```
src/import/
  types.ts       ExternalDesign（源无关） / NormalizedDesign（系统无关中间态） / Provenance
  normalize.ts   NormalizedDesign → Semantic Model（构造只走 docFactory，提交只走 CommandBus）
  json.ts        本系统 Project ↔ ExternalDesign（往返，供导出再导入）
  dxf.ts         DXF → 轮廓/墙体/柜体包围盒（**只出边界，不出板件**）
  image.ts       效果图 → Vision → DesignProposal（识别 + 确认，带 confidence）
  kujiale.ts     仅接口占位：抛 "未实现"，文档化未来路径（本阶段不写 API 代码）
```

### 8.2 统一管道（三类来源同一个出口）

```
酷家乐结构化模型 ─┐
酷家乐 CAD/DXF  ──┼─→ ExternalDesign ─→ normalize ─→ NormalizedDesign ─→ Semantic Model
效果图 / 图片   ──┘                                                    （→ CommandBus → 派生）
```

- **`Provenance` 是 authored 元数据**（允许进模型，不是派生）：`{ source, importedAt, confidence?, rawRef? }`，让界面能说"这条来自酷家乐，置信度 78%"。
- **导入必须走 CommandBus**：新增一个结构性命令 `project.import`（或复用 `replaceProject` + 明确的 diff 摘要），**不许绕过门禁直接赋值** —— 否则记忆门/白名单/撤销全部失效。
- **DXF 导入只到"边界"**：户型轮廓 → `Wall[]`；柜体轮廓 → 包围盒（供人工/AI 定位），**绝不从 DXF 反推板件**（那是第二套几何真相源的入口）。

### 8.3 效果图流程（识别 + 确认，绝不当场出 CAD）

```
效果图 → Vision Model → 候选 Semantic Plan（每字段带 detected|inferred|unknown + confidence）
       → 标记不确定项（"右侧疑似两个层板，置信度 78%，是否确认？"）
       → 用户确认 → Semantic Model → Geometry → CAD
```

契约层面：`DesignProposal` 的每个字段允许携带 `{ value, source: 'detected'|'inferred', confidence }`；`unknown` 字段必须进 `unknowns[]`，**不许编一个默认值蒙混**。

---

## 9. 对现有 2D / 3D / DXF 的影响

| 消费方 | 影响 | 处置 |
|---|---|---|
| `geometry/views.ts`（四视图） | 需画"行"：行间横隔板、各行内立面 | 消费 `CabinetDerived.rows` 增量；**不重算尺寸** |
| `geometry/bodies3d.ts`（3D 体块） | 需按行切分箱体/门/抽 | 同上；仍是轴对齐盒 |
| `geometry/explode.ts`（分解图） | 行隔板入爆炸序列 | 复用 `panels[]`，天然带上 |
| `export/neutralSheet.ts`（DXF 中立表） | **零改动** | 它消费 `panels[]`，行隔板就是多一块板 |
| `export/roomBook.ts`（房间图册） | 低 | 同 views |
| `geometry/pickLines.ts`（点选部件） | 需新增部件名（行隔板线） | 扩 `PARTS` 白名单 + AI 契约同步 |
| 清单/BOM | 零改动 | 行隔板 = `ShelfPanel` 变体 |

**核心保证**：2D/3D/DXF 全部消费 `CabinetGeometry`/`CabinetDerived`，只要 `layout.ts` 是唯一产出方，它们就继续"单源"。**任何一处若发现需要自己算行高/行宽 → 立即停下，说明模型分叉了。**

---

## 10. 迁移方案

| 步骤 | 内容 | 判据 |
|---|---|---|
| M1 ✅P0 | 形状口径落 `core/layoutModel.ts`（读：无 rows ⇒ 单行；写：单行 ⇒ 回 `units`，多行 ⇒ 只写 `rows`）；`projectFile.ts` 读写两侧接上；`schemaVersion 0.2 → 0.3` **推迟到 P1**（P1 才真的写出 rows，见 §15.3） | 旧 `model.json` 读入 → 保存 → **逐字节相同**（`verify/migration-acceptance.ts` A 组，含文件 sha256 指纹） |
| M2 | `computeCabinetLayout` 多行化，**单行分支必须复用原路径**（先写"单行等价"回归断言再改；P0 已把基线数值钉进 migration 验收 B 组） | 全部旧验收脚本持续全绿 |
| M3 | 新字段全部**可选**，`OPTIONAL_AUTHORED` 逐个登记（不许出现"字段缺失 = 状态不明"）。P0 已冻结 `layout.rows`；**写路径白名单未开放**（`cabinet.layout` 的 WRITABLE 不含 rows）—— P1 加入 `rows` 写路径时同步登记，避免现在就把 `layout.rows` 变成 AI 可写面 | `typecheck` + 白名单断言 |
| M4 | 快照新增 `rows`/`assembly` 视图字段；AI 契约版本号 `1.0.0 → 1.1.0` | `ai-acceptance` A 组（契约↔编译器一一对应） |
| M5 | 部署三件套版本同步（模型/生成器/规则集）—— 交付红线 | `roomBook`/`export` 验收 |

**回滚保证（P0 实测口径）**：单行柜在 v0.2/v0.3 下**逐字节同一份文件**，双向无损。多行柜文件**刻意含 `rows` 而不含 `units`**，因此降级回旧版本代码时旧读者会**明确拒绝**该文件（"缺少 layout.units"）而不是把第一行当整柜算错料 —— 这是有意的：**宁可打不开，不可下错料**。旧代码对**未知可选字段**（如未来 `assemblies`）不抛错、不清理，已由 migration 验收 E 组证明。

---

## 11. 测试方案与风险

### 11.1 测试（新增脚本，沿用 `verify/*.ts` 范式）

| 脚本 | 覆盖 |
|---|---|
| `verify/migration-acceptance.ts` | v0.2 文件往返逐字节；未知字段降级不抛错 |
| `verify/rows-acceptance.ts` | Case 2 通顶+三分区、Case 4 上下嵌套、Case 7 洞口+抽屉（改行表达）；高度链恒等式；id 不撞 |
| `verify/assembly-acceptance.ts` | Case 5 L 型关系声明 + 落位复用 `joinSpots`；Case 6 跨柜变深；转角校验改用 `Connection` 后**不回归**（原 `corner.ts` 断言仍绿） |
| `verify/proposal-acceptance.ts` | Design Proposal 校验器（白名单/区间/条数）；`compileProposal` 产出的动作能被 `dryRunPlan` 跑通；`unknowns` 不落模型 |
| `verify/import-acceptance.ts` | `normalize` 往返；`json` 往返等价；`dxf` 只出边界不出板件；`kujiale` 抛"未实现" |
| `verify/preference-acceptance.ts` | 偏好记忆**只影响方案排序**，**拦不住也改不了**硬规则（负样本：偏好说 4 抽，硬规则说 5 抽超净高 → 硬规则赢） |

**回归基线（不可降级）**：现有 25 个脚本 + `verify:ui` 661 断言，全部必须持续全绿。**任何"为了让新 Case 通过而放宽旧断言"都要在评审里说明理由。**

### 11.2 风险登记

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | `layout.ts` 多行化引入浮点/取整误差，破了"宽度链/高度链"恒等式 | **高** | 高度分配**复用 `allocateWidths`/`splitEqual`**（同一套余量算法）；先写单行等价回归再改 |
| R2 | 行内板件 id 跨行撞车（清单下错料） | **高** | id 一律带 `rowId`；`takenIds` 跨行累积；`DUP-PANEL-ID` 断言的负样本测试 |
| R3 | 迁移后旧文件被"规范化"改写，破坏 git diff/哈希 | 中 | M1 逐字节往返断言；单行序列化保持原结构 |
| R4 | **柜内变深**需要阶梯侧板 = 真实结构改动 | 中 | **本阶段不做**；Case 6 用 `Assembly` 跨柜表达；确有需求再单开阶段 |
| R5 | AI 动作数膨胀，模型选择困难 | 中 | 分层命名空间（`design.*`/`section.*`/`assembly.*`）；提示词由词汇表生成，自动带分组 |
| R6 | Design Proposal 变成"AI 直出几何"的后门 | **高** | Proposal 校验器只认语义字段；`compileProposal` 由我们代码实现；`ai-acceptance` 加"提案里不许出现坐标/板件"负样本 |
| R7 | 导入把外部派生数据写进模型 | **高** | `Provenance` 只允许 authored；导入走 CommandBus；`snapshot`/`DENY` 白名单继续拦 |
| R8 | 偏好记忆污染硬规则 | **高** | 物理分层：偏好**不进 Gate**，只进"方案排序/默认值建议"；负样本断言 |
| R9 | 一次性铺开 Case 1–7 导致回归面失控 | 中 | 严格按阶段推进，每阶段独立验收 + 全量回归 |

---

## 12. 实施阶段（小步、可停、可回滚）

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| **P0** 冻结与护栏 ✅**已完成** | 本文件定稿；冻结 v0.3 数据形状（`CabinetRow`/`layout.rows`）；`layoutModel.ts` 建 canonical 口径；`projectFile` 读写两侧接上；`verify/migration-acceptance.ts` 56 条断言。详见 §15 | 旧文件逐字节往返（sha256 相等）；**零行为变更**，全量回归绿 |
| **P1** 垂直维度 ✅**已完成** | `computeCabinetLayout` 多行 + 行隔板/行内立板/行内门抽层板 + 高度链断言 + views/3D 最小增量 + `rows` 写路径登记（**`schemaVersion` 仍未升 0.3，见 §16.4**） | **Case 1/2/4 全绿**；`verify:rows` 101 条断言；全量回归绿。详见 §16 |
| **P2** 组合关系层 ✅**已完成** | `FurnitureAssembly` + `Connection` + `assembly.*` 动作 + 转角校验改用 `Connection`（保留原推断为兜底） | **Case 5/6 全绿**；原 `corner.ts` 断言不回归；`verify:relations` 82 条。详见 §17 |
| **P3** AI 设计阶段 ✅**已完成** | `DesignProposal`（需求级）→ `validateProposal`/`compileProposal`（确定性编译为 `AiAction`）→ `dryRunPlan` → 确认 → `commitPlan`；与既有的 draft/plan 共用唯一写入口 `CommandBus` | 详见 §18；`verify/proposal-acceptance` 89 条 + `verify:fixhint`（PROPOSAL-* 14 码带数字）+ 全链 UI 661/661 不回归 |
| **P4** 导入骨架 | `src/import/{types,normalize,json,dxf,kujiale}` + `project.import` 命令 + `Provenance` | **`verify/import-acceptance`**；`kujiale` 明示"未实现" |
| **P5** 效果图识别 | `image.ts` + Vision → Proposal + 置信度门控 | 识别 + **必须用户确认**才落模型；`unknown` 不落模型 |
| **P6** 设计知识 | 偏好记忆层（与硬规则物理分离）+ 方案排序 | **`verify/preference-acceptance`**；负样本证明偏好改不了硬规则 |

**优先级**：P0→P1 是"旧柜体不坏 + 新模型能表达复杂柜体"的最小闭环，也是你要的核心。P2 让 L/U 从"空间巧合"变"语义事实"。P3 之后才是流程与外部输入。

---

## 13. 与你十一条要求的逐条对照

| 你的要求 | 本方案落点 |
|---|---|
| 一、升级 Semantic Model，兼容旧柜体 | §6；`rows`/`assembly` 全可选，缺省逐位等价 |
| 二、不破坏几何架构 | §9；2D/3D/DXF 全消费单一派生源，改的是 `layout.ts` 一处 |
| 三、增加 AI Design Plan | §7.2；Proposal 是需求级中间产物，确认后编译为动作 |
| 四、扩展 AI Action Contract | §7.1；分层命名空间，仍只出语义 |
| 五、Import Adapter（暂不接酷家乐） | §8；`src/import/` 全套 + `kujiale.ts` 仅占位 |
| 六、效果图"识别 + 确认" | §8.3；`detected/inferred/unknown/confidence` |
| 七、为酷家乐预留接口 | §8.1/§8.2；三条路径收敛到同一 `NormalizedDesign` |
| 八、记忆升级为"设计知识" | §11.1/§12-P6；偏好与硬规则**物理分离** |
| 九、第一阶段只证 7 个 Case | §6.3 + §12（P1 覆盖 1/2/4，P2 覆盖 5/6，3/7 现状已支持） |
| 十、先分析后修改 | 本文件全文；P0 完成前不写实现代码 |
| 十一、最终目标 | §0 路线 + §7.2 + §8：AI 理解/规划/方案/学习；确定性引擎算尺寸/板件/坐标/碰撞/DXF |

---

## 14. 一句话总结

**不动地基，加两个维度**：柜体内加"行"（垂直分层，单行 = 旧模型），柜体间加"组合/关系"（语义拼接，无组合 = 旧模型）。所有扩展都是**可选字段 + 单源派生 + 全量回归**，把 AI 从"参数修改器"升级为"设计提案者"，把外部设计收敛到同一条 `External → Normalized → Semantic` 管道。**第一步（P0）不改任何行为，只冻结形状与护栏。**

---

## 15. P0 实施记录（已完成）

### 15.1 交付物

| 文件 | 变更 |
|---|---|
| `app/src/core/types.ts` | 新增 `RowHeight = number \| 'fill'`、`CabinetRow { id, height, units }`；`CabinetLayout.rows?`（可选）；`units` 语义改为"单行柜唯一真相／多行柜不参与读取"。纯加法。 |
| `app/src/core/layoutModel.ts` | **新建**。canonical 口径唯一实现点：`layoutRows` / `normalizeLayout` / `canonicalUnits` / `isMultiRow` / `allUnits`（读侧），`toFileLayout` / `toFileProject`（写侧），常量 `SINGLE_ROW_ID` / `ROW_HEIGHT_FILL`。 |
| `app/src/core/projectFile.ts` | 写侧改走 `toFileProject()`；解析侧接受 `units` 或 `rows`，并新增行级校验（行非空／行 id 唯一／`height` 合法／行内分区非空／**分区 id 跨行唯一**）；`rows` 与 `units` 并存且不一致时给 warning（以 rows 为准）。 |
| `app/verify/migration-acceptance.ts` | **新建**，56 条断言（A/B/C/D/E 五组）。 |
| `app/package.json` | 新增 `verify:migration`；**顺手修掉一个孤立脚本**：`verify/quota-acceptance.ts`（上一轮新增的 38 条额度断言）此前**从未被 `verify:all` 调用过**，等于不会跑 —— 现已与 `verify:migration` 一并接入。 |

### 15.2 迁移逻辑（一句话版）

> 只有 `layoutModel.ts` 知道 `rows`/`units` 两种形状。读侧一律折成"至少一行"；写侧单行塌回 `units`（旧文件逐字节不变），多行只写 `rows`。其余模块（P1 起）只面对行数组，不需要知道文件里存的是哪个字段。

### 15.3 P0 的三处**有意偏离**草案（都是为安全，需你知晓）

1. **`schemaVersion` 不升 `0.3`。** 草案 M1 写的是 P0 就升版。但 P0 写出的文件形状与 v0.2 完全一致（没有 rows 落盘），升版只会让所有新项目文件字节变化、却没有承载任何新格式；一旦升版，"旧文件逐字节往返"也会被迫在"要不要改写版本号"上二选一。故：**版本号跟着内容走** —— P1 真的写出 `rows` 时才升 `0.3`。
2. **多行时不写 `units` 镜像。** 草案留了"镜像或省略"两可。选**省略**：写镜像会让旧版本代码把第一行当整柜、按全高算板件，**不报错地**产出错误生产尺寸；省略则让旧读者明确拒绝该文件。**宁可打不开，不可下错料。**
3. **不顺手冻结 `FurnitureAssembly` / `Connection` / `Constraint` 类型。** 它们属于 P2/P3，届时会和各自的**校验器**一起落地；现在先冻结会是"没人读的声明"，且可能在 P2 被推翻 —— 那不叫冻结，叫许愿。`rows` 形状则确实冻结了（P1 直接消费）。

### 15.4 回归判据（外部指纹，不是"跑一遍没报错"）

- **文件级**：`sampleProject` 序列化结果的 **sha256 与 P0 之前完全相等**（`1de6c55a…`，4033 字节）—— 这是"零行为变更"最强的一条证据。
- **数值级**：`computeCabinetLayout` 的 `innerW/innerH/netTotal/nets/unitX0/boardT/backT/bodyH/shelfDepth` 与 P0 前逐值相同，且用"把柜宽改成 2000 后必变"作反证，证明这些数字不是恒真比较。
- **引用级**：单行柜的 `canonicalUnits(layout)` 与 `layout.units` **逐项同一对象**（没拷贝、没重排），这正是"P1 可以用 canonical 替换旧取值而不改变行为"的前提。
- **负样本**：9 类非法行**全部被拒且报错文案匹配**（`rejectWhy` 精确到原因）—— 曾经只断言"被拒了"，那会让 A 处的检查替 B 处背锅；本次已把判据升级为"因对的原因被拒"，并**临时关掉行校验分支确认 14 条断言真的转红**后才恢复。

---

## 16. P1 实施记录（已完成）

### 16.1 交付物（按"链路位置"分组，而不是按文件名排序）

| 层 | 文件 | 变更 |
|---|---|---|
| **形状/口径** | `core/layoutModel.ts` | 新增写路径单点 `unitPathPrefix(layout, rowIndex)` + `unitsAtPath()` + `UNITS_PATH`/`BACK_UNITS_PATH`。**全项目仍然只有这一个文件知道 `rows`/`units` 两种文件形状。** |
| **派生** | `core/geometry/layout.ts` | 新增 `resolveRowHeights()`（高度维度唯一分配实现 + 合法判定同处）、`allocateRowWidths()`（**每行独立**分宽）；`computeCabinetLayout` 重写为「行来源 → 解行高 → 自下而上定 `z0` → 逐行分宽」。新增 `rows[] / rowDividers[] / heightChain`。 |
| **派生** | `core/types.ts` | `DerivedRow`（含 `panelTag`）、`RowHeightCheck`（含 `fillCount`）、`CabinetDerived.rows/rowDividers/heightChain`。柜级 `netTotal/nets/unitX0` 标注为"第一行的兼容视图"。 |
| **生成器** | `core/geometry/generate.ts` | 中立板**逐行**（长度 = 该行净高、id 前缀 = `panelTag`）；新增行隔板 `RowDividerPanel`（长度 = 内空宽、Z = 派生给的 `rowDividers`）；层板/门/抽/电器/杆全部按行参数化（`zOffset`）。 |
| **校验** | `core/rules/validate.ts` | 宽度链改**逐行**断言；新增高度链断言；`heightChain.code` → `RULE-ROW-FILL-DUP / FILL-POSITION / FILL-OVERFLOW / HEIGHT-SUM / HEIGHT-BAD`；新增 `RULE-ROW-DOUBLE-UNSUPPORTED`。 |
| **文案** | `core/rules/issueCatalog.ts` | 新增 6 张规则卡片；一键修复的写路径改由 `baseOf(ctx)` 生成（多行时自动落到 `layout.rows[j].units`）。 |
| **2D** | `core/geometry/views.ts` | 四视图全部改**面对行数组**（`rowCtxs`）：俯视中立板取逐行并集、侧视逐行虚线 + 行隔板横板、正视/内部图逐行定位与标注。不读 `rows` 字段，只读 `L.rows`。 |
| **3D** | `core/geometry/bodies3d.ts` | `BoxRole` 加 `'rowDivider'`；逐行绘制 + 行隔板盒；层板/门/抽/电器/杆按行换算。 |
| **装配** | `core/geometry/assembly.ts` | `unitIndexOf` 升级为 `locateUnit`（**跨行**定位，返回 `{rowIndex,unitIndex,z0,netH}`）；摆位按所在行的 `z0/netH` 算；`RowDividerPanel` 进入分解计划。 |
| **拾取** | `core/geometry/pickLines.ts` | `partParamPath` / `pickPartsOf` / 正视图 / 侧俯视图全部按行生成写路径与线（`unitPathPrefix`）。 |
| **命令** | `core/commands.ts`、`core/commandBus.ts` | `setUnitWidth/Int/String` 增可选尾参 `unitBasePath`；白名单增 `layout.rows[\d+].units[\d+]…` 全系列；`addUnit/removeUnit/mirror` 增可选 `rowIndex`（默认 0 = 单行/第一行），多行柜**不会**静默改错行。 |
| **拖动** | `viewport/sheetDrag.ts` | 分区分界/门缝拖动按 `PickLine` 自带的写路径前缀发命令。 |
| **AI** | `ai/compile.ts`、`ai/snapshot.ts` | `resolveUnitIndex` 跨行解析；`cabinet.addUnit` 支持 `rowIndex`；快照新增 **`rows` 字段（仅多行时出现，单行柜快照一个字节不变）**。AI 仍然**只出语义**，不碰几何/坐标/DXF。 |
| **UI** | `ui/panels/PropertiesPanel.tsx`、`ui/panels/ObjectTree.tsx`、`styles.css` | 属性面板按行分组（行头显示"净高 / fill"并可改，行内分区编辑器带写路径前缀）；对象树多行时画行头。 |
| **其它消费点** | `core/variants.ts`、`core/rules/corner.ts`、`export/roomBook.ts` | 一律改走 `layoutRows/canonicalUnits/allUnits` —— 消除"直接读 `layout.units` 在多行柜下拿到空数组"的隐患。 |
| **验收** | `verify/rows-acceptance.ts`（**新建**，101 条） | 见 §16.3。已接入 `verify:all`。 |

### 16.2 核心计算逻辑（三句话）

1. **行高**：`available = innerH − (行数−1)×板厚`；固定行按 authored 值，`'fill'` 行吃掉 `available − Σ固定`。恒等式 `Σ行净高 + (行数−1)×板厚 === innerH`。`'fill'` **只能一个、只能在最后一行**，非法时给 best-effort 布局（每行净高 ≥1mm，不返回 NaN）+ 原因码，由校验器翻人话。
2. **行位置**：行序**自上而下**（`rows[0]` 在最上面），`z0` 从内空底自下而上累加 `净高 + 板厚`。`rowDividers[k] = rows[k+1].z1` —— 隔板位置与行高**同源**，不可能漂。
3. **行宽**：**每行独立**执行已有的 `allocateWidths`。不展平：展平会让"上行 2 格 + 下行 3 格"算成 5 格分同一段净宽，而宽度链恒等式在整柜口径下照样成立 —— 错得毫无征兆。验收里有专门的**展平反例**断言"逐行算 ≠ 展平算"。

### 16.3 `verify:rows` 的 106 条断言（101 + 架构审查补的 5 条）

> P1 交付后做 P2 前的架构审查时，又补了 ⑧b 组 5 条：**多行 × 双面柜**明确报 `RULE-ROW-DOUBLE-UNSUPPORTED`（ERROR）、派生按单行兜底取 canonical 第一行（`netTotal === innerW − boardT`，不是荒谬值）、不产出 phantom 行隔板、所有派生数字 finite。这 5 条来自审查发现的真实缺陷：`geometry/layout.ts` 的双面柜兜底分支当时直接读 `layout.units`，而多行柜按约定**不写 units 镜像** → 拿到空数组 → `allocateRowWidths([], …)` 算出荒谬宽度。**结论：全项目不许再有第二处判断"是 rows 还是 units"。**

| 组 | 覆盖 | 条数要点 |
|---|---|---|
| ① 单行回归 | 旧形状（只有 `units`）vs 新形状（显式一行 `rows`） | 骨架 7 个标量、nets/unitX0、板件清单、五金、统计、平面图元、立面图元、四视图图元/标注/拾取线、3D 盒、**中立导出（DXF 唯一源）** 逐值相等；存盘塌回 `units` 不写 `rows` |
| ② 两行固定 + fill | `rows[0]=480 / rows[1]='fill'` | 净高、`z` 相邻关系（底行顶面 + 板厚 = 上行底面）、`panelTag` 分行、`rowDividers` 恰好 1 块 |
| ③ 高度链恒等式 | 2/3/4 行 + 全固定高闭合 | `ΣnetH + (n−1)t === innerH`；`z1−z0 === netH`；行间只隔一块板厚 |
| ④ fill 规则 | 位置/重复/溢出/和不等/非法值 | 判定码精确到 `FILL-NOT-LAST / FILL-DUP / FILL-OVERFLOW / SUM-MISMATCH / HEIGHT-BAD`，校验器报对应 `RULE-ROW-*` 且 **ERROR**；非法配置仍画得出（净高 ≥1mm） |
| ⑤ 行间横隔板 | 数量 = 行数−1、长度 = 内空宽、Z = 派生值 | 且**中立板长度 = 该行净高**（不是整柜净高 → 上层中立板不会捅穿顶板） |
| ⑥ 每行独立分宽 | 逐行宽度链 + **展平反例** | 展平结果与逐行结果**必须不相等** |
| ⑦ Case 1 / 2 / 4 | 同一套机制 | 三例都断言：行数/分区数、高度链闭合、**无 ERROR**、行隔板数、四视图非空、3D 行隔板盒数 |
| ⑧ 2D/3D/DXF/BOM 一致性 | 四处说同一件事 | BOM 行隔板数 === 3D 行隔板数 === 行数−1；2D 侧视按 `rowDividers` 画；3D 盒 Z 中心 = 派生 Z + 半板厚；中立导出与四视图同源 |
| ⑨ 写路径 | 单行沿用 `layout.units`，多行落 `layout.rows[j].units` | 含"改第 2 行的净宽真的落在第 2 行"的**端到端命令**断言 |

### 16.4 P1 的三处有意偏离 / 已知边界（需你知晓）

1. **`schemaVersion` 仍未升 `0.3`。** 与 §15.3-1 同一个理由：版本号跟着内容走。P1 里只有"用户真的创建了多行柜"才会写出 `rows`，而当前 UI 尚无"新增行"的入口（属性面板能改行高，但**新增/删除行**没有做 —— 那是 P1 之后、与 AI 行级动作一起给的形状变更入口）。等真正有写 `rows` 的用户路径时再升版并补迁移。
2. **多行 × 双面柜（岛台）明确不支持**，报 `RULE-ROW-DOUBLE-UNSUPPORTED` ERROR。这两者的几何语义（背面排按行切还是按整柜切）没有真实需求支撑，现在给任何答案都是猜；**宁可明确拒绝，不可猜一个未定义的几何**。
3. **AI 不参与 P1 的新结构设计**（按你的要求）：快照里新增的 `rows` 字段只是让 AI **看得见**多行（否则它会以为柜子只有几分区），没有新增任何 row 级 AI 动作；`cabinet.addUnit` 的 `rowIndex` 是给后续阶段留的通道，当前契约未开放给模型。

### 16.5 回归判据

- 全量 node 链 **27/27 脚本 exit=0**（含新增 `verify:rows` 106 条）。
- `verify:migration` **56/56**、`verify:quota` **38/38**、`tsc --noEmit` 无错。
- `verify:ui` **661/661 通过**（与 P1 之前的基线逐条相同，未新增也未放宽）。
- **旧断言一条未删、未放宽**：本次对旧脚本零改动（除 `package.json` 接入 `verify:rows`）。

---

## 17. P2 实施记录（已完成）

### 17.1 交付物（按"链路位置"分组）

| 层 | 文件 | 变更 |
|---|---|---|
| **形状** | `core/types.ts` | 新增 `ConnectionEdge / ConnectionKind / ConnectionEnd / Connection / FurnitureAssembly`；`Project.assemblies?`（项目级扁平数组，与 `cabinets` 同构）。**全可选** —— 没有组合的项目与 v0.2 逐字节相同。 |
| **派生 + 校验** | `core/relations.ts`（**新建**） | `deriveContacts()`（"接不接触"的唯一实现）、`contactIndex()`、`inferConnections()`、`authoredConnections()`、`minDistance()`、`validateAssemblies()`、`pairKey()`、`EDGE_ZH/KIND_ZH`。**这个文件不产生任何几何。** |
| **文案** | `core/rules/issueCatalog.ts` | 新增 15 张组合规则卡，每条都带**具体数字**（gap mm / 夹角° / 成员数 / 高度）。 |
| **校验接线** | `core/commandBus.ts` | `deriveFor` 追加 `validateAssemblies(p)`；`SideEffect` 增 `insertAssembly/removeAssembly/patchAssembly/moveAssembly`；`STRUCTURAL_OPS` 增 8 个 `assembly.*`；`planStructural` 增 8 个分支。 |
| **校验** | `core/rules/corner.ts` | 检查队列 = **声明的 corner 对** ∪ **推断对**（按 `pairKey` 去重）。声明优先，推断兜底 —— 没声明组合时行为与 P2 前完全一致。 |
| **命令** | `core/commands.ts` | 新增 8 个构造器：`createAssembly / deleteAssembly / addAssemblyMember / removeAssemblyMember / connectInAssembly / disconnectInAssembly / moveAssembly / renameAssembly`。payload 里**只有 id 与语义，没有一个坐标是这里算的**。 |
| **契约** | `shared/aiContract.mjs` | `ACTIONS` 增 `assembly.create` / `assembly.delete`；`checkParam` 增 `id-list` / `object-list` 两种形状校验。 |
| **编译器** | `ai/compile.ts` | 增两个 case，加入 `COMPILED_ACTIONS`。 |
| **快照** | `ai/snapshot.ts` | `AiSnapshot.assemblies?` —— **只在真的有组合时出现**（与 `rows` 同款纪律，旧项目快照一个字节不变）；连接翻成人话 `kindZh`。 |
| **序列化** | `core/projectFile.ts` | `resolveSchemaVersion()`：**有多行柜或有组合 ⇒ 0.3，否则仍 0.2**；解析端新增组合校验⑦（只挡会引发事故的，其余兜底 + warning，见 §17.4-1）。 |
| **UI** | `ui/panels/ObjectTree.tsx`、`styles.css` | 多选 ≥2 个同房间柜体 → 「把选中的 N 个柜组成一组」；有组合时渲染「组合（N）」整块：成员数、连接列表（kind + 两柜名 + `inferred` 标记）、「选中整组」「按当前落位补全连接（N）」「删除组合」。 |
| **验收** | `verify/relations-acceptance.ts`（**新建**，82 条） | 见 §17.3。已接入 `verify:all`。 |
| **验收** | `verify/fixhint-acceptance.ts` | 新增 `NUM_CTX`（16 条组合卡的真实 ctx）+ 断言「喂进去的每个数字都真写在 message 上」。见 §17.4-2。 |
| **验收** | `verify/ai-acceptance.ts` | `MINIMAL` 增 `assembly.create` / `assembly.delete` 两个最小样例（契约新增动作必须进最小样例表）。 |

### 17.2 三条纪律（P2 的架构边界，比代码重要）

1. **关系层不产生几何。** `FurnitureAssembly` 是"这三个柜是一组"的**声明**，不改板件、不改尺寸、不进 2D/3D/DXF/BOM。验收 E 组逐字节比对：建组合前后 BOM / stats / plan 图元 / 四视图 / 中立导出（DXF 唯一源）**完全不变**。
2. **"接不接触"只有一处实现。** `deriveContacts()` 是唯一判据；`validateAssemblies()`、`corner.ts`、UI 的"按当前落位补全连接"全消费它。不允许第二处自己算距离。
3. **声明（`authored`）与推断（`inferred`）必须分开。** 只有 `origin:'authored'` 的连接会被校验；推断只用于**表达**（UI 里标 `推断`），**不据此报错** —— 拿猜测去骂用户是不可接受的。

### 17.3 `verify:relations` 的 82 条断言

| 组 | 覆盖 | 要点 |
|---|---|---|
| A · Case 5 | L 型角接 | 声明 `corner` 与落位一致 → 无 ERROR；`deriveContacts` 认出 corner；改掉一个柜的朝向 → 精确到 `ASSEMBLY-KIND-MISMATCH` |
| B · Case 6 | 跨柜变深并排 `butt` | 深度不同的两柜并排仍判续接；`edge` 声明错 → `ASSEMBLY-EDGE-MISMATCH` |
| C · 声明 vs 落位 | 四条精确码 | `NOT-TOUCHING`（带 gap）/ `KIND-MISMATCH`（带 angle）/ `EDGE-MISMATCH` / `EDGE-AMBIGUOUS`；**每条都断言具体规则码**，不只断言"报错了" |
| D · 结构非法 | 7 条 | 成员不存在 / 成员重复 / 跨房间 / 房间不存在 / 空组合 / id 重复 / 连接指向组合外 / 自连 / 重复连接 |
| E · 关系层不产生几何 | 逐字节比对 | BOM / stats / plan / views / neutral 建组合前后完全相等 |
| F · 整组操作 | 命令与撤销 | 整组平移一次命令、一次撤销；移除成员 / 删除组合后连接不悬空 |
| G · 转角检查 | `corner.ts` | 声明的 corner 对**一定**被查（哪怕落位算不出来）；没声明组合时行为与 P2 前一致 |
| H · AI 通道 | 不给坐标 | `assembly.create` 的 payload 里没有任何 x/y/z；契约层 `id-list` 拒绝非字符串数组 |
| I · 序列化与版本 | `schemaVersion` | 有组合 ⇒ 0.3；删掉组合后存盘回 0.2；存量文件往返逐字节不变 |
| J · 兼容边界 | 旧项目 | `assemblies` 缺省 ⇒ 与 v0.2 逐值相同；`projectFile` 解析器对缺字段只兜底不拒绝 |
| K · U 型 | 三柜两条角接 | 全绿、无"分成几堆"、首尾两臂不相接不牵连报错 |

### 17.4 P2 的已知边界 / 有意偏离（需你知晓）

1. **`stack` 允许声明但不校验**，报 `ASSEMBLY-STACK-UNVERIFIED`（INFO）。原因：柜体 placement 只有 `(x, y, rotation)`，**没有 Z**，无法判定谁在上。文案里给了两柜高度与"若真叠放总高约 N"，并指了明路（同一柜内用上下两行 `rows` 表达分层，那个是能算的）。**宁可如实说"没核"，不可假装核过。**
2. **`fixhint` 的"给得出数字"不是靠兜底 0 混过去的。** `num()` 缺值时返回 0，于是"成员数 0 个"也算"有数字" —— 这是典型的**假绿**。所以验收里给这 16 条卡喂有辨识度的真实值（gap=137 / angle=45 / count=3 / hA=900 / hB=600 / total=1500），并断言**这个值确实出现在 message 里**。
3. **解析器对组合只挡"会引发事故的"**：id 重复、成员指向不存在柜体、关系指向组合外、kind/edge 取值非法。缺 `name` / `roomId` / `connections` / 空成员一律**兜底 + warning**，业务对错交给 `validateAssemblies()` —— 因为"未来字段不炸旧读者"是 §15 定的护栏，不能为了校验方便把"打不开"当成报错。
4. **`schemaVersion` 仍是内容驱动**：`resolveSchemaVersion()` 一处判定，有 rows>1 或有 assemblies ⇒ 0.3，否则 0.2。存量文件读进来再存盘**逐字节不变**（migration 56 条已钉）。

### 17.5 回归判据（实测）

| 判据 | 结果 |
|---|---|
| `tsc --noEmit` | 无错 |
| 全量 node 链（29 个脚本，含新增 `verify:relations`） | **全部 exit=0** |
| `verify:relations` | **82 / 82** |
| `verify:rows` | **106 / 106**（P1 基线未动） |
| `verify:migration` | **56 / 56**（存量文件逐字节不变） |
| `verify:fixhint` | **26 / 26**（新增 1 条"数字真写在 message 上"，旧断言未放宽） |
| `verify:ui` | **661 / 661**（与 P1 后基线**逐条相同**，未新增也未放宽） |
| `verify:ai` | 70 / 70（含新增的 `assembly.create` / `assembly.delete` 最小样例） |
| 旧断言 | 一条未删、未放宽；`corner.ts` 在无组合时行为与 P2 前一致（G 组已钉） |

---

## 18. P3 实施记录（已完成）

### 18.1 交付物（按"链路位置"分组）

**需求级 Proposal 类型与校验**
- `src/ai/proposal.ts`：`DesignProposal` / `ProposalCabinet` / `ProposalRow` / `ProposalUnit` / `ProposalAssembly` / `ProposalConnection` 类型；`validateProposal(p, project)`（语义校验，报 `PROPOSAL-*` 码，每条给具体数字）、`proposalBlocked()`、`defaultSizes()`。
- `src/ai/compileProposal.ts`：确定性编译器，把 `DesignProposal` 翻成 `AiAction[]`。柜体 → `cabinet.create`（rows/units/backUnits 全透传，落位由 `pickFreeSpot` 定，无坐标）；组合 → `assembly.create`（成员用 `$ref:ref` 占位，真正建出来那一刻由 `planRunner` 换真 id）。

**契约与服务端**
- `shared/aiContract.mjs`：`buildDesignSystemPrompt()` / `buildDesignRequest()`（系统提示写"设计方案"，server/mock 靠它区分通道）；`proposalShapeError()` 形状门（服务端第一道关 + 前端第二道关共用同一份）；`ACTIONS['cabinet.create']` 补 `rows` 参数（`id-list` / `object-list` 形状校验）。
- `server/server.mjs`：新增 `/api/ai/design` —— 只做形状校验 + 转发模型 + 抽取 JSON + 形状门退回；**不编译、不碰模型、不产出几何**。
- `src/ai/aiClient.ts`：`requestDesign()`（前端再验一次形状门，整份退回不修）。

**UI（复用既有收口，不新造提交链路）**
- `src/ui/panels/AIPanel.tsx`：新增"设计方案"按钮与设计方案段；显示标题/说明、AI 假设、系统补齐的默认值（notes）、待确认问题（openQuestions，**非空即禁用应用**）、`PROPOSAL-*` 校验结果、`reasoning`；确认前零改动模型。
- `src/ui/panels/PlanRunView.tsx`（新）：把 `dryRunPlan` 的预览渲染抽出来，**plan 模式与 design 模式共用同一份** —— 杜绝"预览看着对、提交却不一样"的漂移。
- 会话状态新增 `design` 字段，与 chat/draft/plan 一起按房间落 sessionStorage；版本失效时一并作废 design.run。

### 18.2 三条纪律（P3 的架构边界，比代码重要）

1. **Proposal 与正式模型严格分离。** Proposal 只活在会话状态里，编译产物是 `AiAction`，走的是既有的 `dryRunPlan → 确认 → commitPlan` 唯一写入口。它**没有第二条写入口**，结构上不可能是后门。
2. **AI 只出语义，不碰几何。** Proposal 字段里没有 x/y/z；`compileProposal` 产出的动作不含 `atX/atY`。落位由系统定，组合成员用 `$ref:` 占位（不让模型去猜还不存在的 id）。
3. **不确定就问，不猜。** `questions` 非空 ⇒ `compileProposal` 返回 `ok:false`，应用按钮禁用；尺寸没给用规则集默认值并写进 `notes` 显示在界面（悄悄补齐 = 骗人）。

### 18.3 `verify/proposal-acceptance` 的 89 条断言（分组）

- A–F：Proposal→编译→干跑→提交的端到端不污染模型、契约校验通过、`$ref:` 解析、多行柜分区 id 不撞车、"预览===提交"逐 command 比对。
- G：结构边界 —— `proposal.ts` 无任何坐标字段。
- H：兼容 —— 无提案时模型与序列化与 P2 后完全一致。
- I（新增通道级）：`buildDesignRequest` 系统提示含"设计方案"、用户需求与快照随通道带出；`proposalShapeError` 拒缺 title / 非数组 cabinets / 缺 ref / 非法 connection kind / 非数组 members；**openQuestions 阻断编译到可执行动作**且原因把原问题带上；无障碍方案能编译→干跑不动模型→确认才写入。

### 18.4 P3 的已知边界 / 有意偏离（需你知晓）

- **设计模式不新增"design.* 写动作"。** 它复用 `cabinet.create` / `assembly.create`，没有为 Proposal 单独开一套写入口 —— 正是"唯一写入口"纪律的体现。
- **`compileProposal` 不做几何。** 柜体内部结构、落位、组合关系全部交回确定性代码（与 AI 直接出动作的链路同权同位）。
- **待确认问题（openQuestions）一律不让步**：宁可停在预览，也不拿假设替用户拍板。

### 18.5 回归判据（实测）

| 判据 | 结果 |
|---|---|
| `tsc --noEmit` | 无错 |
| 全量 node 链（30 个脚本，含新增 `verify:proposal`） | 全部 exit=0 |
| `verify:proposal` | **89 / 89**（新建） |
| `verify:relations` / `rows` / `migration` / `fixhint` | 82 / 106 / 56 / **27**（PROPOSAL-* 14 码均带具体数字） |
| `verify:ui` | **661 / 661**（与 P2 后基线逐条相同；新增按钮与 PlanRunView 复用未引入新差异） |
| `verify:ai` / `aigen` / `draft` / `assembly` | 70 / 60 / 37 / 78（旧链路未回归） |
| 旧断言 | 一条未删、未放宽；新增 `verify:proposal` 接入 `verify:all` |
