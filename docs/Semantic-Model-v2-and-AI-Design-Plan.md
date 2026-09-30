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

---

## 19. P4 实施记录（已完成）

> commit：`6f5541b`。本阶段只建"边界"，不接通所有平台；酷家乐 / 图片识别只留 Adapter 边界（标"待验证能力"），真正的 API / Vision 实现在 P5。

### 19.1 交付物（按"链路位置"分组）

**统一 Import 链路（客户端运行，与 AI Design 同权同位）**
- `src/ai/import/normalized.ts`：`NormalizedDesign` / `NormalizedCabinet`（同形 `ProposalCabinet` + per-cabinet `source`/`confidence`/`uncertainty`）/`validateNormalized(nd, project)`（形状门复用契约 `proposalShapeError`，通用校验复用 `validateProposal`，导入专属 `IMPORT-*`）/ `importBlocked()`（ERROR / OPEN-QUESTIONS / UNCERTAINTY 阻断）/ `normalizedToProposal()`。
- `src/ai/import/{jsonAdapter,dxfAdapter,kujialeAdapter,imageVisionAdapter}.ts`：四个 Adapter，确定性解析外部数据 → `NormalizedDesign`。来源归属写进 ND；失败/不完整/不确定**明确暴露不静默猜测**。
- `src/ai/import/compileImport.ts`：`compileImport(nd, project, rules)` = `validateNormalized` → 阻断即 `ok:false` → 否则 `normalizedToProposal` → `compileProposal` → 给每个 `cabinet.create` 动作注入 `origin`。产物仍是 `AiAction`，走 `dryRunPlan → commitPlan → CommandBus`。
- `src/ai/import/adapters.ts`：`ADAPTERS` 注册表（`json` verified，`dxf`/`kujiale`/`imageVision` verified:false）+ `parseImport(source, raw, opts)`。

**provenance 落库（穿过整条链路）**
- `src/core/types.ts`：`Cabinet.origin?: ImportOrigin` / `ImportSource` / `ImportOrigin`（source / label / batchId / confidence / uncertainty）。
- `src/core/docFactory.ts`：`createCabinet` opts 加 `origin?` 并写入 Cabinet。
- `src/ai/compile.ts`：`AiAction.origin?`；`buildCabinet`（`createCabinet` 别名）展开 `{...action}` 透传 `action.origin`。

**错误码唯一真相源**
- `src/core/rules/issueCatalog.ts`：`IMPORT-EMPTY` / `IMPORT-SHAPE` / `IMPORT-OPEN-QUESTIONS` / `IMPORT-UNCERTAINTY` / `IMPORT-LOW-CONFIDENCE` / `IMPORT-UNVERIFIED-CAPABILITY`，每条带**具体数字 / 真实文本**（防被兜底值 0 顶替成假绿）；`buildIssue` 对未登记码直接抛错。

**UI（复用既有收口）**
- `src/ui/panels/ImportPanel.tsx`：导入页签（来源选择 / 粘贴 / 解析 / 归一化结果 / IMPORT-* 校验 / 不确定项 / 未验证能力），复用 `PlanRunView` 预览，`blocked` 时禁用编译。
- `src/ui/{App,Toolbar}.tsx`：注册 `导入` 页签（`RightTab` 加 `'import'`）。

**验收**
- `verify/import-acceptance.ts`：59 条断言，接入 `verify:all`（`npm run verify:import`）。

### 19.2 架构边界（P4 的纪律，与 P3 同源）

1. **Import 不新造写入口。** 编译产物是 `AiAction`，走的是 P3 建好的 `dryRunPlan → 确认 → commitPlan` 唯一写入口；与 AI 设计通道同权同位。"Import 是后门"在结构上不可能。
2. **AI / Import 只出语义，不碰几何。** `NormalizedDesign` 字段里没有 x/y/z；`compileImport` 产物不含 `atX/atY`；落位由 `pickFreeSpot` 定，DXF 坐标**不进落位**，组合成员用 `$ref:` 占位。
3. **失败 / 不完整 / 不确定必须暴露，不静默。** 形状错→`IMPORT-SHAPE`；待确认→`IMPORT-OPEN-QUESTIONS`；不确定→`IMPORT-UNCERTAINTY`；未验证能力→`IMPORT-UNVERIFIED-CAPABILITY`（不阻断但必须显示）；uncertainty / questions 非空**阻断应用**。
4. **外部数据不污染 core semantic model。** 适配器产 `NormalizedDesign`（翻译后的标准语），不直接写 `Panel` / 坐标 / DXF 图元；来源归属只作为 `Cabinet.origin` 元数据随动作透传。
5. **旧项目完全兼容。** 导入前旧柜一条不少，新柜追加；项目结构（房间 / schema）不变。

### 19.3 `verify/import-acceptance` 的 59 条断言（分组 A–I）

- A：JSON 端到端（解析→编译→干跑→提交），origin 落到 `Cabinet.origin`、动作无坐标、旧柜保留、版本 +1。
- B：DXF 弱解析诚实（提取块引用、`confidence:'low'`、uncertainty 标"未识别内部结构"、坐标不进标准模型）；uncertainty 触发 `IMPORT-UNCERTAINTY` 阻断；另证"低置信度本身不阻断，只有 uncertainty/questions 拦"。
- C：`uncertainty` 非空 → `IMPORT-UNCERTAINTY` 阻断，message 含真实不确定内容（非兜底）。
- D：`questions` 非空 → `IMPORT-OPEN-QUESTIONS` 阻断，message 含真实问题文本。
- E：酷家乐仅边界占位（非法输入诚实反问、合法输入 `confidence:'low'` + `unverifiedCapabilities`）。
- F：图片识别仅收 Vision 结构化结果（不执行视觉识别，标 low + 未经人工确认）。
- G：`IMPORT-SHAPE` 带真实解析错误文本（防假绿）。
- H：未登记码 `buildIssue` 直接抛错；已登记 `IMPORT-*` 正常产出且带数字。
- I：多柜 + 组合 ref → 真 id（编译期 `$ref:` 占位、提交后换成真 id、两个导入柜都带 origin）。

### 19.4 顺带修复的既有 core bug（defaultUnits 透传 depth）

`defaultUnits(width, rules)` 过去调用 `makeUnit` 建抽屉区时**不传柜深**，于是 `makeUnit` 默认按 600mm 算抽屉滑轨 `runnerLength = min(500, 600-20) = 500`；当一个实际 <520mm 深的柜体走默认三分区时，500mm 滑轨超过柜深，被严格模式判 `抽屉滑轨长 500mm…` 拒收——而这个柜体可能是真实的`玄关鞋柜(350 深)`。修复：`createCabinet` / `createCabinetFromTemplate` / `defaultVariant` / 命令总线补默认分区 四处都透传真实 `params.depth` 给 `defaultUnits`，滑轨按真实深夹紧。影响面安全可逆，全量回归零变化。

### 19.5 已知边界 / 有意偏离（需你知晓）

- **酷家乐 / 图片识别 = 边界占位，不是已接通。** 二者只收"已结构化 / 已识别"的草稿，非法输入诚实反问，合法输入标 `confidence:'low'` + `unverifiedCapabilities`（kujiale-format-parsing / kujiale-auth-api / vision-floor-plan-recognition）；绝不出现"我解析了 / 我识别了"。真接入在 P5。
- **DXF = 诚实弱解析。** 只从 DXF 文本抽 `INSERT` 块引用作"柜体意图"，宽高深按块尺寸估算（不可靠），内部结构与板厚标为 `uncertainty`，因此**默认被阻断**直到用户确认——这正是"不确定就问不猜"。
- **来源信息不绕过链路。** `origin` 只是元数据，不参与几何 / 规则 / 派生；审计与界面读的是同一份 `Cabinet.origin`。

### 19.6 基础设施修复（#91）

`verify/browser-probe.cjs` 的 `killChrome()` 原只 `taskkill /pid /T` 启动器 pid，而 Windows 上 Chrome 会把浏览器交给新 PID（singleton 重排），导致每次验收都留孤儿 chrome，跑十几轮吃满内存（`tsc` 报 `VirtualAlloc failed / errno=1455`）。修复：退出钩子里**额外按独有的 `remote-debugging-port` 用 PowerShell `Get-CimInstance` 兜底强杀**整组残留 chrome（用户自己的 chrome 不带该端口，不会被误杀）。实测验收后 `tasklist` 查 chrome 数为 0。

### 19.7 回归判据（实测）

| 判据 | 结果 |
|---|---|
| `tsc --noEmit` | 无错 |
| 全量 node 链（`verify:all` 除 `verify:ui`） | 全部 exit=0 |
| `verify:import` | **59 / 59**（新建，接入 `verify:all`） |
| `verify:ui` | **661 / 661**（导入页签复用 PlanRunView，无新差异） |
| 其余受 `defaultUnits` 修复牵连的脚本 | `verify`(127) / `proposal`(89) / `variants`(58) / `cabinets`(64) / `rows`(106) / `relations`(82) / `room`(28) / `migration`(56) / `projectfile`(27) / `special`(38) / `glass`(30) 全绿 |
| 旧断言 | 一条未删、未放宽 |

---

## 20. P5 实施记录：图片识别闭环（VisionProvider → 诚实映射 → 候选 → 确认 → Semantic Model）

> commit `8aecd76`（代码）。目标不是"让 AI 猜出一张完整 CAD"，而是建立可靠的人机协作识别链路。

### 20.1 交付物

**新增 `src/ai/vision/`（与 core 解耦的 Provider 层）**：

| 文件 | 职责 |
|---|---|
| `types.ts` | `VisionProvider` 接口（`analyze(VisionInput) → VisionResult`）；`VisionResult` 携带 `scale`（图片是否有可靠尺寸标注）、逐柜逐维 `width/height/depth {value, confidence, source: 'annotation'\|'estimate'}`、`rows/units/components`（可见结构）、`relations`（可观察组合关系）、`notVisible`（看不见的生产结构）、`ambiguous`（模型自己都说不清的） |
| `providers/mock.ts` | `MockVisionProvider`：确定性 fixture（main=三柜衣柜墙无标注 / annotated=带尺寸标注 / ambiguous=模糊图），无网络无 key，验收与离线演示用；**返回形状与真实 Provider 完全一致** |
| `providers/remote.ts` | `RemoteVisionProvider`：OpenAI 兼容 `/chat/completions`（image_url 走 data URL），**经服务端 `/api/ai/vision` 路由**复用既有 `AI_BASE_URL/AI_API_KEY/AI_MODEL` 网关配置——不硬编码任何厂商/模型名，换服务商 = 换网关配置 |
| `visionResultToNormalized.ts` | **诚实映射层（P5 纪律所在）**，见 20.2 |
| `factory.ts` | `createVisionProvider('mock'|'remote')` + `analyzeImageToNormalized()` 一条龙；新增服务商 = 写一个 Provider 实现并登记，Semantic Model / Geometry / Rules 零改动 |

**复用既有链路（不造第二套写入）**：Vision → `NormalizedDesign` → `validateNormalized` → `compileImport` → `dryRunPlan` → PlanRunView 预览 → 用户确认 → `commitPlan` → CommandBus。与 P4 的 JSON/DXF 导入、P3 的 AI 设计通道**同权同位**。

**UI（ImportPanel 扩展）**：来源切「图片识别」→ 选图（或「示例图（离线 Mock）」）→ 识别 → 归一化结果（逐柜置信度 + caveats）→ **caveat 确认门**（未勾选「已知晓」禁用编译按钮）→ 复用 PlanRunView 预览 → 应用。补齐了 P4 遗漏的全部 `import-*` 样式（面板此前是无样式裸渲染）。

**服务端**：`server.mjs` 新增 `POST /api/ai/vision`（复用 AI 网关配置与超时/错误处理）；`aiClient.ts` 新增 `requestVision()`。真实 API 通路需有 key 环境验证（`/api/ai/vision` 已就位，Mock fixture 先行跑通闭环——按用户指示不因 API 问题卡住 P5）。

### 20.2 诚实映射纪律（不编造看不见的生产结构）

| 信息 | 来源 | 处理 |
|---|---|---|
| 柜体数 / rows / units / 门抽屉开放格 / 并排·L 型组合 | 图片**可见** | 翻译成 NormalizedDesign（候选） |
| 尺寸 | 图片有标注（`scale.known` / `source: 'annotation'`） | 高可信采用，仍过规则校验 |
| 尺寸 | 无标注（`source: 'estimate'`） | **保留数值但标 caveats**「视觉估计，下料前请确认」；用户给了参考尺寸可升格 scale |
| 真实深度 / 板厚 / 隐藏隔板 | `notVisible` | caveats（用户逐项确认后才允许生成，确认后随 `Cabinet.origin` 留痕审计） |
| 柜体物理连接方式（贴合/留缝/收口条） | 图片不可见 | **组合只做纯分组（assembly 不带 connections）+ caveat 明示**；用户确认后用既有「按当前落位补全连接」建立真实连接。不硬声明 butt/corner——图片只显示"看起来挨着"；且编译期落位快照里没有前序柜体，硬声明续接必被严格邻接校验正确拒收 |
| 模型自己说不清（柜数歧义/连接歧义） | `ambiguous` | questions（**硬阻断**，`IMPORT-OPEN-QUESTIONS` 前置于形状/空判定暴露） |
| 识别不到任何尺寸的柜体 | — | 必答问题（阻断） |

关键架构决策：`validateNormalized` 的 questions 检查**提到形状/空判定之前**——模糊图识别出 0 柜时，用户看到的是"模型问了什么"而不是一个干巴巴的"导入为空"。

### 20.3 验收（实测 2026-09-30）

| 判据 | 结果 |
|---|---|
| `tsc --noEmit` | 无错 |
| `verify:vision`（新建，接入 `verify:all`） | **49 / 49**：多柜/rows/units/组件/组合识别、逐维置信度、不编造断言（内部可见柜不出现"内部隔板不可见"caveat、标注图不出现"视觉估计"caveat）、questions 硬阻断、scale.known 高可信、参考尺寸升格、闭环落库 origin 留痕 + `computeCabinetLayout` 派生几何/净宽可读（2D/3D/DXF/BOM 同源可消费） |
| `verify:ui` | **678 / 678**（新增 B43 共 17 条：导入页签 → Mock 识别 → 3 柜归一化 → caveat 确认门禁编译 → 勾选后编译预览 → 应用回执 + 版本 +4；console error 仍为 0） |
| 全量 node 链（`verify:all` 除 `verify:ui`） | 全部 exit=0（含 `verify:import` 59/59——normalized 扩展向后兼容） |
| 旧断言 | 一条未删、未放宽 |

### 20.4 遗留问题与决策事项

- **真实 Vision API 通路未实测**（本机无可用 key 的视觉模型）：`/api/ai/vision` 路由 + `RemoteVisionProvider` 已按 OpenAI 兼容协议就位，语法校验通过；接通验证与提示词调优留到有 key 环境（gpt-load 网关后挂视觉模型即可，无需改码）。
- **「声明续接 → 系统自动贴合落位」是既有缺口**（非 P5 引入）：编译期 `pickFreeSpot` 基于编译时快照，多动作序列中后建柜看不到先建柜，故声明 butt 必被严格邻接校验拒收。P5 的处理是诚实绕开（组合=纯分组，连接由用户确认后用 P2 既有命令补）；若未来要"AI/Vision 直接声明并排续接"，需在干跑期逐动作推进落位快照——已记为独立架构项，不在 P5 范围内动。
- B43 同时补上了 **P4 的 UI 覆盖缺口**（P4 报告称"导入页签已覆盖"，实测 661 条中并无 ImportPanel 断言——本轮已修正并新增 17 条）。

---

## 21. P6 实施记录：设计知识系统第一版（三层分离）

> commit `a556353`。目标：把「硬规则 / 设计知识 / 用户偏好」从架构上分层，为「根据设计师历史修改持续优化」打地基。不做大模型记忆库。

### 21.1 三层边界与执行体（单一真相源）

| 层 | 内容 | 执行体 | 来源 |
|---|---|---|---|
| Hard Rule | 几何/板厚/五金/结构约束 | **Rules Engine + CommandBus 记忆门**（原有，不在知识层重新实现） | 规则集 + active Correction（引用） |
| Design Knowledge | 「这类衣柜通常怎么做」 | 无 —— 只作 AI 规划参考 | AI 推测 / 归纳 |
| User Preference | 「这个用户习惯怎么做」 | 无 —— 只作 AI 规划参考 | 行为观察（candidate）/ 用户明说（active） |

优先级**确定性**：`hardRule > designKnowledge > userPreference`，由 Resolver 判定，不由 AI 决定。

### 21.2 生命周期（不是"用户改过一次就永久记住"）

```
事实/观察（observeCommand：LogEntry.diff 的有限语义维度）
  → candidate（置信 0.3 起步，同值重复观察合并证据、上限 0.9）
  → 用户在知识面板确认（唯一升级通道）→ active（confidence=1）
  →（可 rejected 撤回）
用户明说（知识面板手动输入 / 「以后都这样」）→ user-stated → 直接 active
```

candidate **永远不进** Resolver 的 applicable —— 没确认的知识不参与规划。

### 21.3 关键组件（src/ai/knowledge/）

