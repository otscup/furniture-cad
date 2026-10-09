# 对话优先的家具柜体 CAD 产品需求文档

> **版本：** 2.2　**状态：** 当前九次 `pnpm verify:all` 均 exit 1；第九轮于 2026-10-09T19:43:35Z–19:47:35Z 在 `verify:agent-room-sync-ui` 的 B45 基线初始化阶段因 CDP `Runtime.evaluate` `-32000 Promise was collected` 停止，B45 主交互未到达；详见第 1、9、10、12 节。第九轮日志及 SHA-256 保留，前八份日志哈希未变；隔离诊断不构成全链或产品结果，未跑第十轮。全链不可标绿。　**日期：** 2026-10-10
> **目标项目：** `otscup/furniture-cad`
> **产品决策：** PDF 默认每柜一页、房间布局页默认关闭；需要布局页时按房间勾选并通过 `layoutRoomIds` 传入，紧邻该房间首张柜体页之前。本文明确区分历史全链基线、九次当前全链失败、scoped QA 证据与独立 B45/CDP 隔离诊断；这些记录均不把当前全链标绿，也不判定 B45 产品通过或失败。

## 1. 产品定位与要解决的问题

本产品是为全屋定制家具设计师准备的柜体设计工作台。设计师可以用文字、效果图或尺寸图开始设计，在同一个房间工作区查看该房间所有柜体的三视图及柜体 3D 预览；需要交付时，按柜体生成清晰、可核对的横向 PDF 和 DXF。

主要用户是需要快速出方案、边沟通边修改，并把图纸交给客户、工厂或安装人员的家具设计师。生产人员是关键校验者：图纸必须保留房间和柜体名称、尺寸和视图含义，且不能靠人工猜测哪条尺寸线对应哪个柜体。

原版本存在房间内容混组、图册按房间拼版、DXF 最近邻猜配以及主界面过于复杂等问题。既有房间索引、逐柜三视图工作区、横向 PDF 和独立 DXF layout 的验证记录仍可作为历史实现基线参考。**历史全链基线**是 2026-10-09 11:13:01–11:19:15 UTC 的 `pnpm verify:all`（exit 0；常规 UI 47 段、732/732；另 3 个过滤专用 UI 流程 31/31；静态发现 52 个 section 定义，其中 5 个为 ONLY 分支），详见[历史 UI 回归证据](UI-Regression-Report-2026-10-09.md)。该运行早于当前变更，不能证明当前树为绿；旧七柜厨房及文件级导出计数也仅为历史样例。

截至本记录，当前有九次全链运行，**均 exit 1**。首轮 `pnpm verify:all` 于 2026-10-09 15:53:41Z–15:54:11Z 在 `verify:placement` 76/82 失败（6 个级联失败），原因是 placement 验收 fixture 重复 Unit ID，正确触发 fail-closed；最后完整通过段为 `verify:relations`（82/82）。第二轮于 18:09:00Z 启动，在 placement 82/82 后于 `verify:attach` 98/105 失败（7 个级联失败）；attach fixture 重复 Unit ID 导致正确 fail-closed，`offset=20` 负向用例可能 false pass。日志 mtime 为 18:09:31Z、无 `END/EXIT` footer，精确结束时间未知。第三轮于 2026-10-09 18:22:35Z–18:23:35Z 在 `verify:placement-design` 105/107 失败；最后完整通过段为 `verify:attach`（116/116）。QA 复核确认该轮重复默认 Unit ID 的 fixture 正确触发 fail-closed，且 `commitPlan.ok` 断言忽略 `applied:0, skipped:1` 而形成 false-positive；这是 fixture/验收缺口，非已确认的 validator 产品缺陷。第四轮于 2026-10-09 18:33:25Z–18:34:25Z 在 `verify:provenance` 启动时失败；此前最后完整通过段为 `verify:placement-preference`（96/96）。该轮已通过 `verify:export` 119/119（内嵌 roombook HTTP negative acceptance 17/17）、placement 82/82、attach 116/116、placement-design 111/111、placement-preference 96/96。provenance 首个验收在读取 `placementProvenance` 时因事件记录为 undefined 抛出 TypeError，没有 provenance suite 计数；QA 确认旧 acceptance fixture 的重复 Unit ID 正确触发 CommandBus fail-closed，execute 被拒绝且未写入日志，测试随后解引用空事件日志。这是 fixture/断言问题，不是已确认的生产回归。其后 `verify:provenance-persistent` 及所有后续 suite（包括 `verify:ui`）未运行。前八轮均在各自失败点前通过 `verify:export` 119/119，且均包含 roombook snapshot HTTP negative acceptance 17/17；前五轮均未运行独立 `verify:roombook`，第六轮在失败前通过独立 suite `verify:roombook` 19/19；`verify:export-snapshot-ui` 与 `verify:ui` 前八轮均未运行；第九轮在这两项之前停止，亦未运行。第五轮于 2026-10-09 18:43:48Z–18:44:48Z 在 `verify:special` 以 35 项通过、3 项失败停止，`pnpm verify:all` exit 1。此前通过 `verify:export` 119/119（其中 roombook snapshot HTTP negative acceptance 17/17）、placement 82/82、attach 116/116、placement-design 111/111、placement-preference 96/96、provenance 77/77；紧邻 `verify:special` 前的 `verify:glass` 通过 30/30。三项 special 失败由旧多柜 fixture 中 `cab_001.layout.units[0]` 与 `wine_E.layout.units[0]` 重复使用 `unit_001` 引发，正确触发身份 fail-closed，命令被拒绝后两项依赖命令结果的断言级联失败；无证据表明 `finishedEnds`/`shelves.tilt` 实现回归。其后仅修正 `app/verify/special-acceptance.ts` fixture，确保 Unit ID 全局唯一并增加前置检查，保留产品 fail-closed；独立 scoped `npm run verify:special` 于 2026-10-09 18:48:46Z–18:48:47Z 通过 38/38、exit 0（`/tmp/qa-special-2026-10-09-1848.log`），不构成全链通过。`verify:email` 及其后所有 suite 未运行；独立 `verify:roombook`、`verify:export-snapshot-ui` 和后续 suite 均未在这五次全链中执行。同一 live `WorkspaceStore` 的 ExportPanel click-to-download E2E 与 SharedPanel B48 页面仍未验证。第六轮于 2026-10-09 18:53:09Z–18:54:39Z 在 `verify:pdf-room-layout` 失败，`pnpm verify:all` exit 1；此前通过 `verify:special` 38/38、`verify:email` 23/23、独立 `verify:roombook` 19/19、`verify:agent-room-context` 15/15、`verify:sheet-backpanel` 6/6，最后完整通过 suite 为 `verify:door-dimensions` 60/60。PDF suite 首个 fixture-order assertion 通过；首次 PDF POST 返回 409 `EXPORT_SNAPSHOT_REQUIRED`，因旧 acceptance fixture 在空 server project 上导出不同的两房 fixture，且未发送 snapshot ID/hash/version。QA 确认这是旧 acceptance fixture 不兼容，不是已确认产品缺陷；生产快照 gate 正确拒绝。失败 suite 无 aggregate count；其后 `verify:fixhint` 及所有后续 suite（包括 `verify:ui`）未运行。第六轮日志 `app/verify-output/verify-all-sixth-2026-10-10.log`，SHA-256 `dfa03d238bc9ada7f2490c95c1e17d9731f3a32f8be00edf9f1bb6fb6405bee8`（START `2026-10-09T18:53:09Z`，END `2026-10-09T18:54:39Z`）。第五轮日志保留未改写：`app/verify-output/verify-all-fifth-2026-10-10.log`，SHA-256 `a99bb64ba2c4a474ade8071397525532fc60518664d2eb7b1f14ad47b69e4d99`（START `2026-10-09T18:43:48Z`，END `2026-10-09T18:44:48Z`）。前三轮日志保留且 SHA-256 见下；第四轮日志亦保留未改写：`app/verify-output/verify-all-fourth-2026-10-10.log`，SHA-256 `3f0eaf613aac64e3c9e34a5f749c14cbdde49569fbb8a52784d5df2a58045484`（START `2026-10-09T18:33:25Z`，END `2026-10-09T18:34:25Z`）。首轮 `app/verify-output/verify-all-current-2026-10-09.log`，SHA-256 `8c977a10fee4dffd49725fc805280f390b3200502320ad2d18e8d6659d3e4fbe`；第二轮 `app/verify-output/verify-all-second-2026-10-10.log`，SHA-256 `2a97f40e8f7700c628e246ed952493f6a7ad466f2a884838c62b587d713ff034`；第三轮 `app/verify-output/verify-all-third-2026-10-10.log`，SHA-256 `723699371cf41af54c89e7162bd70c5fc6c118afeba4a89d643aa28ccb6f145d`。第七轮于 2026-10-09T19:04:06Z–19:05:36Z 在 `verify:fixhint` 26/27 失败；此前最后完整通过 suite 为 `verify:pdf-room-layout` 7/7。唯一失败的 broad assertion 要求每个 design issue 都包含数字，但 `RULE-SHARED-PANEL-BLOCKED` 是聚合状态/阻断问题，没有单一数值 delta；QA/Product 确认断言过宽，未证明生产文案有缺陷。`verify:quota` 及所有后续 suite（包括 `verify:ui`）均未运行。第七轮日志 `app/verify-output/verify-all-seventh-2026-10-10.log`，SHA-256 `d4ffcd029491a833a883833e271110a2e1790966c6ac4f22feeebf733a56a7c8`（START `2026-10-09T19:04:06Z`，END `2026-10-09T19:05:36Z`）；原始日志及 footer 未改写。
第八轮于 2026-10-09T19:21:28Z–19:22:58Z 在 `verify:preflight-bugfixes` 23/24 失败，`pnpm verify:all` exit 1；此前 `verify:pdf-room-layout` 7/7、`verify:fixhint` 38/38、`verify:quota` 38/38、`verify:manufacturing` 101/101、`verify:candidate-compare` 42/42、`verify:real-furniture-request` 18/18 均通过。唯一失败为“DXF 导出成功后临时目录无新增 `furniture-dxf-*` 残留”，诊断 `ok=false fresh=0`。根因核对显示旧 fixture 的 POST 仅发送 project/which/modelVersion，没有 snapshot ID/hash/version，且隔离 server 未将同一 project 加载为 live snapshot；基于源码只能推断正式 gate 很可能在 `exportDxf` 前拒绝（可能为 409），不是日志直接观测结果。该全链日志没有记录 HTTP 状态/响应体，也没有观察到一次成功导出，因此既不能据此断言 cleanup 成功，也不能断言 cleanup 失败。第八轮原始日志 `app/verify-output/verify-all-eighth-2026-10-10.log` SHA-256 `f5c727128aad5d2a91d074885dfbfa56369a8e0c8e3f4fca0a98c54dba470e79`（START `2026-10-09T19:21:28Z`，END `2026-10-09T19:22:58Z`），原日志/footer 保持未改。其后仅修正 `app/verify/preflight-bugfixes-acceptance.ts` fixture/assertions；独立 QA `npm run verify:preflight-bugfixes` 于 2026-10-09T19:29:58Z–19:30:04Z 通过 24/24、exit 0（`/tmp/qa-preflight-bugfixes-2026-10-09-1930.log`，SHA-256 `a1bcc619de072902c8437a2406d03db2558ab6ff1e550efcf048725e9f489a7b`）。QA GET 并核对 live snapshot ID/hash/version，以同一 project+三元组 POST；QA 日志记录 DXF HTTP response 为 200、`application/dxf`、44,407 bytes；修后验收 fixture 以 `await r.arrayBuffer()` 完整消费响应体；隔离 `TMPDIR` 中 `furniture-dxf-*` 数量 before=0、after=0、fresh=0。仅 acceptance fixture/assertions 改动，生产 `exportCore` cleanup 未改。该 scoped 24/24 单独记录，不补入第八轮 23/24，也不把全链改记为通过。

