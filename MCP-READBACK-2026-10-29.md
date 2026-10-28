# 2026-10-29 · 三个读回工具 + 出图纸面下限

「按你说的都装上」的落地记录。上一个提交 `eca3478` 让压字变成`cad.lint_drawing`能报出来的事实；
这次补的是**看**（render）、**读回**（get_views）、**人体工学输入**（set_project），以及纸面线宽/字号下限。

## 1. 装了什么

| 工具 / 修复 | 解决的具体问题 | 位置 |
| --- | --- | --- |
| `cad.get_views` | 模型画完就瞎：没有任何工具能读回图元，只能猜自己画成什么样 | `app/server/mcp.mjs`、`app/server/exportCore.mjs`、`app/scripts/views-cli.ts` |
| `cad.render` | 唯一能判断「好不好看」的通道：无头 Chrome 出 PNG，返回文件路径 | 同上 |
| `cad.set_project` | `customerHeight` 是 ERGO-* 规则的唯一输入，此前 MCP 侧根本没有写入路径，规则永远不触发 | `app/server/mcpWrite.mjs` |
| 纸面最小线宽/字号 | 420mm 页面把 10m 图幅缩到 0.029，0.5 的线宽落到纸上只有 0.042mm，打印等于消失 | `app/src/export/roomBook.ts` |
| 导出前文字避让 | 导出面板里文字压住衣物/五金示意线 | 同上 |

工具数 19 → 22，三个都进了内置 agent 的白名单与系统提示（`app/server/agentLoop.mjs:506-508`）。

## 2. 数字（实测，不是估算）

柜体页（样例主卧衣柜 2400×2400×600，model viewBox 14000×10000 → A3 槽位 420×297mm，scale 0.02935）：

| 项 | 修改前 | 修改后 |
| --- | --- | --- |
| 最细线宽 | 0.042 mm | **0.130 mm**（辅助）/ 0.250 mm（主线） |
| 最小字号 | 3.08 mm | 3.08 mm（本来就够，未放大） |

平面布局页（scale 0.07635）：线宽 0.130–0.293mm，最小字号 4.96mm。

避让（样例柜 internal 视图 5 条压字）：挪开 4 条（`1164`、`582`、`层板 ×1`、`门板 ×2（已移开）`），
保留 1 条（`挂衣杆 · 距内底 2134`，文字框宽 1255 模型单位，8 环内无空位）。

## 3. 验证

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `verify:drawing-tools`（新增，11 项） | 11/11 |
| `verify:print-space`（新增，21 项） | 21/21 |
| `verify:mcp` | 127/127 |
| `verify:mcp-write` | 78/78 |
| `verify:roombook` | 19/19 |
| 全量逐套件基线（120 套） | **111 通过 / 9 失败** |

9 条失败全部与本次改动无关：

- 7 条 UI 套件（`verify:ui`、`agent-room-sync-ui`、`historical-unit-id-readonly-ui`、
  `shared-panel-browser-acceptance`、`room-workspace-cabinet-groups-ui`、
  `room-workspace-roombook-identity`、`export-snapshot-ui`）：用 `git stash` 在旧 HEAD 上复现过，
  同一个失败。根因是 `verify:ui` 的 B37.server-baseline 走匿名 `GET /api/workspace`，
  服务器 `allowCreate` 只对已登录账号放行（`app/server/server.mjs:1146`、`app/server/workspaceHost.mjs:148`），
  本机没有 `app/data/` 时就 500；其余 6 条是同一条链上的兄弟。
- 2 条网关行为：`verify:agent-cache-mutations`（cached_tokens 探针）与 `verify:vision-probe`（带图请求），单跑同样失败，与提示词/代码无关。

视觉验收：样例工程导出 HTML 拆页后用无头 Chrome 截图（仓库外），俯视图、外观正面图、内部结构图齐全，
四件挂衣钩坐在挂衣杆上、衣身向下悬垂，尺寸链与信息表都在，线宽肉眼可辨。

## 4. 已知边界（必须知道的两条）

1. **导出面的自动避让目前是空转**：导出件走 `buildRawView`（`app/src/export/furnitureSheet.ts`），
   那些标签已被换成件号/尺寸，所以导出页上 `DRAW_TEXT_OVER_CONTENT` 本来就是 0。
   真正压字的 5 条存在于 `buildCabinetViews` 的 internal 视图，也就是**网页预览**。
   要根治得改 `app/src/core/geometry/views.ts` 或 `furnitureSheet.ts` 的标注布局——本次没动。
2. 线宽被顶到下限后主/辅只剩两档，细线与主线的视觉差异变小（打印可读性的取舍）。

## 5. 没做

- `cad.undo` / `cad.history`：需要先定历史栈语义，暂缓。
- `export_png_bundle`：`cad.render` 已能出单视图 PNG，成批打包没人要求，先不加。
- 「技能」文档（让外部 agent 知道这套工具怎么用）仍是空白。
- 【设计目标 intentRequest】里没有 customerHeight 相关项，模型只能靠提示词自觉。

## 6. 坑（复现命令前先读）

- 跑任何套件前设 `TEMP/TMP` 到**仓库外**（`E:\DeepSeek workers\.tmp-furnicad`）。指到 `app/verify/out/tmp` 会让
  vite 的 FSWatcher 去 watch Chromium 的 CDP profile，`EBUSY` 直接把 dev server 打死，所有浏览器套件报「界面未在 15s 内挂载」。
- `verify:all` 是 `&&` 链，第一个失败就中止，不能当基线；基线用 `app/verify/out/tmp/run-all2.mjs`。
- 残留的 `node serve.mjs` 会占住 8791，让 `verify:ui` 报 EADDRINUSE；先 `Stop-Process` 再跑。
- `app/verify/agent-cache-mutation.mjs:132` 变异的是系统提示里那句原文 `- 完成后调用 cad.validate 确认 0 错误。`，
  改这句会打红变异套件；新指令只能另起一条。