| 文件 | 职责 |
|---|---|
| `model.ts` | `KnowledgeEntry`（layer/status/origin/predicate/scope/evidence/confidence/confirmedAt/conflicts）；谓词是**有限集合**（drawerCount/rowHeight/cabinetWidth/cabinetDepth/unitKind/layoutStyle），无谓词的知识只展示不参与冲突检测；不保存 geometry/坐标/DXF primitive |
| `observe.ts` | 修改观察器：吃 CommandBus 的 `LogEntry.diff`（权威 diff，不重新算），只翻译行高/件数/分区类型/柜宽深四类有限语义事实；撤销/系统命令/位置移动/改名不产生知识；观察只产生 candidate |
| `resolver.ts` | 确定性纯函数（验收深比较输入不变）：scope 匹配 → candidate 过滤 → 硬规则压制（数值/枚举冲突检测）→ 同层矛盾暴露。输出 `{applicable, conflicts, suppressed}`，**不产生 Command、不写模型** |
| `store.ts` | JSONL localStorage/内存（与 correctionStore 同模式），键序固定往返逐字节幂等。**不进 project.json**（知识是跨项目用户资产，不背项目往返契约） |
| `digest.ts` | Resolver 结果 → AI system prompt 附加段；明写「硬规则永远优先、方案仍将通过规则校验」；无知识时为空（不注入空段落） |

与 Phase 2 Correction 的关系：Correction 是**拦阻性**记忆（编译成检查挂在 CommandBus 门），Knowledge 是**建议性**知识（供规划参考）。hardRule 层把 active Correction 引用进来做**提前暴露**（提交前告诉 AI/用户会撞硬规则），最终拦截仍由原执行体负责。

### 21.4 冲突处理（以用户原例验证）

硬规则「五金最小净宽 450mm」 vs 用户偏好「我喜欢所有抽屉都做 400」：
偏好被压制（不进 applicable）→ 进 `suppressed` + `conflicts`（kind=`hard-rule-beats-preference`）→ 冲突理由点名双方原文与数值 → AI 的知识摘要里出现「必须遵守硬规则一方，不得绕过」。同层矛盾（两条 active 偏好建议不同值）双方都保留、冲突暴露，AI 不替用户选。

### 21.5 与既有链路集成（不造第二套流程）

`shared/aiContract.buildDesignRequest` 新增可选 `knowledgeDigest`（不破坏既有调用）→ `/api/ai/design` 透传（截断 4000 字）→ AIPanel 生成设计方案时按当前房间注入适用知识。AI 产出仍是 DesignProposal，仍走 validateProposal → dryRunPlan → 确认 → CommandBus。知识不给 AI 任何特权。

### 21.6 UI（轻量验证闭环）

右侧「知识」页签（KnowledgePanel）：分层列表（层/来源/置信/scope/确认状态/冲突）+ 候选「确认生效/拒绝」+ 手动添加偏好 + 「给 AI 的知识摘要」调试段。不做知识管理后台。

### 21.7 验收（实测 2026-09-30）

| 判据 | 结果 |
|---|---|
| `tsc --noEmit` | 无错 |
| `verify:knowledge`（新建，接入 `verify:all`） | **61 / 61**：用户 8 条测试要求逐条覆盖（450 vs 400 真实例子验冲突、同层矛盾、provenance 原话保留、Resolver 深比较不变、观察器负样本：位置/改名/撤销/同值不产生知识、JSONL 往返幂等、digest 空态） |
| `verify:ui` | **686 / 686**（B44 共 8 条：知识页签 → 手动偏好生效 → 卡片标注 → AI 摘要段 → 面板边界声明；console error 0） |
| 全量 node 链 | 全部 exit=0 |
| 旧断言 | 一条未删、未放宽 |

### 21.8 遗留与后续（P6 之后）

- 谓词维度目前 6 种（有限可靠集）。更多维度（分格风格比例、五金品牌偏好等）= 在 `PredicateKind` 加枚举 + `observe.ts` 加翻译 + 冲突检测——扩展点集中，不需要动架构。
- Design Knowledge 目前只有用户观察/AI 推测两个来源，尚无「从案例库归纳」的自动通道（那是后续版本的活）。
- 知识暂为浏览器 localStorage（跨项目用户资产）；多人/多设备同步需上云，属商业化阶段。

---

## 22. P0–P6 架构审查（Architecture Audit / Stabilization）

> 审查目的：P0–P6 收官后建立稳定基线——确认单一真相源、单一写入链路、清晰模块边界仍然成立。只做小修，不做重构，不改稳定行为，不删测试。

### 22.1 逐项审查结论

| # | 审查点 | 结论 | 证据 |
|---|---|---|---|
| 1 | Semantic Model 唯一真相源 | ✅ | 全仓无 `cabinets.push`/直接赋值捷径（core/ 之外零命中）；持久化只有 `serializeProjectFile`→`toFileProject`（authored-only，structuredClone 后仅规范化 layout 形状） |
| 2 | Geometry/Rules/2D/3D/DXF/BOM 确定性派生 | ✅ | `computeCabinetLayout` 单一派生口；relations-acceptance 有"建组合前后 BOM/plan/views 逐字节不变"断言 |
| 3 | AI/Vision/Import/Knowledge 不碰坐标 | ✅ | src/ai 只引只读助手（detectCollisions/pickFreeSpot/layoutModel 折叠）；import/vision 验收断言动作无 `atX/atY`；落位由系统定 |
| 4 | P3/P4/P5 同链 | ✅ | 三条通道全部收口 `dryRunPlan→PlanRunView→commitPlan→bus.execute`；AIPanel×2 / ImportPanel×1 / draftSession 同一 commitPlan |
| 5 | 无第二套写入/提交/编译 | ✅ | `bus.execute` 是唯一写原语；sandbox（planRunner/draftSession）为干跑草稿纸，不落主模型 |
| 6 | rows/assembly/connection/knowledge 无重复语义 | ✅ | 形状判定只在 `layoutModel.ts`；"接不接触"只在 `deriveContacts()`；knowledge 是独立域（建议性），不复制柜体模型 |
| 7 | Hard Rule > Design Knowledge > User Preference | ✅ | `LAYER_RANK` 确定性排序；450 vs 400 用例在 verify:knowledge 压制并暴露冲突 |
| 8 | Resolver 确定性、AI 不能改优先级 | ✅ | 纯函数（验收深比较输入不变）；AI 只收 digest 文本，无任何写路径 |
| 9 | 一次修改不自动升级 | ✅ | observe 只产 candidate；同值重复观察合并证据、置信上限 0.9；唯一升级通道=用户确认 |
| 10 | Vision observed/estimated/authored/uncertainty 语义一致 | ✅ | `source: 'annotation'|'estimate'` + `Confidence` + `notVisible`→caveats/questions 单一口径；annotation 不触发"视觉估计"caveat（验收断言） |
| 11 | Import/Vision 诚实表达不确定 | ✅ | DXF 标 uncertainty（阻断）不静默建柜；模糊图 questions 硬阻断且先于形状判定暴露 |
| 12 | Proposal 与正式模型分离 | ✅ | `ProposalCabinet`/`NormalizedDesign` 独立类型；只有 compile 产出 AiAction 后经 CommandBus 落地 |
| 13 | Preview 与 Commit 同源 | ✅ | 面板持有同一个 `run: PlanRun` 状态，预览渲染它、提交也提交它 |
| 14 | schema/version/migration 无断裂 | ✅ | format 信封 + formatVersion 双版本门；P0 迁移验收逐字节；P4/P5/P6 新增字段全为 additive（origin/caveats 可选，旧读者忽略） |
| 15 | 旧项目兼容 | ✅ | verify:import 断言导入前旧柜一条不少；verify:migration 存量文件不动 |
| 16 | 临时兼容层/重复 helper/dead code | ✅（1 处小修） | 删除 `ids.ts` 的 `slugId`（全仓零引用）；`defaultVariant` 有验收引用（保留）；auth.mjs legacy 哈希解析为有意的密码哈希迁移兼容 |
| 17 | 测试覆盖架构边界 | ✅ | 边界断言在位：动作无坐标、origin 留痕、uncertainty/questions 阻断、Resolver 深比较、观察器负样本（位置/改名/撤销/同值）、关系层字节不变、未登记错误码抛错 |
| 18 | UI 旧入口/旧语义 | ✅ | 全部 16 面板均挂载（RoomsPanel/VariantPanel 在条件分支内渲染）；RightTab 联合类型由 tsc 把关 |
| 19 | 文档与代码一致 | ✅（格式统一） | §15–§21 与实现核对一致（断言数、链路、决策）；标题格式 `## §N`→`## N.` 统一 |
| 20 | 未来扩展点可加性 | ✅ | 真实 Vision：`/api/ai/vision` + RemoteVisionProvider 已就位，gpt-load 挂视觉模型即用；案例归纳：`PredicateKind`/`OBSERVABLE_KINDS` 枚举集中；知识同步：store 函数化（loadKnowledge/saveKnowledge 可换后端）；自动贴合落位：见 §20 决策记录 |

### 22.2 修复记录

1. 删除 `src/core/ids.ts` 的 `slugId()` —— 全仓（src/verify/server/shared）零引用的 dead export。
2. 文档章节标题格式统一（`## §20/§21` → `## 20./21.`，与 §15–§19 一致）。

### 22.3 确认无需修改（易误报项）

- `verify:lan` 不进 `verify:all`：**有意设计**（脚本头写明——它依赖具体局域网机器，并进常驻验收会让"代码对不对"取决于"机器开没开机"）。
- `defaultVariant` 未在 src 业务路径引用：它是方案候选的规范构造器，verify:variants 验收覆盖，保留。
- `compile.ts` 引用几何助手（detectCollisions/nudgeOutOfWalls 等）：这是"系统替 AI 定落位"的执行点，属原则 18 的正例而非越界。
- auth.mjs 的 `legacySalt` 密码哈希解析：账号哈希格式迁移的有意兼容，有注释与测试。

### 22.4 未来架构 Decision（记录，不擅自选择）

| Decision | 现状 | 触发条件 |
|---|---|---|
| D1 自动贴合落位 | 编译期落位快照不含前序动作产物，"声明续接"被严格邻接校验拒收；Vision 走"纯分组+用户确认补连接"诚实绕开 | 若要"AI/Vision 直接声明并排续接"，需干跑期逐动作推进落位快照——动 planRunner 核心，需专门设计 |
| D2 知识多设备同步 | 知识存浏览器 localStorage（JSONL，函数化封装） | 多人/多设备协作时换云存储——接口已收敛，换实现不动调用方 |
| D3 真实 Vision 通路 | 路由+Provider 按 OpenAI 兼容协议就位，未实测（无 key 环境） | gpt-load 网关挂视觉模型即可验证，无需改码 |
| D4 案例库归纳 | Design Knowledge 只有观察/推测两个来源 | 需要批量案例归纳时加第三来源，`PredicateKind` 扩枚举 |

### 22.5 审查时全量测试（2026-09-30）

| 判据 | 结果 |
|---|---|
| `tsc --noEmit` | 无错 |
| 全部 32 个 node verify 脚本（verify:all 全链） | 全部 exit=0 |
| `verify:ui` | **686 / 686**（console error 0，故意 4xx 48 条单独归类） |
| 旧断言 | 一条未删、未放宽 |

---

## 23. P7 实施记录：制造语义第一阶段（Manufacturing Semantics，已完成）

> 目标：在不动 Semantic Model / Rules / Geometry / CommandBus 的前提下，建立"设计语义 → 结构语义 → 制造语义 → Manufacturing Parts → BOM/DXF"的确定性派生链路。制造层**只派生、零写入口**；尺寸单一来源；不能确定性给出的加工诚实标 unverified，绝不脑补。

### 23.1 交付物

| 文件 | 变更 |
|---|---|
| `app/src/core/manufacturing/model.ts` | **新建**。制造语义类型：`ManufacturingPart`（role/category/尺寸/材质/数量/纹向/封边/溯源 `MfgPartSource`/加工 `ManufacturingOperation[]`/warnings/verification/provenance）、`ManufacturingProject`。每条操作带 role/source/confidence/verification 四件套。 |
| `app/src/core/manufacturing/rules.ts` | **新建**。`ManufacturingRuleSet` 与设计规则 `RuleSet` 分层；默认 `mfg_factory_default_v1`：封边来源=`geometry.edge`、背板工艺来源=`semantic.backPanel.method`、五类 unverified 方面显式登记（层板托孔/铰链孔/抽屉五金孔/箱体连接孔/组合连接加工孔）。 |
| `app/src/core/manufacturing/derive.ts` | **新建**。`deriveManufacturing(project, geom, rules, mfgRules)`：纯函数派生。尺寸**只读几何 Panel**（generateProject 已派生的 `CabinetGeometry.panels`），Manufacturing 不重算一个 mm；verified 加工仅封边+背板工艺；其余按角色生成 unverified 操作；authored 组合成员只追加 unverified 组合连接孔备注。 |
| `app/src/core/manufacturing/bridge.ts` | **新建**。三座兼容桥：`manufacturingToPanels`（无损回投影）、`bomFromManufacturing`（BOM 行带 `sourcePanelId` 溯源）、`manufacturingToNeutralExport`（DXF 经制造层出图，输出与旧路径逐字段相等）。 |
| `app/src/export/neutralSheet.ts` | `toNeutralExport` 增加第 5 参数 `panelsOverride?`（兼容参数，旧调用不变）；override 也走 `panelRow` 投影，保证与旧路径 shape 一致。 |
| `app/src/ui/panels/ManufacturingPanel.tsx` | **新建**。只读"制造"页签：统计/全局提示/逐柜制造件卡（尺寸·材质·封边·已确认加工·未确认警示）。零按钮改模型。 |
| `app/src/ui/Toolbar.tsx` / `App.tsx` | `RightTab` 加 `'manufacturing'`，页签按钮 + 按需挂载。 |
| `app/verify/manufacturing-acceptance.ts` | **新建**，32 条断言（§23.4）。 |
| `app/verify/fixhint-acceptance.ts` | 修复一处**基线既有红**（与 P7 无关，干净 worktree 复现在 `84df960`）：`IMPORT-SHAPE` 是形状门/结构矛盾，本无"差多少 mm"概念 → 加入 `NO_NUMBER_OK` 例外集（带 manual 出口），26/0。§22.5"全部 exit=0"对这条不准确，以本轮为准。 |
| `app/package.json` | 新增 `verify:manufacturing`，并入 `verify:all`。 |

### 23.2 关键架构决策

1. **制造尺寸单一来源 = 几何 Panel。** Manufacturing 的长/宽/厚/数量/纹向/材质全部照搬 `CabinetGeometry.panels`，不重算。理由：重算 = 第二份尺寸真相源 =「图上 2400、料单 2399」的结构性风险。制造件 `id` 与几何 `Panel.id` 相等，1:1 可追溯。
2. **verified 白名单极小。** 当前只承认两类 verified 加工：封边（来自几何 `panel.edge`，边位由设计规则定）与背板工艺（来自语义 `cab.params.backPanel.method`）。drilling / connector-hole / groove / hardware-mount 一律 `verification:'unverified' + confidence:'none'`，不产孔位坐标 —— 「不能可靠确定的明确输出 unverified/openQuestion，不脑补」。
3. **Assembly 不自动产生加工。** authored 组合连接只给成员件追加 unverified 的「组合连接加工孔」操作与 `MFG-ASSEMBLY-CONN-UNVERIFIED` 级提示，绝不生成 verified 孔。
4. **兼容桥而非重写 exporter。** DXF/BOM 继续消费既有出口：制造件无损回投影为几何 Panel（字段全保留）→ 经 `panelsOverride` 进中立导出。验收钉死「经制造层的 DXF panels 与旧路径逐字段相等」—— 图 = 料 不变。
5. **制造规则独立分层。** `ManufacturingRuleSet`（工厂工艺口径）与 `RuleSet`（设计约束口径）分开；派生结果 `provenance` 同时带两个 ruleSetId，交付三件套口径不变。
6. **UI 零写入口。** 制造页签只读；这把「Manufacturing 不得成为新写入入口」摆到界面上。

### 23.3 真实闭环（同源验证）

选稳定柜型跑完整链：Semantic Model → `generateProject` → `deriveManufacturing` → 2D / 3D / BOM / DXF / Manufacturing Parts 五个出口。验收断言：制造侧板长 === 几何 bodyH === 3D 体块高度之一；BOM 行 `sourcePanelId` === 制造件 id === 几何板件 id；DXF 经制造层与旧路径逐字段相等 —— 五出口同源于一个 Semantic Model。

### 23.4 验收判据（verify:manufacturing，32 条）

确定性（同输入两次派生 JSON 逐字节相等）；数量（板件数===制造件数===BOM 行数）；尺寸一致+溯源；多行柜角色/行隔板/行溯源（rowId 回指正确行）；未验证不脑补（无坐标类字段、封边/背板 verified 带来源）；组合不自动 verified 但标 unverified；BOM 来源一致；DXF 经制造层与旧路径逐字段相等；改柜宽重派生（顶板长变化量===改量、侧板不变）；真实闭环五出口同源。

### 23.5 限制与扩展点

- **不做**（按 P7 边界）：CNC 完整支持、工厂定制、自动排版/套料、复杂五金库、AI 决定工艺、重写 DXF、重构 Semantic Model。
- **扩展点已留**：`MfgOperationRole` 枚举（groove/hardware-mount/machining 已占位）；未来排孔/套料加枚举+对应 derive 规则即可，不动几何与 Semantic Model；真实孔位需先在 `ManufacturingRuleSet` 给出可判定规则，才允许 unverified → verified。