第九轮于 2026-10-09T19:43:35Z–19:47:35Z 运行 `pnpm verify:all`，最终 exit 1。最后完整通过的 suite 为 `verify:room-create-persistence-ui`（13/13）；随后 `verify:agent-room-sync-ui`（B45）只通过三项 setup assertions：accounts session、tokenless 401、mock provider。baseline 初始化按 dynamic import store → GET workspace → `bus.replaceProject` 执行时，在 `browser-probe.cjs:513/1417` 遇到 CDP `Runtime.evaluate` `-32000 Promise was collected`。Agent → remote draft → confirm apply → local room sync 主交互未到达；`verify:ui` 及后续 suite 未运行。原始日志 `app/verify-output/verify-all-ninth-2026-10-10.log`，SHA-256 `0aa8b28c1df9feb2d343ea90adc88fb26b5086cd03b48848da09847e70925c68`，START `2026-10-09T19:43:35Z`，END `2026-10-09T19:47:35Z`。QA 独立只读核对该日志 footer/hash 及前八份日志哈希未变；未重跑，也无 commit/push。

**第九轮之后的单次隔离 B45/CDP 诊断（与全链结论分开；记录为组协调 follow-up，不表述为用户直接批准）：** 必须区分以下三件事，不能合并成同一根因：

1. **第九轮全链结果：** exit 1；B45 只过三项 setup assertions，baseline 初始化遇到原始 `Promise was collected`，产品主交互未到达。这不是 B45 产品通过或失败的证据。
2. **原始 CDP 症状的隔离窄复测：** 当前 worktree 的 baseline expression 总计成功 6 次（P0 一次、P1 五次）；P1 五次中原始 `Promise was collected` 复现 0/5。根因仍未确认；症状未复现，因此没有进行单变量因果探测。`replaceProject` 导致重渲染/导航、Runtime.evaluate 重叠、async import/fetch 的 awaitPromise 生命周期、timeout/cleanup/context 生命周期这四个假设均未证实也未排除。timeout 假设较弱（`evalJs` 无单次调用 timeout，cleanup 在完成/报错后执行），但没有控制实验。
3. **扩展 B45 harness 的新错误：** P0 推进至下一步时在 `browser-probe.cjs:1484` 抛出 `ReferenceError: Cannot access 'waitFor' before initialization`（TDZ），发生在 confirm/apply 之前。初版复核时 QA 未查看源码；后续只读 QA 已独立核对当前源码并确认：`:1484` 调用 `waitFor`，同一外层词法作用域中的 `const waitFor` 到 `:1999` 才初始化，因此该新增 harness 错误可由 TDZ 解释。此解释只针对扩展诊断的新 `waitFor` 错误，**不解释第九轮原始 `Promise was collected`**；后者仍未复现、根因未知。该静态定位不是修复授权。

隔离诊断使用的临时副本/日志已清理，未修复生产代码或仓库 harness；源码与第九轮日志 hash 保持不变。隔离诊断不能解释原始失败，也不构成 B45 产品通过或失败。
placement scoped `npm run verify:placement` QA 于 2026-10-09 18:02:17Z–18:02:18Z 独立通过 82/82、exit 0（`/tmp/qa-placement-2026-10-09-1802.log`）；attach scoped QA 于 18:14:19Z–18:14:20Z 独立通过 116/116、exit 0（`/tmp/qa-attach-2026-10-09-1814.log`）。第三轮之后仅修复 placement-design 测试 fixture，再由 QA scoped 运行 `npm run verify:placement-design` 于 18:28:24Z–18:28:25Z 通过 111/111；证据包括显式唯一性、dry-run 与全部步骤成功、warning、解析后位置变化，以及 commit `applied=1/skipped=0` 且 `preview==commit`。第四轮之后仅修复 `verify/placement-provenance-acceptance.ts` fixture/测试断言：每柜 Unit ID 唯一、增加 fixture 唯一性前置条件，并在读取事件日志前断言 `executeAndAssertOk` 成功。QA 独立运行 `npm run verify:provenance` 于 2026-10-09 18:39:33Z 通过 77/77、exit 0（`/tmp/qa-provenance-2026-10-09-1839.log`）。该 provenance 结果是修复后的 scoped 证据，不是第四轮全链通过，也没有 provenance suite 计数补入第四轮。placement、attach、placement-design、provenance、special 五项均为 scoped 通过而非全链通过；前述修复仅限验收 fixture/断言，未确认生产安全代码回归。第五轮之后仅修复 `app/verify/special-acceptance.ts` fixture，使 Unit ID 全局唯一并增加前置检查；QA 独立运行 `npm run verify:special` 于 2026-10-09 18:48:46Z–18:48:47Z 通过 38/38、exit 0（`/tmp/qa-special-2026-10-09-1848.log`）。该 scoped 结果不代表全链通过，也不补入第五轮计数。第六轮之后仅修复 `app/verify/pdf-room-layout-acceptance.ts`：隔离的 live server workspace 使用与导出相同的两房 fixture；GET `/api/workspace` 返回精确 project 与 snapshot 三元组，三次 HTTP PDF 请求均携带该 project 及完全一致的 ID/hash/version。QA 独立运行 `npm run verify:pdf-room-layout` 于 2026-10-09T18:58:51Z–18:59:03Z 通过 7/7、exit 0（`/tmp/qa-pdf-room-layout-2026-10-09-1858.log`）：默认 PDF 3 页；仅选 B 时 4 页、B 布局页紧邻 B 柜体页之前；仅选 A 时 4 页、A 布局页先于 A 两柜；页序断言通过。该修复仅限 acceptance fixture，生产 gate 未改，原第六轮日志未改写，不构成全链通过。QA 覆盖请求元数据及页面数/内容，但未断言响应 `X-Project-Snapshot-*` headers 与请求值完全相等；成功路径目前由同一已确认快照派生响应与 headers，但不能据此声称 header 相等已受测试。第七轮之后仅 `app/verify/fixhint-acceptance.ts` 改变，production files/copy 未改；QA 核验该项工作仅改 acceptance script、production file mtimes 未变且 diff-check 通过。QA 在 genuine validator integration 后独立运行 `npm run verify:fixhint`，于 2026-10-09T19:17:15Z–19:17:16Z 最终通过 38/38、exit 0（`/tmp/qa-fixhint-validator-integration-2026-10-09-1916.log`；此为最终结果，不以中间 34/34 作为最终证据）。测试保留 catalog-level issue/hint 覆盖，并新增真实双柜 Project/SharedPanel fixture：未确认 panel issue 由 `validateSharedPanels` 生成，`CommandBus.issues()` 保留精确 blocker reason/message 与具体 next step；数值厚度用例由 validator/CommandBus 生成，核对当前材料上限 18mm 与实际 37mm。该 scoped 通过不改变第七轮全链 26/27 exit 1。第九轮全链已运行并以 exit 1 结束；后续隔离诊断与该全链结果分开记录；截至本文更新时未运行第十轮。`verify:draft-assembly-generation` 已注册并加入 `verify:all`。NAS/Docker 实机验证仍未完成。

