# 更正：三步走方案里有一处判断错误

## 我上一轮说错的地方

我说「① 补 6 个缺失的意图构造器（至少 storage-priority/near-opening/room-inside，这三个能纯确定性算）」。

**storage-priority 不属于这一层，我搞错了。**

实测 `designIntent/vocabulary.ts` 里 8 个目标的分类：

| 目标 | class | scope | fact | 能否构造候选 |
|---|---|---|---|---|
| kitchen-workflow | **priority** | room | null | ❌ |
| **storage-priority** | **priority** | room | null | ❌ |
| circulation-priority | **priority** | room | null | ❌ |
| wall-contact | condition | cabinet | — | ✅ 已有 |
| opening-clear | condition | cabinet | — | ❌ |
| door-swing-clear | condition | cabinet | — | ❌ |
| near-opening | condition | cabinet | — | ❌ |
| room-inside | condition | cabinet | — | ❌ |

`priority` 类 = **取舍方向**，源码明确写着：

> 「储物量可以算，但"储物够不够"取决于用户放什么 —— 那是**评分类**的事（P9.4），不是本阶段的词。」

所以 `storage-priority` **永远不该有摆放构造器** —— 它没有"位置"可言。硬给它造一个，就是源码里说的"拍脑袋"。

## 更正后的分组

### 真的能补构造器的（condition 类，有空间事实可判定）

| 目标 | 判据（都来自已有 `SpatialFacts`） | 难度 |
|---|---|---|
| **room-inside** | `classifyCabRoom(fp, loop) === 'inside'` —— 柜体完全在房间回路内 | 低 |
| **near-opening** | `classifyCabOpening(...) === 'clear'` 且与目标洞口距离最近 | 中 |
| opening-clear | 同 near-opening 但语义是"让开"，判据相同 | 低（和上面合并） |
| door-swing-clear | 需要门扇开启扇形几何 —— **当前 spatial/derive 没有这个事实** | 高，暂不做 |

### 不该补的（priority 类，本来就没有"位置"）

kitchen-workflow / storage-priority / circulation-priority —— 这三个的正确归属是**评分/取舍**，不是摆放枚举。

---

## 所以三步走要改成

| 步 | 原计划 | 更正后 |
|---|---|---|
| ① | 补 6 个构造器（含 storage-priority） | **补 2 个**：`room-inside` + `near-opening`（opening-clear 复用同一判据） |
| ② | 开 `designIntent.propose` | 不变 |
| ③ | 开 `candidate.compare` | 不变 |

**少做一件（storage-priority），但做对了两件事**：
- `room-inside` 是**最基础的合法性约束**（柜子跑到墙外/隔壁房间），现在居然没有构造器
- `near-opening` 是**最常用的设计需求**（柜子要靠窗/靠门）

---

## 关于你问的"画完能不能人工手动微调"

**能，而且能力已经相当完整。** 我查了代码：

### 已经有的手动编辑

| 操作 | 实现位置 | 说明 |
|---|---|---|
| **拖动柜体** | `Viewport.tsx` `drag.kind='body'` | 支持多选批量移动，走 `moveCabinetBatch` |
| **拖夹点改宽度** | `gripDrag.ts` `cab-width-l/r` | 左右夹点独立 |
| **拖夹点改进深** | `cab-depth-f` | |
| **移动柜体** | `cab-move` | |
| **拖墙端点** | `wall-start/end` | 改房间尺寸 |
| **属性面板改参数** | `PropertiesPanel.tsx` 1075 行 | 尺寸/材质/分区/门/抽屉… |

### AI 画完之后能不能改？

**能。** 关键在 `App.tsx:1861`：

```js
bus.replaceProject(applied.data.project, `应用 MCP/Agent 草稿 ${draftId}`);
```

AI 草稿"采纳"之后，就变成 **CommandBus 里的普通柜体**，和手工建的完全一样 —— 所有拖动、夹点、属性面板都照常可用，而且**可以撤销**（`jumpTo` 历史）。

### 一个真实限制

夹点只支持 **宽/深/位移**，**没有"改高度"的夹点**。改高度要去属性面板。
如果你觉得这是问题，可以加 `cab-height-t` 夹点 —— 但柜高通常和层板/挂衣杆联动，拖动改高可能需要重新布局内部分区，风险比改宽度大。建议先不动。

---

## 实施顺序（更正后）

1. **`room-inside` 构造器** —— 最基础的合法性，先补
2. **`near-opening` 构造器** —— 最常用的设计需求
3. `designIntent.propose` 动作
4. `candidate.compare` 动作
5. 验收 + 接入 `verify:all`

我按这个开始做。