### 23.6 P7.1 实施记录：制造规则硬化 + 测试完整性（Manufacturing Rule Hardening + Test Integrity，已完成）

> 基线 `2552072`（P7 已验收，本阶段不动 P7 任何既有逻辑、不进 P8）。
> 目标：① 堵住「`num()` 缺值兜底 0」类假绿（缺失值必须显式说"无法识别"，绝不表述成 0）；② 系统梳理 `ManufacturingRuleSet → ManufacturingOperation → verification` 的 verified/unverified/unsupported 分类并写明 verified 升格条件；③ 实现第一条**真实**制造规则（层板托孔），全链路确定性、不脑补坐标；④ 明确本阶段边界（不做完整五金库/CNC/套料/AI 直出坐标/P8）。

#### 23.6.1 交付物

| 文件 | 变更 |
|---|---|
| `app/src/core/rules/issueCatalog.ts` | 新增两个工具函数：`numOrUndef(c,key)`（缺值/非数返回 `undefined`，与兜底 0 的 `num` 区分）；`countText(c,key)`（真有数→"N 个"，缺失→"数量无法识别（数据缺失或非数组）"）。IMPORT 家族五条（EMPTY / OPEN-QUESTIONS / UNCERTAINTY / LOW-CONFIDENCE / CAVEAT）的"缺失"分支统一走 `countText`，**绝不说"0 个/0 项"**。确立项目级口径：外部数据带进来的数量一律 `numOrUndef`，只有本系统算出的确定尺寸差才用 `num`。 |
| `app/src/core/manufacturing/model.ts` | 新增 `MfgDrillHoles`（结构化孔位：`reference:'cabinet-inner-bottom'` / `elevations[]` / `holesPerElevationPerSide` / `insetFrontMm` / `insetBackMm`）。`ManufacturingOperation` 增加 `source` 枚举值 `'deterministic.shelfElevations'` 与可选 `holes?: MfgDrillHoles`（**仅 verified 钻孔填，unverified 不填坐标**）。 |
| `app/src/core/manufacturing/rules.ts` | 新增 `MfgShelfPinRule`（`enabled` / `source:'deterministic.shelfElevations'` / `holesPerElevationPerSide` / `insetFrontMm` / `insetBackMm`）；`ManufacturingRuleSet` 增加 `shelfPins` 字段；`DEFAULT_MANUFACTURING_RULES.shelfPins = {enabled:true, 2, 37, 37}`；从 `unverifiedAspects` 移除「层板托孔」（已升格 verified），保留铰链孔/抽屉五金孔/箱体连接孔/组合连接加工孔 4 项。注释写明 verified 升格四条件。 |
| `app/src/core/manufacturing/derive.ts` | `shelfPinOps(cab,g,mfgRules)`：从 `g.layout.rows` 收集带 `shelves` 分区的 `equalSpacing(row.netH, count)` 标高（基准 `innerBottomZ = bodyLift + boardT`，柜内底），去重排序，生成 verified 钻孔并填 `holes`。`buildPart` 加 `g` 参数，侧板（Left/Right）挂 verified 托孔；`unverifiedOps` 移除 ShelfPanel 的未确认托孔（托孔已升格到侧板）。 |
| `app/verify/fixhint-acceptance.ts` | `NUM_CTX` 增加 5 条 IMPORT 家族（带真实 `count` 值）；`NO_NUMBER_OK` 例外集扩展纳入 5 条 IMPORT 码；新增 **C2 Test Integrity** 段：字段缺失时消息含"无法识别/缺失"且**不含**"只有 0 项/0 个/0 处/0 个柜体"。26 → 27 条。 |
| `app/verify/manufacturing-acceptance.ts` | `⑫ 层板托孔` 段：侧板 verified 托孔、样本柜存在 shelves 触发、标高逐值===几何 `equalSpacing` 集合、横向留量来自 `DEFAULT_MANUFACTURING_RULES.shelfPins`、无 shelves 柜不钻、`shelfPins.enabled=false` 不钻。32 → 39 条。 |

#### 23.6.2 ManufacturingRuleSet 分类（本阶段定稿）

| 加工 | 现状 | verification | 升格 verified 的条件 |
|---|---|---|---|
| 封边 edge-banding | 来自几何 `panel.edge` | **verified** | 几何边位存在即确认（设计规则定边位） |
| 背板工艺 back-panel-treatment | 来自语义 `backPanel.method` | **verified** | 语义字段给出 groove/inset |
| **层板托孔 shelf-pin holes** | 几何 `equalSpacing` 标高 + 工厂留量 | **verified（P7.1 新增）** | ① `shelfPins.enabled`；② 柜体有 `shelves.count>0`；③ 标高全来自几何 equalSpacing（不重算不猜）；④ 横向留量来自制造规则（工厂参数） |
| 铰链孔 hinge boring | 语义未携带 | unverified | 需工厂排孔方案 + 语义携带孔位（unverified → verified） |
| 抽屉五金安装孔 | 语义未携带 | unverified | 同上 |
| 箱体连接孔（三合一/木榫） | 语义未携带 | unverified | 需制造规则给出可判定连接孔方案 |
| 组合连接加工孔 | authored 组合声明 | unverified | 经制造规则确认（绝不自动生成 verified） |

**铁律**：verified 只能来自确定性可验证的制造规则（几何/语义已派生的确定事实）。AI / Vision / Import **绝不**输出孔位坐标，孔位坐标只能由确定性规则从几何派生；信息不足则保持 unverified，不污染 Semantic Model、不建第二尺寸计算体系、不把制造规则塞进 Geometry/CommandBus。

#### 23.6.3 测试完整性纪律（项目级一致口径）

- 真 0 与 `undefined`/`missing`/`unknown` 必须区分：`num()`（兜底 0）只用于"本系统已算出的确定尺寸差"；外部数据带进来的数量一律 `numOrUndef`，缺失显式报"无法识别"。
- 不删旧测试、不放宽旧断言、`numOrUndef` 让"字段缺失"显式浮出而非静默变 0。
- 验收判据精确到"因对的原因失败"：C2 段对 5 条 IMPORT 码在 ctx 缺 `count` 时构造，断言消息含"无法识别/缺失"且**不含**"0"。

#### 23.6.4 验收结果（P7.1）

- `tsc --noEmit`：0 错。
- `verify:manufacturing`：39/39（⑫ 新增 7 条全过）。
- `verify:fixhint`：27/27（C2 新增段全过）。
- `verify:all`（node + UI）：全绿，console 0，未减少测试覆盖、未放宽断言（详见 §23.6.5 全量回归记录）。
- 架构边界全部保持：Semantic Model 唯一真相源；Geometry/Rules 确定性计算；Manufacturing 只读派生层；AI/Vision/Import 语义理解层；无第二尺寸真相源；Manufacturing 不回写 Semantic Model；未改 CommandBus/设计规则/几何真相。

#### 23.6.5 仍存架构边界（本阶段未做，留待后续阶段）

- 不做：完整五金库、铰链全套、三合一全套、抽屉五金库、CNC、套料排版、自动优化、AI 直出坐标、自动 Placement、P8。
- 4 类 unverified 加工（铰链/抽屉五金/箱体连接/组合连接）仍诚实标 unverified，待真实工厂规则接入后逐项升格。
- 本阶段停在 P7.1，未自动进入 P8。

### 23.7 P7.2 实施记录：制造规则架构审查 + 层板托孔硬化（Manufacturing Rule Architecture Review + Shelf Pin Rule Hardening，已完成）

> 基线 `0ec9c77`（P7.1 已验收）。本阶段**不新增任何 verified 加工**（铰链孔/三合一/木榫/背板槽等仍 unverified），目标是**验证 P7.1 建立的 Manufacturing Rule 架构是否真的足以承载后续真实制造规则**，并把边界钉死，而非继续堆功能。

#### 23.7.1 层板托孔规则的性质判定（审查结论 ①）

- `equalSpacing()`（位于 `allocate.ts`）是**几何辅助算法**——生成器/视图/3D 用它把层板摆到这些高度，**它并不是制造规则**。
- 层板标高（孔位 Z）是**几何事实**：层板物理上就坐在这些高度。
- 因此 `shelfPinOps` 这条规则做的是「在层板标高处钻孔」这个**确定性工艺决策**，由三部分组成：
  1. **标高（位置）** = 读几何事实（基准 `innerBottomZ = bodyLift + boardT`，与生成器 `edgeLabel`「距柜内底 Nmm」同源）；制造层**只读、不另算一份布局**，不产生第二尺寸真相源；
  2. **孔型参数**（holesPerElevationPerSide / insetFrontMm / insetBackMm）= **本规则的工厂参数**，来自 `mfgRules.shelfPins`，不是几何、不是语义；
  3. **「是否钻」的决策**（enabled + 本柜存在带 shelves 的分区）= 规则的确定性触发条件。
- **判定**：当前实现是**名副其实的确定性层板托孔制造规则**（满足 verified 9 条），不是临时占位算法——前提是必须清楚「`equalSpacing` 是几何事实的载体、而非规则本身」。已在 `allocate.ts` 与 `rules.ts`/`derive.ts` 注释中明确这一分类，避免后续把几何辅助误读成工厂规则。

#### 23.7.2 架构可扩展性（审查结论 ②）

- `buildPart` 原对每条 verified 规则写一处 `if/else` 调用。本阶段改为 **`VERIFIED_RULE_EVALUATORS` 注册表**（`derive.ts`）：每条真实制造规则 = 一个纯函数 evaluator（`edgeBandingOps` / `backPanelOps` / `shelfPinOps` …），统一签名 `MfgRuleEvalCtx`，列表式 `flatMap` 派发。
- **新增一条规则（铰链孔 / 三合一 / 木榫 / 背板槽）的扩展路径已固定且最小**：① 在 `rules.ts` 加接口 + `DEFAULT_MANUFACTURING_RULES` 默认；② 在 `derive.ts` 加一个纯函数 evaluator（自己判断适用面、只读几何/语义/规则）；③ 在 `VERIFIED_RULE_EVALUATORS` 注册。不必在 `buildPart` 堆针对加工类型的 `if/else`。
- 每个 evaluator **必须自判适用面**（例如 `shelfPinOps` 内判 `role === 'LeftSidePanel'|'RightSidePanel'`、`backPanelOps` 内判 `role === 'BackPanel'`）——注册表对每块板都会调用它，不能依赖调用方过滤。本阶段最初漏掉自判导致 ShelfPanel/每块板都被错误挂上托孔，**被既有 ⑥ 测试捕获**，已修正。
- **未过度设计**：未引入抽象基类/工厂模式；注册表 + 统一 ctx 已是满足"可扩展且不堆 if/else"的最小结构。

#### 23.7.3 verified 升格 9 条标准（审查结论 ③，已落代码+测试）

- `rules.ts` 新增导出常量 `VERIFIED_PROMOTION_CHECKLIST`（9 条）：① 输入语义事实明确 ② 制造规则确定 ③ 参数来源明确 ④ 加工结果可确定性推导 ⑤ 不依赖 AI ⑥ 不依赖 Vision ⑦ 不依赖 Import ⑧ 不产生第二尺寸真相源 ⑨ 可被自动化测试验证。
- 必须**同时满足全部 9 条**才标 `verified`；否则保持 `unverified`（当前规则无法确认）或 `unsupported`（本阶段不支持）。
- `shelfPinOps` 增加**参数合法性闸门**：`holesPerElevationPerSide < 1` 或任一只留量非数/为负 → 视为「工厂参数未就绪」，降级为 `unverified`（detail 明说"参数非法，需工厂校准"），**绝不补默认值、绝不脑补坐标**。

#### 23.7.4 层板托孔测试硬化（审查结论 ④，新增 §13，39 → 62 条）

`verify:manufacturing` 新增 **§13 层板托孔规则硬化**，证明规则"正确"而非只证明"有孔位"：

- 结构性判据：verified 坐标加工 `source` 绝不来自 `manufacturing-rule:unverified`；unverified 加工绝不携带 `holes`（不脑补坐标）；verified 钻孔必有结构化坐标。
- 不同柜高（1800/2400/3000）：标高随之变化且逐值 === 几何 `equalSpacing`。
- 多行柜：仅带 shelves 的行贡献标高（挂衣行不钻）；双行都带 shelves → 两行标高合并。
- 不同 `shelfPins` 参数（1/3 孔、20/50mm 留量）：孔型参数逐字段反映，标高不变（参数不影响位置）。
- 边界高度（矮柜 700）：标高皆为正且 ≤ 侧板长（物理合理、单一来源）。
- 参数缺失 / 参数非法（holes=0 / inset 为负）：降级 unverified，不产生 verified 托孔。
- 不应打孔：无 shelves 语义的柜（open / drawerBank）→ 侧板不钻。
- 左右侧板来源：两侧板都带 verified 托孔且标高一致；层板自身不钻。
- 制造尺寸与 Geometry Panel 一致（侧板长 === 几何侧板长）、provenance 正确、托孔标高 ≤ 侧板长（无第二尺寸真相源）。

#### 23.7.5 尺寸真相源复核（审查结论 ⑤）

- Manufacturing 全程只读 `CabinetGeometry` 的 Panel 尺寸与 `g.layout`（行净高/标高/Z）。`shelfPinOps` 的标高由 `g.layout.rows` 的 `equalSpacing` 派生，与生成器放层板用**同一公式、同一几何输入**——属"读几何事实"，不是"重算一份尺寸"。
- 制造件长/宽/厚/数量逐字段 === 几何 Panel（§④ 断言钉死）。Manufacturing 不回写 Semantic Model。
- 已知边界（留待 P8+，非本阶段问题）：当前 shelves 语义仅 `count`（等分布局），故 `equalSpacing` 与几何一致；若未来支持"自定义层板位置"，应让几何直接暴露层板标高结构化字段、制造层读取，而非各自算——已在 `derive.ts` 注释标注。

#### 23.7.6 本阶段明确不做（⑥）

- 禁止主动扩展：铰链孔 verified、三合一 verified、木榫 verified、抽屉五金、完整五金库、CNC、套料、自动优化、自动 Placement、P8。
- 审查发现需调整的基础设施已做最小必要修改（注册表派发 + 参数闸门 + 注释分类），未引入新功能。

#### 23.7.7 验收结果（P7.2）

- `tsc --noEmit`：0 错。
- `verify:manufacturing`：62/62（§13 新增 23 条全过；§12 及 P7 旧断言全部保留、未放宽）。
- `verify:fixhint`：27/27（Test Integrity C2 保留）。
- `verify:all`（node + UI）：全绿，console 0，未删测试、未放宽断言。
- 架构边界全部保持。

#### 23.7.8 对下一阶段（P7.3+）的建议

- 升格铰链孔/三合一/木榫时，**复用本阶段的注册表 + `MfgRuleEvalCtx` + 参数闸门 + §13 测试模板**，按"几何事实(位置) vs 工厂参数(孔型)"二分法拆解每条规则。
- 每条新规则落地前先回答：孔位标高从哪个几何事实读？孔型参数是哪个工厂参数？语义事实是否明确？九条是否全满足？任一不满足 → 先保持 unverified。
- 建议下一阶段优先做**箱体连接孔（三合一/木榫）**：其"位置"可由几何板件边/中板交点确定性派生（类似层板托孔的几何事实法），最易走通"几何事实 + 工厂参数"范式；铰链孔则需语义携带铰杯位置或工厂排孔方案，依赖更强，建议稍后。
- 本阶段停在 P7.2，未自动进入 P7.3 / P8 或其他阶段。

### 23.8 P7.3 实施记录：箱体连接孔 Manufacturing Rule（Case Connector Holes，已完成）

**基线 `a867f98`（P7.2 已验收）。本阶段目标：实现箱体连接孔（三合一 / 木榫），复用 P7.2 建立的「几何事实(位置) + 工厂参数(孔型)」范式与 `VERIFIED_RULE_EVALUATORS` 注册表。停在 P7.3，不进 P7.4 / P8。**

#### 23.8.1 先审查现有模型（确认孔位可确定性推出）

自主审查 `Panel / Geometry / Cabinet / Unit / Row / FurnitureAssembly / Connection / relations.ts / ManufacturingRuleSet / VERIFIED_RULE_EVALUATORS`：

- `Panel` 不带世界坐标、无板↔板接触图；`relations.ts` 仅提供柜↔柜接触（`deriveContacts`），无板件级接触图。
- 但**箱体外壳主连接（侧板 ↔ 顶/底板）拓扑由板件 role 直接判定**：标准 carcass 永远存在左/右侧板与顶/底板，连接关系不依赖运行时几何求解，是确定性结构事实。
- 进深维 = `panel.width`（每片外壳板 `width = p.depth`，侧板与顶/底板共享同一进深）→ 无第二尺寸真相源。
- 结论：**孔位可完全在「板件自身边 + 沿边位置（沿进深、从背面 Y=0 量起）」表达**，无需柜体世界坐标、不产生第二尺寸。这是本阶段能严格证明的子集，符合用户「只做确定性最强的一种连接方式」。

#### 23.8.2 实现哪种连接加工（最可证明子集）

仅 **箱体外壳主连接**（侧↔顶/底、顶/底↔侧）升格 verified，支持两种孔型：