随附的 12 页 CAD 样例提供了本项目的版式参照：横向图框、右侧柜名/规格栏、页脚信息、清楚的尺寸链；第 11 页是“厨房布局”，第 12 页是“厨房橱柜”，说明复杂房间可按需先给布局页、再给柜体图纸。新版本不需要封面页和分解图；图纸空间优先留给柜体本身。

## 2. 目标、非目标与已确认的产品边界

### 目标

1. **房间是浏览与组织入口，柜体是图纸交付单位。** 打开一个房间，应能找到该房间的全部柜体，并查看每个柜体的外观正面图、内部结构正面图、俯视图和独立 3D 预览。
2. **导出逐柜、可读、可验证。** 默认一柜一页；可选添加房间布局页。每页都有房间名称和柜体名称。尺寸、注记、边框和标题栏不能互相覆盖或被裁切。
3. **把聊天作为主要操作入口。** 保留 AI 文本建模、效果图/尺寸图识别、连续修改和 MCP 能力；将非日常操作收纳到次级入口。
4. **在现有语义模型上修复与迭代。** 项目语义模型仍为唯一真相源；房间视图、柜体视图、PDF 和 DXF 均为派生结果。

### 非目标

- 不做通用 CAD、自由曲面或照片级效果图渲染，也不新增 DWG 导出。
- 不把分解图/爆炸图列入 MVP 的界面或交付 PDF。
- 不改造工厂 ERP、报价、排产、CNC 或完整拆单流程；现有开料清单等功能可以保留在次级菜单，但不占用主工作区。
- 不承诺识别任意手绘图、任意柜体或缺少尺寸的图片后即可直接生产。识图结果仍需展示来源、置信度和待确认项。

### 用户已确认的硬要求

- 房间页展示房间内所有柜体，而非错误地把不同房间的柜体混在一起。
- 每个柜体都能查看：**带门板的外观正面、去掉门板的内部结构正面、俯视图**；每个柜体还要有 3D 视图，3D 不要求导出。
- PDF 横向、保留房间及柜体名称；默认逐柜出页。小而相关的柜体可以合并，但若自动合并影响清晰度，优先一柜一页。
- 厨房等复杂项目可以有独立布局页，随后输出厨房柜体图；布局页是房间级信息，柜体页是柜体级信息。
- MVP 覆盖当前代码已经支持的所有柜型和结构组合，而不是只支持衣柜等单一示例。

## 3. 信息架构与关键交互

### 3.1 主工作区

桌面端采用房间优先工作区：左侧导航，中间上方是当前房间柜体设计，下方是与房间上下文绑定的聊天时间线和固定输入区，而不是右侧常驻聊天栏。

- **左侧窄栏：** 房间列表与各房间柜体数量；切换房间时，设计卡片和聊天上下文同步切换。栏底固定显示账户头像，点击打开登录/账户设置。
- **中央上方设计区：** 当前房间内每个柜体各有一张卡片，逐柜显示外观正面、内部结构和俯视图；“3D 预览”打开该柜体的独立视图。房间标题提供“添加柜体”入口，可在当前房间直接选择柜型、调整宽高深并创建，不应要求回到旧页面完成普通加柜操作。
- **中央下方聊天区：** 将对话以连续上下文时间线展示，输入区固定在聊天区底部；对话默认绑定当前房间，并提供 Agent 草案/校验/应用入口。选中柜体时明确展示房间/对象身份，避免跨房间指代错误。
- **顶部与过渡入口：** 项目名、房间/柜体概况、建房间和导出操作；旧版 CAD 高级入口在新路径成熟前继续保留，可供复杂编辑和兼容场景使用。管理、记忆、诊断等低频能力不从系统中删除。

视图需有明确图名：“外观正面”“内部结构”“俯视”“3D”。对没有门板的柜体，仍显示外观与内部两个有意义的投影，并在视图标题上说明结构差异，不能以空白图冒充视图。房间视图与柜体视图均由同一语义模型派生。

### 3.2 关键用户流程

**从文字开始设计：** 用户选择或新建房间 → 在聊天中描述柜型与尺寸 → AI 生成动作计划 → 页面显示变更内容、推断值和校验问题 → 用户确认应用 → 房间柜体卡片、三视图、3D 与问题状态更新。

**从图片开始设计：** 用户上传效果图或尺寸图并标记图片类型 → 识图提取柜体、标注尺寸、组件和不确定项 → 对“图上明确标注”与“视觉估计”分开标示 → 用户确认/修正后导入语义模型 → 后续通过聊天连续修改。缺少可靠尺寸时不得把估计值伪装成已确认的生产尺寸。

**检查单柜：** 用户进入房间 → 扫视房间布局和全部柜体 → 打开衣柜或书柜卡片查看三视图 → 切到该柜体 3D 预览 → 通过聊天或参数控件修改 → 确认视图和规则问题。

**生成交付文件：** 用户点击导出 → 选择 PDF 或 DXF、需要的房间布局页和柜体范围 → 系统列出校验问题和预计页/布局数量 → 有 ERROR 则阻断正式文件并给出修复指引；无 ERROR 时允许导出，WARNING 仅提示 → 用户按 PDF 页码或 DXF 布局名检查房间及柜体。服务端对每个导出请求重跑共享 CommandBus 校验，不能只依赖按钮禁用；MCP 调用继续使用既有只读/草稿/校验/应用边界，不因 UI 改造绕过命令总线。

## 4. MVP 功能规格与边界

| 编号 | 功能 | MVP 要求 | 验收重点 |
|---|---|---|---|
| FR-01 | 房间导航 | 列出所有房间、房间名和柜体数量；进入房间后只展示该房间柜体 | 房间顺序稳定；柜体不跨房间、不丢失、不重复 |
| FR-02 | 单柜三视图 | 每个柜体显示外观正面、内部结构、俯视三个视图 | 三视图均非空，视图标题正确，标注不会遮住主要结构 |
| FR-03 | 单柜 3D | 每个柜体可独立打开/关闭交互式 3D 预览 | 3D 与当前语义模型尺寸一致；不进入 PDF/DXF 图纸页 |
| FR-04 | 聊天与 AI | 支持自然语言创建/修改、房间/柜体上下文、方案预览和明确应用；消息以时间线展示，输入固定在聊天区底部 | AI 修改仍经 `CommandBus`；预览与实际提交使用同一组命令 |
| FR-05 | 图像输入 | 支持效果图、尺寸图识别；展示标注/估计来源、置信度和歧义 | 未确认的不确定字段不静默写成确定生产尺寸 |
| FR-06 | PDF 图纸 | A3 横向；按房间顺序逐柜生成页；每页保留房间名、柜体名、尺寸和必要标题栏 | MVP 一柜一页；无封面/汇总挤占默认图纸；图元、尺寸与标题栏无明显重叠或裁切 |
| FR-07 | DXF 图纸 | 一柜一个独立布局；房间布局单独成布局；单位毫米、中文可读 | 单柜布局内图元完整；不同柜体不在同一图纸空间互相压叠 |
| FR-08 | 导出前校验 | 正式 PDF/DXF/CSV（及备用 HTML 打印版）存在任一 ERROR 时必须拒绝；WARNING 可继续 | 界面显示错误数量、首条错误与修复提示；服务端重新校验并以结构化拒绝响应阻断绕过 UI 的请求；项目 JSON 存档不受影响 |
| FR-09 | MCP 与现有项目 | 保留 MCP、项目导入导出、历史/撤销和现有语义字段兼容 | UI、Agent、MCP 对同一对象的改动一致，旧项目升级不丢房间/柜体 |
| FR-10 | 房间内新增柜体与账户入口 | 当前房间可直接创建柜体并安全落位；左侧栏底部头像进入登录/账户设置 | roomId 必须等于所选房间；创建不依赖旧 CAD 页面；登录组件复用现有账户链路 |

### 4.1 Agent/MCP 远端草稿与浏览器本地同步

浏览器 `CommandBus` 项目与 MCP 服务端工作区是两份独立状态；Agent 创建的 draft 默认属于服务端，不代表浏览器本地项目已经改变。Agent 回复必须明确标记“服务器远端草稿”，并提供通往草稿管理/应用流程的入口；远端 apply 的服务端 `Project` 与 live version 是同步本地的唯一依据，不能用“服务器 live”标签冒充浏览器本地已更新。

- 调用 Agent 写工具前，服务端必须核验请求的房间 ID 属于当前账号的服务端 Project。ID 缺失、未分配或浏览器/服务端房间映射不一致时，在模型/MCP 写调用前拒绝，并提示用户选择或同步有效房间；不得回退到“唯一/第一个房间”。
- apply/sync 前由客户端核对浏览器本地 `localVersion`，并将核对值随 receipt 记录。服务端可核验自身 workspace/version，但没有独立可信来源验证浏览器本地版本；不得把 receipt 中的 `localVersion` 描述为服务端验证或证明的本地版本。仅当客户端确认本地 Project 与服务端基线一致、且本地版本在操作期间没有变化时，客户端才可在服务端应用后用返回的 Project 更新本地 `CommandBus`，使当前房间卡片与本地 version 一并刷新。
- 若两边基线不同，apply 只更新服务端；保留本地项目并显示“远端已应用、本地尚未同步”状态。用户另行确认整体替换本地前，必须重新读取两端版本；若确认期间任一端改变则中止。确认替换时明确警告本地未同步修改将被覆盖。

