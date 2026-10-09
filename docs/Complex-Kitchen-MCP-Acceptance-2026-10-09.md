通过真实 MCP 在独立临时 Workspace 中建立并应用了一套厨房组合：1个新房间、4个地柜、3个吊柜，全部归属同一房间。正式`pnpm verify:complex-kitchen`从空白隔离数据通过56/56，HTTP导出文件检查76/76；该专项也在最终`pnpm verify:all`中重跑并通过。最终全链于2026-10-09 11:13:01–11:19:15 UTC exit 0；常规 UI 实际输出47段、732/732全绿，另3个过滤专用 UI 流程独立31/31（静态定义52段含5个 ONLY 分支，范围见 [UI 回归证据](UI-Regression-Report-2026-10-09.md)）。测试服务器和 Workspace 结束时清理，项目原有房间与柜体未被写入。机器可读结果位于`app/verify-output/complex-kitchen/acceptance.json`；最终文件修改时间：CSV/DXF 11:15:41 UTC、PDF 11:15:45 UTC、验收 JSON 11:15:57 UTC（2026-10-09）。

## 厨房布局与柜体

房间尺寸为 5000×4000×2700 mm。地柜沿同一墙面从 x=60 mm 起连续排布；吊柜也沿该墙排布，吊柜底标高 1450 mm，与 850 mm 高的地柜顶之间留 600 mm。地柜线包含 3 个相邻连接，吊柜线包含 2 个相邻连接。

| 柜体 | 类型 | 外尺寸 W×H×D（mm） | 安装底标高 |
|---|---|---:|---:|
| 01 三抽地柜 | 地柜 | 800×850×600 | 0 mm |
| 02 水槽地柜 | 地柜 | 900×850×600 | 0 mm |
| 03 灶具地柜 | 地柜 | 900×850×600 | 0 mm |
| 04 烤箱地柜 | 地柜 | 604×850×600 | 0 mm |
| 05 左吊柜 | 吊柜 | 1200×700×350 | 1450 mm |
| 06 中吊柜 | 吊柜 | 1000×700×350 | 1450 mm |
| 07 右吊柜 | 吊柜 | 1000×700×350 | 1450 mm |

MCP 输入包含三抽分区、水槽柜/灶具柜分区、烤箱预留（洞口 568×600×560 mm，另含上抽屉），以及吊柜内分区和层板。水槽台面参考预留为 650×450 mm，灶具为 640×520 mm。

## 验收结果

草稿阶段 live Workspace 仍为空；`cad.validate(draftId)` 检查的是同一个待应用草稿，返回 0 个阻断错误；`cad.apply_draft` 后，房间和 7 个柜体均在 live 状态下可见，组合关系也已保存。几何负样本确认，同投影、同标高的柜体会报 `RULE-CABINET-OVERLAP`；垂直分离的地柜/吊柜即使平面投影重合也不会误报。吊柜 3D 体块的 Z 范围为 1450–2150 mm，水槽和灶具参考预留均派生为 3D 占位体。验收 JSON 记录同一房间 `room_001`、4 地柜/3 吊柜、两个组合分别 3/2 个连接。

厨房 PDF 显式传入 `layoutRoomIds: ["room_001"]`，共 8 页（1 页厨房布局 + 7 页逐柜图）；未选择的普通房间仍按默认无布局页契约。PDF、DXF 中都核对了七柜名称和完整外尺寸；烤箱开口 568×600 mm、吊柜门板 372×660 mm，以及水槽/灶具名称与尺寸也都能在相应图纸内容中找到。水槽/灶具页及厨房布局页显著注明“参考预留｜非 CNC 开孔｜待拆单确认”；PDF/DXF 文件级回读确认警示归属到具体柜体/布局。最新栅格图对 PDF 第 4/6/8 页完成目视复核：9mm 背板标签位于右侧信息栏，文字 bbox 在页面宽度 x=0.827 处且 `noTextOverlap=true`；侧栏红字在三页各检出 343 个栅格像素。左装订安全检查为最左墨迹 22 px，超过 5 mm 安全区基线 18 px；没有裁字。