- **三合一（cam-lock）**：`caseConnectors.type: 'cam-lock'`（默认，孔径 15 / 孔深 13 / 每边 2 孔 / 配对加工）。
- **木榫（wood-dowel）**：`caseConnectors.type: 'wood-dowel'`（位置算法相同，仅 `holeType` 与工厂参数不同）。

**verified 边界**：`role ∈ {LeftSidePanel, RightSidePanel, TopPanel, BottomPanel}`。
**unverified 边界（诚实留待真实规则，不伪造语义 / 不脑补坐标）**：中立板 / 行隔板 / 中板 / 背板的连接孔、柜↔柜组合连接（assembly connector machining）。`unverifiedAspects` 已同步更新措辞。

#### 23.8.3 几何事实 vs 工厂参数（严格二分）

- **位置 = 几何事实**：连接边由 role 拓扑决定（`CONNECTOR_EDGES`：侧板钻 top+bottom 边，顶/底板钻 left+right 边）；沿边位置由进深 `panel.width` 经 `edgeHolePositions(depth, endMargin, count)` 派生（1 孔=中点；2 孔=两端留量；≥3 孔=两端留量 + `equalSpacing` 内插）。该助手是**工厂留量作用于几何进深的制造间距**，非几何事实、非第二尺寸源。
- **孔型 = 工厂参数**：`holeType / diameterMm / depthMm / endMarginMm / holesPerJoint / pairMachining` 全部来自 `mfgRules.caseConnectors`（`source: 'deterministic.caseConnectors'`）。
- Manufacturing 仍只读派生层（Panel），不重算 `width`/尺寸、不回写坐标、不创造新语义。

#### 23.8.4 注册表架构（不堆 if/else、不重构几何）

- `derive.ts` 新增纯函数 `caseConnectorOps(ctx)`：自判适用面（role 命中 `CASE_CONNECTOR_ROLES` 才处理）、参数合法性闸门（`holesPerJoint<1` / `endMarginMm` 非数或 ≥ 进深 / `diameterMm` 非正 / 规则未启用 → 降级 unverified，不补默认不脑补）。
- 直接注册进既有 `VERIFIED_RULE_EVALUATORS`（现 4 项：edgeBandingOps / backPanelOps / shelfPinOps / caseConnectorOps）。
- `unverifiedOps(role, inAuthoredAssembly, mfgRules)` 增加 `mfgRules` 参数：外壳主连接被 verified 覆盖时跳过 unverified 箱体连接孔，其余结构板仍标 unverified 箱体连接孔。
- **无需新抽象、无需重构 Geometry 系统**，满足「不重新堆 if/else」要求。

#### 23.8.5 模型与规则扩展

- `model.ts`：`ManufacturingOperation` 加 `connectorHoles?: MfgConnectorHoles`（`holeType`、`diameterMm`、`depthMm`、`pairMachining`、`lines: MfgConnectorHoleLine[]`）；`MfgConnectorHoleLine` 含 `edge`、`positions:number[]`（沿进深、从背面 Y=0 量）、`joint`、`withPanelRole`。仅 verified 填，unverified 不填。
- `rules.ts`：新增 `MfgCaseConnectorRule`（带 `source:'deterministic.caseConnectors'` 与 VERIFIED_PROMOTION_CHECKLIST 注释）；`DEFAULT_MANUFACTURING_RULES.caseConnectors` = `{enabled:true, type:'cam-lock', endMarginMm:37, holesPerJoint:2, diameterMm:15, depthMm:13, pairMachining:true}`。

#### 23.8.6 验收结果（P7.3）

- `tsc --noEmit`：0 错。
- `verify:manufacturing`：101/101（§12 7 + §13 23 + **§14 新增 39**：A 结构性 / B 三合一 verified（侧顶底、边=top+bottom/left+right、孔位=37/563、provenance、工厂参数）/ C 木榫（位置同算法）/ D 不同进深 500/600/700 孔位随之变 / E 不同板厚 15mm 位置不变（只依赖进深）/ F 参数变体只改制造参数 / G 多行柜（侧板 verified、行隔板 unverified）/ H 多柜组合（外壳 verified、组合连接 unverified）/ J 参数缺失非法降级 / K 非连接板无孔 / L 左右一致+几何一致+provenance+不改模型）。§⑥ allowed source 白名单扩展 `deterministic.caseConnectors`（合规，非放宽）；§⑦ 改判「组合连接」专指柜↔柜、排除外壳连接。
- `verify:fixhint`：27/27（Test Integrity 保留）。
- `verify:all`（node + UI）：**686/686 通过、0 失败、console 0**，未删旧测试、未放宽旧断言。
- 原层板托孔（§13）与封边/背板（§12）验收全部继续过。

#### 23.8.7 本阶段明确不做（避免过度扩展）

铰链孔、抽屉五金、完整五金库、CNC / 套料 / 自动优化 / 自动 Placement、P8；不重构 Geometry 系统；中立板/行隔板/中板/背板连接与组合连接孔保持 unverified（待真实规则，不伪造坐标）。

#### 23.8.8 核心文件

- `app/src/core/manufacturing/model.ts`（MfgConnectorHoles / MfgConnectorHoleLine）
- `app/src/core/manufacturing/rules.ts`（MfgCaseConnectorRule / DEFAULT_MANUFACTURING_RULES.caseConnectors / unverifiedAspects 措辞）
- `app/src/core/manufacturing/derive.ts`（caseConnectorOps / VERIFIED_RULE_EVALUATORS 注册 / unverifiedOps 加 mfgRules / edgeHolePositions / CASE_CONNECTOR_ROLES / CONNECTOR_EDGES）
- `app/verify/manufacturing-acceptance.ts`（§14 新增 39 条）

#### 23.8.9 对下一阶段（P7.4+）的提示

- 升格中立板/行隔板/中板/背板连接孔与组合连接孔时，须先有确定性位置事实（行隔板 Z 已是几何事实，但连接孔数/配对/与邻板关系尚无规则）→ 任一语义不充分则保持 unverified。
- 铰链孔依赖更强（需铰杯位置或工厂排孔方案），建议仍置后。

- 本阶段停在 P7.3，未自动进入 P7.4 / P8 或其他阶段。

### 23.9 P8.1 实施记录：确定性落位基础设施（Deterministic Placement Foundation，已完成）

**基线 `67f6764`（P7.3 已验收）。本阶段目标：建立 `PlacementIntent → 确定性 Placement Engine → 可验证的空间位置` 的纯函数基础设施。成功标准不是"AI 能自动摆完房间"，而是系统第一次拥有可靠、纯函数、可验证、可回滚的确定性空间落位底座。停在 P8.1，不进 P8.2 / P8.3。**

#### 23.9.1 审查结论：空间位置的 canonical source 已经存在

动手前自主审查了 Semantic Model / FurnitureAssembly / Connection / relations.ts / Geometry / CommandBus / DesignProposal / Import / 2D·3D 视图：

- **canonical source = `Cabinet.placement { x, y, rotation }`**（types.ts）：柜体背面左角的世界坐标 + 绕该点逆时针旋转角（deg）。唯一写入口 CommandBus 的路径白名单（cabinet.move / rotate / resize / moveBatch / assembly.move）。
- **坐标系**：世界是 2D 平面图（mm）；柜体局部 +X 沿宽（左→右）、+Y 沿进深（背面→正面）；高度不在 placement 里（`stack` 因此仍未验证——模型没有 Z）。足迹 = `rectPts(0,0,W,D)` 经 `localToWorld`（90° 三角吸附在 transform.ts，全项目唯一旋转实现）。
- **2D / 3D 天然同源**：`generateProject` 一次派生同时产出 plan 图元（2D）、四视图与 bodies3d 体块（3D），都经 `getCabinetFootprint` 消费同一 placement。
- **Placement ≠ Assembly 已分离**：FurnitureAssembly/Connection 只声明"谁和谁一组、怎么连"（无坐标）；落位由 placement 表达。本阶段不混用。
- **既有先例**：snapPlace.ts 的 `placeAgainstNearestWall / candidateSpots / joinSpots / nudgeOutOfWalls` 都是"纯函数产候选 + `detectCollisions` 唯一判据"的范式——P8.1 沿用同一态度。
- **缺口**：系统有"绝对坐标"与"自动找空位"，但没有**关系式落位**（贴着谁、对齐谁）的语义表达与确定性解析——这正是本阶段补的最小一层。

结论：不新造坐标真相源、不把 x/y 塞进 Geometry；新增的是"语义意图 → 解析 → 经 CommandBus 写回 placement"的管道。

#### 23.9.2 PlacementIntent 模型（core/placement.ts）

封闭词汇表，三种关系（`attach/touch` 并入 `adjacent`——面贴合就是同一个语义，不设第四个同义词）：

- **`absolute`**：authored 显式坐标（用户拖动 / 属性面板 / 既有 `cabinet.move` / MCP 显式输入）。`origin: 'authored'` 是**必填**字段——没有"缺省当授权"这回事；引擎只做校验 + 整数取整，不做解析。
- **`adjacent`**：target 贴在 reference 的 `side`（left/right 并排、front/back 前后叠）一侧，面贴合零缝隙；`alignment` 控制共享轴（并排缺省背面齐 back、前后叠缺省左缘齐 left，可给 front/center 等）。
- **`align`**：只动一条轴与 reference 的指定边缘齐平（left/right/front/back），`center` = 包围盒中心重合。

**authored 与 resolved 在类型层分开**：`origin:'authored'` 只存在于 absolute 分支；AI 新接口（cabinet.place / 方案 placement）在类型与契约上就没有坐标字段。

#### 23.9.3 Resolver / Engine 结构（纯函数）

```
sceneFromProject(project) → PlacementScene（id/x/y/rotation/width/depth，只读快照）
PlacementIntent → validateIntentShape → resolvePlacement(intent, scene) → ResolvedPlacement（整数 mm）
resolvePlacements(intents, scene) → 依赖拓扑排序 → 全成或全不成（批量原子）
```

- **算法**：相邻/对齐全部表达为**位移增量**（平移原点必平移包围盒，对任意 rotation 成立，不需要分角度讨论）；包围盒用与 `getCabinetFootprint` 同一套变换原语（不写第二份旋转实现）。
- **批量解析**：意图的 reference 若也在本批重摆，必须用其解析后的新位置（Kahn 稳定拓扑序，同为就绪按输入序）；成环 → 结构化 `PLACEMENT-CYCLE`（列出涉及柜体），绝不按数组顺序碰运气。
- **结构化错误**（绝不静默回退到 (0,0,0)）：`PLACEMENT-TARGET-NOT-FOUND / REFERENCE-NOT-FOUND / SELF-REFERENCE / CYCLE / GEOMETRY-MISSING / SIZE-INVALID / INTENT-INVALID / UNRESOLVED`，每条 message 带具体 id 与数量。
- **纯函数纪律**（验收证明）：同输入同输出；不改 scene、不改 Project、不改 intent；无随机无时钟；输出整数 mm。

#### 23.9.4 支持与不支持的关系

**支持**：absolute（authored）/ adjacent（4 向 × 3 对齐）/ align（5 种）。这是现有几何事实（足迹包围盒 + 语义参数宽深）能**确定性**计算的全部子集。

**暂不支持及原因**：
- **绕障自动摆放 / 碰撞优化 / 自动吸附**：属于 P8.2+；本阶段解析失败/撞墙由既有 `detectCollisions` + planRunner strict 模式诚实拒绝，不悄悄挪。
- **贴墙（wall-referenced placement）**：参照物目前只支持柜体；墙参照需要墙法线/内表面语义，留待真实需求。
- **挂墙高度 / Z 轴（stack 落位）**：模型没有 Z，与 P2 的 `ASSEMBLY-STACK-UNVERIFIED` 同一条边界。
- **旋转自动求解**（"贴着 L 角自动转 90°"）：相邻/对齐保留 target 当前 rotation；rotation 是独立语义意图（cabinet.rotate / create.rotation），不替用户猜。

#### 23.9.5 CommandBus / Proposal 接入（不绕唯一写入口）

- **新命令 `cabinet.place`**：路径白名单 `placement.(x|y|rotation)`，**一条命令原子写入**三个字段（move+rotate 两条命令会产生"转了没挪"的中途态）；diff/inverse/undo/夹紧全部复用既有路径机制。坐标的"算"在引擎（纯函数），命令词汇表只管"把算好的值安全写进去"。
- **AI 动作 `cabinet.place`**（契约 ACTIONS 注册，`buildSystemPrompt` 自动枚举）：参数只有 `relation/reference/side/alignment`——**没有坐标参数**（结构性保证）。编译器在沙盒当前状态上调用引擎解析，产物是带具体整数坐标的命令；relation=absolute 直接拒收（绝对坐标是授权输入）。
- **DesignProposal 扩展**：`ProposalCabinet.placement { relation, reference, side?, alignment? }`——方案里永远不出 x/y（形状门显式拒收坐标字段）。编译顺序：**全部 create 之后**统一发 place 动作（`$ref:` 那时才换得出真 id），place 之间按参照依赖排序；planRunner 的 `$ref` 替换扩展到 `action.target`。缺省对齐写进 notes（系统替模型按惯例取了什么，界面必须显示）。
- **方案级静态校验**（新增 PROPOSAL-PLACE-* 六码）：关系不认识 / 参照不存在 / 自参照 / 缺 side / 对齐与方向不匹配 / **成环**（成环必须在方案期拦下——放过去的话执行期两条各自都能"解析成功"，结果取决于执行顺序）。文案全部带数字（第几个柜体 / 几种取值 / 几个成环），过 fixhint B 检查。

#### 23.9.6 Geometry / 2D / 3D 接入

零改动、同源消费：落位经 CommandBus 写进 placement → `generateProject` 单次派生同时更新 plan 图元与 bodies3d 体块（验收 §7 断言两者位移一致）。DXF 本阶段不接（走既有导出管线读 placement，无新增接入点，后续接入点即 neutralSheet/export 家族，无需改动）。

#### 23.9.7 核心文件

- `app/src/core/placement.ts`（新增）：PlacementIntent / ResolvedPlacement / sceneFromProject / resolvePlacement / resolvePlacements / 结构化错误码
- `app/src/core/commands.ts`：`placeCabinet()` 命令构造器
- `app/src/core/commandBus.ts`：WRITABLE 加 `cabinet.place`
- `app/src/core/rules/issueCatalog.ts`：PROPOSAL-PLACE-RELATION / -REF / -SELF / -SIDE / -ALIGNMENT / -CYCLE 六码
- `app/src/ai/proposal.ts`：ProposalPlacement + 语义校验（含静态成环检测）
- `app/src/ai/compileProposal.ts`：create 后按依赖序发 place 动作 + 缺省对齐 notes
- `app/src/ai/compile.ts`：case 'cabinet.place'（解析在编译期对沙盒状态执行）+ COMPILED_ACTIONS 登记
- `app/src/ai/planRunner.ts`：`$ref:` 替换扩展到 action.target
- `app/shared/aiContract.mjs`：ACTIONS['cabinet.place'] + proposalShape 拒收坐标字段
- `app/verify/placement-acceptance.ts`（新增）+ `verify/ai-acceptance.ts`（A3 最小样例补一行）+ package.json（verify:placement 接入 verify:all）

#### 23.9.8 验收结果（P8.1）

- `tsc --noEmit`：0 错。
- `verify:placement`（新增）：**82/82**（§1 基础 20 + §2 连续落位 4 + §3 错误 13 + §4 纯函数 6 + §5 CommandBus 8 + §6 Proposal 链路 27 + §7 2D/3D 同源 3）。
- `verify:manufacturing`：101/101；`verify:fixhint`：27/27（新码文案带数字，未放宽任何旧断言）。
- `verify:ai`：全绿（A1/A3 证明契约与编译器无漂移）。
- 全量 `verify:all`（node + UI）：**VERIFY_ALL_EXIT=0**，UI 686/686、零 console error，未删旧测试、未放宽旧断言（proposal-acceptance 的 G 断言按 P8.1 演进：从"禁 placement 一词"升级为"精确禁坐标 atX/atY/position* 与裸 x:/y: 字段"，并**新增**"形状门拦 placement 夹带 x"断言——语义落位意图无坐标的结构性证据反而更强了）。
- 中途抓到的真缺陷（测试的价值证明）：compileProposal 的 `$ref` 判据最初只查"参与落位的柜"，参照指向**不参与落位**的方案内柜时占位符漏生成，执行期按名字找不到本轮刚建的柜——placement 验收的 §6 首轮抓出并修复。

#### 23.9.9 对下一阶段（P8.2+）的提示

- 底座已备：新关系（如贴墙、对齐房间中心）= 在 placement.ts 加封闭枚举 + 纯函数分支 + 契约/方案校验各一条，链路其余部分零改动。
- 自动碰撞优化 / 全屋布局属 P8.2+；判据仍只有 `detectCollisions` 一份，候选生成方可复用 snapPlace 的候选+过滤范式。

- 本阶段停在 P8.1，未自动进入 P8.2 / P8.3 或其他阶段。

### 23.10 P8.2 实施记录：语义面接触落位（Semantic Attach / Contact Placement，已完成）

**基线 `4290a3a`（P8.1 已验收）。本阶段目标：把"空间相邻"提升为"明确的面接触关系"——`AttachIntent → 确定性面/接触解析 → ResolvedPlacement`。attach 不是 `adjacent + gap=0` 的别名：两个面各有其名、参与计算，面朝向对不上就是贴合不了（报结构化错误，不退化成相邻）。不引入 Z 轴，不做自动碰撞优化，停在 P8.2，不进 P8.3。**