### 4.2 柜型分类与连续装配确认

- 房间工作区按柜体类型（例如地柜、吊柜、高柜）自动分类；柜体仍各自保留在分类成员列表中。相邻、同房间或存在装配名称本身，都不得自动将柜体显示为一个连续装配组。
- 连续装配仅在用户显式确认当前装配后，才可作为已确认组显示。确认记录必须绑定当时精确的成员 cabinet ID 与连接关系，并保存单调递增的关系代次。
- 成员新增/移除、连接新增/删除/变更，以及 undo/redo 所造成的关系变化，均使先前确认失效并隐藏连续组；即使撤销或重做回到外观相同的成员/连接集合，确认也不得复活。恢复组显示必须由用户再次明确确认当前关系。
- 老项目缺少确认字段/快照/有效关系代次时默认为未确认；仅有旧 `confirmed=true` 而不能证明快照有效的记录也不得视为已确认。
- 确认仅控制房间工作区里的连续组呈现，不得改变任何单柜生产图、柜体 ID、单柜导出身份或其制造明细。

### 4.3 服务端确认的不可变项目快照与导出

- PDF、DXF、CSV/开料清单与 roombook 导出必须绑定服务端确认的不可变项目快照，至少携带快照 ID、规范化项目内容 hash 与项目版本；服务端生成文件时必须以这一个快照派生全部图纸、制造数据与关联元数据。
- 缺少快照元数据，或客户端提交的项目内容、快照 ID/hash/version 与服务器当前可确认的快照不匹配、过期或互相矛盾时，必须在创建/缓存任何导出文件前拒绝。返回结构化冲突/过期原因，不得静默采用客户端展示版本或另一个 live 版本。
- 上述一致性规则适用于浏览器、HTTP 与 MCP 的所有正式生产导出入口，roombook 也不得绕过快照闸门。成功响应/下载元数据必须指回实际用于派生结果的同一快照；快照之后 live 项目变化时，不得把新旧项目的内容混合到同一导出。

### 4.4 HTTP/MCP 草稿应用的原子一致性

- HTTP 与 MCP apply 使用同一事务语义：先 reconcile 草稿关系确认状态/代次，再形成唯一规范化提交项目及其服务器确认快照；reconcile 结果、快照、版本、内容 hash 与关系代次作为同一提交结果。
- 成功响应、持久化 sync receipt、live project、重启后读取的项目及同一幂等键的 replay，必须指向同一快照以及相同版本、相同 hash 和相同最终关系代次；成功 apply 后 replay 只能返回原提交结果，不得再次递增版本/代次或重复应用。
- 持久化任一必要组成部分失败时，提交必须整体回滚：live 项目/版本、receipt、草稿消费状态及可见工作区均维持操作前状态。不得出现 response、receipt、磁盘或 live GET 相互不一致的半提交。

### 4.5 历史重复 Unit ID 的 fail-closed 与恢复

- 历史项目、草稿或 receipt 中检测到重复 Unit ID 时，服务必须 fail-closed：保留诊断与原始数据、进入只读状态，并阻断会改写受影响状态或生成生产导出的操作；不得自动改 ID、静默迁移、去重或覆盖原档。
- 恢复必须由用户明确执行健康项目恢复（例如显式选择/导入经唯一 ID 校验通过的健康项目，或经明确授权的修复/迁移流程）。完成后需重新验证 Unit ID 全局唯一及引用完整，再恢复写入/导出；不得以自动回退至样例项目或首个项目代替恢复。

### 4.6 SharedPanel 共享板原型范围

- SharedPanel 是用户**显式选择并确认**的共享台面/共同顶板制造数据原型；相邻柜体或 assembly 关系不能自动推导共享板。未显式建立共享对象时，各柜箱体顶板仍分别制造。
- 原型只处理共享件身份、成员追溯、制造尺寸/材料/厚度/饰面、封边、外挑、支撑、分段/接缝与已确认加工数据。关键输入缺失、成员/几何/材料快照过期、成员或输入歧义、加工状态未确认，或整件超出可用板幅且分段工艺未明确确认时，必须阻断生产导出。
- 只要存在尚未明确确认的 SharedPanel 草稿改动，PDF/DXF/CSV/roombook 正式导出均须锁定。用户明确确认改动后，所有正式导出必须使用同一份新的不可变快照；若丢弃草稿并恢复到旧的已确认快照，且其他导出校验通过，则可从该旧快照导出。
- 该原型**不是**结构工程或承载安全计算，不提供优化套料/nesting，也不生成或验证 CNC toolpath；参考孔位不得伪装为已确认加工指令。

MVP 的柜型覆盖以仓库的 `CabinetLayout`、`UnitSpec` 与对应生成器为准，包括当前支持的地柜/吊柜/高柜、开门与开放格、抽屉、挂衣区、层板、玻璃门/甲购件、电器预留格、上下多行、双面岛台，以及通过柜体组合表达的转角/并排等已有结构。验收使用现有复杂柜体、组合、门板、玻璃与电器夹具；“全部柜型”指**当前语义模型已表达的范围**，不扩展为任意未建模的异形家具。

## 5. 房间、柜体和图纸的数据关系

项目继续采用现有结构：`Project.rooms[]` 存房间，`Project.cabinets[]` 存柜体；每个 `Cabinet.roomId` 必须引用一个实际房间 ID。柜体继续在项目级数组中独立存放，不嵌入 `Room`，避免迁移时需要在多个房间数组之间搬运对象。房间和柜体名称是用户可读身份；导出内部关联始终使用稳定 ID，不能用名称关联。

```text
Project
├── rooms[] ──────────────────────────── 房间顺序与名称
└── cabinets[] ── cabinet.roomId ───────→ rooms[].id
      ├── authored 参数 / 分区 / 门板 / 落位
      └── 派生：2D 三视图 / 3D / 板件 / 标注 / 图纸
```

新增的 `RoomWorkspaceView` 与 `DrawingPlan` 是**派生视图数据**，默认不写入项目文件，不新增第二套柜体尺寸或位置：

```ts
RoomWorkspaceView = {
  roomId: string;
  roomName: string;
  roomLayout: DerivedRoomLayout;
  cabinets: Array<{
    cabinetId: string;
    cabinetName: string;
    views: { frontExterior: Prim[]; frontInterior: Prim[]; top: Prim[] };
    view3d: Derived3DScene;
  }>;
};

DrawingPlan = {
  pages: Array<
    | { kind: 'room-layout'; roomId: string; roomName: string }
    | { kind: 'cabinet'; roomId: string; roomName: string; cabinetId: string; cabinetName: string }
  >;
};
```

字段只是接口意图，实施时可按现有 `Prim`、`ViewSet` 与 `NeutralSheet` 类型复用，不要求照抄上述字面类型。生成 `RoomWorkspaceView` 和 `DrawingPlan` 时先建一次房间索引并校验：每个有效柜体恰好归属一个房间；引用不存在的房间时，进入显式“未分配”组并显示问题，不可自动塞入第一个房间或静默丢弃。房间顺序按 `rooms[]`；同一房间柜体页复用 `indexProjectRooms` 与房间工作区相同的稳定顺序，PDF 不另行隐藏重排。

所有几何都从语义模型和当前规则集计算。屏幕投影、PDF 和 DXF 应共享同一张 `DrawingPlan` 与同一套图元/标注来源；导出 HTML、PDF、DXF 都不能重新猜柜体尺寸、房间归属或尺寸线关联。

## 6. PDF 与 DXF 导出设计

### 6.1 PDF 页面规则

PDF 使用 **A3 横向**，采用示例里的黑白 CAD 图框、右侧柜体/规格信息栏、底部项目信息区和清楚的尺寸链。当前逐柜模板保留项目/房间/柜体标识与柜体宽高深，并在输出元数据中记录模型/规则/生成器版本；超大或复杂柜体仍需用实际打印尺寸继续验收。

柜体页至少包含三幅互相对应的投影：

1. **外观正面图：** 显示门板、抽面等外观元素。
2. **内部结构图：** 去掉门板/抽面，显示内部隔板、抽屉/挂衣/电器区等结构。
3. **俯视图：** 显示柜体宽度和进深关系。

三个视图均有清晰标题与必要尺寸；尺寸文字和引线不得互相重叠，不得遮盖关键轮廓。每个柜体独占一页；不因为“同房间”就把不同柜体强行缩小并排。房间布局页是可选房间级页面，不替代任何单柜三视图；导出面板每房间的布局复选框默认关闭，用户仅对需要布局的房间勾选。

**当前 PDF 页面顺序：** `layoutRoomIds` 缺省为空集；默认只按房间顺序与房间工作区相同的稳定柜体顺序逐柜输出，每柜一页。只为本次勾选且有可导出布局内容的房间插入布局页，并紧邻该房间第一张柜体页之前；其他房间和柜体顺序不变。页数公式为“本次导出的柜体页数 + 本次实际插入的布局页数”。默认无封面、无冗余汇总页、无分解图。

吊柜与地柜等“简单且相关柜体”合页属于允许的优化，不作为牺牲可读性的自动启发式。首版固定一柜一页，避免错误合并；只有用户明确选择合并且布局器能证明字号、尺寸链和图元包围盒均满足可读阈值时才允许合页。自动识别合页对象及阈值需在实际样例上验证后再启用。

### 6.2 DXF 页面规则