CSV 文件级回读共 91 块制造板，length/width/thickness 均为正，零尺寸/负尺寸件为 0；吊柜 KICK/KICKB 为 0，地柜有效 KICK 保留。当前 fixture 产生 1 条可导出 `RULE-MIN-PANEL` 警告（P_cab_001_KICK），PDF 第 2 页与对应 DXF 单柜 layout 均保留规则名、柜名与说明；零尺寸吊柜件不进入 CSV、PDF 或 DXF。厨房 PDF/DXF 同时通过水槽/灶具非 CNC 参考预留说明文件级回读。当前导出文件位于：

- [厨房图册 PDF](../app/verify-output/complex-kitchen/complex-kitchen-roombook.pdf)
- [厨房布局与逐柜图 DXF](../app/verify-output/complex-kitchen/complex-kitchen-layout-and-sheets.dxf)
- [图册 HTML](../app/verify-output/complex-kitchen/complex-kitchen-roombook.html)
- [机器可读验收结果](../app/verify-output/complex-kitchen/acceptance.json)

## 可重复运行与回归

新增命令为 `pnpm verify:complex-kitchen`，执行 `verify/complex-kitchen-mcp-acceptance.ts`：使用独立临时服务器和 Workspace，通过真实 JSON-RPC MCP 调用覆盖创建房间、柜体/组合、draft→validate→apply、同房间读取、碰撞正负样本、3D 标高，以及按房间导出 PDF/DXF。此命令已加入 `verify:all`，位于 MCP 写入验收之后。

本次厨房实际重跑结果为`verify:complex-kitchen` **56/56 PASS**，HTTP导出/文件级回读**76/76 PASS**。最终完整`pnpm verify:all`于2026-10-09 11:13:01–11:19:15 UTC exit 0；常规完整 UI 实际输出47段、732/732通过，另3个过滤专用 UI 流程31/31。B36真实拖动/同步/撤销28/28；B38洗衣机 Agent→MCP→draft→确认/apply→读回34/34。静态52个 section 定义及5个 ONLY 分支的执行范围见 [UI 回归证据](UI-Regression-Report-2026-10-09.md)。旧 UI 运行的红项/统计仅作历史记录，不混入本轮；厨房生产与视觉边界详见上文。

## 当前制造边界

水槽和灶具切口目前是带精确位置/尺寸的参考标记与半透明占位，不是生产板件中的真实 CNC 开孔；校验器返回两条非阻断 `RULE-COUNTERTOP-CUTOUT-PLACEHOLDER` 警告。图纸必须明确“参考预留｜非 CNC 开孔｜待拆单确认”，不得把虚线表现成已加工孔。此次厨房 fixture 另有 1 条可导出的 `RULE-MIN-PANEL` 小踢脚板 warning，警告随 PDF/DXF 文件保留；这不代表零尺寸板可导出——所有正式 PDF/DXF/CSV 中制造板件的 length、width、thickness 任一小于或等于 0 都应 ERROR 阻断。吊柜不生成零尺寸踢脚板，地柜有效踢脚板仍保留。

### 跨柜连续台面 / 顶板的语义边界（后续验收要求）

- **柜体箱体顶板仍按柜体分别制造**：它们是各自箱体的结构件，不能因为相邻就合并。
- 如果实际是一块跨左/中/右柜的台面或共同顶板，应表达为**单独、显式创建的共享制造对象**，成员柜体只作为来源追溯；不能从相邻关系自动推断。
- 共享对象必须确认尺寸、材料、厚度、外挑、封边、支撑及接缝方案。若真的是一块整板且尺寸在材料板幅内，料单应只有该共享件一项；若超板幅，生产导出必须阻断，直到明确拼缝并据此生成可追溯分件。
- 共享对象及其分件 ID、尺寸、材料、封边/接缝说明必须贯穿 CSV、PDF、DXF 回读；被共享对象替代的柜顶不得重复计料。成员或尺寸变化后旧确认应标记 stale 并阻断生产导出。
- **当前实现边界**：本次厨房模型尚无共享制造对象字段；现有台面切口只是非 CNC 参考预留，制造层仍按每个柜体分别派生箱体板件。因此不得把本次 CSV/DXF/PDF 解释为已生成跨柜一体台面/顶板，也不得自动把相邻柜的结构顶板合成一件。
