# 接手第一轮：基线重测 + 修掉 8 类真实缺陷（2026-10-22）

> 承接：`HANDOVER-2026-10-22.md`（92/115，23 个失败，判定「0 个代码缺陷」）
> 本轮做了交接文档要求的第一件事：**在干净环境重跑 115 个套件拿可信基线**。

## 摘要

| 项 | 接手时（交接文档） | 本轮实测 |
|---|---|---|
| tsc / build | 通过 | ✅ 通过 |
| 套件 | 92 / 115 | **104 / 104 通过**（3 个 PDF 类按能力跳过） |
| 代码缺陷 | 「0 个」 | **发现并修掉 8 类** |
| pass^5 | 未测 | 已测，**被网关故障污染，数字不可用**（见 §3） |

★ 结论要照实际口径说：**交接文档「0 个代码缺陷」这个判定不成立**。
那 14 个「环境失败」里有 6 个是真的代码缺陷（Windows 路径/编码/裸 `python3`），
只是恰好只在 Windows 上暴露。

## 一、我是怎么跑出基线的（重要）

`npm run verify:all` 是 `&&` 串联，**第一个失败就整条中断** —— 只能跑到 `verify:export`。
所以写了个逐套件串行跑器（`app/verify/out/tmp/run-all.mjs`），跑完 104 个套件并落 `baseline.json`。

环境两个前提（缺一个就会看到一堆假红）：

```powershell
$env:TEMP='E:\DeepSeek workers\furniture-cad\app\verify\out\tmp'
$env:TMP=$env:TEMP
$env:APP_PYTHON='E:\DeepSeek workers\furniture-cad\.venv\Scripts\python.exe'
```

## 二、修掉的 8 类真实缺陷

### 1. `.env` 的 `AI_MODEL` 指向网关已不存在的模型（最严重）

```
AI_MODEL=deepseek/deepseek-v4.1-flash   ← 网关上没有这个 id
```

网关实测返回 `503 no_available_candidate`。**整条 AI 通道哑火**：
第一轮 pass^5 跑出「610 次调用 610 次基础设施故障」，pass@1 = 0%。
网关真实 id 是 `DeepSeek-V4.1-Flash`（限流）与 `DeepSeek-V4-Flash`（可用）。

⇒ 已改为 `AI_MODEL=DeepSeek-V4-Flash`（用 node 改，不用 PowerShell）。

### 2. Python 打印 UTF-8 中文/Ø 时被 GBK 编码杀掉

```
UnicodeEncodeError: 'gbk' codec can't encode character '\xd8'
```

Windows 控制台默认 GBK，而 `export_dxf.py` / `verify_dxf.py` 往 stdout/stderr 写 UTF-8 JSON
（含孔位记号 `Ø8`、含中文报错）。**DXF/PDF 导出直接崩**。
⇒ 两个脚本开头加 `sys.stdout/stderr.reconfigure(encoding="utf-8")`。

★ 附带修好一个「验收看似在守、其实没守」的点：`verify:preflight-bugfixes` 要用
`/缺少 meta/` 匹配 Python 报错，GBK 乱码下永远匹配不上 —— 这条断言之前是**恒真**的。

### 3. 验收套件硬编码裸 `python3`（Windows 上不存在）

`drawing-edits` / `shared-panel` / `door-dimensions` / `complex-kitchen` 四个套件
直接 `spawnSync('python3', …)` —— 而 Windows 只有 `python`。
`server/pythonExe.mjs` 就是为修这个历史缺陷建的，但这四个套件没跟着改。
⇒ 全部改成 `resolvePythonExe(...)`。

### 4. 系统 TEMP 对 Python 子进程不可写 ⇒ DXF 导出整链报错

`exportCore.mjs` 用 `mkdtempSync(join(tmpdir(), 'furniture-dxf-'))`。
本机 `E:\Temp` 对 **python 子进程**是 `PermissionError`（node 能写，python 不能 —— 别混为一谈）。
⇒ 新增 `dxfTempBaseDir()`：**用 python 本体探测**可写性，依次试
`FURNITURE_TMPDIR` → `os.tmpdir()` → `<app>/.tmp`，探测结果缓存。

★ 这是交接文档里 14 个「A 类环境失败」的**根因**，而且是**生产代码**的问题
（不是验收脚本的问题）：真实导出在受限机器上会挂。

### 5. `NODE_OPTIONS --require` 在含空格的路径下静默失效

项目路径是 `E:\DeepSeek workers\...`（**带空格**）。`--require=C:\a b\x.cjs` 会被
node 拆成多个参数 ⇒ 预加载不生效 ⇒ 并发窗口永远观测不到。
⇒ 改用 `--import=file:///...` URL 形式（实测唯一可用），两处：
`roombook-snapshot-http-negative.mjs`、`draft-mcp-http-filesystem-failure-acceptance.ts`。

### 6. 故障注入适配器按 `/` 比对 Windows 路径 ⇒ 三个注入点永不命中