“导出全部柜体”生成一个 DXF 文件，其中每个柜体有独立、名称唯一的纸空间布局，名称包含可读的房间/柜体信息及短 ID；“导出当前柜体”只生成该柜体的图纸布局。导出面板的“房间平面布置图”是可选房间级内容，用户可勾选一个或多个房间；系统按 `rooms[]` 顺序为每个选中且有图元的房间各生成一个独立 A3 横向纸空间 layout，名称保留房间名。每个 room PLAN 与柜体图分别统一等比例适配 A3，1:1 打印并保留 5 mm 安全边距；PLAN 不再写入 modelspace，因此不会与柜体生产图叠加。默认 R2007、单位毫米、中文不转义；不同柜体仍逐柜分页。

尺寸线、文字与引线由 TypeScript 图纸图元作为唯一权威来源；Python `ezdxf` 层逐项序列化这些中立图元。**禁止用“离标注最近的任意线段”推断尺寸对象或引线对象，也不额外猜配 DIMENSION/LEADER 实体。** 这样避免实体标注与兼容线条/文字双重显示造成重叠。

### 6.3 版面自动校验

当前单柜布局器将视图和标题栏放入固定图幅区域；柜体图与可选房间 PLAN 均通过统一比例变换适配 A3。历史 PDF room-layout HTTP 验收曾检查默认无布局页及选择 A/B 房间时布局页位置；历史 DXF 回读检查布局、纸张设置和打印边界。尚无通用的任意图元碰撞求解器，仍须用真实 PDF 栅格复核重点标注。历史七柜厨房 PDF 第 4/6/8 页红色“9mm 背板”标注的 bbox 与栅格复核仅证明该历史样例中标签未与视图、图框或相邻注记重叠，不代表当前树或任意图元已有通用碰撞求解。柜体结构线之间有意接触或重合，不应被简单的“任意线相交即报错”规则误报。

## 7. 关键技术方案与取舍

1. **延续现有语义模型，不重写建模核心。** `Project.rooms[]`、`Project.cabinets[]`、`Cabinet.roomId`、`CommandBus`、参数化几何、Three.js、Agent、图像导入和 MCP 已有实现，应优先复用。房间聚合、柜体卡片、`DrawingPlan` 是新工作流层，不另造一套储存结构。
2. **先建立稳定的 room/cabinet 页面索引。** 同一个索引同时供 UI、PDF 和 DXF 使用，替换 `roomBook.ts` 当前按柜体遍历再去重的错误逻辑；不让不同导出器各自实现房间分组。
3. **TypeScript 负责所有几何与排版决策。** 延续 `neutralSheet.ts` 的原则：语义模型 → 确定性三视图/标注/页面布局 → 中立图元。PDF 渲染器与 DXF 序列化器消费同一份中立图纸数据。Python 不计算最近尺寸线，不自行排图。
4. **PDF 服务端确定性渲染。** 服务端复用同一份图纸 HTML/SVG，由锁定版本的 WeasyPrint 输出 A3 横向 PDF；固定页面尺寸、零页边距并安装 Noto CJK 字体。本机已验证真实 PDF、中文和逐柜页数；目标 NAS/Docker 仍需实机验证。
5. **DXF 保持为序列化层。** 保留 `ezdxf` 和 R2007 路线，`NeutralSheet` 携带房间/柜体身份；每个柜体各自独立 layout，房间 PLAN 按房间选择后各自独立 layout，全部按 A3 横向纸面等比例映射，modelspace 不承载这些交付图纸。Python 不再按最近邻生成 DIMENSION/LEADER。服务端专项验收包含 DXF 回读、房间顺序与页面边界检查。
6. **以模型派生的 3D 预览，不要求导出。** 延续 Three.js 懒加载，3D 预览只在用户打开时初始化，避免房间含多个柜体时首屏一次性加载所有三维资源。
7. **Agent 不直接写 live 模型。** 文字/图像意图经 `/api/ai/agent` function-calling 调用 MCP；写操作只进入 draft，Agent 执行 `cad.validate` 后返回步骤和摘要。`cad.apply_draft` 不暴露给 Agent，只有用户明确应用草稿后才进入 live 模型。
8. **高级 CAD 的手工编辑是可持久化覆盖层，不改结构真相源。** 选择/框选、移动/复制/删除、线/多段线/文字/尺寸/引线、捕捉/正交、撤销/重做和属性编辑都写入 `Project.drawingEdits` 并纳入 CommandBus；模型生成图元通过稳定 source key 建立当前视图覆盖，柜体结构性变化仍经参数/Agent 重生成。模型来源 fill 暂保持只读，闭合/虚线/文字旋转保真；房间 PLAN 和柜体 top/front/internal 复用屏幕、PDF、DXF 的派生图元。未映射的 sheet view 在加载/写入时拒绝、导出时 422 阻断。**圆形图元与通用镜像尚未实现**，不得在状态表述中误写为已覆盖。

```mermaid
flowchart LR
  AI[聊天 / 图像识别 / Agent] --> MCP[Agent function-calling → MCP draft 工具]
  MCP --> VAL[cad.validate]
  VAL -->|用户明确应用| CB[应用 draft → live 模型]
  CB --> P[项目语义模型：rooms[] + cabinets[]]
  P --> IDX[统一房间与柜体索引]
  IDX --> UI[房间工作区：当前房间全部柜体三视图 + 单柜 3D]
  IDX --> PLAN[DrawingPlan：按房间分组的逐柜图纸]
  PLAN --> PDF[横向 PDF]
  PLAN --> DXF[逐柜 DXF Layout]
```

## 8. 当前风险及处理

- **房间分组与错分：** 已用共享房间索引统一 UI、PDF、DXF 的房间顺序和柜体归属；悬空 `roomId` 进入显式“未分配”，不再被塞入首个房间。`verify:roombook` 覆盖多房多柜、名称和异常归属。
- **视图越界与门方向：** 已修复内部衣物示意超出柜顶、单扇门开向方向错误，以及项目多柜视图横向重叠；四视图验收通过 62 项。复杂柜型仍应在实际图纸样例上继续目视检查。
- **DXF 标注重复：** 最近邻猜配的 DIMENSION/LEADER 已移除，DXF 只序列化中立图元；专项 HTTP 与回读验收已通过。若未来增加原生尺寸实体，应先扩展中立标注契约。
- **PDF 部署：** 本机 WeasyPrint 和 Noto CJK 已验证真实 PDF、中文和逐柜页数；NAS/Docker 依赖安装、资源占用和目标打印机仍待实测。
- **导出校验：** ERROR 阻断正式生产导出为默认规则；WARNING 允许导出。HTTP 与 MCP 共用的 `exportCore` 在生成文件前用 `CommandBus.derive()` 服务端重算；HTTP 拒绝响应为 422 `EXPORT_BLOCKED` 并包含 ERROR 清单。项目 `.json` 存档不受生产导出闸门影响。
- **页面策略：** PDF 默认不输出 PLAN，每柜一张生产图；房间布局页通过 `layoutRoomIds` 按房间可选，选中的布局页紧邻该房间第一张柜体页之前。导出面板复选框默认关闭。DXF 的房间布局图和逐柜生产图各自独立 A3 layout，房间 PLAN 按房间选择。不自动合并吊柜/地柜。
- **二维覆盖一致性：** 页面编辑只支持屏幕/PDF/DXF 共同派生的 plan 与 sheet top/front/internal；side/缺失 view/无效柜体归属不得静默丢图，项目文件拒绝加载，HTTP/MCP 正式导出返回 422 `EXPORT_BLOCKED`。fill 暂只读，手工尺寸若与生产尺寸端点重合会提示复核。
- **AI/识图不确定性：** Agent 的写入只进入 draft 并先经 `cad.validate`；应用草稿仍由用户明确触发。视觉估计字段不得冒充已确认的生产尺寸。

## 9. 当前实现与交付状态（证据范围）

下表将历史基线、九次失败的全链运行与当前 scoped QA 明确分开。任何历史 UI/HTTP/文件计数或 scoped 通过都不代表当前变更树的全量回归结果；要求存在但尚无本轮 scoped 证据的契约，仍须由后续验证覆盖。

