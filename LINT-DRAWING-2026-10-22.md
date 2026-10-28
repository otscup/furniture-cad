# 图纸静态检查 cad.lint_drawing（2026-10-22）

> 前情：参考图纸实测与挂衣杆改造见 `REFERENCE-DRAWING-2026-10-22.md`；
> 本轮要解决的是那次验收里暴露的问题——**图上的错误，工具层自己看不见**。

## 一句话

新增第 19 个 MCP 工具 `cad.lint_drawing`：纯几何、无视觉、确定性地回答
"这张图印出来能不能读"，把"文字压在衣物/五金示意线条上"变成一条可读的
issue，而不是一句要靠眼睛才发现的感觉。

## 为什么必须做（不是可选优化）

1. **没有任何工具能返回图。** `server/mcp.mjs` 里 `image|png|svg|render|preview` 零命中，
   `cad.get_state` 只回 JSON 数字。agent 画完就瞎，换更强的模型也一样瞎。
2. **压字这件事从来没被记成事实。** `src/core/geometry/labels.ts:125`
   `return !this.placed.some((b) => boxOverlap(b, box, this.margin));`
   —— `this.placed` 只登记标签（labels.ts:114 / labels.ts:147），从不登记图形线条。
   所以"挂衣杆 · 距内底 2134"横穿几件西装这件事，`cad.validate`、日志、审计全是空白。
3. 于是用户那句"你也不知道那个重叠了"是准确的，而且根因在工具面缺失，不在客户端。

## 规则：只报两条，都是能确定性判定的

| code | 含义 |
| --- | --- |
| `DRAW_TEXT_OVER_CONTENT` | 文字框被内容层（`F-CAB-HW`：衣物/五金示意）的线条真正穿过 |
| `DRAW_TEXT_OVERLAP` | 两段文字的版心互相重叠 |

- 判"穿过"用 Liang–Barsky，且要求 `t0 < t1`：擦边、碰角点都不算，避免刷噪音。
- 文字版心统一用 `labels.ts` 的 `primVisualExtent`（项目里"一个字占多大纸面"的既有定义），
  不另造一套估算。

### 被否掉的规则（重要，别再加回来）

第一版还加了"文字被任意非尺寸线穿过"和"文字跑到视图外"。在真实样例柜上**一次报 21 条**：

- 板件名（顶板 / 左侧板 / 踢脚板 / 门板）本来就横跨自己那块 18mm 板的边线——这是本项目既定画法；
- 若干标注本来就在视图留白里。

**一条 21 警告的规则等于没有规则**（人只会全忽略）。收敛到内容层后是 5 条，
且与之前人工看图挑出来的缺陷**逐条对上**。

## 实测结果（sampleProject，主卧衣柜 2400×2400×600）

```
{"ok":true,"cabinets":1,"primsChecked":165,"summary":{"ERROR":0,"WARNING":5,"INFO":0}}
```

5 条全部在主卧衣柜·internal：`1164`(6 处线条) / `582`(4) / `层板 ×1`(8) /
`挂衣杆 · 距内底 2134`(20) / `门板 ×2（已移开）`(3)。

**这 5 条是真缺陷，本轮只把它们变成可见，没有顺手改排版**——改排版是下一件事，
而且应该先由 agent 自己看着 lint 结果改（这正是这个工具存在的意义）。

## 落地

| 文件 | 作用 |
| --- | --- |
| `app/src/core/geometry/drawingLint.ts` | 纯函数 `lintPrims(prims, scope) → Issue[]`，不读文件不改图 |
| `app/scripts/lint-drawing.ts` | stdin `{project, rulesPath?}` → stdout 结果；派生失败降级为一条 ERROR issue |
| `app/server/exportCore.mjs` | `lintDrawing(project, {rulesPath})`，沿用既有"spawn TS + JSON stdin"模式 |
| `app/server/mcp.mjs` | 注册 `cad.lint_drawing`（readOnlyHint=true），加入 ALLOWED_TOOLS |
| `app/server/agentLoop.mjs` | 内置 agent 白名单 + 系统提示：validate 之后再过一遍 lint |
| `app/verify/drawing-lint-selfcheck.ts` | 11 条断言，含"板件边线穿过文字不报""视图框穿过文字不报"两条反向断言 |

自检跑法：`npm run verify:drawing-lint`（已挂进 `verify:all`）。


## 验证（2026-10-22 实测）

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | 干净 |
| `npm run verify:drawing-lint` | 11/11 |
| `npm run verify:mcp` | 127/127（工具清单 19、①3 只读声明） |
| `npm run verify:mcp-write` | 75/75 |
| 逐套件全量基线 | 119 套件，**110 绿 / 9 红** |

9 条红**全部是既有问题，与本改动无关**，逐条查过：

- 7 条是浏览器 UI 套件（`verify:ui` / `agent-room-sync-ui` / `historical-unit-id-readonly-ui` /
  `shared-panel-browser-acceptance` / `room-workspace-cabinet-groups-ui` /
  `room-workspace-roombook-identity` / `export-snapshot-ui`）。
  **证据**：把这批改动 `git stash` 掉、在 HEAD 上原样重跑，报错**逐条相同**
  （`B37.server-baseline` 拿到 500 `WORKSPACE_UNAVAILABLE`，页面侧 `/api/workspace` 匿名拿不到工作区）。
- 2 条依赖线上网关：`verify:vision-probe`（带图请求）与 `verify:agent-cache` 第 6 节
  （前缀缓存 `cached_tokens>0` 的机制验证）。后者在 `agent-cache-mutations` 里也一起红，
  单独跑 `verify:agent-cache` 同样红 —— 与提示词内容无关，是网关侧行为。

一个踩过的坑：跑基线时把 `TEMP` 指到仓库内（`app/verify/out/tmp`），
Chromium 的 CDP profile 就落在 vite 的 watch 范围内，`Cookies` 被占用触发 `EBUSY`，
**vite dev server 直接崩**，于是所有 UI 套件都报"界面未在 15s 内挂载"。
基线请把 `TEMP` 放到仓库外（我用 `E:\DeepSeek workers\.tmp-furnicad`）。

## 明确的没做

- **没有渲染口子**（`cad.render` 出 PNG）——判断"好不好看"仍然做不到，只能判断"读不读得清"。
  真要做得先定传输方式（base64 vs 落文件），本轮不碰。
- 内容层只认 `F-CAB-HW`；将来若把别的图层也算"示意图"，改 `CONTENT_LAYERS` 一处即可。
- 只查"文字被线穿"和"文字压文字"，不查"该有的标注缺失""尺寸链不闭合"。
- 5 条压字**没有修**，只是现在能看见了。
