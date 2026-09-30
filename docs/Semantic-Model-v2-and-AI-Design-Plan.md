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