| 事项 | 产品/实现状态 | 证据状态与边界 |
|---|---|---|
| 房间工作区、逐柜图纸与基础导出 | 保留既有房间索引、逐柜工作区、PDF/DXF/CSV 及 ERROR 阻断等需求与实现基线 | 旧专项、旧浏览器探针及文件级检查仅作历史实现证据；不可外推为当前全链通过。导出仍必须满足第 4.3 节的服务器快照契约 |
| 历史厨房与导出样例 | 七柜厨房样例曾覆盖 4 地柜+3 吊柜、MCP draft→validate→apply、布局页与图纸文件 | `verify:complex-kitchen` 56/56、HTTP 文件检查 76/76、CSV 91 个正尺寸板件、显式选布局后的 PDF 8 页及 warning/bbox 回读，均属于旧 2026-10-09 基线记录；不得描述为当前树最新结果 |
| 装配确认与柜型分类 | 柜体按类型自动分类；连续装配须经用户显式确认，并绑定成员/连接关系；关系变化单调失效，单柜生产身份不变 | QA 已独立核验装配确认修复的 scoped 范围。该证据不等于全量 UI/CAD 工具浏览器回归，也不覆盖当前全链 |
| HTTP/MCP 草稿生成与原子 apply | 采用第 4.4 节的 reconcile、项目/hash/版本/关系代次一致及失败不变契约 | QA 已独立核验草稿/apply 修复的 scoped 范围。`verify:draft-assembly-generation` 已注册于 `package.json` 并加入 `verify:all`；这些 scoped 证据不替代当前全链结果 |
| 导出快照与 roombook 一致性 | 第 4.3 节的服务器快照、冲突/过期阻断和文件生成前 fail-closed 为产品要求 | 前八次全链均在失败点前通过 `verify:export` 119/119，内嵌 roombook snapshot HTTP negative acceptance 均为 17/17；前五轮分别更早停止，未运行 standalone `verify:roombook` 或 `verify:email`。第六轮另通过 `verify:special` 38/38、`verify:email` 23/23、独立 `verify:roombook` 19/19、`verify:agent-room-context` 15/15、`verify:sheet-backpanel` 6/6、`verify:door-dimensions` 60/60，后在 `verify:pdf-room-layout` 失败；随后 `verify:fixhint` 及之后套件未运行。失败是旧 acceptance fixture 未携带与导出项目匹配的快照三元组；生产 gate 正确返回 409。仅修 fixture 后 scoped PDF-room-layout 7/7，见下行；不证明同一 live `WorkspaceStore` 上可见下载 E2E，也不代替 SharedPanel B48 页面与正式四出口链的独立 QA 验收。`verify:export-snapshot-ui` 与 `verify:ui` 前九轮均未运行。第七轮在 `verify:pdf-room-layout` 7/7 后于 `verify:fixhint` 26/27 失败，`verify:quota` 及后续 suite（含 `verify:ui`）未运行；精确记录见第 1 节。
| 历史重复 Unit ID | 重复身份 fail-closed、只读诊断、显式健康项目恢复；禁止静默迁移 | 产品契约见第 4.5 节。前三次全链分别在 `verify:placement`、`verify:attach`、`verify:placement-design` 遇到验收 fixture 重复 Unit ID 并触发正确 fail-closed；第四轮 provenance acceptance fixture 的重复 Unit ID 也触发正确 fail-closed，测试随后因空事件日志而 TypeError；第五轮 special fixture 的 `cab_001.layout.units[0]` 与 `wine_E.layout.units[0]` 均为 `unit_001`，也正确触发身份 fail-closed并导致三项 special 验收失败。上述是 fixture/验收问题，不确认 validator 产品缺陷，也不构成历史重复身份专项通过的证据
| SharedPanel | **产品契约、非本轮 QA 验收**：仅为显式选择的共享台面/共同顶板制造数据原型，范围与阻断条件见第 4.6 节 | `verify:shared-panel` 31/31 只证明数据/文件原型。B48 页面草稿锁、正式 HTTP 四出口（PDF/DXF/CSV/roombook）及确认/丢弃流程未由 QA 本轮独立复跑；同一 live `WorkspaceStore` 上可见 `ExportPanel` click-to-download E2E 未证实。第 4.6 节中的锁定、确认后使用新快照及丢弃后恢复旧快照仍是产品契约，不构成本轮验收证据；不代表结构工程、优化套料或 CNC toolpath 已实现 |
| Placement fixture 修正 | `verify/placement-acceptance.ts` 的双柜 fixture 使用全局唯一 Unit ID，并加入重复前置断言与失败详情 | 首轮全链在 placement 76/82 由重复 Unit ID fixture 触发 6 个级联失败；QA 独立复跑 `npm run verify:placement`：82/82、exit 0（2026-10-09 18:02:17Z–18:02:18Z），覆盖 dryRun/提交/undo/redo/2D/3D 的 1800mm 位移。仅为修后 scoped QA，不是全链通过；记录见 `/tmp/qa-placement-2026-10-09-1802.log` |
| Attach fixture 修正 | attach 验收 fixture 的 Unit ID 全局唯一性及 `offset=20` 负向用例 | 第二轮全链在 `verify:attach` 98/105 出现 7 个级联失败；QA 静态检查确认重复 Unit ID 导致正确 fail-closed，且 `offset=20` 负向用例可能 false pass。之后只修复测试 fixture、未改生产安全代码；QA 独立 attach scoped 116/116、exit 0（2026-10-09 18:14:19Z–18:14:20Z），记录见 `/tmp/qa-attach-2026-10-09-1814.log`。这是 scoped 通过，不是全链通过 |
| Placement-design fixture 修正 | placement-design fixture 的 Unit ID 唯一性与 commit 断言的有效应用检查 | 第三轮全链于 `verify:placement-design` 105/107 失败；QA 复核确认 fixture 重复默认 Unit ID 正确触发 fail-closed，另有 `commitPlan.ok` 断言忽略 `applied:0,skipped:1` 的 false-positive。这是 fixture/验收缺口，并非已确认 validator 产品缺陷。之后仅修复测试 fixture；QA scoped `npm run verify:placement-design` 于 18:28:24Z–18:28:25Z 通过 111/111，覆盖显式唯一性、dry-run/全部步骤成功、warning、解析后位置变化、`applied=1/skipped=0` 与 `preview==commit`。scoped 通过不是全链通过 |
| Provenance acceptance fixture 修正 | provenance acceptance fixture 以每柜唯一 Unit ID 构造，并验证 fixture 唯一性及执行成功后再读取事件日志 | 第四轮在 `verify:provenance` 读取 `placementProvenance` 时 TypeError；QA 确认重复 Unit ID 正确触发 fail-closed，测试因空事件日志而失败，非已确认生产回归。之后仅修复 fixture/断言；scoped `npm run verify:provenance` 77/77、exit 0（2026-10-09 18:39:33Z，`/tmp/qa-provenance-2026-10-09-1839.log`），不代表全链通过 |
| Special acceptance fixture 修正 | `app/verify/special-acceptance.ts` 的多柜 fixture 使用全局唯一 Unit ID，并加入唯一性前置检查，维持产品 fail-closed | 第五轮 `verify:special` 35/38 的三项失败源于 `cab_001.layout.units[0]` 与 `wine_E.layout.units[0]` 重复为 `unit_001`，正确身份拒绝后依赖命令结果的断言级联失败；没有 `finishedEnds`/`shelves.tilt` 生产实现回归证据。仅修 fixture 后，QA scoped `npm run verify:special` 38/38、exit 0（2026-10-09 18:48:46Z–18:48:47Z，`/tmp/qa-special-2026-10-09-1848.log`）；不代表全链通过 |
| PDF 房间布局 acceptance fixture 修正 | `app/verify/pdf-room-layout-acceptance.ts` 在 `/api/workspace` 中读取与导出相同 live project 的精确 snapshot ID/hash/version，并将三元组用于三次 HTTP PDF 请求；不改生产快照 gate | 第六轮首个页序断言通过后，旧 fixture 的首个 PDF POST 因缺少快照元数据被正确拒绝为 409 `EXPORT_SNAPSHOT_REQUIRED`。QA 判定为旧 acceptance fixture 不兼容、非已确认产品缺陷。仅修 fixture 后 scoped `npm run verify:pdf-room-layout` 7/7、exit 0（2026-10-09T18:58:51Z–18:59:03Z，`/tmp/qa-pdf-room-layout-2026-10-09-1858.log`）：默认 3 页；仅选 B 或仅选 A 时均为 4 页，所选布局页顺序正确。原全链仍失败；测试未断言响应 `X-Project-Snapshot-*` 与请求值完全相等。|
| Fixhint 验收与 validator 集成 | `RULE-SHARED-PANEL-BLOCKED` 是无单一数值 delta 的聚合状态阻断；不能要求每项 issue 都带数字 | 第七轮全链的 26/27 失败经 QA/Product 判定为过宽验收断言，不是已证明的生产文案缺陷。之后仅改 `app/verify/fixhint-acceptance.ts`，production files/copy 未变。最终独立 `npm run verify:fixhint` 38/38、exit 0（2026-10-09T19:17:15Z–19:17:16Z，`/tmp/qa-fixhint-validator-integration-2026-10-09-1916.log`）：包含真实双柜 Project/SharedPanel fixture，经 `validateSharedPanels` 生成未确认 panel issue，`CommandBus.issues()` 保留原 blocker reason/message 与具体 next step；并以 validator/CommandBus 生成 18mm 当前材料上限对比 37mm 实际厚度。保留 catalog-level 覆盖；这是最终 38/38 scoped 证据，不替代全链结果或此前中间 34/34。QA 确认只改 acceptance script、production mtimes 不变、diff-check 通过。
| 第八轮 preflight acceptance fixture 修正 | `app/verify/preflight-bugfixes-acceptance.ts` 读取 live `/api/workspace` snapshot ID/hash/version，并以同一 project+三元组执行 HTTP DXF 导出；只改验收 fixture/assertions | 第八轮原失败为 `verify:preflight-bugfixes` 23/24，单一断言为“DXF 导出成功后临时目录无新增 `furniture-dxf-*` 残留”，诊断 `ok=false fresh=0`。旧 fixture 只提交 project/which/modelVersion，未提供快照三元组，隔离 server 也未加载同一 live snapshot；源码推断正式 gate 很可能在 `exportDxf` 前返回 409，但原日志未记 status/body，也未观察到成功导出，故不能声称原运行证明 cleanup 成功或失败。其后仅修 acceptance fixture/assertions；独立 QA `npm run verify:preflight-bugfixes` 于 2026-10-09T19:29:58Z–19:30:04Z 通过 24/24、exit 0（`/tmp/qa-preflight-bugfixes-2026-10-09-1930.log`，SHA-256 `a1bcc619de072902c8437a2406d03db2558ab6ff1e550efcf048725e9f489a7b`）：验收 fixture 以 `await r.arrayBuffer()` 完整消费 DXF 响应体；QA 日志记录 HTTP 200、`application/dxf`、44,407 bytes；隔离 `TMPDIR` 中目录数 before=0、after=0、fresh=0。生产 `exportCore` cleanup 未改；该 scoped 通过独立于且不改变第八轮全链 exit 1。|
| 浏览器与环境验证边界 | 现有 UI 自动化覆盖若干具名流程 | 并非所有 CAD 工具都逐项经过真实浏览器验证；本轮未证明导出面板在同一个 live `WorkspaceStore` 上完成 click-to-download 的端到端链路。NAS/Docker 未实机验证；圆形图元与通用镜像仍未实现 |
| 当前九次全链运行 | 九次完整运行均失败；隔离 B45/CDP 诊断独立列示 | **九次均 exit 1，不得标为当前树通过。** 前八轮停止点、时间、原因、日志哈希和 scoped 证据见第 1 节。第九轮于 2026-10-09T19:43:35Z–19:47:35Z 在 `verify:agent-room-sync-ui`（B45）失败：此前最后完整 suite `verify:room-create-persistence-ui` 13/13；B45 只通过 accounts session、tokenless 401、mock provider 三项 setup assertions；baseline 初始化在 `browser-probe.cjs:513/1417` 遇到 CDP `Runtime.evaluate` `-32000 Promise was collected`，主交互未到达，`verify:ui` 及后续 suite 未运行。日志 `app/verify-output/verify-all-ninth-2026-10-10.log` SHA-256 `0aa8b28c1df9feb2d343ea90adc88fb26b5086cd03b48848da09847e70925c68`（START `2026-10-09T19:43:35Z`，END `2026-10-09T19:47:35Z`）；前八份日志 hash 未变。未跑第十轮。
| B45/CDP 隔离诊断（全链之外） | 根因未确认；不判定 B45 产品通过或失败 | 与第九轮全链严格分开：窄复测 baseline expression 成功 6 次（P0 1 次、P1 5 次），P1 原始 `Promise was collected` 为 0/5；原症状未复现，未做单变量探测，四个候选假设均未确认/排除。扩展 harness 的 P0 另在 `browser-probe.cjs:1484` 报 `ReferenceError: Cannot access 'waitFor' before initialization`；初版复核时 QA 未查看源码；后续只读 QA 已独立核对当前源码，确认同一外层作用域的 `const waitFor` 到 `:1999` 才初始化，故可解释该新 harness TDZ 错误。此解释不解释第九轮原始 CDP 症状；不是修复授权，也不是产品失败结论。临时副本/日志已清理，生产代码与仓库 harness 未修复；细节及四项假设见第 1 节。|

