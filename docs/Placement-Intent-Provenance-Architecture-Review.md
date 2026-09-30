# P8.5 架构审查：Placement Intent 可追溯性（Placement Provenance）

> **状态：仅审查与方案设计，未实现、未改代码、未提交。**
> 基线 `eec86d0`（P8.4 已验收）。审查结束时工作树干净（`git status` 无输出）。
> 本文待验收；验收通过后才进入 P8.5 实现阶段。

---

## 0. 审查范围与事实清单（带位置证据）

| 事实 | 位置 |
| --- | --- |
| 空间位置唯一真相源 `Cabinet.placement {x,y,rotation}` | `src/core/types.ts:311-320` |
| 项目级**可选** authored 数据先例 `assemblies?` | `src/core/types.ts:39` |
| 柜体级 provenance 先例 `origin?: ImportOrigin`（P4 导入来源，落盘） | `src/core/types.ts:333-354` |
| Resolver 纯函数、不持久化、不新增位置字段 | `src/core/placement.ts:20-49`（头注释） |
| 唯一写入口：`cabinet.place` 一条命令原子写三字段 | `src/core/commands.ts:68`、`src/core/commandBus.ts:235` |
| 生产路径只用**单条**解析（批量 `resolvePlacements` 仅验收使用） | `src/ai/compile.ts:514,540`；`verify/attach-acceptance.ts:319,332` |
| Intent 现在只活在两处：`Command.label` 字符串、`PlanStep.action`（内存） | `src/ai/compile.ts:519,548`；`src/ai/planRunner.ts:30-46,166-173` |
| 命令日志**不落盘**（内存态；服务端 `audit.jsonl` 只记账号/安全事件） | `src/core/commandBus.ts:570-571`；`server/server.mjs:70` |
| `Command` 已有声明位：`intent?: {nl, assumptions}` | `src/core/commandBus.ts:90-91` |
| `CommandSource = 'ui'\|'ai'\|'mcp'\|'system'` | `src/core/commandBus.ts:36` |
| AI 编译的所有命令源恒为 `'ai'`（含用户点"应用"后的提交） | `src/ai/compile.ts:393` |
| P8.4 观察器用 `source` **代理**"是不是人的选择" | `src/ai/knowledge/observe.ts:55-61` |
| 序列化是 clone 不是清理器（未知字段往返保留） | `src/core/projectFile.ts:43-61`、`src/core/layoutModel.ts:176-180` |
| 旧读者容忍未知可选字段（迁移护栏 E1/E2） | `verify/migration-acceptance.ts:347-360` |
| 知识库独立于项目文件（localStorage，跨项目资产） | `src/ai/knowledge/store.ts:1-11` |
| 观察发生在命令落账那一刻 | `src/ui/App.tsx:330-348` |
| **UI 没有 alignment / attach 控件**（只有 x / y / rotation 数字框与拖拽） | `src/ui/panels/PropertiesPanel.tsx:221-227` |
| `cabinet.resize` 会补偿 placement；`assembly.move` 批量改成员 placement | `src/core/commandBus.ts:236-240,150` |

---

## A. 根因：为什么现在无法可靠学习 alignment preference

不是 Knowledge 系统的问题，是**意图 → 坐标这一步不可逆**，且**用户根本没有表达 alignment 的入口**。

### A1. `intent → coordinates` 是多对一（非单射）

同一份最终坐标，可由多个不同意图产生：

1. **等深并排**：`adjacent side=right` + `alignment ∈ {back, center, front}`，当两柜深度相等（600 贴 600，最常见）时三者算出**同一个 y**。`start/center/end` 在等长贴合面上同理坍塌。→ **alignment 在最常见情形下不可恢复。**
2. **relation 名不可恢复**：`adjacent side=right` 与 `attach targetFace=left referenceFace=right` 定义上就是同一件事（零缝隙面接触），坐标逐值相同。
3. **offset 与手动位移不可区分**：`attach offset=20` 与 `attach offset=0` + 之后 `nudge(0,20)` 同坐标，含义相反（一个仍贴着、一个已脱离）。
4. **参照物不可辨识**：对称布局下（柜子夹在两个等距邻居中间），坐标集合与多个 `referenceId` 都自洽。
5. **存在完全不经 intent 的 placement 写入**：`cabinet.resize` 的锚点补偿、`assembly.move` 的整组平移，都会改 x/y 而没有任何 intent 参与。

