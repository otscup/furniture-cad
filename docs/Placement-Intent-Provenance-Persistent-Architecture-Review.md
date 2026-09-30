# P8.5-B 架构审查：Persistent Placement Provenance

> 基线：`ec3565b`（P8.5-C1 已落地）
> 阶段性质：**仅架构审查**。本文件不修改任何源码、不新增测试、不提交 commit。
> 下游实现若被接受，将以独立 commit 落地，并停在 P8.5-B。

---

## 0. 审查范围与已读代码

| 文件 | 角色 | 审查要点 |
|---|---|---|
| `core/commandBus.ts` | 命令总线 / provenance 唯一写入口 | `PlacementProvenance`(129)、`derivePlacementAuthority`(153)、`execute` 写入(1008)、`recomputeProvenance`(1513)、`undo/redo`(1430/1441)、`replaceProject`(1543) |
| `core/types.ts` | `Project`/`Cabinet`/`ImportOrigin` | `placement`(320)、`origin`(333)、`schemaVersion`(22) |
| `core/placement.ts` | `PlacementIntent`/`PlacementIntentDecl`/`ResolvedPlacement` | 落位语义词表（与 provenance 同源） |
| `core/projectFile.ts` | 序列化 / 解析 / `schemaVersion` | `serializeProjectFile`(43)、`resolveSchemaVersion`(70)、`parseProjectFile`(103) |
| `core/layoutModel.ts` | `toFileProject`（写形状唯一口径） | provenance 未进入序列化路径 |
| `ai/knowledge/observe.ts` | 观察器 | `authorityToOrigin`(77)、`alignmentFromIntent`(178)、`observeCommand`(214) |
| `ai/knowledge/model.ts` | `KnowledgeEvidence`/`KnowledgeEntry` | 证据与偏好分层 |
| `ai/planRunner.ts` | `commitPlan`/`markConfirmed` | `confirmedPlan` 打标(329) |
| `ai/import/compileImport.ts` | 导入编译 | origin 注入(28)；走 `commitPlan` 链路 |
| `ui/App.tsx` | 观察副作用 | 从 `placementProvenance` 取 authority(343)、`observeCommand` 回放(333) |

**结论先行**：当前 provenance 是**纯会话内状态**，挂在 `LogEntry.placementProvenance` 上，由总线集中重算，完全不进 `project.json`。持久化是可行的、且**不需要升 `schemaVersion`、不需要 migration**。推荐方案 **A**（每柜只存当前 live provenance）。

---

## 一、当前 provenance 的真实生命周期

```
命令进入 execute()
  └─ PLACEMENT_OPS.has(op)?
       ├─ 否 → 不写 provenance
       └─ 是 → affectedPlacementCabinets(cmd)
                 map → { targetId, intent=cmd.placementIntent??null,
                         authority=derivePlacementAuthority(cmd),
                         byOp=cmd.op, atVersion=this.modelVersion, status:'live' }
                 push 进 LogEntry.placementProvenance
  └─ this.recomputeProvenance()   ← 每次 execute / undo / redo 后都跑

recomputeProvenance():
  activeLog() 内按 targetId 分桶
  └─ 同一柜最后一条 = live，之前全 = superseded（写 supersededBy）

序列化（save）:  serializeProjectFile → toFileProject → JSON
  ⚠ placementProvenance 不在任何被序列化字段里 ⇒ 落盘即丢失

加载（load）:  parseProjectFile → 全新 CommandBus
  ⚠ 命令日志为空，activeLog() 为空 ⇒ provenance 全为空（无法从文件重建）

消费:  App.tsx 读 LogEntry.placementProvenance → authority → observeCommand
```

**四类信息的当前归属**：

1. 只存在于 Command：`cmd.placementIntent`、`cmd.source`、`cmd.confirmedPlan`（命令对象本身，属会话日志）。
2. 只存在于 activeLog（会话）：`PlacementProvenance` 记录（含 `atVersion`、`status`、`supersededBy`）。
3. 已存在于 Semantic Model：`Cabinet.placement`（几何真相）、`Cabinet.origin`（导入来源）、`Connection.origin`（关系来源）。
4. 跨会话后**不可恢复**：provenance 全部（因为不序列化）。