#### 23.10.1 审查结论：可直接复用的 contact 几何事实

动手前审查了 placement.ts（P8.1）/ relations.ts（P2）/ deriveContacts / transform.ts / Geometry Panel / Cabinet.placement / L·U·跨柜变深场景，结论是**面语义与面几何都已经存在，只需借，不需重建**：

| 已有事实 | 位置 | P8.2 怎么用 |
| --- | --- | --- |
| 面词汇 `ConnectionEdge = back\|front\|left\|right` | types.ts | attach 的 `targetFace/referenceFace` **直接复用同一套语义面**（不另起面词汇） |
| 面名 ↔ 几何边的唯一映射 `EDGE_ORDER` | relations.ts | placement.ts 直接 import（源码扫描断言：本文件不得出现字面量面表） |
| 矩形足迹点序 `rectPts` | transform.ts | 面的两个端点从点序取，面法线由"面中点 − 体中心"推出 |
| 唯一旋转实现 `localToWorld` | transform.ts | 端点与法线都经它旋转（验收断言 placement.ts 里没有 Math.cos/sin） |
| 唯一接触判定 `deriveContacts()` | relations.ts | **反向验证** attach 的结果（不复制、不让其改 placement） |

**审查中发现的 P2 真实缺陷（已修）**：`relations.ts` 的 `distPointToLine` 文档写的是"点到直线"，实现却把参数夹取到 `[0,1]`（等于点到**线段**）。于是**深度不同的两柜背面齐并排**（两面共面且重叠 550mm、实打实相接）被判成"没连着"——P8.2 的 attach 第一次系统性踩中它（attach 允许目标面比参照面长）。表现是 Placement 说"贴上了"、Relations 说"没连着"，两层说不同的话。修法：去掉夹取（重叠与否由 `overlapLen` 单独判，共面判定不该顺手把"伸出去了"当成"没连着"）。连带把 relations-acceptance 里两条**前提已失效**的夹具改成"真的分开"（沿接触面滑动并不会分开两柜，反而把角接变成 40mm 续接）——判据随修法演进，不删不放宽。

#### 23.10.2 AttachIntent 模型（core/placement.ts）

```ts
| { relation: 'attach';
    targetId; referenceId;
    targetFace: PlacementFace;      // = ConnectionEdge
    referenceFace: PlacementFace;
    alignment?: 'start'|'center'|'end';   // 缺省 start
    offset?: number;                       // 缝隙 mm，≥0，缺省 0
  }
```

- 面词汇 = `ConnectionEdge`（四个垂直面 `left/right/front/back`）；`PLACEMENT_FACES` 直接取 `[...EDGE_ORDER]`，**面词汇与面↔边映射都不许有第二份**。
- `top/bottom` 在类型层就不存在（需要 Z，本阶段不做）。
- 与 `adjacent` 的关系：`adjacent` 说"往哪一侧放"（方向语义、包围盒法），`attach` 说"哪两个面贴在一起"（面语义、面平面法）。轴对齐时两者给出同一个数，但 attach 走的是精确面平面（旋转过的柜 bbox 是放大近似，面平面才是真的）。

#### 23.10.3 面语义必须是真实语义（不是字符串 → adjacent）

`faceGeometry(item, face)` 从几何推出面的三件事，**没有第二张"哪个面朝哪"的表**：

1. **端点**：局部足迹 `rectPts(0,0,W,D)`，边序号 = `EDGE_ORDER.indexOf(face)`（P2 唯一映射）。
2. **自然方向**（start/end 的唯一读法）：从边自身轴向推出——左右面沿进深（背面→正面），前后端面沿宽（左端→右端）。
3. **外法线**：`面中点 − 体中心` 归一化（矩形局部边轴对齐，减出来就是纯法向），再经 `localToWorld` 旋转。

解析 = ① 两面朝向必须**反向平行**（否则 `PLACEMENT-FACE-NOT-OPPOSING`，message 带夹角数字）→ ② 法向：target 的面平面 = reference 的面平面 + `offset`（沿 reference 外法线外推）→ ③ 切向：沿接触面自然方向做 start/center/end 对齐。全部表达为**位移增量**，对任意合法 rotation 成立。

#### 23.10.4 alignment 与 offset 语义

- **`start`（缺省）/ `center` / `end`**：沿面的自然方向——左右面的 start 是背面端、end 是正面端；前后端面的 start 是左端、end 是右端。缺省 **不是**隐式 center（与 adjacent 的"并排背面齐、前后左缘齐"同惯例），系统替模型取值时写进 notes。
- **面接触 ≠ 整条边重合**：600 深贴 550 深、start 对齐时长的那头必然伸出 50mm——这仍然是真实贴合（验收的独立复核用"共面 + 投影有正重叠"，不用"两端点都落在对方线段内"）。
- **`offset`**：沿接触面外法线的缝隙（mm），0 = 真正贴合；**负数（重叠）拒收**——重叠是碰撞，落位层不造。offset 只改变解析结果，不进模型、不改几何（验收：offset=20 时 P2 `deriveContacts` 如实不算接触）。

#### 23.10.5 Rotation：复用 P8.1 的唯一旋转实现

端点与法线都走 `transform.ts` 的 `localToWorld`（含 90° 三角吸附），**没有新增任何三角函数**。验收覆盖 0° / 90° / 180° / 270° 的精确数值 + 独立重算的两面共面复核；45°/45°（非 90°）也可解析且确定（相对旋转为 0 时两面恒能共面）。

**几何事实（写入报错文案）**：两个矩形要面贴合，两者的**相对旋转必须是 90° 的整数倍**——因为 target 面外法线 `R(θt)u` 与 reference 面外法线 `R(θr)v` 必须反向平行，而 `u/v` 是轴向单位向量，`R(Δ)u` 仍是轴向的充要条件就是 Δ ≡ 0/90/180/270。所以"0° ↔ 45°"报的是 `PLACEMENT-FACE-NOT-OPPOSING`（不是静默换个放法）。

诚实边界：非轴对齐（如双柜 45°）的贴合**几何上精确**，但 P2 的 `deriveContacts` 只覆盖轴对齐柜体——验收里把它写成显式断言（"不声称已验证"），不假装验过。

#### 23.10.6 与 P2 Relations 的边界（复用，不复制）

```
P2 Relations  = 对象之间有什么关系（FurnitureAssembly / Connection / deriveContacts）
P8 Placement  = 根据关系，确定对象应该在哪里（PlacementIntent → ResolvedPlacement）
Geometry      = 确定性计算实际空间几何
Manufacturing = 从最终几何派生制造信息
```

- 只借常量（`EDGE_ORDER`）与唯一接触判定（`deriveContacts` 反向验证），**不复制接触算法**（源码扫描断言 placement.ts 里没有 deriveContacts / edgesFlush / CONTACT_TOL）。
- `deriveContacts` 是只读派生：验收断言它验证 attach 结果时没有反过来改任何 placement。
- attach 不写 Connection：贴上了不等于声明了连接（那是用户的语义决定，属于 P2）。

#### 23.10.7 CommandBus / Proposal / AI 接入

- **不新增写入命令**：attach 只是"一种解析方式"，最终仍写 `Cabinet.placement`，命令仍然是 P8.1 的 `cabinet.place`（一条原子写 x/y/rotation，白名单不变）。验收断言 `cmd.op === 'cabinet.place'`。
- **契约**：`cabinet.place.relation` 加 `attach`；新增 `targetFace / referenceFace`（枚举四垂直面）与 `offset`（≥0）；仍然**没有 x/y 参数**。
- **compileAction**：新增 attach 分支——先按既有规则解析参照（id → 唯一名字），再校验面/对齐/缝隙词汇，最后交给引擎解析；产物是带整数坐标的 `cabinet.place`。契约里没有 x，AI 夹带的坐标对解析结果零影响（验收断言"夹带 x=999 与没夹带逐值相同"）。
- **DesignProposal**：`ProposalPlacement` 支持 `relation:'attach'` + `targetFace/referenceFace/alignment/offset`；新增 `PROPOSAL-PLACE-FACE`（缺面 / 面名不认识，报 4 种取值）与 `PROPOSAL-PLACE-OFFSET`（缝隙非法，报上限数字），成环/自参照/参照不存在复用 P8.1 的既有码；编译顺序与 `$ref` 机制零改动（create 全部在前、place 按依赖序）。缺省对齐（start）写进 notes。

#### 23.10.8 核心文件

- `app/src/core/placement.ts`：PlacementFace / AttachAlignment / attach 意图分支 / `faceGeometry` / `resolveAttach` / `PLACEMENT_FACES`·`ATTACH_ALIGNMENTS`·`ATTACH_DEFAULT_ALIGNMENT` / 新增错误码 `PLACEMENT-FACE-NOT-OPPOSING`
- `app/src/core/relations.ts`：**修** `distPointToLine` 的夹取缺陷（点到直线而非线段）
- `app/src/ai/compile.ts`：case 'cabinet.place' 的 attach 分支
- `app/src/ai/proposal.ts` / `compileProposal.ts`：ProposalPlacement 扩展 + 两个新校验码 + notes
- `app/src/core/rules/issueCatalog.ts`：`PROPOSAL-PLACE-FACE` / `PROPOSAL-PLACE-OFFSET`
- `app/shared/aiContract.mjs`：ACTIONS 参数 + proposalShapeError（面/缝隙词汇、坐标仍拒收）
- `app/verify/attach-acceptance.ts`（新增，105 断言）+ `verify/relations-acceptance.ts`（两条前提失效的夹具改为"真的分开"）+ `verify/fixhint-acceptance.ts`（新码进 NUM_CTX）+ package.json（`verify:attach` 接入 verify:all）

#### 23.10.9 明确不支持（本阶段划界）

Z 轴 / top·bottom 面 / 柜体上下叠放 / 贴墙 / 房间边界 / 门窗 / 自动碰撞优化 / 自动吸附 / 全屋布局 / AI 自动布局 / P8.3 —— 全部不做。其中 top·bottom 与叠放**明确阻塞于 Z**：模型 `Cabinet.placement` 只有 (x, y, rotation)，没有 Z 就无法表达"谁在谁上面"（与 P2 的 `ASSEMBLY-STACK-UNVERIFIED` 同一条边界），本阶段没有偷偷加 Z。

#### 23.10.10 验收结果（P8.2）

- `tsc --noEmit`：0 错。
- `verify:attach`（新增）：**105/105**（§1 四向基础贴合 15 + §2 尺寸/朝向/互换/0·90·180·270·45° 共 14 + §3 混合关系链 attach+adjacent / attach+align / attach+attach / 成环 5 + §4 错误 12（含"绝不 fallback (0,0,0)"总检）+ §5 架构 15（纯函数/不改输入/无第二套旋转·bbox·面表·接触算法/唯一写入口/deriveContacts 反向验证且只读/preview===commit/2D·3D 同位移）+ §6 Proposal·AI 边界 24）。
- `verify:placement`：82/82（P8.1 旧断言一条未动）；`verify:relations`：82/82；`verify:proposal`：90/90；`verify:manufacturing`：101/101；`verify:fixhint`：27/27（两个新码进 NUM_CTX，喂进去的 4 / 2000 真出现在 message 里）。
- 全量 `verify:all`（node + UI）：**VERIFY_ALL_EXIT=0**，UI 686/686、零 console error。未删旧测试、未放宽旧断言；两条"前提已被缺陷掩盖"的 P2 夹具与两处 `kind:'corner'` 声明改为**按实际落位如实声明**（判据随修法演进，见 23.10.1）。

- 本阶段停在 P8.2，未自动进入 P8.3。

### 23.11 P8.3 实施记录：落位之后的设计语义验证（Design / Assembly Validation，已完成）

**基线 `7850046`（P8.2 已验收）。本阶段不再新增落位关系，而是补上 P8.2 暴露的架构缺口：几何上合法的 Placement，不一定等于设计语义上合理的 Placement。目标是 `PlacementIntent → Resolver → ResolvedPlacement → Design Validation → valid / warning / error`，且**Validator 不重算 Placement、不改 rotation、不替用户选朝向**。不做全屋布局、不引入 Z、不停在 P8.4。**

#### 23.11.1 审查结论：现有系统已经有哪些"设计语义"

动手前逐项审查了 `FurnitureAssembly` / `Connection` / `Assembly.kind` / corner / `deriveContacts()` / P8.2 attach / `Cabinet.rotation`。**一处需要纠正的事实**：指令里提到 `Assembly.kind = corner`，但模型里 **`FurnitureAssembly` 没有 `kind` 字段——kind 在 `Connection` 上**（`corner | butt | stack`）。本阶段**不新增 `Assembly.kind`**：那等于重新定义已经存在的事实，而且一组三只柜完全可以既有角接又有续接，一个 kind 说不清。

可复用的既有设计语义：

| 已有事实 | 位置 | P8.3 怎么用 |
| --- | --- | --- |
| `Connection.kind = corner/butt/stack` | types.ts | 语义来源；本层只读不重定义 |
| 唯一接触判定 `deriveContacts()` | relations.ts | **只消费它的结论**（连"是不是 corner"都问它要），不写第二份接触检测 |
| 声明 vs 派生的硬校验 `validateAssemblies()` | relations.ts | 已证明非法的（KIND-MISMATCH / EDGE-MISMATCH …）**直接透传为 error**，不重写 |
| "角接的角点属于两条边，本身有歧义" | relations.ts `cornerEdgeOf` | 直接决定了本层**不能**用"接触边是不是 front"作判据（见 23.11.4） |
| 人话词表 `EDGE_ZH` / `KIND_ZH` | relations.ts | 复用，不另写一套面/关系叫法 |
| 唯一旋转实现 `localToWorld` + `rectPts` | transform.ts | facing 全部从这里派生（源码扫描：设计层无 cos/sin） |

四层边界（本阶段把它写成了代码里的文件头注释）：

```text
P2 Relations  = 对象之间有什么关系
P8 Placement  = 根据关系，确定对象应该在哪里
P8.3 Design   = 这样放是否符合已有的设计/Assembly 语义（只判断，不重算、不改）
Geometry      = 确定性计算实际空间几何
Manufacturing = 从最终几何派生制造信息（继续只读）
```

#### 23.11.2 分层模型：resolved / valid / warning / error

```ts
DesignPlacementReport {
  status: 'valid' | 'warning' | 'error';
  findings: DesignPlacementFinding[];   // status / code / message / cabinetId / neighborId / alternatives / ambiguous
  contacts: DesignContactFact[];        // a/b/kind/edgeA/edgeB/turn?（全部来自 deriveContacts）
}
```

| 档 | 含义 | 由谁判定 |
| --- | --- | --- |
| **resolved** | 落位解析成功（能不能放） | Placement Resolver（`core/placement.ts`）—— 本层不改它 |
| **error** | 已证明非法 | ① P2 的硬事实（声明 corner 实际 butt 等）透传；② 解析层失败（透传其结构化错误，**绝不因为"算不出"就当 valid**） |
| **warning** | 几何成立但设计语义可疑 | 本层唯一新增的判定（见 23.11.4） |
| **valid** | 既没硬冲突也没可疑 | — |

汇总规则：有任一 error ⇒ `error`；只有 warning ⇒ `warning`；都没有 ⇒ `valid`。

#### 23.11.3 Facing / Orientation：派生，不落模型

`core/placement.ts` 新增四个最小 helper（实现复用**同一个** `faceSegmentOf`，即唯一的面几何）：

```ts
frontDirection(cab) / backDirection(cab) / leftDirection(cab) / rightDirection(cab)  // 外法线单位向量
```

**不新增 `Cabinet.facing` 之类的字段**：它与 `rotation` 是同一件事的两种写法，写进模型就是第二份真相（改了 rotation 忘了改 facing，系统就会自相矛盾）。派生的东西不会与模型不一致 —— 验收里钉住 `Object.keys(cab.placement)` 仍只有 `['rotation','x','y']`。

另加一个**事实**型派生（不是规则）：

```ts
cornerTurnSide(A, B): 'left' | 'right'
// 站在 A 的背面朝 A 的门脸看，B 在左手边 = left（左转角），否则 right
```

左右转角**都可能完全合理**，所以它是事实不是判据，只负责把"到底是哪一个"说清楚（验收断言左右两种构造各得 `left`/`right`，且都为 valid）。

#### 23.11.4 本阶段唯一新增的判定：门脸是否朝内

判据（几何事实，唯一可判定）：

> 从柜体**门脸中点**沿**门脸外法线**射出的射线，是否穿过**与它相接**的那只柜的包围盒（slab 法）。命中 ⇒ 门开出去就撞上邻居。

三条收窄，都是为了避免假警报：

1. **只检查已相接的柜对**（接触来自 `deriveContacts`）。隔 2m 的柜不该报 —— 那是开门半径/碰撞优化，本阶段不做。
2. **不用"接触边是不是 front"来判**。角接时共享角点天然属于两条边，P2 的 `cornerEdgeOf` 自己就声明过这份歧义（因此边不符只报 WARNING）；真拿它判，标准 L 型会被误报（实测：一个完全正确的 L，A 的角接边会被算成 `front`）。
3. **不写"corner 必须 rotation=270"这类习惯**。左右转角、镜像结构、不同家具都可能合理 —— 没有硬规则能证明它一定非法，所以只能是 warning。