## 10. 可量化验收标准

| 类别 | MVP 验收标准 |
|---|---|
| 房间归属 | 2 个以上房间、每房多柜的 fixture 中，房间顺序与 `rooms[]` 完全一致；每个柜体出现且只出现一次；未分配柜体显式告警，不静默改归属 |
| 视图完整性 | 所有当前支持的柜型夹具中，每柜均生成外观正面、内部结构、俯视三图及可开启的 3D；三视图与语义尺寸一致，3D 不进入图纸 |
| 房间工作区 | 打开房间后列出该房间全部柜体；可在当前房间直接添加柜体；切换房间同步切换聊天上下文；左下头像可打开登录/账户设置 |
| 分类与装配确认 | 柜型自动分类；未确认的装配不显示为连续组；确认绑定精确成员/连接快照；任何关系变更及 undo/redo 都以单调代次使旧确认 stale，回到相同关系也不复活；必须重新显式确认；确认不改变单柜 ID、生产图或导出身份；缺少有效快照/代次的老项目默认未确认 |
| PDF 分页 | 默认 `layoutRoomIds=[]`，默认页数 = 本次导出的柜体数；仅对显式选择的房间增加布局页，页数 = 柜体页数 + 实际插入的布局页数。按 `rooms[]` 与 UI 的 `indexProjectRooms` 稳定顺序；选中的布局页紧邻所属房间首柜页之前 |
| PDF 可读性 | 目标样例中无页外图元、无文字框/尺寸文字碰撞、无标题栏遮挡、无裁切；默认 A3 下最小字号不低于 2.5 mm，否则升幅或拆页。历史七柜厨房 PDF 第 4/6/8 页 9mm 背板 bbox/栅格检查仅是该历史样例的证据，其他复杂图纸仍需按实际导出复核 |
| DXF 正确性 | 单位 `$INSUNITS=4`；中文可读；每柜有可追溯的独立 A3 layout；选中一个或多个房间时仅为所选房间按 `rooms[]` 顺序生成独立 A3 layout；PLAN 与柜体图不在 modelspace 重叠；所有图元与中立图元回读一致、实体边界位于 5 mm 打印安全区内；不生成最近邻猜配实体 |
| 标注一致性 | 每个 DXF 尺寸实体都能追溯到指定柜体、视图和源测量；整数毫米标注与语义测量差值为 0 mm；没有幽灵、重复尺寸文字 |
| 二维手工编辑 | 工具清单内选择/框选、移动/复制/删除、线/多段线/文字/尺寸/引线、捕捉/正交、撤销/重做、属性编辑均可用；模型覆盖不改变柜体语义参数；闭合/dash/rot 在保存重载及 screen/PDF/DXF 中一致；fill 不可选/不可覆盖；重复生产尺寸给出提示；来源 key 在前插/删除/重排后不误映射；完全相同多候选、目标删除、源几何重算或重复覆盖产生 stale/ambiguous ERROR、不隐藏候选且 HTTP PDF/DXF 返回 422 |
| 不可变导出快照 | PDF/DXF/CSV/roombook 均绑定服务器确认的快照 ID/hash/version；缺失、过期、项目内容不符或元数据冲突时，在创建任何文件前 fail-closed；成功导出内容与响应元数据指向同一快照，HTTP/MCP/browser 不得绕过 |
| 导出安全 | 任何 ERROR（包括任一制造板件 length/width/thickness ≤0）都阻断正式导出；HTTP 冲突返回结构化拒绝，ERROR 导出返回 `EXPORT_BLOCKED` 与错误清单；仅有 WARNING 时允许导出且相关生产 warning 必须随文件留存；水槽/灶具参考预留不得伪装成 CNC 开孔；JSON 项目存档仍可用 |
| 原子草稿 apply | HTTP/MCP reconcile 结果、服务器快照、响应、receipt、live project、持久化结果与幂等 replay 必须一致于同一规范化版本/hash/关系代次；重复 replay 不重复提交；任何存储失败使项目、版本、receipt、草稿状态全部保持操作前值 |
| 历史重复 Unit ID | 任一 live/draft/receipt 重复身份导致只读诊断及写入/生产导出阻断，不静默改号/迁移；仅显式恢复至全局唯一、引用有效的健康项目后解除只读 |
| SharedPanel 原型 | 仅用户显式选择的共享台面/共同顶板作为制造件；关键制造输入缺失、快照 stale/歧义、加工未确认或超板幅分段未确认均阻断生产；未确认草稿锁定 PDF/DXF/CSV/roombook，确认后导出统一使用同一新快照，丢弃草稿恢复旧快照后可导出；不以此宣称结构工程、优化套料或 CNC toolpath 能力 |
| 房间持久化 | 空项目从新建房间、添加柜体到二次刷新后，第二房间、柜体归属与活动 `projectId+roomId` 全部恢复；失效上下文不得静默切到样例数据 |
| 性能 | 20 柜体房间：2D 房间工作区在常规桌面开发机上 2 秒内可交互；首次打开单柜 3D 5 秒内可用；20 柜体 PDF/DXF 完整导出目标 10 秒内完成，超时显示阶段和错误而非无响应 |
| 浏览器证据边界 | 对每个 CAD 工具分别记录实际浏览器验收；不得由局部 UI 探针推断所有工具均经浏览器验证。当前未取得同一个 live `WorkspaceStore` 的导出面板 click-to-download E2E 证据 |
| 当前最终回归 | 当前九次 `pnpm verify:all` 均 exit 1；第九轮后续隔离诊断不改变全链状态 | 第九轮于 2026-10-09T19:43:35Z–19:47:35Z 在 `verify:agent-room-sync-ui` 的 B45 baseline 初始化处因 CDP `Runtime.evaluate` `-32000 Promise was collected` 停止；此前最后完整 suite `verify:room-create-persistence-ui` 13/13，B45 仅三项 setup assertions 通过，Agent→remote draft→confirm apply→local room sync 主交互未到达。原日志 SHA-256 `0aa8b28c1df9feb2d343ea90adc88fb26b5086cd03b48848da09847e70925c68`；前八份日志 hash 保留且未变。隔离窄复测原始症状 0/5（P1），根因未确认；扩展 harness 另报 `waitFor` TDZ error，二者不是同一已确认根因，且均不构成 B45 产品通过或失败。`verify:ui` 及后续 suite 未运行；未跑第十轮。诊断细节见第 1、9、12 节。

碰撞验收仅针对不应重叠的标签、尺寸文字、标题栏、图框和相邻页面元素；柜体结构线条之间有意接触或重合的情况应由语义/图层规则区分，不能用泛化的线段相交检测误报。

## 11. 初稿假设及现状说明

> 以下清单记录 PRD 初稿中的待决项；当前已落实的默认方案以第 6、7、9 节及交付补充说明为准。