**根因**：provenance 的"真相"目前寄生在**命令日志**上，而命令日志是会话态、不落盘。要让 provenance 跨会话，要么把日志落盘（方案 C，重），要么把**必要的 provenance 派生事实**抽出来随柜体落盘（方案 A/B，轻）。

---

## 二、四层边界（Final Placement / Intent / Provenance / Knowledge Evidence）

必须严格分离，禁止任何一层吞掉另一层：

| 层 | 类型 / 位置 | 是什么 | 能否改几何 | 真相属性 |
|---|---|---|---|---|
| **① Final Placement** | `Cabinet.placement {x,y,rotation}`（`types.ts:320`） | 最终几何事实 | 是（它是几何本身） | **唯一几何真相** |
| **② Placement Intent** | `PlacementIntent` / `PlacementIntentDecl`（`placement.ts`） | 当时表达的落位意图（relation/face/alignment/offset） | 否（只声明） | 语义事实 |
| **③ Placement Provenance** | `PlacementProvenance`（`commandBus.ts:129`） | 解释①是怎么来的（source/authority/intent decl/op/version） | 否（被动记录） | 来源事实 |
| **④ Knowledge Evidence** | `KnowledgeEvidence` + `KnowledgeEntry`（`model.ts`） | 证明"用户长期偏好某方式" | 否 | 偏好证据 |

铁律（沿用 P8.4/P8.5）：
- **③ ≠ ④**：provenance 是"这次怎么来的"；evidence 是"可复用成偏好的"。证据只能由观察器**从命令实时产生**，不能由 provenance 直接平移（否则每次载入都 +1，见 §十一）。
- **③ 不得成为第二个位置真相**：任何派生层（几何/清单/DXF/P8.3 校验）一律不读 provenance（已有源码扫描断言守护，§8 验收）。
- **② 不进模型坐标**：`ResolvedPlacement` 仍是管道中间产物，提交后①与解析结果同一值。

---

## 三、project.json 最小持久化模型（方案 A 草案）

**原则：只持久化"解释当前 live placement 所必需"的最小事实；其余可派生或属临时态。**

每柜新增一个可选字段（跟随柜体走，与 `origin` 同姿态）：

```ts
// core/types.ts —— 加在 Cabinet 上（可选，旧文件读出来是 undefined）
export interface Cabinet {
  // …现有字段…
  /** 落位 provenance（P8.5-B，可选）。只存当前 live 记录；
   *  status / targetId / supersededBy 不落盘（加载后由总线重算）。
   *  undefined = 无来源信息（等同 unknown，绝不伪造）。 */
  placementProvenance?: PersistedPlacementProvenance;
}

/** 落盘形态：去掉会话态字段 */
export interface PersistedPlacementProvenance {
  /** 当时的落位意图声明；null = 来源未知（导入 / 手摆），不伪造 */
  intent: PlacementIntentDecl | null;
  /** 落位权威（user-authored / user-confirmed / system-resolved / unknown） */
  authority: PlacementAuthority;
  /** 产生它的命令 op（cabinet.place / move / rotate / nudge / resize / assembly.move） */
  byOp: string;
  /** 提交时的模型版本（可复现指针，不是时间戳） */
  atVersion: number;
}
```

**落盘 vs 派生对照**：

| 字段 | 落盘？ | 理由 |
|---|---|---|
| `targetId` | 否 | = 柜体自身 id，冗余 |
| `intent` | **是** | 跨会话解释"用了哪个对齐"的唯一事实；不落盘则 reload 后退化成 unknown |
| `authority` | **是** | 区分 user-confirmed vs ai-inferred 的唯一事实（§八） |
| `byOp` | 是 | 人类可读的来源类别；调试/审计用 |
| `atVersion` | 是 | 追踪"对应哪份模型"，便于判定过期 |
| `status` | 否 | 加载后重算（live / invalidated，见 §四） |
| `supersededBy` | 否 | superseded 是会话内"被后续命令取代"的瞬时态，不持久化（§十） |

**不落盘的**：完整命令日志、superseded 历史、undo/redo 历史、resolved 坐标、contact/turnSide（上下文是观察时的派生，不存）。

---

## 四、live / superseded / invalidated / unknown 语义（确定性规则，不靠猜）