因此"从坐标反推"只能得到**一个能解释当前坐标的意图**（计算），而不是**用户当时选的那个意图**（记录）。前者违反铁律 9（不从最终坐标猜测用户意图），并会把 system-resolved 误当证据（违反铁律 10）。

### A2. 更硬的一条：用户今天无法"选择 alignment"

`cabinet.place` 在 `src/` 里**只**由 `ai/compile.ts` 调用；UI 侧无 attach/alignment 入口（`PropertiesPanel` 只有 x/y/rotation）。所以：

- "用户反复选择 `attach alignment=center`" 这个动作**今天不可能发生**；
- 能发生的只有"用户接受了 AI 提案里的 `center`"。

这是**产品入口缺口**，不是数据缺口。建了 provenance 也补不上最强那一类证据（用户主动改对齐方式）；只能拿到较弱的一类（用户接受 AI 的取值）。

### A3. authority 缺位（P8.4 的近似在这里塌了）

`compile.ts:393` 让 AI 编译出的命令 `source` 恒为 `'ai'`——包括用户点"应用"之后真正提交的那一次。而 P8.4 用 `source` 代理"是不是人的选择"（`observe.ts:61`）。后果：**用户确认过的语义落位被归类成 ai-inferred，结构性不产生任何证据**。这解释了为什么 alignment 类证据一条都收不到——不是观察器写错，是"谁授权的"这一维根本没被记录。

---

## B. 三方案对比

### B1. A：不持久化 Intent（需要时从坐标重推）

| 维度 | 评价 |
| --- | --- |
| 数据一致性 | 最好：不存在第二份东西 |
| undo/redo | 零影响 |
| migration | 零成本 |
| AI Proposal | 提案里的 `center` 提交后即蒸发 |
| Import | 天然 unknown，正确 |
| Knowledge | **alignment 偏好不可得**——除非违反铁律从坐标猜 → 达不到 P8.5 目标 |
| preview/commit | 无影响 |
| 长期扩展性 | 未来"参照柜移动后重新贴合（参数化联动）"做不了 |
| 侵入程度 | 零 |

**结论**：不能单独达成目标；但它是**安全底线**——任何 provenance 缺失/不可判定情形都必须退化成 A 的行为（老实说"不知道"），不得报错、不得猜。

### B2. B：记进 Semantic Model（柜体级可选字段，如 `Cabinet.placementProvenance?`）

| 维度 | 评价 |
| --- | --- |
| 数据一致性 | **中风险，可约束**：必须硬性规定"只被写、不被任何派生读取"（几何/清单/DXF/校验/P8.3 一律不读），且必须与 placement **同一条命令原子写** |
| undo/redo | **最自然**：走既有路径 set + `inverse` 快照，整块 set/还原 |
| migration | 可选字段；旧文件没有 → 行为不变。**不升 schemaVersion**（P0 口径：版本跟内容结构走；未知字段容忍已由 E1/E2 钉住） |
| AI Proposal | 直接满足：提案的 alignment 提交后仍在 |
| Import | 不写记录（缺省 = 未知），由既有的 `cabinet.origin` 回答来源 |
| Knowledge | 直接满足（commit 时刻读得到；knowledge 自身另存证据，不依赖文件） |
| preview/commit | provenance 与 placement 同一条命令 → 沙盒干跑同样是这一条 → `preview === commit` 天然成立 |
| 长期扩展性 | 单条最新记录；不适合"历史/多参照/多次重贴合"。**故应做成单条 + status，不要做成数组**（半个历史比没有更糟） |
| 侵入程度 | 中：`types.ts` + 白名单 + 构造器 +（可选）导入校验。**不动 resolver / geometry / manufacturing / 导出** |
| 主要风险 | `Cabinet` 变胖；字段紧邻 `placement`，后人容易当真相读 → 靠命名（provenance 而非 intent）+ 注释 + **源码扫描验收断言**钉死 |