1. **纸张规格：** MVP 默认 A3 横向，已在本机生成并检查真实 PDF；自定义纸幅和更大纸张自动扩幅仍未实现，也未在目标打印机上验证。
2. **合页对象：** MVP 固定一柜一页，不自动合并吊柜、地柜或其他柜体；先保证字号、尺寸和图元可读，后续可按真实订单增加明确的合并选择。
3. **房间布局页：** PDF 默认无 PLAN；用户可按房间勾选 `layoutRoomIds`，只为所选房间输出布局页，并放在该房间首张柜体页之前。DXF 的 PLAN 也按房间选择，与逐柜图各有独立 A3 layout，不以房间图替代柜体图。
4. **标题栏字段：** 每页保留项目、房间和柜体身份及尺寸；设计师、联系电话、客户地址、签字等不要求补录，仍为空白字段或后续可选表单项。
5. **错误时的导出策略（已定）：** 任一校验 ERROR 都阻断正式 PDF、DXF、CSV 及备用 HTML 打印版；WARNING 不阻断，但界面明确计数。服务端在共享导出核心重算校验并拒绝直接 HTTP 或 MCP 请求，HTTP 返回 422 `EXPORT_BLOCKED` 和 ERROR 清单。修复到 ERROR 为 0 后才能正式导出；项目 JSON 存档仍可用于备份和继续编辑。
6. **PDF 后端：** 当前服务端使用 WeasyPrint 70.0 与 Noto CJK；本机已验证真实 A3 PDF、中文和页数，NAS/Docker 镜像、资源占用和目标打印机仍未实测。
7. **柜体页顺序：** 当前按 `rooms[]` 房间顺序分组，再按房间内空间位置稳定排序；设计师自定义拖动排序尚未实现。

## 12. 实现补充、证据边界与未完成项

- **导出默认值：** PDF 仍以 A3 横向、一柜一页、默认不插 PLAN 为基线；`layoutRoomIds` 为空时不插房间布局页，按需选择的 PLAN 紧邻所属房间首柜页。DXF 房间 PLAN 与逐柜 layout 分离；柜型间不自动合页。
- **服务器快照：** PDF、DXF、CSV 与 roombook 必须使用同一不可变服务器确认快照及其 ID/hash/version。缺失、过期或与项目内容/元数据冲突时，在任何文件生成前拒绝；不得以浏览器展示版本代替服务器权威版本。
- **apply 原子性：** HTTP 与 MCP 对草稿先 reconcile，再一次性提交规范化 Project。响应、receipt、live/readback、持久化状态与幂等 replay 必须在版本、内容 hash、关系代次上相同；存储失败必须完全不变。浏览器 `localVersion` 由客户端在 apply/sync 前核对并随 receipt 记录；服务端没有独立可信来源验证该浏览器本地版本，不能将其表述为服务端验证/证明。
- **装配与身份：** 柜型自动分类不等于连续装配确认；只在显式确认当前成员/连接后显示连续组。任何关系变化（包括 undo/redo）均单调失效，旧项目缺少有效确认快照时默认为未确认；单柜生产身份不受确认影响。历史重复 Unit ID 必须只读 fail-closed，只有显式恢复到唯一 ID 的健康项目后才恢复写入/导出，不得静默迁移。
- **SharedPanel 范围：** 仅作为用户显式选择的共享台面/共同顶板制造数据原型；未确认、缺失、过期、歧义或未确认的超板幅分段输入均阻断生产导出。只要有未确认 SharedPanel 草稿改动，正式 PDF/DXF/CSV/roombook 均锁定；明确确认后各导出统一使用同一新快照，丢弃草稿并恢复旧确认快照后可重新导出。该能力不代表结构工程、优化套料或 CNC toolpath。
- **历史全链/厨房基线：** 2026-10-09 11:13:01–11:19:15 UTC `pnpm verify:all` exit 0（常规 UI 47 段、732/732）；旧复杂厨房 56/56、HTTP 文件检查 76/76、CSV 91 个正尺寸板件、PDF 8 页及第 4/6/8 页标签回读均为该历史运行/样例记录，不是当前变更树的结果。历史 UI 报告只能说明当时的执行范围与输出。
- **当前 scoped 证据：** QA 独立核验了装配确认、草稿/apply 修复；placement scoped `npm run verify:placement` 于 2026-10-09 18:02:17Z–18:02:18Z 82/82、exit 0（在第二轮全链启动前），记录 `/tmp/qa-placement-2026-10-09-1802.log`；attach scoped 于 18:14:19Z–18:14:20Z 116/116、exit 0（第二轮失败后），记录 `/tmp/qa-attach-2026-10-09-1814.log`；placement-design fixture 修复后 scoped `npm run verify:placement-design` 于 18:28:24Z–18:28:25Z 111/111。第四轮后仅修复 `verify/placement-provenance-acceptance.ts` fixture/断言，QA 于 2026-10-09 18:39:33Z 独立运行 `npm run verify:provenance` 77/77、exit 0，记录 `/tmp/qa-provenance-2026-10-09-1839.log`。第五轮后仅修复 `app/verify/special-acceptance.ts` fixture 为全局唯一 Unit ID 并增加前置检查，QA 于 2026-10-09 18:48:46Z–18:48:47Z 独立运行 `npm run verify:special` 38/38、exit 0，记录 `/tmp/qa-special-2026-10-09-1848.log`。第六轮后仅修复 `app/verify/pdf-room-layout-acceptance.ts` fixture：live server workspace、导出 fixture 与 GET `/api/workspace` 返回的 snapshot ID/hash/version 对齐，三个 HTTP PDF 请求均携带完全相同三元组；QA 于 2026-10-09T18:58:51Z–18:59:03Z 独立运行 `npm run verify:pdf-room-layout` 7/7、exit 0，记录 `/tmp/qa-pdf-room-layout-2026-10-09-1858.log`。default PDF 为 3 页；仅选 A 或仅选 B 时各 4 页，布局页顺序断言通过。该 acceptance 测试未断言响应 `X-Project-Snapshot-*` headers 与请求三元组逐值相等；成功路径使用同一已确认快照的事实不等于该断言已测试。以上均为 scoped 证据，不是全链通过，也不补入对应失败全链计数；fixture/断言修复未确认生产安全代码回归。`verify:draft-assembly-generation` 已注册于 `package.json` 并纳入 `verify:all`。 第七轮之后仅修改 `app/verify/fixhint-acceptance.ts`，production files/copy 未变；QA 确认该项只改 acceptance script、production mtime 未变且 diff-check 通过。最终 QA 独立 `npm run verify:fixhint` 于 2026-10-09T19:17:15Z–19:17:16Z 通过 38/38、exit 0（`/tmp/qa-fixhint-validator-integration-2026-10-09-1916.log`；最终证据为 38/38，不采用中间 34/34）。新增真实双柜 Project/SharedPanel fixture：`validateSharedPanels` 生成未确认 panel issue，`CommandBus.issues()` 保留 exact blocker reason/message 和 concrete next step；numeric thickness case 经 validator/CommandBus 生成，assert 当前 material limit 18mm 与 actual 37mm；catalog-level issue/hint tests 保留。该 scoped 结果不补入第七轮全链 26/27。 第八轮之后仅修复 `app/verify/preflight-bugfixes-acceptance.ts` fixture/assertions；QA 独立 `npm run verify:preflight-bugfixes` 于 2026-10-09T19:29:58Z–19:30:04Z 通过 24/24、exit 0（`/tmp/qa-preflight-bugfixes-2026-10-09-1930.log`，SHA-256 `a1bcc619de072902c8437a2406d03db2558ab6ff1e550efcf048725e9f489a7b`）。测试核对 `/api/workspace` live snapshot ID/hash/version，并提交匹配 project+三元组；DXF HTTP 200、`application/dxf`、44,407 bytes；验收 fixture 以 `await r.arrayBuffer()` 完整消费响应体；隔离 `TMPDIR` before=0/after=0/fresh=0。production `exportCore` cleanup 未改；该 scoped 结果不补入第八轮全链 23/24。
- **当前全链与待验证项：** 当前九次 `pnpm verify:all` 均 exit 1；前八轮停止点、时间、原因、哈希及 scoped 证据见第 1 节。第九轮于 2026-10-09T19:43:35Z–19:47:35Z 在 `verify:agent-room-sync-ui`（B45）失败，此前最后完整 suite `verify:room-create-persistence-ui` 13/13；B45 只通过三项 setup assertions，baseline 初始化遇到 CDP `Runtime.evaluate` `-32000 Promise was collected`，Agent → remote draft → confirm apply → local room sync 主交互未到达。第九轮日志 SHA-256 `0aa8b28c1df9feb2d343ea90adc88fb26b5086cd03b48848da09847e70925c68`，START `2026-10-09T19:43:35Z`，END `2026-10-09T19:47:35Z`；前八份日志 hash 均未变。必须分开记录三点：第九轮 exit 1 且 B45 主交互未到达；隔离窄复测 P1 原始症状 0/5、根因未确认；扩展 B45 harness 另出现 `waitFor` TDZ（confirm/apply 前）。不能将后二者混为同一根因，也不能称 B45 产品通过或失败。`verify:ui` 及后续 suite 未运行；未跑第十轮。隔离诊断的 6 次成功 baseline、未执行单变量探测、未确认的四项假设及 cleanup 范围见第 1、9 节。后续只读 QA 已独立核对源码；该静态 TDZ 定位仅指向扩展 harness 新错误（调用在 `browser-probe.cjs:1484`、同作用域 `const` 初始化在 `:1999`），不解释原始 `Promise was collected`，也不构成修复授权。
