# 视图缓存：把拖动预览从 52ms 压到 20ms（2026-10-21）

## 摘要

性能报告里列的 #3（CommandBus 改一个字段全量重算）实测下来，
真实收益比报告说的小 —— 但**用户能感知**的那部分（拖动掉帧）确实存在，也确实修好了。

| 指标 | 优化前 | 优化后 | 加速 |
|---|---|---|---|
| `buildProjectViews`（120 柜） | 43.2 ms | **11.3 ms** | 3.8× |
| `generateProject`（120 柜） | 56.9 ms | **18.4 ms** | 3.1× |
| **拖动一帧** | 52.4 ms | **19.9 ms** | 2.6× |
| 拖动一帧（30 柜） | 15.3 ms | **5.8 ms** | 2.6× |

19.9ms/帧 ≈ 50 FPS（优化前 19 FPS，明显掉帧）。

---

## 一、先把瓶颈测准（不照搬报告）

### 报告里的数字是**冷启动**的

性能报告说「120 柜 execute 170ms/次」。我实测预热后是 **57ms** ——
差 3 倍，因为报告的数字含 JIT 预热。

### 真实拖动路径

```
Viewport.previewCommand:
  bus.preview(cmd)          →  plan(cmd)（**不派生**）→ 1.6 ms
  generateProject(r.project) →  **53.0 ms**  ← 成本全在这
```

（`plan` 不做派生，`derive()` 有 modelVersion 缓存 —— 我一开始误以为
`plan` 内部也派生，量了两遍才发现不是。）

### generateProject 的分解（120 柜，预热后）

```
generateProject 整体            56.9 ms
  ├ generateCabinet ×N           3.8 ms
  ├ buildProjectViews           43.2 ms   ← 76%
  └ detectCollisions             0.2 ms
```

### buildProjectViews 的分解

```
buildCabinetViews ×N            17.8 ms
sheetSourceKeys（指纹）          18.9 ms   ← 占一半
每柜 bboxOf(flatMap)             5.1 ms
全局 bboxOf(flatMap)             3.8 ms
标签过滤                          2.9 ms
数组 push                        1.1 ms
```

**结论：先别急着改算法 —— 这是线性增长，不是 O(N²)。**

---

## 二、为什么能缓存

### 关键观察 1：视图几何与位置无关

`buildCabinetViews` 的四个 mapper 全是**纯平移**：

```js
const mapFront: Mapper = (X, Z) => ({ x: fx + X, y: fy + Z });
const mapTop:   Mapper = (X, Y) => ({ x: fx + X, y: ty0 - Y });
const mapSide:  Mapper = (Y, Z) => ({ x: sx0 + Y, y: fy + Z });
const mapInt:   Mapper = (X, Z) => ({ x: ix0 + X, y: fy + Z });
```

几何计算**与 fx/fy 无关**。实测：

```
buildCabinetViews(cab, rules, {x: 0})    与    {x: 7777}
的图元坐标逐位相同（只是整体加了 7777）
```

### 关键观察 2：拖动改的是 placement，而 placement **不进**视图

实测：

```
改 placement.x/y 后 → 局部视图逐位相同   ✓ 可复用
改 params.width 后 → 局部视图不同       ✓ 必须重算
```

### 关键观察 3：指纹含坐标，但**排布位置**在拖动时不变

`sheetSourceKeys` 的命名空间是 `sheet:${cab.id}:${view}`（不含坐标），
但**指纹值本身含坐标** —— 位置变了指纹就变。

而 `cursorX`（排布位置）只由**柜体宽度**累加得出，与 `placement` 无关 ⇒
拖动时 `fx` 不变 ⇒ 指纹可以整体复用。

### 最终设计

```
缓存键 = cabinetContentKey(柜子内容) + '@' + fx(排布位置)
缓存值 = 已定位的 ViewSet（含图元 + meta + hinge + labels）
         以及 5 组 sourceKeys
```