#### 23.11.5 不替用户选：alternatives 与 ambiguous

可疑时给出**所有**同样成立的候选朝向，不排序、不推荐：

```ts
alternatives: [{ rotation: 270, front: '右（+X）', note: '…位置需按该朝向重新解析（本模块不改 placement、不替你选）' }, …]
ambiguous: true   // 候选不止一个
```

候选算法：在当前原点下逐一试 0/90/180/270，留下"门脸射线不命中邻居"的那些。每条候选都写明**位置要按新朝向重新解析** —— 改朝向会改 footprint，说了才算诚实（"预览 ≠ 提交"的老教训）。

**没有 `autoFix`**：转哪个方向是设计决定，界面不许给假按钮（原则 20）。验收断言 finding 上不存在 `autoFix`/`fix`，且校验前后 `placement` 与 `rotation` 逐值不变。

#### 23.11.6 与 P2 的边界：硬冲突透传，不重写

`validateAssemblies()` 报出的 ERROR/WARNING 原样带出（`code: 'DESIGN-ASSEMBLY'` + `sourceCode: 'ASSEMBLY-KIND-MISMATCH'`），**message 仍由 `issueCatalog` 产出**，本层不另拼一份。INFO（如 `ASSEMBLY-STACK-UNVERIFIED`）不计入 —— 信息提示不是设计疑问。

#### 23.11.7 Proposal / CommandBus 接入

- **不新增写入命令**：最终仍写 `Cabinet.placement`，命令仍是 `cabinet.place`。
- `CompileResult.design`：AI 编译 `cabinet.place` 时顺带给出设计结论（adjacent/align/attach 三条路径都带）。
- `PlanRun.design`：干跑结束时对草稿整体评一次 —— **预览阶段就能看见"几何成立但门脸朝内"**。
- **warning 不拦截**：有设计疑问时 `blockingErrors` 仍为 0、仍可提交，且 `preview === commit` 照旧成立（验收两条都钉住）。
- **刻意不进主规则链**：设计语义是提示不是硬规则。进了主链等于把"可能合理"的布局报成项目错误，也会挤掉 P6 的 `Hard Rule > Design Knowledge > User Preference`（用户偏好本该能影响朝向选择，不该被硬规则堵死）。
- AI 边界不变：契约里没有坐标参数，形状门照旧拦坐标；本层只新增"结论"，不给 AI 任何新的写权限。

#### 23.11.8 核心文件

新增 `app/src/core/placementDesign.ts`（纯函数设计语义层）、`app/verify/placement-design-acceptance.ts`（107 断言）。修改：`core/placement.ts`（facing helper + 导出 `faceSegmentOf`/`sceneItemOf`）、`core/rules/issueCatalog.ts`（两个新码）、`ai/compile.ts`（`CompileResult.design`）、`ai/planRunner.ts`（`PlanRun.design`）、`verify/fixhint-acceptance.ts`（两码进 NUM_CTX）、`package.json`（`verify:placement-design` 接进 `verify:all`）。

#### 23.11.9 测试结果

- `tsc --noEmit`：0 错。
- `verify:placement-design`（新增）：**107/107** —— §1 facing 派生 12（0/90/180/270 × front/back/left/right 与独立重算一致 + 无第二字段/无第二套旋转）+ §2 resolved+valid 6 + §3 **几何合法但设计可疑**核心 fixture 12（含"候选含 270 / ambiguous / 当前朝向不在候选 / 不改 rotation / 无 autoFix"）+ §4 门对门 5 + §5 左/右转角 7 + §6 不同宽深与 550/600 混深 × start/center/end 共 25 + §7 P2 硬冲突透传 5 + §8 resolved+error 5 + §9 架构 9（同输入同结果/不改模型/不改 placement/源码扫描：无第二套接触·面表·旋转·文案）+ §10 不拦截 & preview===commit 10 + §11 2D/3D 同一 resolved placement 4。
- 旧链一条未动：`verify:placement` 82/82、`verify:attach` 105/105、`verify:relations` 82/82、`verify:proposal` 90/90、`verify:import` 59/59、`verify:manufacturing` 101/101、`verify:fixhint` 27/27（两个新码进了 NUM_CTX，喂进去的 90/900/1/3 与 270/600/2/3 真出现在 message 里）。
- 全量 `verify:all`（node + UI）：**VERIFY_ALL_EXIT=0**，UI 686/686、零 console error、全链 2639 条断言 0 红（= P8.2 的 2532 + 本阶段新增 107）。

#### 23.11.10 明确不支持 / P8.4+ 候选

明确不做：自动改 rotation、自动在多方案中选、Z 轴、上下叠放、贴墙/房间边界/门窗、碰撞优化、全屋布局、AI 自动布局、P8.4。

留给后续阶段的候选（本阶段只记录不做）：
1. **界面呈现**：`PlanRun.design` 已把结论带出，但 UI 尚未渲染"设计语义提示"区块（本阶段刻意不动 UI，避免把提示变成既成事实的拦截）。
2. **Attachment 的开门半径**：现在只判"紧贴"，尚未判"隔 500mm 门扇扫到邻居"（需先有门扇开启包络这一确定性事实）。
3. **用户偏好影响朝向**：P6 的 userPreference 可作为 candidate orientation preference 影响下一次 Proposal，但不得覆盖硬几何约束。

- 本阶段停在 P8.3，未自动进入 P8.4。

---

### 23.12 P8.4 实施记录：落位偏好与设计知识接入（Placement Preference / Design Knowledge Integration，已完成）

> 把 P6 Design Knowledge、P8.1 确定性落位、P8.2 面接触、P8.3 设计语义验证接成一条链：
> **观察 → candidate → 用户确认 → active → 提案上下文 → 语义意图 → 确定性解析 → 设计校验**。
> 一句话边界：**偏好只影响"建议什么"，永远不影响"几何怎么算"。**

#### 23.12.1 架构审查结论（先审查，后编码）

| 审查问题 | 结论 |
| --- | --- |
| P6 `PredicateKind` 是否够用 | **维度名够用，上下文不够**：`{kind, op, value}` + `KnowledgeScope{cabinet,room}` 表达不了"corner / 右转角"。裸的 `{kind:'orientation',value:270}` 恰恰就是被禁止的"corner 永远 270" |
| 最小扩展点 | 在 `KnowledgePredicate` 上加**封闭的** `context?: PlacementContext`（`contact` + `turnSide`），不新增 scope 字段、不新增第二套知识系统 |
| 属于哪一层 | **userPreference**（来自该用户的行为观察）。designKnowledge 是"行业通常这样做"，与本阶段来源不同 |
| 怎么防止被当成硬规则 | 复用既有机制：layer rank（hard 0 / knowledge 1 / preference 2）+ candidate 不进 `applicable` + 硬规则压制进 `suppressed`/`conflicts` |
| 提案注入口是否已有 | **已有且唯一**：`AIPanel` → `knowledgeDigest(resolveKnowledge(...))` → `aiContract` system prompt。本阶段只扩展 digest 内容，不新建提示词系统 |
| P8.3 的结论要不要影响偏好 | **不要**。warning 是提示不是证据；偏好也不得反过来消灭 P8.3 结论 |
| 需不需要新语义字段 | **不需要**。`ProposalCabinet.rotation`（"朝向意图，落位由系统定"）P3 就已存在并编译进 create 参数，本阶段直接复用 |

#### 23.12.2 偏好数据模型（带上下文，不是裸值）

```ts
interface PlacementContext {
  contact?:  'corner' | 'butt';   // ← P2 Connection.kind / deriveContacts().kind
  turnSide?: 'left'   | 'right';  // ← P8.3 cornerTurnSide()，**以对方柜为视角**
}
predicate = { kind: 'orientation', op: 'prefer', value: 270, context: { contact:'corner', turnSide:'right' } }
```

- `turnSide` 取**对方柜**为视角：转目标柜时上下文不变，否则改一次朝向就换一个上下文，永远沉淀不出知识。
- 上下文不同即**两类情形**：右转角 270 与左转角 90 不冲突、不合并（冲突检测与证据累积都按 `contextKey` 分格）。
- **语义模型零新增字段**：`Cabinet.placement` 仍是 `{x,y,rotation}`，没有 `facing`/`orientation` 第二真相（验收逐键断言）。

#### 23.12.3 观察门禁（只有能证明是用户选择的改动才成为证据）

产生候选的**全部**条件：命令 op ∈ {`cabinet.rotate`, `cabinet.update`, `cabinet.create`} 且路径是 `placement.rotation`、source 是**人的来源**（`ui`/`mcp`）、值确实变了（等价角 `-90 ≡ 270` 不算）、且**拿得到上下文**。

| 情形 | 是否产生 | 理由 |
| --- | --- | --- |
| 用户改朝向（90 → 270） | ✅ candidate | 唯一能证明"用户选择"的落位证据 |
| AI 给的朝向（source='ai'） | ❌ 一条都不产生 | 尚未经用户确认，不得冒充 user-observed |
| 撤销 / 系统（source='system'） | ❌ | 不是新事实 |
| `cabinet.place`（Resolver 算的） | ❌ **整类排除** | 系统输出当证据 = 自我强化闭环 |
| 同值写入 / 等价角 | ❌ | 没有发生改动 |
| 只挪 x/y | ❌ | 位置是一次性决定，不是偏好 |
| 拿不到上下文（孤立柜 / stack） | ❌ | 说不出是哪一类情形，就不记（不猜） |

> 实现中发现并修掉的一个真问题：观察原本会把 `scope.cabinet = 柜名` 一起存下来，导致偏好只在"叫这个名字的柜子"上生效 —— 既不可复用，也会在真正该生效时被 `scopeMatches` 挡掉。**落位偏好挂在情形上，不挂在柜子名上**（是哪只柜改的，证据里 `cabinetId` 已留痕）。

#### 23.12.4 生命周期与优先级（复用 P6，不重新定义）

`观察 → candidate（置信 0.3）→ 累积同类证据（不升级）→ 用户确认 → active（置信 1）`，另有 `rejected`。
优先级沿用既有三层：**Hard Rule > Design Knowledge > User Preference**，实现证据三条：
① 与硬规则冲突的偏好进 `suppressed` 且不出现在 `applicable`；② `preferredOrientation()` 只读 `applicable`（被压制/未确认的一律读不到，返回 null = "没依据就别说"）；③ 流水线层：偏好在，P8.3 的 error/warning 结论**逐值不变**。

#### 23.12.5 本阶段**没有**做的三类偏好（及原因）

用户建议了四类，本阶段只落地了 `orientation` 一类，另外三类明确不做 —— 不是偷懒，是模型不足以安全表达：

- **corner turn side preference**：与 orientation 来自同一条证据，无法区分"用户偏好右转角"与"这个房间只能右转"，记下来是重复计数。
- **adjacent / attach alignment preference**：语义模型的 `Cabinet.placement` **不存落位意图**（只存 `{x,y,rotation}`），"这次并排按背面齐还是中心齐"落盘即消失；而对齐偏好只能从 x/y 移动观察 —— 那又与"普通移动不产生偏好"直接冲突。硬造 `relation` 字段 = 拿猜测当证据。

#### 23.12.6 边界的硬保证（不是约定，是结构与断言）

- `placement.ts` / `placementDesign.ts` **不 import knowledge**（源码扫描断言）；有偏好与没偏好，同一 `PlacementIntent` 的解析结果**逐值相同**。
- 偏好只变成提案里的 `rotation` 语义意图；**x/y 仍由 Resolver 算**（偏好换成 90 时位置随之重算，证明位置来自几何而非偏好）。
- 不新增写入命令、不改 `cabinet.place`；`preview === commit` 照旧。
- 多解保留：`alternatives` 与 `ambiguous` 一个都不少，偏好的 270 只是候选之一。

#### 23.12.7 核心文件

新增：`src/ai/knowledge/placementContext.ts`（上下文派生）、`verify/placement-preference-acceptance.ts`（96 断言）。
修改：`src/ai/knowledge/model.ts`（PlacementContext / orientation / contextKey / contextCovers）、`resolver.ts`（上下文感知冲突 + `preferredOrientation`）、`observe.ts`（旋转观察 + 门禁 + 上下文分格）、`digest.ts`（上下文展示 + 落位免责条款）、`index.ts`、`src/ui/App.tsx`（传上下文）、`package.json`。

#### 23.12.8 验收

- `tsc --noEmit` 0 错；`verify:placement-preference` **96/96**。
- 回归：knowledge 61/61、placement 82/82、attach 105/105、placement-design 107/107、relations、proposal、import 59/59、manufacturing 101/101、fixhint 全绿。
- 全量 `verify:all`（node + UI）：**VERIFY_ALL_EXIT=0**，UI 686/686、零 console error、2735 条断言 0 红。
- 旧测试零删除、零放宽；P6 原有 61 条断言（含"450 硬规则 vs 400 偏好"）逐条保留。

#### 23.12.9 停在 P8.4

下一步候选（仅记录不做）：alignment 类偏好需先让落位意图可追溯；UI 渲染"设计语义提示"区块；用户偏好影响 Proposal 后的二次确认回路。

---

### 23.13 P8.5 实施记录：落位意图的 Provenance（Placement Intent Provenance，C1 已落地）

> 承接 P8.4 §23.12.5 主动缩范围的原因：**语义模型的 `Cabinet.placement` 不存落位意图**，"按背面齐还是中心齐"落盘即消失、事后只能从坐标猜，于是 alignment 偏好本阶段不做。
> P8.5 用**命令层 provenance**（审查报告推荐方案 C1）把"这次落位是怎么来的"带进命令，使 alignment 成为**可观察事实**——不再猜。
> 边界（审查报告 §H 铁律，全部结构保证）：provenance 是被动记录，**不进 Semantic Model、不进 project.json、不进任何派生层**；落位权威由**总线单点派生**，调用方无从声明。

#### 23.13.1 架构审查两个待拍板点（本次实现的处理）

| 待拍板点 | 结论 | 理由 |
| --- | --- | --- |
| 跨会话可见是否属验收项 | **否 → 走 C1** | C1 只在命令层加声明通道，不动 `Cabinet/types.ts`、不进 `project.json`、不动 resolver；跨会话持久化（柜体级落盘）列为条件性第二阶段 B，本期不做 |
| 是否补"用户可选 alignment 入口" | **属产品待办，非数据模型** | UI 当前没有对齐入口，这是产品功能而非数据模型问题；本阶段只把"用了哪个对齐"变成可观察事实（须用户在知识面板确认才生效） |

#### 23.13.2 数据模型（命令层，不进模型）

```ts
// core/placement.ts —— 复用落位词表，不新造面/对齐词汇（DistributiveOmit 对联合类型逐成员剥键）
export type PlacementIntentDecl = DistributiveOmit<PlacementIntent, 'targetId'>;
export function toPlacementIntentDecl(intent: PlacementIntent): PlacementIntentDecl;

// core/commandBus.ts —— 命令只声明"怎么来的"，不决定坐标
interface Command {
  placementIntent?: PlacementIntentDecl;  // 仅 cabinet.place 带（compile 从 AI 提案重建）
  confirmedPlan?:   boolean;             // 仅 apply 路径（commitPlan/commitPlanSubset）打上
}
type PlacementAuthority = 'user-authored' | 'user-confirmed' | 'system-resolved' | 'unknown';
interface PlacementProvenance {           // 会话内，不进 project.json
  targetId: string; intent: PlacementIntentDecl | null; authority: PlacementAuthority;
  byOp: string; atVersion: number; status: 'live' | 'superseded'; supersededBy?: { op: string; atVersion: number };
}
```

#### 23.13.3 落位权威派生（总线单点，根治 P8.4 根因 A3）

旧代码用 `Command.source` 代理"是不是人的选择"，但 `compile.ts` 让 AI 编译的命令 source 恒为 `'ai'`（含用户点应用后的提交）→ 用户确认过的提案被当成 `ai-inferred`，结构性收不到落位证据。

`derivePlacementAuthority(cmd)` 在总线里**唯一**计算，调用方无权声明：

| `cmd.source` | `confirmedPlan` | authority |
| --- | --- | --- |
| `ui` / `mcp` | — | `user-authored`（人的动作） |
| `ai` | `true`（用户点「应用」确认） | `user-confirmed` |
| `system` | — | `system-resolved`（自动贴墙/整组平移/撤销） |
| `ai`（未确认）/ 导入 / 手摆 | — | `unknown`（绝不冒充 user 证据） |

`confirmedPlan` 只由 `planRunner.commitPlan` / `commitPlanSubset` 在用户点「应用」时经 `markConfirmed()` 打上。

#### 23.13.4 失效判定（集中重算，与 undo/redo 原子同步）

`recomputeProvenance()` 在每次 `execute` / `undo` / `redo` 末尾跑，按 `targetId` 分桶、**最后一条 = live，之前全 = superseded**（带 `supersededBy`）。覆盖全部失效情形：rotate / move / nudge / resize / 手动移回 / 重跑同一 intent。因为只读 `activeLog()`（applied 且未丢弃），撤销分支自然退出，provenance 与模型状态原子一致。
`replaceProject()`（导入）清空所有历史条目的 `placementProvenance`——导入来源由既有 `cabinet.origin` 回答，绝不伪造"导入来的柜是谁摆的"。

#### 23.13.5 观察门禁（alignment 现在可学，但门禁同源纪律）