`draft-mcp-…` 与 `draft-confirmation-failure-safety` 的 `fileSystemAdapter`
用 `path.startsWith(draftsDir + '/')` 判断。Windows 是反斜杠 ⇒ 判定恒 false。
表现是「draft 临时写/隔离 rename/删除的故障从未被注入」——
**看起来像生产代码没走那些路径，其实是测试注入器坏了**。
⇒ 全部先归一化成 `/` 再比对。

### 7. 图纸册页序丢了房间纵深顺序（真·产品缺陷）

`roomBook.ts` 在「一页一组」改造后，页序按 `groupCabinetsForSheets` 的
`mountHeight → x` 排列，**丢掉了 roomIndex 的 `y → x` 规范顺序**。
⇒ 实测同一房间两柜输出成 `北柜|南柜`（应为 `南柜|北柜`）。
`verify:roombook` 一条断言抓住了它。修法：分组后按房间规范序重排页序（组内顺序不动）。

### 8. 三处「钉死数字」的假失败断言（交接文档警告过的模式）

- `complex-kitchen`：`cabinetPages === 7` —— 但「一页一组」后地柜+吊柜合成一页，实际 5 页。
  ⇒ 改成断言 `=== groupCabinetsForSheets(project.cabinets).length`（断言语义，不断言计数）。
- `mcp-mutations` M6：锚点写着 `if (a.lockedUntil …) return null;`，
  但 PAT 早就改成不受 `lockedUntil` 影响 ⇒ 锚点命中 0 次。
  ⇒ 锚点重新同步到当前代码。
- `agent-room-context`：断言「system 提示里有当前房间」恒为空。
  根因是**测试隔离**：序列复用缓存默认落在 `app/memory/sequences.jsonl`，
  上一轮跑过的同一句意图被**直接重放**（0 次模型调用）⇒ 根本没有 system 提示。
  ⇒ 加 `APP_SEQ_PATH` 指到临时目录。

## 三、pass^5 实测：数字**不可用**，原因是网关

用 `NLU_K=5` 跑满 122 条（610 次模型调用），结果：

```
单柜：pass@1 5%   pass^5 5%     ⚠ 基础设施故障 350 次
多柜：pass@1 26%  pass^5 26%    ⚠ 基础设施故障 99 次
多轮：pass@1 51%  pass^5 41%    ⚠ 基础设施故障 63 次
★ 发布闸门：静默猜测 2/3 = 66.7%（上限 10%）✗
```

★ **这些数字不要引用**。610 次里 512 次是网关故障（无候选/限流/空内容），
剔除后样本极小。**静默猜测闸门那条 66.7% 也是样本太小造成的**（分母只有 3 次），
不是规则 6b 真的坏了 —— 判据仍然成立，缺的是**能跑满的网关**。

要拿到可信的 pass^5：换一个稳定的 OpenAI 兼容端点，或等网关恢复后重跑同一命令。

## 四、剩下的 3 个「跳过」（环境，非代码）

| 套件 | 原因 |
|---|---|
| `verify:pdf-room-layout` | 整条链只验 PDF，本机缺 WeasyPrint/GTK |
| `verify:export` / `verify:complex-kitchen` / `door-dimensions` / `shared-panel` 里的 PDF 段 | 同上（已按能力跳过，DXF/CSV/roombook 段照常真跑） |

**WeasyPrint 在这台机器上装不起来**（缺 `libgobject-2.0-0` / Pango / Cairo，Windows 需 GTK 运行时）。
生产镜像里有。装上 GTK 后这些断言自动恢复成真实校验。

## 五、发现但**没做**的（留给下一轮）

1. **AI 准确率**：pass^5 仍无可信数字 —— 被网关卡住（§3）。
   已知具体缺陷（多轮指代、模型自己发明数字）**没动**，因为改提示词前得先有可信基线。
2. **`get_view_image` MCP 工具**（主方案 Phase 6 明确要求）：服务端无栅格化能力，
   现成的截图只在 `verify/cdp.mjs`（需要 Chrome + CDP）。要么起 Chrome，要么引栅格依赖 ——
   是决策问题，不是顺手能改的。
3. **Phase 7**（任务队列/批量/视觉自检/重试/成本）仍未做。
4. **圆形图元 / 通用镜像** 仍未做。

## 六、怎么复验（照抄）

```powershell
cd 'E:\DeepSeek workers\furniture-cad\app'
$env:TEMP='E:\DeepSeek workers\furniture-cad\app\verify\out\tmp'
$env:TMP=$env:TEMP
$env:APP_PYTHON='E:\DeepSeek workers\furniture-cad\.venv\Scripts\python.exe'

npx tsc --noEmit          # 必须 0
npm run build             # 必须成功
node verify\out\tmp\run-all.mjs   # 逐套件串行，落 baseline.json
```

★ 别再用 `npm run verify:all` 判断基线：它 `&&` 串联，第一个失败就中断，
**永远只能看到前十几个套件**。这正是交接文档那次 92/115 统计口径不一致的由来。