**柜子内容 = params + layout.units/backUnits/rows**，**不含 placement**。

---

## 三、两个缓存

| 缓存 | 键 | 值 | 作用 |
|---|---|---|---|
| `LOCAL_VIEW_CACHE` | 内容 + fx | ViewSet | 省掉视图重算（17.8 ms） |
| `SOURCE_KEY_CACHE` | 内容 + fx | 5 组 sourceKeys | 省掉指纹重算（18.9 ms） |

两者都有**上限 256**，满了整体清空 ——
宁可偶尔重算，也不让内存无限涨。

---

## 四、验收

### 行为断言（19 项）`verify:view-cache-acceptance.ts`

1. **缓存不改变任何结果** —— 图元/指纹/排布/bbox/拾取线**逐位一致**
2. **失效边界正确** ——
   · 改 `placement`（拖动）→ 视图不变（可复用）
   · 改 `params.width` → 视图变了（正确失效）
   · 加分区 → 视图变了（正确失效）
3. **性能不退化** —— 120 柜 `generateProject`（缓存热）< 35 ms
   （优化前 56.9 ms，留近 2 倍余量）
4. **修法本身的结构断言** —— 缓存键含内容与 fx、**不含 placement**、有上限

### 变异测试（8 项）`verify:view-cache-mutation.mjs`

★ 变异测试抓出 5 处断言弱点，都已修：

1. **变异只改了一处** —— 同一个 key 表达式在两个缓存函数里都有，
   `String.replace` 只改第一处 ⇒ 第二个缓存根本没被测到。
   改成 `split().join()` 全部替换。
2. **「有上限」没查值** —— 把 256 改成 100000 也满足「有上限」，
   等于没限。改成断言**值 <= 512**。
3. **「含 fx」没查值** —— 只查源码里出现过 fx。
   改成查**具体表达式** `cabinetContentKey(cab) + '@' + fx`。
4. **期望串对不上** —— key 固定后红的是结构断言，不是结果断言。
   改了期望串。

---

## 五、没做的事（及原因）

### ❌ 改指纹算法

`canonicalPrim` 用 `JSON.stringify` 拼坐标数组 —— 实测占指纹耗时 70%（12.6/17.9 ms），
直接拼字符串能快 34%。

**但指纹值存在项目文件里**（`drawingEdits[].replacesSource`），
改算法 ⇒ 已存项目的**手工标注全部失配** ⇒ 破坏性变更。
这一轮不做。

### ❌ 改 `validateCabinet` 为增量

实测它只占 `deriveFor` 的 5%（4.4/92.7 ms）—— 收益太小，
不值得为它引入缓存失效的复杂度。

### ❌ `detectCollisions` 加 sweep 剪枝

实测只有 0.2 ms —— 现在不是瓶颈。
（报告里说它是热点，是因为报告测的是**冷启动**。）

### ❌ `deriveSpatialFacts` 的 `wallInteriorSide` 预计算表

这一轮**已经做了**（上一轮做的），实测收益明显。

---

## 六、一个方法论上的教训

性能报告里最有价值的一条**不是**某个具体优化点，而是：

> **别照搬报告里的数字。**

报告说「execute 170ms」「detectCollisions 是热点」「validateCabinet 收益有限」，
这些是在**冷启动**下量的。预热后：

| 报告的说法 | 预热后实测 |
|---|---|
| execute 170 ms | 57 ms |
| detectCollisions 是热点（120 柜 5.14 ms） | 0.2 ms |
| validateCabinet × N = 5.5 ms | 4.4 ms（占 5%） |

**如果按报告直接动手，我会去优化 `detectCollisions`（0.2 ms）和
`validateCabinet`（4.4 ms）—— 两个都不是瓶颈。**
真正的瓶颈（`buildProjectViews` 43 ms）报告里只提了一句「views 增量重算」，
而且标成「中风险，最后做」。

★ 所以：**先测，再优化。**