### B3. C1：命令层 provenance（不落盘）

| 维度 | 评价 |
| --- | --- |
| 数据一致性 | 最好：不在模型里，不存在第二真相 |
| undo/redo | 天然一致（LogEntry 整体撤销，provenance 随命令回滚） |
| migration | 零 |
| AI Proposal | 会话内可得；**重开项目即丢失** |
| Import | 不适用 |
| Knowledge | **足够**——证据在 commit 那一刻已被复制进 knowledge 条目，而 knowledge 自己持久化（localStorage）。偏好学习不要求 provenance 跨会话 |
| preview/commit | 一致 |
| 长期扩展性 | 会话内审计够用；跨会话"为什么在这儿"不够 |
| 侵入程度 | **最小**：`Command` 加可选声明位 + `LogEntry` 带出；不改模型、不改文件 schema |

### B4. C2：项目级 provenance 集合（`Project.placementProvenance?: []`）

与 B 语义等价，但额外负担：删柜需清理孤儿记录；数组元素定位使 undo 退化成 prev/next patch（参考既有 `patchAssembly`）；复制柜体时的处理。**只有当"要存多条历史"成为明确需求时才值得**——现在不要。

### B5. C3：独立 sidecar 文件 / 独立 store

破坏"项目文件自包含"；复制/分享项目会丢一半；与"知识库是跨项目资产"的边界混淆。**否决。**

---

## C. 推荐方案

**两层互补，不是三选一：**

```
命令层 provenance  = intent 的传递通道（谁声明的、谁授权的）  → 必需
柜体级/项目级留档  = 要不要跨会话可见                        → 条件性
```

**推荐：P8.5 先做 C1（命令层），把 B（柜体级落盘）设为条件性第二阶段。**

理由：

1. P8.5 的**目标**（让 alignment preference 未来可安全学习）只要求"commit 那一刻知道用了哪个 intent、由谁授权"——C1 完全满足；knowledge 的证据是**复制进知识条目**的，不要求项目文件记住。
2. C1 **不碰 `types.ts`、不碰 project.json、不碰 resolver**，把"是否污染语义模型"这个最贵的问题推迟到真的需要它时再付。
3. B 的第二阶段切换成本低：record 结构、派生规则、失效判据与 C1 **完全同一份**，只是多"落盘 + 白名单 + 失效联动"三处。

**触发 B 的条件（任一成立即上 B）**：

- 要求"重开项目仍能回答『这个柜为什么摆在这儿』"（UI/审计需求）；
- 要求"参照柜移动后按原 intent 重新贴合"（参数化联动需求）。

> 若你认为第 ① 条属于 P8.5 的验收项，请直接说，我按 B 一次做完——不是加工作量，只是把落盘那一步提前。

**真相源（无论哪种）**：`Cabinet.placement` 仍是唯一几何真相。provenance 是**被动记录**：
- 只有 CommandBus 能写，且只写"这条命令声明了什么 + 谁授权 + 当时的版本"；
- 任何派生层（geometry / manufacturing / DXF / P8.3 校验 / BOM / 2D / 3D）**一律不读**；
- 缺失/不可判定时一律按"unknown"处理，不报错、不猜。

**Resolver 输出不变**：仍是纯 `ResolvedPlacement`（可另附调试用 trace，不参与持久化）。provenance 在命令层组装——回答 §四.7：不要让 resolver 变成持久化系统。

---

## D. 最小数据模型草案（仅草案，未落代码）

