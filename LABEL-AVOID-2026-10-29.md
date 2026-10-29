# 内部图的字号不再压在衣服上（2026-10-29）

## 一句话

原来的标注避让器**只知道标签在哪、不知道衣服在哪**，所以把「挂衣杆 · 距内底 2134」
从杆上一路滑进衣服里。现在它一开始就把内容线（衣物/五金示意）登记成障碍，
内部结构图的压字从 5 处变成 0 处。

## 复现与证据

渲染真实样例柜的内部结构图（`app/scripts/views-cli.ts` op=png → 无头 Chrome 截图）：

- 修前：`挂衣杆 · 距内底 2134` 横穿 4 件西装；`1164` 压肩线；`582` 压挂衣杆双线；
  `层板 ×1` 被顶到衣服中间；`门板 ×2（已移开）` 宽 1014mm，跑出 2400 宽柜体 198mm。
- 修后：5 条压线全部消失，`cad.lint_drawing` 对样例柜报 **0 条问题**（图元 182）。

## 根因（`app/src/core/geometry/labels.ts`）

`LabelPlacer` 的 `placed` 里只塞过**标签框**（`reserve`/`reserveBox` 的调用方只有标签）。
`fit()` 沿 Y 轴以 `max(40, size*0.95)`≈102mm 为步长最多试 8 步，撞不上任何东西就落位 ——
它根本不知道画面上还有别的线条。

## 修法

1. **避让器内容感知**（`views.ts`）：`drawInternalLabels(I, prims.internal)`，
   在 `new LabelPlacer()` 之后先把已画出的 `F-CAB-HW` 多边形/填充（衣物、挂衣杆、
   层板上的折衣）全部 `reserveBox` 成障碍。
   **坑**：`prims.internal` 是**画布绝对坐标**，`LabelPlacer` 吃的是**视图局部坐标**；
   第一次直接喂绝对坐标，标签一个都没动（还被记成"让不开"）。
   减掉 `ix0`（视图左边）和 `fy`（视图底边）之后才对。
2. **删掉重复的净宽数字**：内部图每格顶上原来还画一遍 `582/1164`，与视图上方的分区
   尺寸链（`dims.add`，基准 900 + 行号×400）重复，且必然压住衣服肩线。尺寸链已有，删。
3. **挂衣杆标注直接落到空档**：高柜里杆与衣服肩之间只剩 150mm，塞不下 108 号字
   （避让步长 102.6），而真正空的带子在杆下 ~1300mm 处 —— 超出 8 步的搜索半径，
   所以改成锚点就放在那（`H >= 1800 ? z0+160 : rodLabelZ+190`）。
4. **删掉「虚线 = 移去后所见」图例**：892mm 宽、塞进 582mm 的格子里永远压字；
   `VIEW_NOTE.internal`（`同正视图方向 · 移去门 / 抽面 · 标注板件`）已经说了同一件事。
5. **门板标注去掉「（已移开）」**：1014mm → 不再跑出柜体边框。
6. **叠放区画"折好的衣服"**（顺带）：原来每块层板上画 3 条裸横线，看着像"层板画多了"；
   现在按参考图画上宽下窄的叶形 + 两道折纹，尺寸跟层间净空走（净空 <24mm 就不画）。
   试过把折衣放大到 78mm 高：`右侧板` 被挤出原来的位置、贴到顶柜缝上，已回退到 52mm。

## 验证

| 门 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run verify:views` | 63/63（新增 I7：内部图文字不得被 `F-CAB-HW` 线条穿过） |
| `npm run verify:drawing-lint` | 11/11，样例柜 **0 条问题**（曾是 5 条） |
| `npm run verify:print-space` | 22/22（三条断言原来钉在"已知有压字"的旧状态上，已改成"真干净 + 合成用例仍会挪"） |
| `npm run verify:roombook` / `verify:export` / `verify:complex-kitchen` | 绿 |

`verify:print-space` 之前**没有 npm 入口**，只有文件没人跑；这次加进 `package.json`
和 `verify:all`，它才算真的门。

## 全量基线（121 套，逐套跑，2026-10-29 12:35）

113 通过 / 8 失败，全部与本改动无关：

- 7 套浏览器 UI 套件（`verify:ui`、`agent-room-sync-ui`、`historical-unit-id-readonly-ui`、
  `shared-panel-browser-acceptance`、`room-workspace-cabinet-groups-ui`、
  `room-workspace-roombook-identity`、`export-snapshot-ui`）：本机没有 `app/data/` 工作区文件，
  匿名运行 `/api/workspace` 走 `allowCreate=false` 分支返回 500 `WORKSPACE_UNAVAILABLE`
  （`server/server.mjs` → `workspaceHost.mjs`）。此前已用 stash 在 HEAD 上复现过，非本次引入。
- `verify:vision-probe` 的"带图请求成功"：网关侧图片通道，与图纸无关。
- 曾判为"网关抖动"的 `verify:agent-cache` / `agent-cache-mutations` 这一轮**全绿**。

**坑（记下来别再踩）**：残留的 `node serve.mjs` 会占住 8791，后续 UI 套件变成
`EADDRINUSE / listenInCluster` 而不是真实断言的失败 —— 看到这种尾巴先
`Get-NetTCPConnection -State Listen`，别急着改代码。

## 明确没做

- 板件名（左/右侧板、顶板、踢脚板）仍然横跨自己那块 18mm 板的两条边线 —— 这是制图惯例
  （名字就写在这块板上），文字白底遮罩（mask）会更好看，但那是渲染器改动，没做。
- 顶柜被褥、枕头的比例仍按固定 mm 画，没有按格子实测重新标定。
- 洗衣机还是"外框 + 一个圆"的示意，不是参考图里那种带控制面板的写实画法。