| 状态 | 定义 | 如何得到 |
|---|---|---|
| **live** | 当前最能解释该柜 placement 的 provenance | 加载时种子为落盘记录；会话内由 `recomputeProvenance` 末条规则维护 |
| **superseded** | 被同柜后续落位命令取代的旧记录 | 会话内 `recomputeProvenance` 计算（不落盘，save 时丢弃） |
| **invalidated** | 声明的 intent 与**当前几何**不再一致 | **确定性重解析**：用 `resolvePlacement(intent, sceneFromProject(project))` 重算，与 `Cabinet.placement` 比对（x/y/rotation 全等于容差内 ⇒ 仍 valid；否则 invalidated） |
| **unknown** | 无语义意图或来源不可判定 | `intent === null` 或 `authority === 'unknown'`（导入 / 手摆 / 未确认 AI） |

**为什么 invalidated 必须重解析而不是标记**：用户手移柜体后 `Cabinet.placement` 变了，旧 attach provenance 仍在。不能靠"猜用户动了没"，必须拿 intent 重新解析对比几何——与 P8.3 设计语义校验同一条"只判断不重算、用纯函数核对"的纪律。重解析是 `placement.ts` 已有的纯函数，零新增算法。

> 容差：mm 整数坐标，`x/y/rotation` 全等（placement 本就整数）即 valid；任何偏差 ⇒ invalidated。无浮点误差问题。

---

## 五、最终状态一致性（save → reload 会不会漂移）

场景：`A attach B center → commit → save → 重开 → 用户手工移动 B`。

- **save 时**：`B.placementProvenance = { intent: attach(center), authority, … }` 随柜体落盘；`B.placement = 解析出的坐标`。两者此刻一致。
- **reload 时**：总线种子 `B.placementProvenance`（live），`B.placement` 从文件恢复。一致。
- **用户手移 B**：新会话 `cabinet.move` 命令 → `recomputeProvenance` 把旧 live 标 superseded、写入新 live（intent=null，authority=derived）。
- **此时旧 attach 是否还"解释"几何**：否——旧记录已 superseded，不再产生证据；新记录 intent=null（手移无语义意图）。
- **如果用户没动、只是 reload 后再看**：旧 attach 仍是 live，但 `invalidated` 检查会确认几何仍匹配（没动过）⇒ 保持 live/valid。

**不会漂移**：一致性由两道独立机制守护——
1. 落盘即"几何 + 当时意图"同时存（同一份文件，原子写）；
2. reload 后任何"意图是否还成立"都用 `resolvePlacement` **重新核对几何**，不信任落盘时的 status。

---

## 六、用户修改后的持久化语义（A–F 六情况）

> 统一前提：provenance 的 live/superseded 由总线在会话内重算；save 只落 live。

- **A. attach center，用户没再动** → live 保留，reload 后仍 live/valid。
- **B. attach center，用户移动 x/y** → 新 `cabinet.move` 命令 supersede 旧 live，写新 live（intent=null）。save 后旧 attach 消失（被用户覆盖，正确）。若用户移动**前**就 save，reload 后旧 attach 仍是 live，但 `invalidated` 检查会因几何不符而标 invalidated（诚实：意图已不再解释几何）。
- **C. attach center，用户只改 rotation** → `cabinet.rotate` 是 PLACEMENT_OP ⇒ supersede。attach intent 不含 rotation，重解析得原 x/y、未含新 rotation ⇒ 不一致 ⇒ invalidated。旧 attach 不再作为有效解释（用户主动转了向，合理）。
- **D. attach center，用户 undo** → `undo()` 调 `recomputeProvenance`，provenance 与模型原子回退（旧 live 恢复）。会话内态，未落盘；save 才固化。
- **E. redo** → 同上，重新变 live。
- **F. save → 重开 → 继续修改** → reload 把落盘 live 种子进总线；后续命令照常 supersede。无需特殊 merge 逻辑——总线只认"当前 live"，无论它来自文件还是本会话。

---

## 七、Import 必须继续诚实

两条导入链路，provenance 行为必须一致地"不伪造"：