```ts
// ── ① 命令层：声明"这次落位是怎么来的"（可声明部分，不含 authority）──
// 复用 core/placement.ts 的 PlacementIntent 词汇，不新造第二套关系/面/对齐词表。
export type PlacementIntentDecl =
  | { relation: 'absolute'; x: number; y: number; rotation?: number; origin: 'authored' }
  | { relation: 'adjacent'; referenceId: string; side: PlacementSide; alignment?: PlacementAlignment }
  | { relation: 'align'; referenceId: string; alignment: PlacementAlignment }
  | { relation: 'attach'; referenceId: string; targetFace: PlacementFace;
      referenceFace: PlacementFace; alignment?: AttachAlignment; offset?: number };

interface Command {
  // ...既有字段
  /** 本次落位声明的语义意图（只声明，不决定坐标；坐标仍由 resolver 算） */
  placementIntent?: PlacementIntentDecl;
}

// ── ② 总线派生：authority 由总线判定，调用方无权声明 ──
export type PlacementAuthority =
  | 'user-authored'    // 人自己给的（界面 / 属性面板 / MCP 显式）
  | 'user-confirmed'   // AI 提案，人点「应用」确认
  | 'system-resolved'  // 系统自动（自动贴墙 / 自动落位 / 整组平移 / resize 补偿）
  | 'unknown';         // 导入、手工摆放、不可判定

export interface PlacementProvenance {
  targetId: string;
  /** null = 来源未知（导入 / 手摆）—— 不伪造 intent */
  intent: PlacementIntentDecl | null;
  authority: PlacementAuthority;
  byOp: string;                 // 'cabinet.place' | 'cabinet.create' | 'cabinet.move' | ...
  atVersion: number;            // 当时的模型版本（不是时间戳：版本是本项目唯一的可复现指针）
  status: 'live' | 'superseded';
  supersededBy?: { op: string; atVersion: number };
}
```

**刻意不存的东西与理由**：

- **不存 resolved 坐标**：避免"派生数据进项目文件"的争议；需要复核时用 intent 对当前场景重解并与 placement 比对（可判定的复算，不是猜）。
- **不存 contact/turnSide**：观察时 `placementContextOf()` 现算即可（P8.4 已如此），存了反而与 P2 事实漂移。
- **不存数组/历史**：单条 + status。要历史时再换结构，别先造半个历史。

---

## E. 生命周期

```
[声明] UI / AI / MCP / 脚本给出语义意图（无坐标）
   │    AI:    ProposalCabinet.placement → cabinet.place params
   │    人:    未来的「对齐方式」控件（今天没有 → 见缺口 A2）
   ↓
[编译] compileAction → PlacementIntent（core/placement.ts 词汇，封闭枚举）
   ↓
[解析] resolvePlacement(intent, scene) → ResolvedPlacement     ← 纯函数，行为不变
   ↓
[命令] placeCabinet(cab, resolved, source, label, intentDecl)
   │    · Command.placementIntent = 声明
   │    · Command.source          = 谁发的（ui / ai / mcp / system）
   ↓
[执行] CommandBus.execute：同一条命令原子写 placement.x/y/rotation
   │    · 派生 authority（source × 是否来自已确认的 plan）
   │    · 生成 PlacementProvenance{ intent, authority, byOp, atVersion, status:'live' }
   ↓
[留档] C1: LogEntry.provenance（会话内）   ──或──   B: Cabinet.placementProvenance（跨会话）
   ↓
[消费①] Knowledge 观察器（commit 那一刻）
   │    仅 authority ∈ { user-authored, user-confirmed } 且 intent 含 alignment / face
   │    → candidate（永不自动 active，仍走 观察→候选→人确认→active）
   ↓
[消费②] P8.3 设计语义校验 —— 只看 resolved placement，不看 intent / provenance（不变）
   ↓
[用户改动后的失效规则]（判定在总线单点执行，不靠猜）
   ├─ cabinet.rotate（只改 rotation）   → status='superseded'（朝向变了，原解析不再解释当前位置）
   ├─ cabinet.move / nudge（改 x/y）    → status='superseded'
   ├─ cabinet.resize（补偿 placement）  → status='superseded'
   ├─ assembly.move（整组平移）         → 所有成员 status='superseded'
   ├─ 重跑同一 intent（cabinet.place）  → 写新记录，status='live'
   └─ 参照柜被删 / 被移走               → 仍 live，但重解会失败 → 界面报「原落位关系已不可复现」
                                          （不静默改坐标、不自动改贴别的柜）
   ↓
[证据] superseded 记录**保留**（历史来源），不再作为 live 依据，也不再产生新偏好

[撤销/重做] provenance 与 placement 同属一条 LogEntry / 同一条命令回滚
            → 不存在独立通道，也就不会出现「模型回去了、provenance 没回去」
```