`observeCommand(cmd, diff, name?, ctx?, authority?)` 新增 `authority` 参数（未传退化旧 `source` 代理行为，向后兼容）。

- `alignment` 谓词（P8.5 新增到 `PredicateKind`）：只从**确认过的 `cabinet.place` 的 `placementIntent`** 提取（`adjacent`/`align`/`attach` → 对齐方式），且必须 `human`（user-authored / user-confirmed）、必须带 `PlacementContext`、只产 candidate（弱证据，须用户在知识面板确认才生效）。`absolute` 是授权输入，不记为对齐偏好。
- **关键修复**：`cabinet.place` 的 diff（x/y/rotation）是 Resolver 算的，不是人的选择——所以 ① 路径分支对 `cabinet.place` **整体跳过**（只走 ② intent→alignment），否则 Resolver 算出的 `rotation` 会被误判成"人的朝向偏好"（这会破坏 P8.4 的 `placement-preference` §2 验收）。
- `authorityToOrigin`：user-authored / user-confirmed → `user-observed`；system-resolved → `system`；unknown → `ai-inferred`。

#### 23.13.6 边界硬保证（结构 + 断言，同 P8.4 纪律）

- `placement.ts` 不 import knowledge、不出现 `placementProvenance`（落位层只读 decl）。
- 派生层 `geometry/project.ts`、`placementDesign.ts`（P8.3）、`export/roomBook.ts`、`export/neutralSheet.ts`（DXF/清单）**不读** `placementProvenance` / `PlacementAuthority` / `derivePlacementAuthority`——落位来源不影响几何算法。
- `placementProvenance` 全仓只出现在 `core/commandBus.ts`（定义+写）与 `src/ui/App.tsx`（读 `authority` 传给观察器）；观察者 `observe.ts` 只吃 `authority` 参数，职责分离，不引用该字段。

#### 23.13.7 核心文件

新增：`verify/placement-provenance-acceptance.ts`（54 断言，已接入 `verify:all`）。
修改：`core/placement.ts`（PlacementIntentDecl + toPlacementIntentDecl）、`core/commandBus.ts`（authority 派生 + provenance 记录 + recompute + 导入清空）、`core/commands.ts`（placeCabinet 透传 placementIntent）、`ai/compile.ts`（落位命令带 decl）、`ai/planRunner.ts`（markConfirmed）、`ai/knowledge/model.ts`（PredicateKind 'alignment' + PLACEMENT_KINDS）、`resolver.ts`（isJudgable + preferredAlignment）、`observe.ts`（authority 门禁 + alignmentFromIntent）、`digest.ts`（PRED_ZH）、`src/ui/App.tsx`（传 authority）、`package.json`。

#### 23.13.8 验收

- `tsc --noEmit` 0 错；`verify:placement-provenance` **54/54**（声明通道 / authority 矩阵 / 真实 apply 路径 / 观察门禁 / superseded 失效 / undo-redo 原子 / 导入不伪造 / 源码扫描）。
- 回归：P8.4 `verify:placement-preference` **96/96**（修复 cabinet.place 误判后保持全绿）、knowledge 61/61、placement 82/82、attach 105/105、placement-design 107/107、relations、proposal、import、manufacturing 等全绿。
- 旧测试零删除、零放宽。

#### 23.13.9 停在 P8.5

本期只落地方案 C1（命令层 provenance）。条件性第二阶段 B（柜体级落盘 / 跨会话可见）与"用户可选 alignment 入口"均为后续候选，不在本期范围。

### 23.14 P8.5-B 实施记录：落位 provenance 持久化（Persistent Placement Provenance，方案 A 已落地）

> 前置：`docs/Placement-Intent-Provenance-Persistent-Architecture-Review.md`（审查阶段产物，方案 A 经拍板采纳）。三个拍板点结论：① 方案 A 采纳（`Cabinet.placementProvenance?` 随柜体进 project.json）；② `invalidated` 不持久化（由 `Cabinet.placement + placementProvenance + 当前 resolver` 确定性重算，派生态绝不存成第二份真相）；③ `PlacementAuthority` **不迁入** placement.ts（保持 `core/commandBus.ts` 为落位权威生命周期唯一归口；types.ts 以 `import type` 引用，编译期擦除无运行时环）。

#### 23.14.1 数据模型（落盘形态，最小字段）

```ts
// core/types.ts
export interface PersistedPlacementProvenance {
  intent: PlacementIntentDecl | null;  // null = 来源未知（导入/手摆），不伪造
  authority: PlacementAuthority;       // user-authored / user-confirmed / system-resolved / unknown
  byOp: string;                        // cabinet.place / move / rotate / nudge / resize / assembly.move
  atVersion: number;                   // 提交时模型版本（可复现指针，不是时间戳）
}
// Cabinet 新增可选字段：
placementProvenance?: PersistedPlacementProvenance;
```

刻意**不落盘**：`status` / `targetId` / `supersededBy`（会话派生态）、resolved 坐标、contact/turnSide、完整命令日志、undo/redo 历史。**不含任何 x/y/z/rotation/几何快照**——`Cabinet.placement` 仍是唯一几何真相，provenance 只解释、不决定。

#### 23.14.2 生命周期（种子 → 会话维护 → 保存时物化）

```
load（构造 CommandBus / replaceProject 整批载入）
  └─ seedProvenanceFromProject：每柜 placementProvenance → baselineProv + provById（status=live）
  └─ stripProvenanceFields：把该字段从内存模型剥掉 —— 模型里永远干净
execute / undo / redo
  └─ recomputeProvenance（只动 provById，不动模型）：
       ① activeLog() 分桶，同柜最后一条 = live、之前全 = superseded（C1 规则不变）
       ② provById = new Map(baselineProv) ← 先回到加载基线
       ③ 用 activeLog 的 live 覆盖（无会话记录的柜保留基线）
save（App / ExportPanel / draftStore）
  └─ bus.toFileSnapshot()：clone 状态、把每柜当前 live 物化成 Cabinet.placementProvenance，
     再交 serializeProjectFile —— 只有这里有 provenance 进模型形状
```

**为什么 provenance 不进会话内存模型（本阶段最关键的架构裁定）**：本项目核心不变量「预览 === 提交」「干跑终点 === 提交终点逐字节相同」（bus-acceptance §4 ×8、ai-acceptance F3）。干跑在沙盒总线上执行同一批命令，此时**未打** `confirmedPlan` → authority=`unknown`；真提交已确认 → `user-confirmed`。这是**真实的语义差异**（干跑本来就不知道用户会确认），不是缺陷——provenance 一旦进模型状态，这两条逐字节断言就在结构上永远不可能成立。所以 provenance 只住总线（`provById/baselineProv`），保存时经 `toFileSnapshot()` 物化成文件形状，加载时种子化回来。第一版实现曾把 live 镜像进 Cabinet（syncProvenanceToCabinets），全量回归立刻红掉 6 条逐字节断言，据此改为物化方案。

**"先回基线再覆盖"**：撤销某条落位命令后，该柜自然回到"加载时"状态 → provenance 回到基线（基线为空则清空），从结构上杜绝"placement 已 undo 但 provenance 还停在旧 live"。`replaceProject` 的 undo/redo 同样原子：快照两侧都带 provenance（prev 侧经 `toFileSnapshot()` 物化、next 侧原样），revert 时按方向重新种子化+剥字段。

#### 23.14.3 四态语义（持久化后）

| 态 | 来源 |
|---|---|
| live | 落盘记录（reload 种子）或会话内 activeLog 末条 |
| superseded | 会话内瞬时态（不落盘；save 只写 live） |
| invalidated | **不持久化、不计算进库**：派生判定由 `Cabinet.placement` + intent 重解析比对得出（审查 §四），留待消费方（如 P8.3 校验）需要时现算 |
| unknown | `placementProvenance === undefined`（老项目 / 导入 / 无记录柜），等价 `intent=null`，**绝不回填伪造** |

#### 23.14.4 reload 规则（不做的事比做的事更重要）

- reload **只**恢复 provenance 状态（种子进总线），**绝不回放 `observeCommand`**——App 的 `observedSeqRef` 闸门 + reload 后 `bus.log()` 为空，双重保证"保存→打开"不产生任何 Knowledge candidate，杜绝自我强化循环。
- `recordObservation` 内容合并（kind+op+value+contextKey+scope 相同只涨置信不新建）作为次保险。
- `getPlacementProvenance(cabinetId)` 为新增公共读取口（会话记录优先、否则加载基线）。

#### 23.14.5 Import / AI / Undo-Redo 的诚实边界

- **Import / 载入（replaceProject）**：统一语义"整批载入 = provenance 状态整体重置"——旧映射先清（旧柜绝不残留），再按载入内容重新种子化。自家格式（项目文件 / 草稿恢复）里带 provenance = **恢复**（user-confirmed 不退化）；外来来源（P4/P5 适配器构造的柜）从不带该字段 = 天然 **unknown**。恢复的是"我们自己持久化过的事实"，unknown 是"确实不知道"，两种都诚实、都不伪造。
- **增量导入**：不带 `placementIntent` 的落位 → `intent=null`，绝不从最终坐标反推 alignment/attach。
- **AI Proposal**：`markConfirmed()` → `user-confirmed` 显式落盘，reload 后读到的就是 `user-confirmed`，不可能退化成 ai-inferred（C1 根因 A3 的跨会话兑现）；未确认 AI → `unknown`。

#### 23.14.6 schemaVersion / migration

**不升、不加 migration**（与审查结论一致）：可选字段 + 旧读者忽略 + 内容驱动 `resolveSchemaVersion` 不受影响，存量文件读存逐字节兼容。`parseProjectFile` 对字段非法（非对象/缺 authority）的防御：静默降级为缺失（unknown），不阻断打开——"缺了顶多不知道这柜怎么来的"比"因一个坏字段拒绝整个文件"安全。

#### 23.14.7 核心文件

- `core/types.ts`：`PersistedPlacementProvenance` + `Cabinet.placementProvenance?`（`PlacementAuthority` 以 `import type` 引自 commandBus）。
- `core/commandBus.ts`：`baselineProv/provById` 双 Map、`seedProvenanceFromProject` / `stripProvenanceFields` / `toFileSnapshot()` / `getPlacementProvenance`、`recomputeProvenance` 扩展（回基线→覆盖，不动模型）、`replaceProject` 重置+种子化、revert 的 replaceProject 分支双向种子化、构造函数种子化+剥字段。
- `core/projectFile.ts`：字段非法防御性降级。
- `ui/App.tsx` / `ui/panels/ExportPanel.tsx`：保存出口改走 `bus.toFileSnapshot()`。
- `verify/placement-provenance-persistent-acceptance.ts`（NEW，63 断言）。

#### 23.14.8 验收

- `tsc --noEmit` 0 错；`verify:provenance-persistent` **63/63**（持久化 round-trip / 无坐标无几何 / **内存模型不带 provenance** / 老项目兼容 / AI 未确认 unknown·确认 user-confirmed 跨会话不退化 / user 修改产生新 live / undo-redo 原子含分支不复活·replaceProject 双向原子 / reload 不回放观察·evidence 去重 / import intent=null·外来 unknown·自家恢复 / resolver 几何不受 provenance 影响 / schemaVersion 带-不带 provenance 相等 / 源码扫描 51 项）。
- C1 `verify:provenance` **61/61**（§8 扫描随架构更新：允许集扩为 总线+types+App，派生层禁止集不变）；`verify:placement-preference` **96/96**；bus-acceptance **127/127**（含 §4 预览===提交 ×8）；ai-acceptance **70/70**（含 F3 干跑===提交逐字节）。
- 全量非 UI 回归（40 脚本）全绿；旧测试零删除（C1 §8 扫描允许集随新架构更新属"判据跟着事实走"，非放宽——派生层禁读的红线原样保留并有断言）。

#### 23.14.9 停在 P8.5-B

本期只落地方案 A（柜体级 live provenance 持久化）。不做：完整命令历史落盘、独立 history 文件、Resolver 读 provenance、从坐标反推 intent、UI alignment 编辑器、云端同步、P8.6 及以后。

## 23.15 P8.6 实施记录：语义落位意图 UI（User-authored Alignment）

#### 23.15.1 目标与边界

解决 P8.5-B 留下的缺口：用户此前只能拖拽（intent=null）或靠 AI 提案表达落位意图。P8.6 给用户一个**语义入口**——点「对齐到 / 贴合到」而不是输入 x/y——产出的真实 `PlacementIntent`（authority=user-authored）由此可被 Knowledge 安全观察为 alignment preference candidate。

硬边界：不修改 Resolver / placement 几何定义 / P8.3 校验；不新增 uiPlace/uiAlign/uiAttach 平行执行路径；不做全屋自动布局、自动选朝向、自动重贴合；拖拽永远 intent=null，绝不从坐标反推意图。

#### 23.15.2 UI 入口（PropertiesPanel → PlacementIntentSection）

- 挂载点：属性面板柜体属性「位置」区之后，新增「落位意图（对齐 / 贴合）」Section。
- **对齐到**：参照柜下拉（其余所有柜）+ 五个按钮（左缘/右缘/前缘/后缘/中心）——对应 `align` 的 `ALIGN_ALIGNMENTS` 全集。
- **贴合到**：参照柜 + 本柜面（back/front/left/right）+ 参照柜面 + 沿面对齐（start/center/end）+ 缝隙 mm（0=真贴合）——对应 `attach` 全词表。
- 界面上**没有 x/y 输入**；校验结果直接显示 P8.3 `DesignPlacementReport`（只提示不拦截）。
- 无参照柜时诚实提示"语义对齐/贴合需要参照柜体"。

#### 23.15.3 链路（UI → Intent → Resolver → CommandBus → provenance → Knowledge）

```
用户点击「对齐到·右缘」
  → buildAlignIntent（词表与 PlacementIntent 逐字同一份）
  → commitPlacementIntent（src/ui/placementIntent.ts，UI 层唯一提交路径）：
      resolvePlacement（core/placement.ts，唯一 Resolver，纯函数）
      → designCheckPlacement（P8.3 报告，只提示）
      → CMD.placeCabinet(cab, resolved, 'ui', label, toPlacementIntentDecl(intent))
      → bus.execute（source='ui' → derivePlacementAuthority = user-authored）
      → LogEntry.placementProvenance（intent 真实保存）
      → App 观察回路（P8.5 已接）：observeCommand 从 intent 提 alignment candidate
      → 用户在知识面板确认 → active → knowledgeDigest（AI 设计可见）
```

关键点：`commitPlacementIntent` 是纯逻辑模块（无 React），UI 组件只是它的皮；坐标计算、声明生成、提交全部复用既有单点实现，UI 层零第二套实现（§8 源码扫描断言钉死）。

#### 23.15.4 preview === commit 保持

provenance 只住总线（P8.5-B 结构裁定），UI 意图命令在干跑沙盒与提交两端的模型状态逐字节相同、文件内容（含 provenance）逐值相同（序列化的 `savedAt` 是墙钟元数据，比较以 parse 回的 project 为准）。

#### 23.15.5 Knowledge 观察结果

- user-authored UI 对齐 → 1 条 alignment candidate（值=用户选的对齐、source=user-observed、带 PlacementContext、不挂柜名）；
- candidate 阶段同类观察累积 evidence、不自动升级；确认后 active 进 digest；
- 负样本全部钉死：拖拽移动 / AI 未确认（unknown）/ system-resolved / absolute 授权坐标 一律不产生 alignment candidate；
- undo / redo / reload 不重复制造 evidence（seq 消费 + reload 日志为空 + 观察不回放）。

#### 23.15.6 核心文件

- `src/ui/placementIntent.ts`（NEW）：buildAlignIntent / buildAttachIntent / placementIntentLabel / commitPlacementIntent。
- `src/ui/panels/PropertiesPanel.tsx`：PlacementIntentSection（语义 UI）+ CabinetProps 透传 project/onToast。
- `verify/placement-intent-ui-acceptance.ts`（NEW，62 断言）+ `package.json`（`verify:placement-intent-ui` 接入 `verify:all`）。

#### 23.15.7 验收

- `tsc --noEmit` 0 错；`verify:placement-intent-ui` **62/62**（8 章节：align 五向坐标逐值 / attach 两面+offset / 非法面诚实拒绝不改状态 / provenance user-authored+intent 逐值 / 拖拽 intent=null / preview===commit / Knowledge 闭环含 4 类负样本 / undo-redo-reload 不重复 evidence / 报告同源+Resolver 不读 provenance / 源码扫描）。
- 关键回归全绿：placement-preference / provenance / provenance-persistent / placement / attach / placement-design / knowledge；全量非 UI 回归链见 verify:all。
- 旧测试零删除、零放宽；schemaVersion 不变（内容驱动）；不动 Semantic Model 与 Resolver。

#### 23.15.8 停在 P8.6

不进 P8.7。后续候选（需明确指令）：知识面板对 alignment candidate 的展示细化、attach 的图形化交互、全屋布局等。

### 23.16 P8.7 实施记录：Spatial Semantics Foundation（Room / Wall / Opening）

#### 23.16.1 现状审查结论（先复用，后新建）

项目里 **Room / Wall 已存在且就是边界本身**：`Room { id, name, walls: Wall[] }`、
`Wall { id, name, start, end, thickness, height }`（中心线+厚度）。指令里"Room polygon 与
墙坐标两套真相互相矛盾"的风险在现有模型中**结构性不存在**——房间边界 = 墙中心线回路，
唯一来源就是 `Room.walls`。因此 P8.7 只新增 **Opening** 一块拼图，不重造房间模型、
不引入独立 polygon、不定义新 Point 类型（复用 `Vec2`）。

