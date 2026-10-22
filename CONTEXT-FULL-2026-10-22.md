# 补全项目摘要：让模型能算相对量（2026-10-22）

> 起因：NLU 评测卡扩到 122 条后，「挂衣杆再高 200」这条**完全没对**。
> 模型的回答是：「系统里没有记录这个分区的杆高基准值，给我一个当前数」。

---

## 一、★ 那句话是**事实** —— 数真的不在提示词里

评测卡里模型答：

```
「挂衣杆再高 200」
  → 「挂衣杆现在离柜内底是多少？系统里没有记录这个分区的杆高基准值，
     给我一个当前数（比如「原来是 1000」），我就按「当前值 −100」来设」
```

★ 它说得**完全对** —— 提示词里的摘要长这样：

```
· 柜体「主卧衣柜」(cabinetId=c1)：tall，1800×2400×600mm，离地=0mm，位置=(100,60)，
  2 个分区（挂衣区/挂衣杆、层板格/3层板）
```

**只有「挂衣杆」三个字，没有杆高 1800。**
模型不是笨，是**信息没给全**。

---

## 二、★ 缺口清单：AI 能改的每个数值，摘要里有没有

逐个对照契约里的参数：

| 参数 | 摘要里有？ | 影响 |
|---|---|---|
| width / height / depth | ✓ | — |
| 层板数 / 抽屉数 | ✓ | — |
| bodyLift | ✓（离地=0mm） | — |
| **rodHeight（杆高）** | **✗** | **「挂衣杆再高 200」算不出** |
| **requestedWidth（分区净宽）** | **✗** | **「这格再宽 100」算不出** |
| doorCount（门数） | ✗ | 门相关判断 |
| openingWidth/Height/Depth（电器洞口） | ✗ | 电器位相关 |
| topDrawers（顶抽） | ✗ | 组合柜判断 |

---

## 三、修法：抽一个 describeUnitFull，两处共用

★ 原来**两处拼装逻辑重复**（rows 分支与 units 分支），
本来就容易漂移 —— 这次就漂了（rows 分支连 appliance 都没有）。

```ts
function describeUnitFull(u) {
  let s = describeUnitKind(u.kind);
  if (typeof u.requestedWidth === 'number') s += `/${u.requestedWidth}宽`;
  if (u.shelves && u.shelves.count) s += `/${u.shelves.count}层板`;
  if (u.drawers && u.drawers.count) s += `/${u.drawers.count}抽`;
  if (u.doors && u.doors.count) s += `/${u.doors.count}门`;
  if (u.rod && u.rod.count) {
    s += '/挂衣杆';
    if (typeof u.rod.heightFromBottom === 'number') s += `(离底${u.rod.heightFromBottom})`;
  }
  // 电器洞口、顶抽 …
}
```

### 修完的摘要

```
2 个分区（挂衣区/900宽/挂衣杆(离底1800)、层板格/900宽/3层板）
```

---

## 四、★ 效果：三条相对量**一次算对**（之前全要追问）

```
「挂衣杆再高 200」
  → cabinet.setUnitParam { param: 'rod.heightFromBottom', value: 2000 }
    「从离柜内底 1800 升到 2000（再高 200）」                    ✓

「那个挂衣区再宽 100」
  → cabinet.setUnitWidth { width: 1000 }
    「从 900 改成 1000（+100）。若柜体是总宽硬约束模式，分区宽会按比例重新分配…」  ✓

「层板格改成 4 层」
  → cabinet.setUnitParam { param: 'shelves.count', value: 4 }
    「从 3 层改成 4 层」                                          ✓
```

★ 注意第二条：模型还**主动提醒**了 fit_total 与 fit_units 的区别 ——
那是因为它现在**看得到分区净宽**了。

---

## 五、★ 顺带发现：plan 通道**早就是对的**

`src/ai/snapshot.ts`（plan 通道的快照）**每个字段都显式列出**，
连「没有就是 null」都标出来：

```ts
requestedWidth: mm(u.requestedWidth),
drawers: u.drawers ? { count: u.drawers.count, runnerLength: mm(u.drawers.runnerLength) } : null,
shelves: u.shelves ? { count: u.shelves.count } : null,
doors: u.doors ? { count: u.doors.count, gapOuter, gapMid, material } : null,
rod: u.rod ? { count: u.rod.count, heightFromBottom: mm(u.rod.heightFromBottom) } : null,
appliance: u.appliance ? { name, openingWidth, openingHeight, openingDepth, topDrawers } : null,
```

⇒ **两条通道的口径本来就不一致**：plan 通道给全了，Agent 通道给不全。
这次修的是 Agent 通道，把它**对齐到 plan 通道的水准**。

★ 教训：**同一种信息在两条通道里各写一遍，必然漂移** ——
这次漂的方向是「Agent 通道信息更少」，正好是「更笨」的表现。

---

## 六、验收

`verify:context-summary`（13 项）加了 2 条：

- ★ 摘要里有挂衣杆高度（模型要靠它算「再高 200」）
- ★ 摘要里有分区净宽（模型要靠它算「再宽 100」）

---

## 七、★ 顺带修掉一个真 bug：「离地」写的是**挂高**

补全过程中发现的：

```
params.bodyLift = 80      ← 踢脚高（真实值）
params.mountHeight = 0    ← 挂高（吊柜才用）

摘要输出：… 1800×2400×600mm，**离地=0mm**，位置=(100,60) …
```

★ 代码里写的是 `离地=${p.mountHeight ?? 0}` —— **两个完全不同的字段**。
结果：地柜（踢脚 80mm）被显示成「离地=0mm」。

⇒ 模型看到「离地=0」，就会以为踢脚是 0 ——
「踢脚改成 100」这种相对量/基准判断会**基于错数据**。

### 修法

```
const lift = p.bodyLift ?? 0;      // 踢脚高
const mount = p.mountHeight ?? 0;   // 挂高（吊柜）
`踢脚=${lift}mm${mount ? `，挂高=${mount}mm` : ''}`
```

修完：`踢脚=80mm` ✓（挂高为 0 时**不显示** —— 地柜不需要挂高）。

---

## 八、验收

`verify:context-summary`（15 项）加了 4 条：

- ★ 摘要里有挂衣杆高度（模型要靠它算「再高 200」）
- ★ 摘要里有分区净宽（模型要靠它算「再宽 100」）
- ★ 摘要里有门板材质（「换成玻璃门」得知道现在是什么）
- ★ 摘要里的踢脚高是 bodyLift（不是 mountHeight）

★ 最后一条钉的是**字段对不对**，不只是「有没有」——
「有踢脚高」但取错字段，同样是错的。