**失效判定的验收判据**（可判定的复算，非猜测）：对 `status='live'` 的记录，用其 intent 对当前场景重解，结果必须与当前 `placement` 逐值相等；不相等即为缺陷。这条只作**断言**，不作运行时判定（运行时按 above 的写入者规则判定——因为用户可能手动移回恰好贴合的位置，那仍是 manual，不能复算成 live）。

---

## F. §四 七问裁决

| # | 情形 | 裁决 |
| --- | --- | --- |
| 1 | AI Proposal 提交后还能不能知道用了 center | C1/B 下**能**（intent 随命令留档）；A 下不能 |
| 2 | attach center 后用户手动移 30mm | intent **不再 live**（superseded），但**保留为历史来源**；不发明新 intent、不产生偏好证据 |
| 3 | 只改 rotation（90→270） | 几何上原解析不再成立 → **superseded**；但 P8.4 的 orientation preference 观察**照旧**（它看的是"人改了朝向"这一事实，与 intent 是否存活无关） |
| 4 | 只改 x/y | 同 2：**invalidated（不再 live）+ retained（保留为来源）**，两者由 `status` 一个字段区分清楚 |
| 5 | undo/redo | provenance 必须与 placement **同一条命令/同一条 LogEntry** 原子回滚；禁止任何独立通道。C1 天然满足，B 走路径 set + inverse |
| 6 | Import | **不写 provenance**（缺省即 unknown），导入来源由既有 `cabinet.origin` 回答；绝不伪造 intent |
| 7 | Resolver 是否输出 provenance | **不**。Resolver 仍只输出 `ResolvedPlacement`（纯函数五不不变）；provenance 在**命令层/总线层**组装 |

## G. §五：学到 alignment preference 的最小持久化集合

```
relation，referenceId，(side | targetFace + referenceFace)，alignment，offset，authority，atVersion，status
```

- **contact / turnSide 不需要**（观察时 `placementContextOf()` 现算）；
- **resolved 坐标不需要**（会引发"派生数据进文件"争议，且复核可复算）；
- **authority 是必需的**，且是本次审查最重要的新增维度——没有它，"用户确认过的 AI 提案"永远被当成 ai-inferred。

**⚠ 但必须同时说明**：仅有数据模型**仍不足以**产生 alignment 偏好。缺一个前提——**用户主动选择 alignment 的入口**（UI 控件或等价通道）。否则能拿到的只有"用户接受了 AI 给的 center"，那是**弱证据**：可作为 candidate 并在知识面板由人确认，但不应被当成"用户亲自选了 center"。若你要求强证据，需先把这个入口排进产品待办（它不属于 P8.5 的数据模型，但决定 P8.5 的上限）。

---

## H. P8.5 实现边界（待批准）

**做**（若批准）：
1. `Command` 层 provenance 声明通道（改 `commandBus.ts` / `commands.ts`，**不动 `core/types.ts` 的 Cabinet**）；
2. authority 派生规则（替代 P8.4 用 `source` 代理 authority 的近似）；
3. Knowledge 观察器改读 authority，并把 alignment / face 类证据纳入门禁 + 上下文（仍永不自动 active）；
4. 失效（superseded）规则在总线单点执行；
5. 新增独立 acceptance + 源码扫描断言：`placement.ts` 不 import knowledge；geometry / manufacturing / export 不读 provenance。

**不做**：改 `Cabinet` 字段与 project.json、升 schemaVersion、改 resolver、改 P8.3 判据、改 UI 拖拽行为、给 AI 开坐标能力、自动重贴合、全屋布局、碰撞优化、墙/门窗、Z 轴/上下叠放、门扇开启包络、P8.5 之后的任何阶段。

---

## I. 需要你拍板的两个决策点

1. **跨会话可见是否属于 P8.5 验收项？** 是 → 直接上 B（柜体级落盘）；否 → 先 C1。
2. **是否补"用户可选 alignment"的入口？** 这决定 alignment preference 的证据强度上限（弱=接受 AI 取值；强=用户主动改）。它本身不属于数据模型，但建议同期排期。