1. **文件级导入**（`ExportPanel` / 草稿恢复 → `bus.replaceProject`）：现有逻辑(1543)已 `for (e of entries) e.placementProvenance = undefined` ⇒ 导入后 provenance 全清（落盘即 unknown）。柜体靠 `Cabinet.origin` 说明来源。**持久化后仍应如此**：import 不写 provenance，或写 `{ intent:null, authority:'unknown' }`。
2. **增量导入**（`compileImport` → `commitPlan`，per-cabinet `cabinet.create` + `cabinet.place`）：**诚实关键点**——`commitPlan` 会对所有 step 打 `confirmedPlan=true`(329)，于是 `derivePlacementAuthority` 会把这些落位判成 `user-confirmed`。但导入的落位意图来自**外部文件**，不是用户自己的落位决定。必须保证：
   - 若导入源**只给绝对坐标**（大多数 DXF/JSON）→ `cabinet.place` 不带 `placementIntent` ⇒ intent=null ⇒ provenance 诚实为"来源未知/外部"。
   - 若导入源**真的携带语义关系**（极少数结构化来源）→ 才允许带 `placementIntent`；此时 authority 记 `user-confirmed` 表示"用户确认应用了这份导入设计"，属合理。
   - **绝不允许**：把"AI/Vision 猜出的对齐"写成 `alignment=center` 而源数据并无此语义事实。

> 落地检查项（实现阶段）：在 `compileImport` / Vision 适配器中确认导入动作**默认不填 `placementIntent`**；只有显式含语义关系的来源才填。

---

## 八、AI Proposal 持久化

链路：`AI 提案 → 用户点应用 → markConfirmed() → confirmedPlan=true → commitPlan → execute → authority='user-confirmed' → 落盘`。

- 落盘的 `authority='user-confirmed'` 是**显式事实**，不依赖命令日志里的 `confirmedPlan` 标志。
- **reload 后**读到的就是 `user-confirmed`，**不可能**退化为 `ai-inferred`——这正是 P8.5-C1 修复的根因 A3 的跨会话兑现。
- 若 AI 提案**未被确认**直接落库（异常路径）：source='ai' 无 confirmedPlan ⇒ authority='unknown' ⇒ 诚实，不产生 user 证据。

---

## 九、Migration / schemaVersion（本阶段重点）

**明确结论：本阶段不升 `schemaVersion`，不需要 migration。**

1. provenance 进 `project.json` 的方式是 **`Cabinet` 上一个可选字段** `placementProvenance?`。旧读者（不认识该字段）解析 JSON 时直接忽略它，**逐字节兼容**（旧文件无该键，读出来 `undefined`）。
2. 它**不改变**任何既有结构（不碰 `units`/`rows`/`assemblies`），因此 `resolveSchemaVersion`（按内容判 0.2/0.3）的结果不变——存量文件读存仍逐字节不变。
3. **老项目无 provenance** ⇒ 字段 `undefined` ⇒ 视为 `unknown`（等同"来源不可知"），与其它未知来源同处理，无需报错或迁移。
4. **不需要 migration**：没有结构变更、没有字段语义冲突、没有旧值需要改写。
5. **provenance 缺失 ≡ unknown**：这是有意设计，不是"数据损坏"。缺失即"我们不知道这柜怎么来的"，比伪造更诚实。
6. **不允许"save 时补生成 provenance"**：provenance 只在 `execute` 真实落位命令时产生；从旧文件 reload 不出 provenance（因为旧文件没有），不能事后倒推。
7. **逐字节兼容原则守护**：`serializeProjectFile` 经 `toFileProject` 保持键序；新增可选字段追加在末尾，旧读者忽略，新读者可选读——与 `ImportOrigin`(P4)、`Connection.origin`(P2) 完全一致的前例。

> 若未来某天 provenance 需要**破坏性**结构变更（目前看不需要），才触发 `schemaVersion` 升级 + migration；本阶段不构成该情形。

---

## 十、数据大小与历史膨胀

- **只存每柜 live provenance**：1 柜 ≈ 1 个小对象（intent 声明 + 4 标量）。100 / 500 / 1000 柜体 ⇒ 约 100 / 500 / 1000 条，JSON 增量 < 几十 KB 量级，可忽略。
- **superseded 不落盘**：它是"被后续命令取代"的会话瞬时态，只在会话内支撑"末条=live"重算；save 时只写 live，历史随日志丢弃。
- **undo/redo 历史仍只存 session**：`CommandBus` 日志不落盘（与现在一致），provenance 持久化不改变这一点。
- **不需要 version/hash**：provenance 内已带 `atVersion`（模型版本指针）；跨会话一致性由 §四 重解析保证，不需要对 provenance 自身做哈希。
- **目标达成**：解释能力足够（谁、什么来源、什么意图、是否用户确认），但不是完整操作日志数据库。

