# 设计意图通道落地报告（2026-10-20）

## 一、先回答"画完能不能人工手动微调"

**能，能力已经相当完整，而且 AI 画的东西采纳后就是普通柜体。**

### 已有的手动编辑

| 操作 | 位置 | 说明 |
|---|---|---|
| 拖动柜体 | `Viewport` `drag.kind='body'` | 支持多选批量，走 `moveCabinetBatch` |
| 拖夹点改宽度 | `gripDrag` `cab-width-l/r` | 左右独立 |
| 拖夹点改进深 | `cab-depth-f` | |
| 拖夹点移动 | `cab-move` | |
| 拖墙端点 | `wall-start/end` | 改房间尺寸 |
| 属性面板 | `PropertiesPanel`（1075 行） | 尺寸/材质/分区/门/抽屉全都在 |

### AI 画完之后

关键在 `App.tsx:1861`：

```js
bus.replaceProject(applied.data.project, `应用 MCP/Agent 草稿 ${draftId}`);
```

草稿"采纳"后变成 **CommandBus 里的普通柜体**，和手工建的完全一样 —— 拖动、夹点、属性面板全部可用，而且**可以撤销**。

### 一个真实限制

夹点只覆盖 **宽 / 深 / 位移**，**没有改高度的夹点**。改高要去属性面板。
不建议加：柜高与层板/挂衣杆联动，拖拽改高会触发内部分区重排，风险高于改宽。

---

## 二、三步走完成情况

### ① 补构造器 —— 但**不是 6 个，是 2 个**

我上一轮说"补 6 个（至少含 storage-priority）"，**这个判断是错的**。

实测 `designIntent/vocabulary.ts` 的分类：

| 目标 | class | 能否构造 |
|---|---|---|
| kitchen-workflow | **priority** | ❌ 永远不该有 |
| **storage-priority** | **priority** | ❌ 永远不该有 |
| circulation-priority | **priority** | ❌ 永远不该有 |
| wall-contact | condition | ✅ 已有 |
| opening-clear | condition | ✅ **本次补** |
| near-opening | condition | ✅ **本次补** |
| room-inside | condition | ✅ **本次补** |
| door-swing-clear | condition | ❌ 缺扇形几何事实，暂不做 |

`priority` 类是**取舍方向**，没有"位置"可言。源码原话：

> 「储物量可以算，但"储物够不够"取决于用户放什么 —— 那是**评分类**的事，不是本阶段的词。」

**结果：可构造目标从 2/8 提升到 5/9**（词表 9 个词，含 standalone）。

### ② 开 intentRequest —— 完成

不是 action，是 **request**（与 candidateRequest / plannerRequest 同一条纪律：不改模型的东西不该进动作清单）。动作清单仍 28 条，一个字没变。

**红线保持**：`makeCandidateIntent()` 没有参数能造成 active，想生效只能走 `confirmIntent()` —— 那是用户的动作。

### ③ 端到端打通 —— 并且**修了一个真实缺陷**

**发现**：`candidateRequest` 和 `plannerRequest` 从 P9.3 起就写在提示词里，但服务端**从来没解析过**，客户端也没读。模型认真写了，用户以为生效了，实际直接蒸发。

这违反项目自己的铁律：「静默忽略是最危险的行为」。

**修复**：`intentRequest` 现在真的走完了全程 —— 提示词 → AI 输出 → 服务端 `validateIntentRequest` → 审计 → 回传 → `aiClient` 类型化。

---

## 三、端到端实测

输入：「这个衣柜现在摆放得不太合理，我希望它别跑到屋子外面去，请帮我调整一下方向」

模型输出（4.3 秒）：
```json
{ "intentRequest": {
    "goal": "room-inside",
    "scope": { "kind": "cabinet", "cabinetId": "cab_001" },
    "statement": "主卧衣柜整体（含门）不得超出主卧墙体范围"
} }
```

reply：「我把「柜体必须完整落在房间内」作为设计目标提给系统（作用对象为主卧衣柜）。系统会据此枚举几种不越界的摆法给你预览确认，不会自动采用…」

**它做对了**：正确把"别跑到屋子外面"翻译成 `room-inside`，没瞎给坐标，并主动说明"不会自动采用"。

---

## 四、验收：38 条断言

`verify/intent-channel-acceptance.ts`，已接入 `verify:all`。

| 节 | 守什么 |
|---|---|
| 1 | 契约词表 ⇄ core 词表逐项相同（防漂移） |
| 2 | room-inside 真出候选 + 落点复核 |
| 3 | near-opening / opening-clear 真出候选 |
| **3.5** | **判据本身**：直接喂事实集断言 satisfiesGoal |
| 4 | 负样本：屋外柜 / 挡门柜不被判满足 |
| 5 | 红线：AI 意图只能 candidate |
| 6 | intentRequest 契约：合法收、非法拒、几何必拒 |
| 7 | 无构造器的目标如实进 unresolved |

### 一个变异测试抓出来的教训

我第一版**只跑端到端候选生成**，然后把 `satisfiesGoal` 的 room-inside 分支改成恒 `true` —— **测试全绿**。

原因：`candidateSpots` 只枚举贴墙且不挡洞口的位置，那个判据在端到端里**从未被触发过**。

补了第 3.5 节（直接给 `satisfiesGoal` 喂构造好的事实集）后，两个变异各被抓出 3 条断言。

**这正是项目 MEMORY 里记的坑："测试通过本身可错"。**

---

## 五、回归结果

- `tsc --noEmit` 干净
- `npm run build` 通过
- `verify:intent-channel` 38/38
- `verify:design-intent` 162/162
- `verify:candidate-layout` / `verify:ai` / `verify:sheet-layout` / `verify:sync-delete` / `verify:security-hardening` 全绿

---

## 六、下一步（还没做）

1. **前端确认 UI**：`intentRequest` 已经到 `aiClient`，但界面上还没有"确认这条意图"的弹窗。
   现在它落在了 `PlanResponse` 里，需要接一个确认按钮 → `confirmIntent()` → 重新生成候选。
2. **候选预览面板接进来**：确认意图后应该触发 `generateCandidateLayouts` 并把候选画给用户选。
3. `candidateRequest` / `plannerRequest` 同样有"只写提示词、没解析"的缺陷，
   本次只修了 `intentRequest`，那两个要不要一起修由你定。

---

## 七、诚实的不确定性

- `room-inside` / `near-opening` 的候选**能生成**，但我只验证了"满足该目标"，**没有验证这些候选在视觉上是否合理**（比如会不会挤到角落）。
- `candidateSpots` 只枚举贴墙位置，所以 `room-inside` 对"房间中央的岛台"可能枚举不出合适的落点 —— 这是继承的枚举器限制，不是新构造器的问题。
- 端到端只测了 1 条 prompt，样本太小。
