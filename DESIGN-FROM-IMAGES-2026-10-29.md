# 两张图 → 一套图：能力边界与这轮补的洞（2026-10-29）

输入：一张效果图（餐边柜墙）+ 一张带尺寸的现场照（墙长 3510、层高 2440、门洞 560、冰箱位 700）。
输出（同一套语义模型生成，可重跑）：`roombook.pdf`（5 页 A3 横向）、`roombook.html`、`drawing.dxf`、`cutlist.csv`。

做的项目：4 个柜 —— 冰箱高柜 700×2400×600（设备净空 650×1850）、地柜 1920×900×600（三抽 + 3 门）、玻璃酒柜 880×1150×350、吊柜 1040×1150×350；南墙 3510×120、门洞 560（铰链远端、向内开）。板材清单：46 种板件 / 49 件 / 22.32 m² / 246 kg。

## 这轮修的真问题：平面图的墙从来不画门洞

- 现象：平面页上南墙是一整条实墙，门洞既没有缺口也没有门扇线（把页面底部墙带裁出来放大确认）。
- 根因：`app/src/core/geometry/project.ts` 的 `wallPrims` 只画整条墙，`w.openings` 从未被读；而 `app/src/viewport/renderer.ts` 的 `drawWalls` 又自己抄了一遍同样两个图元 —— 两处实现分叉，导出的图永远修不好。
- 修法：抽出 `export function wallPlanPrims(w: Wall): Prim[]`（按 `openings` 把墙切成实段、洞口两端封口、窗在洞口里画两条墙线），`generateProject` 与 `drawWalls` 都调它；墙长文字留在各自调用方（画布有缩放阈值）。
- 门扇/扇形不在这里算：直接用空间层判出来的包络（`doorSwingPrimsOf(project, roomId)`，与 `cad.validate` 的净空判定同源），PDF 平面页与 DXF PLAN 页都叠同一份；顺手给 `doorSwingPrimsOf` 加了可选 `roomId` 过滤（多房间时别的房间的门不会跑到这一页）。
- 设计侧同步：`open_001` 补了 `hinge:'end'` + `swingDirection:'into-room'`，否则空间层按「未指定」保持沉默，只留洞不画扇。

## 验收

新增 `verify/door-swing-acceptance.ts` 51a–51e：51a 洞口中心点不在任何一段墙实体里（真的断了）；51b 洞口两端各有封口线；51c 无洞口的墙仍是「一块填充 + 一条闭合轮廓」（不回归）；51d 画布与导出共用 `wallPlanPrims`（不许再各画一条）；51e 两个导出面都叠了同源扇形。

复核：door-swing 70/70、room 28、spatial 60、views 63、roombook 19、export 109、drawing-edits 52、sheet-layout 38、pickline 37、mcp 127、drawing-lint 11、print-space 22 —— 全绿；tsc 干净。（`verify:export` 第一次跑挂在一处 fetch ECONNRESET，重跑 109/109 —— 既有 flake，与本次改动无关。）

## 明确没做 / 仍缺的工具（回答「还需要什么工具」）

1. **图纸看不出外观**：效果图那种观感还没有输出通道（3D 有模型，但没有渲染悬窗/PNG 出口）。`cad.render` 一直排在待办里没动。
2. **Z 向洞口净空**：2D footprint 没有高度，所以「门上柜」（门上方 2100 起的吊柜）建模就会被判成压门洞（这轮真实发生过，只能删掉）。要建门上柜，得先给洞口/柜体一个三维占位关系。
3. **窄柜内部标注挤成一团**：冰箱高柜 700 宽，内部图里 左侧板/右侧板 旋 90° 压在洞口线上、底板 与 踢脚板 H=80 互压、顶板 贴图边 —— `cad.lint_drawing` 报了 4 条 WARNING + 1 条 OVERLAP；`lintPrims` 只报不挪（引线标注是另一套排版机制，这轮没做）。这是当前最扎眼的遗留缺陷。
4. **台面/灯带/吊顶/洞洞板** 只有部分语义（设备净空有；台面、灯带刚够出图；吊顶、洞洞板没有）。
5. **PDF 依赖外部渲染器**：本机 WeasyPrint 缺 GTK，这轮改用 `chrome --headless --print-to-pdf` 打通（5 页 A3 正常）；容器内仍走 WeasyPrint。
6. **量尺照片不能直接读**：这轮尺寸是我读图后手输进脚本的；`customerHeight` 这类现场事实没有「从图/从聊天落库」的入口（AI 合同里已有 action，但提示词没要求它问）。

## 复现

脚本在 `E:/DeepSeek workers/.tmp-furnicad/design3510/`：`build.ts`（建项目，file:// 静态 import 仓库 TS）→ `export.ts`（DXF/清单/lint，走 `app/server/exportCore.mjs`）→ Chrome 打印 PDF → `pages.py` 渲染页图 / `render.ts` 单视图 PNG。