---

## 十一、Knowledge 的关系与 evidence 去重

链路（持久化后）：

```
持久化 provenance（落盘）
   ↓ reload：总线**种子** provenance 为 live 状态
   ↓ 不触发 observeCommand（不回放命令）
观察器
   ↓ 只在【本会话新执行的命令】上运行（App.tsx:333 回放新增 LogEntry）
Knowledge candidate
```

**去重机制（双保险）**：

1. **主保险（结构性）**：reload 只把 provenance **作为状态种子进总线**，绝不调用 `observeCommand` 回放。观察器只在"本会话新增的 `LogEntry`"上运行（App 的 `observedSeqRef` 闸门：只处理 `seq > 上次已观察的 seq`）。因此：
   - 保存一次 → 打开一次 ⇒ 不产生任何 candidate（没新命令）。
   - 多次开关 ⇒ 不会 +1 自我强化。
2. **次保险（内容合并）**：`recordObservation` 已按 `(kind, op, value, contextKey, scope)` 合并同一条（涨置信不新建）。即使异常路径重复喂入相同观察，也不会无限 +1。

**关键纪律**：持久化 = 恢复"来源事实"的状态，不是"重放历史产生知识"。Knowledge 证据永远只在用户**当场**做了某件事（或确认了某提案）时产生。

---

## 十二、三方案比较

### A. project.json 只保存当前 live provenance（**推荐**）
- 一致性：强。live 随柜体原子落盘；invalidated 由重解析核对；superseded 会话内维护。
- 数据量：最小（每柜 1 条）。
- migration：无（`Cabinet` 可选字段，旧读者忽略）。
- undo/redo：会话内，save 固化 live，符合预期。
- Knowledge evidence：reload 不重放 ⇒ 无自我强化（§十一）。
- Import：replaceProject 清 provenance；增量路径 intent=null 即诚实。
- AI Proposal：authority 显存，不退化。
- 多人/未来同步：单文件项目，天然单写；不影响。
- 长期扩展：将来要历史再扩 B，向后兼容（加字段即可）。
- 对 Semantic Model 侵入：极低（1 个可选字段）。

### B. project.json 保存 live + 少量不可逆历史 provenance
- 一致性：同 A，且多保留 superseded 历史。
- 数据量：中等（每柜可能多几条）。
- migration：无（仍可选字段，可存数组）。
- **价值存疑**：superseded 记录**永不产生知识**（只有 live/user-confirmed 才产）；保留它只为"审计曾发生过什么"，但 `atVersion` + 命令日志（若未来落盘）已能覆盖。当前需求不支撑其复杂度。
- 对 Semantic Model 侵入：中（数组 + 历史状态机）。

### C. 独立项目级 placement history 文件
- 一致性：需额外保证 history 文件与 project.json 原子同写（两文件易分裂）。
- 数据量：最大（趋近完整操作日志）。
- migration：需新文件格式 + 版本。
- undo/redo：与 session 日志重叠，概念混乱。
- Knowledge / Import / AI：全部要跨文件查，耦合陡增。
- 对 Semantic Model 侵入：低（不碰 Cabinet），但对**工程**侵入高（双文件同步、加载顺序、备份）。
- 结论：过度设计，否决。

---

## 十三、推荐方案

**方案 A**：`Cabinet.placementProvenance?`（单条 live，落盘形态去 status/targetId），随柜体进 `project.json`，无需升 `schemaVersion`、无需 migration。总线在 `execute`/`undo`/`redo` 后照常 `recomputeProvenance`；在 load 时把落盘 provenance 种子为 live；`invalidated` 由 `resolvePlacement` 重解析几何确定性得出；reload 不回放观察。

理由：最小必要数据、零破坏性兼容、直接兑现 P8.5-C1 的全部目标（跨会话来源可见、confirmed intent 成可靠 evidence、alignment 跨会话积累、来源不丢失），且不引入方案 B/C 的复杂度与风险。

---

## 十四、最小数据模型 TypeScript 草案（落盘形态）