#### 23.16.2 Opening 语义模型

```ts
export interface Opening {
  id: string;
  kind: 'door' | 'window';
  offset: number;  // 沿墙中心线从 start 到洞口起点边缘（mm 整数，≥0）
  width: number;   // 洞口沿墙净宽（mm 整数，>0）
  name?: string;
}
// Wall.openings?: Opening[]
```

关键决策——**洞口挂在墙下**（`wall.openings`），不建项目根下的独立列表：
roomId/wallId 由结构回答，无悬空引用可校验、无世界坐标可重复保存（洞口世界位置 =
沿墙 offset 的派生值，绝不 authored）。不存宽度与 start/end 双份、不存朝向。

#### 23.16.3 空间派生模块（`core/spatial/`）

- `model.ts`：容差唯一出处 `SPATIAL_TOL { TOUCH:1, NEAR:50, OPENING_ZONE:600 }`（mm，
  集中定义、严格分段不互吞）+ 确定性几何助手（点在多边形/正交穿越/多边形距离/回路构造
  `roomLoop`/洞口影响带 `openingZoneRect`）。**零三角函数**——旋转几何全部复用
  geometry 层的 `getCabinetFootprint`（唯一旋转实现）与 `wallPolygon`。
- `derive.ts`：事实层 `deriveSpatialFacts` → 柜↔房间（inside/outside/crossing/unknown）、
  柜↔墙（touching/near/crossing/none，footprint 多边形判定，bbox 只做剪枝）、
  柜↔洞口（clear/overlap/unknown）。
- `validate.ts`：issue 组装（经 `buildIssue` 唯一出口），`deriveSpatial(project): SpatialReport { facts, issues }`。
- `index.ts`：公共面。

**洞口影响带（OPENING_ZONE=600mm）的必要性**：洞口本体是墙体厚度里的一段空腔，
贴墙摆放的柜体与它只有"贴线"接触——按纯空腔几何**永远检不出柜子挡门**。
影响带 = 洞口 span × [墙外侧 −t/2 … 室内侧 t/2+600]，"柜站在洞口正前方"由此成为
可判定的平面重叠。室内侧方向由房间回路 + 中点采样点确定性判定（不是猜）。

#### 23.16.4 与既有规则的分工（不重复报、不抢归属）

- **柜体嵌墙硬错误仍是 geometry 层 `RULE-CABINET-IN-WALL`**（bbox ⊇ footprint，
  凡 footprint 穿墙它必报）——空间层不发重复 issue，只在 facts 里给更细分类。
- 空间层独有码（已登记 issueCatalog）：`SPATIAL-WALL-ZERO`、`SPATIAL-ROOM-OPEN`（WARNING）、
  `SPATIAL-ROOM-SHAPE`（ERROR：dup/branch/selfx）、`SPATIAL-OPENING-SPAN`（ERROR）、
  `SPATIAL-CABINET-OUTSIDE`（WARNING）、`SPATIAL-CABINET-OPENING`（ERROR）。
- 全部不给"自动移柜"式修复：怎么解是设计决定。
- 接线：`commandBus.deriveFor()` 追加 `deriveSpatial(p).issues`——空间 issue 进入
  项目 issue 流，与 RULE-* 同一界面、同一审计。

#### 23.16.5 命令与持久化

- 命令三件套（结构性 op，镜像 wall 同构）：`opening.create / opening.delete / opening.update`，
  sideEffect `insertOpening/removeOpening/updateOpening` 带 index/前后值，undo/redo 最小可逆。
- 持久化：`wall.openings` 随 structuredClone 透传（toFileProject 不点名它）；**不升
  schemaVersion**（内容驱动只看 rows/assemblies，openings 与 provenance 同策略）。
- `projectFile.parseProjectFile` 校验**形状**（id 唯一/kind 封闭词汇/整数 mm）；span 是否
  落在墙内属语义校验 → 空间校验器报 issue，不在文件层拒绝——用户能在界面里调回来，
  而不是打不开项目。

#### 23.16.6 UI / AI / Import 边界

- UI 最小入口：墙属性面板新增「门窗洞口」区（列表/加门洞 900/加窗洞 1200/改 offset 与
  width/删除），对象树墙节点下展示洞口。不做户型编辑器/拖墙/吸附/门窗智能定位。
- **AI 契约本阶段不开放**空间实体创建（room/wall/opening 的 create 不进 AI 词汇表）——
  AI 不产墙体坐标/碰撞结论；验收断言钉死契约词表不变。
- Import：P4/P5 管线不产空间实体；不确定项照旧阻断（IMPORT-UNCERTAINTY），
  unknown 不变假确定性。

#### 23.16.7 核心文件

`core/spatial/{model,derive,validate,index}.ts`（NEW）、`core/types.ts`（Opening+Wall.openings）、
`core/rules/issueCatalog.ts`（6 个 SPATIAL 码）、`core/commandBus.ts`（三 op + 三 sideEffect + derive 接线）、
`core/commands.ts`（opening 三构造器）、`core/projectFile.ts`（openings 形状校验）、
`ui/panels/PropertiesPanel.tsx`（洞口区）、`ui/panels/ObjectTree.tsx`（展示）、
`verify/spatial-acceptance.ts`（NEW）。

#### 23.16.8 验收

- `verify:spatial` **60/60**（覆盖指令 45 项 + 容差边界负样本），接入 `verify:all`。
- 实现期抓出的真缺陷：① `pointInPoly` 射线法交叉乘不等号方向依赖 `(yj−yi)` 符号，
  初版写成依赖 `xj>xi` → 全部 inside/outside 判反（探针抓出，修正后全绿）；
  ② `roomLoop` 闭合时起点重复入列（poly 首尾重复）→ 修正为纯环；
  ③ 贴墙挡门在纯空腔几何下检不出 → 引入集中定义的 OPENING_ZONE 影响带。
- `tsc --noEmit` 0；全量非 UI 回归 42/42；旧测试零删除零放宽；schemaVersion 不变。

#### 23.16.9 停在 P8.7

不进 P8.8。不做：门扇开启包络、自动贴墙/移柜、AI 空间意图、DXF 墙体导入、图片户型识别、
Z 轴、BIM/IFC。后续候选（需明确指令）见 §20 禁止清单反向。

### 23.17 P8.8 实施记录：Spatial Constraint Integration（Unified Design Validation）

#### 23.17.1 目标与分层：本层只组合，不复制

P8.7 之后系统有两条各自成链的结论：`validatePlacementDesign`（P8.3：柜间设计语义）
与 `deriveSpatial`（P8.7：空间事实）。P8.8 的工作是**把两条链路合成一个回答**，
让系统能一次说清：柜子为什么在这里（P8.5 的 provenance / 意图）、这个位置合法吗
（Resolver）、这样放合理吗（P8.3）、违反空间事实了吗（P8.7）。

```text
Semantic Model
      │
Placement Resolver ──→ Placement Design Report（P8.3）
      │                        │
      └──→ Spatial Report（P8.7）──→ 组合（core/designValidation，P8.8）
                                   │
                            Unified Design Validation
```

三条纪律（写进代码注释，验收逐条钉）：

1. **只组合**：`report.placement` / `report.spatial` 与单独调用两条链路**逐字节相同**
   （验收 §2/§3 深比较断言）。组合层不许"顺手修一下"下层的结论。
2. **解释 ≠ 判定**：本层唯一新增的判断是**把事实翻译成人话**（哪一面抵墙 / 门口余量 /
   声明与事实是否一致）。touching / near / crossing / overlap 的判定仍**只有 P8.7 一处**，
   读的是 `facts`，不是自己再判一遍。
3. **纯函数 + 不进主链**：不改 Model、不改 placement、不调 AI、不出几何/DXF/BOM；
   **不写进 `CommandBus.deriveFor`**（那里只有可阻断生产的硬规则，设计建议混进去会污染
   `blockingErrors`）。

#### 23.17.2 数据模型（`core/designValidation/model.ts`）

```ts
DesignValidationReport {
  status: 'valid' | 'warning' | 'error'
  placement: DesignPlacementReport   // P8.3 原样
  spatial:   SpatialReport           // P8.7 原样
  findings:  DesignValidationFinding[]   // 三层合并，各自保留原码 + layer/sourceCode
  counts:    { error, warning }
  wallContacts: WallContactFact[]    // 柜↔墙语义（结构化的 ✓ 用）
  cabinets:  CabinetDesignView[]     // 单柜视图（界面「空间检查」区消费）
}
```

- **不复制 PlacementReport**：`findings` 里的 placement 条目由 `fromPlacementFinding()`
  折叠而来（只补 `layer`/`sourceCode`，文案与等级一个不改）。
- 空间层的 issue 只做"搬运 + 归属还原"（target 是墙/洞口/房间 id 时按 id 查一次，
  好让界面能按柜分组）。
- 合并后按 `(code, cabId, wallId, openingId)` **去重**：语义解释层与声明验证器
  可能命中同一条硬错（如"声明贴墙却穿墙"），同一件事只留一条。
- 单柜视图只收**明确挂在这只柜上**的结论（房间/墙/洞口自身的结构问题不混进每只柜）。

#### 23.17.3 空间语义解释层（`interpret.ts`）

柜↔墙语义（P8.7 只有 touching/near/crossing/none，这里给出设计含义）：

| 语义 | 来源 | 等级 |
|---|---|---|
| `back-wall-contact` 背面贴墙 | touching + 抵墙面 = 背面 | 正面事实，**不发结论**（不吵人） |
| `side-wall-contact` 侧面顶墙 | touching + 抵墙面 = 左/右端 | 正面事实，不发结论 |
| `front-wall-contact` 门脸朝墙 | touching + 抵墙面 = 前脸 | WARNING（门基本开不了） |
| `wall-near` 离墙有缝 | near | WARNING（报实测缝宽） |
| `floating` 没靠墙 | 与任何墙都无关系 | WARNING（"独立摆放"的形态） |
| `wall-conflict` 穿进墙里 | crossing | ERROR |

**"是哪一个面"怎么定（不写第二套旋转数学）**：设 `n` 为墙单位法线（
`wallNormalUnit`，纯派生自 `wallPolygon` 角点）、`s` 为"墙中心→柜中心"在 `n` 上的符号，
则抵墙那一面的外法线必与 `s·n` 反向且与 `n` 几乎平行 —— 四个面里恰好一个满足，唯一解。
斜向旋转（法线对不上）时回退到"面中点离墙矩形最近的那个面"，并置 `rotated: true`
（如实说明"是按最近面推的"）。面的几何一律取 `placement.faceSegmentOf`（唯一实现）。

洞口语义（§六：只加解释，不做门扇开启/人流/开合半径）：
`DESIGN-CABINET-NEAR-DOOR` / `DESIGN-WINDOW-BEHIND-CABINET`（WARNING）——
只有 P8.7 判成 `clear`（没盖住）且**室内侧判得出**时才量距离；
`overlap` 的硬错由 P8.7 的 `SPATIAL-CABINET-OPENING` 报，本层不重复报。
"离洞口影响带多远"用空间层的同一批原语量一次，**只用于报数**，不参与任何事实判定。
阈值 `DESIGN_TOL.APPROACH = 600mm` 与 `SPATIAL_TOL` 分工明确（前者只影响提示）。

#### 23.17.4 墙贴合声明验证（§五）

```ts
WallAttachDecl { cabId; face?; offset? }        // 声明只有"哪一面/留多宽缝"
verifyWallAttachment(project, decl, facts?) → { ok, fact, findings[] }
```

- **声明里没有 wallId**：哪面墙是**派生事实**（由落位与房间结构算出），写进声明就等于
  给柜子挂 `Cabinet.wallId` 那种第二份真相（§四明令禁止）。实际贴的是哪面墙，由验证器
  从事实里读出来告诉用户。
- **不新增 authored 模型字段**（不写 Cabinet、不升 schemaVersion）：验证器接受显式声明
  参数，任何授权来源（用户操作/导入/未来的 AI 提案/由知识偏好推导）都可调用。
- 与 P2 的 `validateAssemblies` 同一条纪律：**只校验声明过的**；声明与事实不符 = ERROR
  （`NOT-TOUCHING` / `FACE-MISMATCH` / `OFFSET-MISMATCH` / 穿墙走 conflict）。
- 声明贴墙却没贴上时必须说得出**差多少**，而 P8.7 的 facts 只记录 ≤NEAR 的关系
  （更远的墙不进 facts）—— 故 `nearestWallDistance()` 用空间层原语量一次，**只为报数**
  （验收断言：报出来的就是那个实测值，且 > 0，防兜底 0 假绿）。

#### 23.17.5 Intent 与 Validation 的关系（§七）

`User Intent → Resolver → Validation → Report`：意图**不豁免**验证。
验收 §6 用真实 Resolver 跑一条合法的 `align` 意图（Resolver 返回 ok），落位结果让柜体
压在墙中心线上 —— 统一验证照样报 ERROR；再叠一条"声明贴墙"也照样是 ERROR。
（Resolver 只管几何关系、不认识墙，这正是需要组合层的原因。）

#### 23.17.6 错误等级再审查（§三）

等级的唯一真相源仍是 `issueCatalog`（本层不另立一张等级表，避免漂移）：

- **ERROR（已被证明非法）**：与墙体重叠、声明贴墙而事实不符（没贴上/面不符/缝不符）。
- **WARNING（几何成立但可疑，属"设计建议"）**：门脸朝墙、离墙有缝、没靠墙、门前余量、
  窗被挡。全部给出 `manual`（"这是你要决定的事"），一个一键修复按钮都不给。
- **不发**：判不出规则的等级不设；判不出来就沉默（房间边界不闭合 → 房间关系 unknown，
  不发 floating、不发门前提示；房间没有墙 → 不发 floating）。

#### 23.17.7 Knowledge / AI / 主规则链边界（§八·§九）

- Knowledge：只学"用户明确选过的"（`user-authored`/`user-confirmed`）。
  验收用**同一命令、同一 diff、只改 authority** 的对照断言：`system-resolved`/`unknown` → 0 条，
  `user-authored` → 1 条 candidate（低置信、不自动生效）；反向再由 `source === 'system'`
  入口门禁兜住。error 状态不产偏好：设计验证层源码里没有 knowledge 导入、没有 candidate 生成。
- AI：本阶段**不扩大写入能力** —— 不新增可写命令、`shared/aiContract.mjs` 与 `ai/compile.ts`
  都不认识设计验证层；AI 仍只能"提案 → CommandBus"。允许的解释（解释 validation finding）
  走的是同一份 `DesignValidationReport` 数据，不需要新的写通道。
- 主规则链不变：`commandBus.deriveFor` 不 import 设计验证（验收源码扫描钉死）。

#### 23.17.8 UI（§十，最小展示）

柜体属性面板新增**只读**「空间检查」区：`✓ 位于「房间」内`、`✓ 背面贴墙「墙名」`、
`⚠ 离墙「墙名」还有 5mm 缝`、`✕ 穿进了墙「墙名」里`、`○ 房间边界没有闭合，判不出…`，
下面是该柜的结论清单（Pill + 文案 + fixHint）；项目属性面板给一行汇总。
**没有任何自动修复/自动拖动/自动重排按钮**，并明写"挪到哪儿、怎么收口是设计决定"。

#### 23.17.9 核心文件

`core/designValidation/{model,interpret,validate,index}.ts`（NEW）、
`core/spatial/index.ts`（开放 `wallInteriorSide` / `wallNormalUnit` / `openingZoneRect` /
`distPointSeg` 等**几何原语**给解释层复用，判定仍只有一处）、
`core/rules/issueCatalog.ts`（9 个 DESIGN 码）、`ui/panels/PropertiesPanel.tsx`（空间检查区）、
`verify/design-validation-acceptance.ts`（NEW）、`verify/fixhint-acceptance.ts`（新码 NUM_CTX 归位）。

#### 23.17.10 验收

- `verify:design-validation` **77/77**（覆盖指令 §十一 的 15 项 + 附加红线），接入 `verify:all`。
- **变异测试（确认断言真的会失败）**：把 `front` 误判成背面贴墙 → 4 条红；
  去掉"房间闭合"门禁 → 2 条红；还原后全绿。**新增断言不是摆设**。
- 一条断言初版自己写错被逮住：预期"离墙 1440mm"，实测是 840mm（最近的是上墙）——
  改成断言"文案里的数 = `nearestWallDistance` 的实测值且 > 0"，不写死数字。
- 实施期环境坑：`npm run typecheck` 在本机会 OOM（TS 7 的 Go 编译器提交内存失败，
  `VirtualAlloc … errno=1455`），`GOMEMLIMIT=1500MiB npm run verify:all` 即通过（不改代码）。
- `tsc --noEmit` 0；`verify:all` **全链绿**（38 个脚本套件 + 浏览器 `verify:ui` 686/686）；
  旧测试零删除零放宽；`schemaVersion` 不变；未新增任何模型字段。

#### 23.17.11 停在 P8.8

不进 P8.9。P8.8 明确不做：自动布局、自动贴墙、自动优化位置、AI 改布局、门扇开启模拟、
人流分析、DXF 建筑导入、图片识别户型、BIM/IFC、Z 轴、CNC。