```ts
// core/types.ts
import type { PlacementAuthority } from './commandBus.ts';
import type { PlacementIntentDecl } from './placement.ts';

/** 落盘形态：去掉会话态（status / targetId / supersededBy） */
export interface PersistedPlacementProvenance {
  intent: PlacementIntentDecl | null; // null = 来源未知，不伪造
  authority: PlacementAuthority;       // user-authored / user-confirmed / system-resolved / unknown
  byOp: string;                        // cabinet.place / move / rotate / nudge / resize / assembly.move
  atVersion: number;                   // 提交时模型版本（可复现指针）
}

// Cabinet 增加（可选）
export interface Cabinet {
  // …现有…
  placementProvenance?: PersistedPlacementProvenance;
}
```

> 注意：`PlacementAuthority` 现在定义在 `commandBus.ts`(127)；为打破"类型从总线倒灌 core"的环，建议把它与 `PlacementIntentDecl` 一并移入 `core/placement.ts`（纯类型、无运行时依赖），`commandBus.ts` 改为 re-export。这是实现阶段的伴随重构，不新增语义。

总线侧需新增（实现阶段，非本审查）：
- `loadProvenanceFromProject(project)`：把每柜 `placementProvenance` 种子为 live（status 重算）。
- `serializeProjectFile` 透传该字段（经 `toFileProject`）。
- `recomputeProvenance` 在种子基础上继续维护 live/invalidated。
- `replaceProject` 保持清空（导入诚实）。

---

## 十五、P8.5-B 最小实现边界（若被采纳）

只解决：

```
session provenance ──→ project persistence ──→ reload ──→ provenance consistency ──→ knowledge evidence dedup
```

具体：
1. `Cabinet.placementProvenance?` 类型 + `toFileProject` 透传 + `parseProjectFile` 容错（可选字段，旧文件忽略）。
2. 总线 load 时种子 live；`recomputeProvenance` 维护 live/invalidated（重解析核对）。
3. `save` 只落 live（superseded 不入盘）。
4. reload 不回放观察（App 闸门已天然满足， implementation 只需确认不新增回放路径）。
5. 验收：跨会话来源可见、`user-confirmed` 不退化、import 诚实（intent=null）、手移→invalidated、alignment 跨会话可累积（用户确认后）。
6. 源码扫描断言：provenance 仍只住总线 + 观察器参数，派生层不读。

**不顺便做**：
- 完整 command history 落盘
- 云端同步 / 多人协作
- UI redesign / alignment UI 入口
- 全屋布局 / 自动 Placement / 碰撞优化
- Z 轴 / 墙 / 门窗 / 门扇开启包络
- P8.6 及以后阶段

---

## 十六、不应该做的事情（红线）

1. **不把整个 `placementProvenance` 数组原样塞进 project.json**——superseded 是会话态，落盘即污染且膨胀。
2. **不升 `schemaVersion`、不加 migration**——可选字段已逐字节兼容，机械升级反而破坏存量文件。
3. **不让 provenance 成为第二个位置真相**——任何派生层（几何/清单/DXF/P8.3）仍禁止读 provenance（§8 断言守护）。
4. **不在 import 时伪造 intent**——外部来源无语义关系 ⇒ `intent=null`；绝不写 `alignment=center` 之类猜测。
5. **不让 reload 重放观察**——否则 candidate 无限自我强化（§十一）。
6. **不把 `resolved` 坐标 / contact / turnSide 存进 provenance**——它们是会话派生上下文，落盘即失真。
7. **不把 provenance 直接平移成 Knowledge evidence**——evidence 只能由观察器实时产生。
8. **不修改 `Cabinet.placement` 语义**——它仍是唯一几何真相，provenance 只解释、不决定。

---

## 待拍板点（交回用户验收）

1. **是否采纳方案 A**（推荐）：每柜只存 live provenance，不升 schemaVersion。
2. **`invalidated` 是否需要在 reload 时主动写回文件**：建议"不写回，只在内存计算"——落盘只存原始事实（intent/authority/byOp/atVersion），live/invalidated 永远由总线现算。这样文件最小、且不会因"上次算出的 invalidated"被当成真相固化。
3. **`PlacementAuthority` 是否随 `PlacementIntentDecl` 一起迁入 `core/placement.ts`**（打破类型环的伴随重构）——建议迁。
