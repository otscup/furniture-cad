# 视觉链路打通 + 两个真缺陷（2026-10-22）

> 这一轮的起因是「下一步该做视觉还是做语言」—— 结论是**先做视觉**，
> 因为语言侧已经量到 91-100%，而**视觉侧从来没端到端跑过**。
> 一跑就抓到两个**产品级阻断缺陷**。

---

## 一、缺陷 1：一条未闭合的注释 ⇒ 所有 AI 端点一律 500

### 现象

调用 `/api/ai/vision` 直接 500：

```
{"ok":false,"error":"HARD_MAX_TOKENS_CAP is not defined"}
```

### 根因

`server/server.mjs` 第 206-209 行：

```js
 * @param {object} env readEnv() 的结果
 * @returns {number}
                                 <- 这里少了 */
// ── 导出链路的外部程序 ──
const EMIT_NEUTRAL_TS = join(ROOT, 'scripts', 'emit-neutral.ts');
```

**少一个注释结束符 ⇒ 从第 206 行起全是注释 ⇒ `HARD_MAX_TOKENS_CAP` 根本没被声明**
⇒ 所有 AI 端点（chat / plan / design / vision / agent）**一律 500**。

### 什么时候引入的

`git blame` 指向 **2d34cda**（子代理的「序列相似度匹配收尾」提交，10-21 15:57）。
**整整一天，所有 AI 功能都是坏的。**

### 为什么所有既有验收都没抓住

| 手段 | 为什么测不到 |
|---|---|
| `tsc --noEmit` | **不检查 .mjs**（它在 tsconfig 的检查范围外） |
| `node --check` | 只查**语法**，不查「注释吞掉了后面的代码」 |
| 单元级验收 | 直接 import 某个函数，**绕过 HTTP 路由** ⇒ 模块顶层根本没被求值 |
| `verify:admin` | 看到 500 就归为「既有失败」放过了 |

★ 最后一条是我自己的问题：前几轮我**三次**看到 `HARD_MAX_TOKENS_CAP is not defined`，
都因为「基线也失败」而放过。**「既有失败」不等于「可以不管」** ——
尤其当它是一个 500 级的**全功能阻断**。

---

## 二、缺陷 2：视觉模型没配 ⇒ 识图功能是坏的

### 现象

配好视觉模型后手动指定模型调用 ⇒ 识别很好（宽 2400mm、三格分区全对）。
但走**产品路径**（前端发图）⇒ 模型答：

```
"图片内容为浏览器中显示的原始 SVG/XML 源码文本，其顶部有
 'This XML file does not appear to have any style information associated with it.' 提示，
 因此不是柜体效果图或截图。"
```

### 根因

`/api/ai/vision` 用 `env.AI_MODEL`（= `deepseek/deepseek-v4.1-flash`）。
而实测 **deepseek 发图后 `usage.prompt_tokens_details.image_tokens = 0`** ——
**它根本不看图**，只是对着输入瞎猜。

⇒ 「视觉识别」这个功能**看着在、实际是坏的**。

### 修法

```bash
# app/.env
AI_MODEL=deepseek/deepseek-v4.1-flash        # 文本（语言理解）
AI_VISION_MODEL=sensenova-6.8-flash-lite      # 视觉（识图）
```

并在**启动信息**里单列一行，配置没分开时给出提示：

```
  模型      deepseek/deepseek-v4.1-flash
  视觉模型  sensenova-6.8-flash-lite
```

---

## 三、新增验收：verify:server-integrity（35 项）

★ 核心是**真起一个服务端，打真实端点** —— 这才是那个 bug 的现场。

```
1. 扫描所有服务端 .mjs，找未闭合的块注释（跳过字符串与行注释）
2. ★ 真起服务（随机端口），打 /api/ai/vision：
   · 必须返回 400（参数校验）而不是 500（代码崩了）
   · 错误里不能出现「is not defined」
3. 各服务端模块能被 node 加载（顶层无 ReferenceError）
```

### ★ 为什么不能只扫源码

试过「块注释开合配平」这个判据 —— **误报**：
`server/server.mjs:2779` 的正则字面量里含 `/`，被误认成注释起止。

⇒ 改成**在子进程里真的访问符号**，符号不存在就一定抛 ReferenceError。
⇒ 再进一步，**直接起服务打端点** —— 那是最诚实的判据。

### ★ 验证它真的能抓住那个 bug

注入同样的「少一个结束符」⇒ 3 条立即变红：

```
x 服务端能起来
x AI 端点不会因为「变量不存在」而崩（说明顶层声明都在）
x AI 端点返回的是结构化错误（400 参数校验）而不是 500
```

---

## 四、视觉链路端到端验证结果

用 `demo-out/png/sym-02c.png`（正投影工程图）：

```
HTTP 200   8.6 秒
柜体数=1   把握=high
· C1  宽=2400mm(annotation)  高=2400  深=600
    shelves count=3 / hanging count=1 / shelves count=3
notes: 图纸标注清晰，尺寸明确 / 背板厚度9mm / 三开门设计，含挂衣区和叠放区
```

**对照 EXPORT-DEMO 文档里的 ground truth**（「尺寸链齐全（2400 总宽、288/287 门宽、2400 高）」）
⇒ **宽 2400 / 高 2400 完全吻合**。

★ 特别值得注意：`width.source = annotation` ——
模型是**真的读到了图上的尺寸标注**，不是猜的。
# 视觉链路打通 + 两个真缺陷（2026-10-22）

> 这一轮的起因是「下一步该做视觉还是做语言」—— 结论是**先做视觉**，
> 因为语言侧已经量到 91-100%，而**视觉侧从来没端到端跑过**。
> 一跑就抓到两个**产品级阻断缺陷**。

---

## 一、缺陷 1：一条未闭合的注释 ⇒ 所有 AI 端点一律 500

### 现象

调用 `/api/ai/vision` 直接 500：

```
{"ok":false,"error":"HARD_MAX_TOKENS_CAP is not defined"}
```

### 根因

`server/server.mjs` 第 206-209 行：

```js
 * @param {object} env readEnv() 的结果
 * @returns {number}
                                 <- 这里少了 */
// ── 导出链路的外部程序 ──
const EMIT_NEUTRAL_TS = join(ROOT, 'scripts', 'emit-neutral.ts');
```

**少一个注释结束符 ⇒ 从第 206 行起全是注释 ⇒ `HARD_MAX_TOKENS_CAP` 根本没被声明**
⇒ 所有 AI 端点（chat / plan / design / vision / agent）**一律 500**。

### 什么时候引入的

`git blame` 指向 **2d34cda**（子代理的「序列相似度匹配收尾」提交，10-21 15:57）。
**整整一天，所有 AI 功能都是坏的。**

### 为什么所有既有验收都没抓住

| 手段 | 为什么测不到 |
|---|---|
| `tsc --noEmit` | **不检查 .mjs**（它在 tsconfig 的检查范围外） |
| `node --check` | 只查**语法**，不查「注释吞掉了后面的代码」 |
| 单元级验收 | 直接 import 某个函数，**绕过 HTTP 路由** ⇒ 模块顶层根本没被求值 |
| `verify:admin` | 看到 500 就归为「既有失败」放过了 |

★ 最后一条是我自己的问题：前几轮我**三次**看到 `HARD_MAX_TOKENS_CAP is not defined`，
都因为「基线也失败」而放过。**「既有失败」不等于「可以不管」** ——
尤其当它是一个 500 级的**全功能阻断**。

---

## 二、缺陷 2：视觉模型没配 ⇒ 识图功能是坏的

### 现象

配好视觉模型后手动指定模型调用 ⇒ 识别很好（宽 2400mm、三格分区全对）。
但走**产品路径**（前端发图）⇒ 模型答：

```
"图片内容为浏览器中显示的原始 SVG/XML 源码文本，其顶部有
 'This XML file does not appear to have any style information associated with it.' 提示，
 因此不是柜体效果图或截图。"
```

### 根因

`/api/ai/vision` 用 `env.AI_MODEL`（= `deepseek/deepseek-v4.1-flash`）。
而实测 **deepseek 发图后 `usage.prompt_tokens_details.image_tokens = 0`** ——
**它根本不看图**，只是对着输入瞎猜。

⇒ 「视觉识别」这个功能**看着在、实际是坏的**。

### 修法

```bash
# app/.env
AI_MODEL=deepseek/deepseek-v4.1-flash        # 文本（语言理解）
AI_VISION_MODEL=sensenova-6.8-flash-lite      # 视觉（识图）
```

并在**启动信息**里单列一行，配置没分开时给出提示：

```
  模型      deepseek/deepseek-v4.1-flash
  视觉模型  sensenova-6.8-flash-lite
```

---

## 三、新增验收：verify:server-integrity（35 项）

★ 核心是**真起一个服务端，打真实端点** —— 这才是那个 bug 的现场。

```
1. 扫描所有服务端 .mjs，找未闭合的块注释（跳过字符串与行注释）
2. ★ 真起服务（随机端口），打 /api/ai/vision：
   · 必须返回 400（参数校验）而不是 500（代码崩了）
   · 错误里不能出现「is not defined」
3. 各服务端模块能被 node 加载（顶层无 ReferenceError）
```

### ★ 为什么不能只扫源码

试过「块注释开合配平」这个判据 —— **误报**：
`server/server.mjs:2779` 的正则字面量里含 `/`，被误认成注释起止。

⇒ 改成**在子进程里真的访问符号**，符号不存在就一定抛 ReferenceError。
⇒ 再进一步，**直接起服务打端点** —— 那是最诚实的判据。

### ★ 验证它真的能抓住那个 bug

注入同样的「少一个结束符」⇒ 3 条立即变红：

```
x 服务端能起来
x AI 端点不会因为「变量不存在」而崩（说明顶层声明都在）
x AI 端点返回的是结构化错误（400 参数校验）而不是 500
```

---

## 四、视觉链路端到端验证结果

用 `demo-out/png/sym-02c.png`（正投影工程图）：

```
HTTP 200   8.6 秒
柜体数=1   把握=high
· C1  宽=2400mm(annotation)  高=2400  深=600
    shelves count=3 / hanging count=1 / shelves count=3
notes: 图纸标注清晰，尺寸明确 / 背板厚度9mm / 三开门设计，含挂衣区和叠放区
```

**对照 EXPORT-DEMO 文档里的 ground truth**（「尺寸链齐全（2400 总宽、288/287 门宽、2400 高）」）
⇒ **宽 2400 / 高 2400 完全吻合**。

★ 特别值得注意：`width.source = annotation` ——
模型是**真的读到了图上的尺寸标注**，不是猜的。

---

## 五、★ 缺陷 3：模型不看图时，返回一份「看起来很专业」的假结果

### 问题

即使配好了视觉模型，如果它**没看图**（image_tokens = 0），
返回的结果照样「结构完整、置信度 high」，用户根本看不出来。

实测那次误配时，模型返回的是：

```
"图片内容为浏览器中显示的原始 SVG/XML 源码文本……因此不是柜体效果图或截图。"
```

### 修法

响应里加一个 `sawNoImage` 标记（**只有网关明确报 image_tokens = 0 才为 true**）：

```js
const imageTokensRaw = usage?.prompt_tokens_details?.image_tokens;
const sawNoImage = imageTokensRaw !== undefined && Number(imageTokensRaw) === 0;
```

★ 关键：**undefined ≠ 0**。
实测 gpt-load 走 sensenova 时**根本不报** image_tokens ——
第一版写成 `?? 0` 就把一个**其实看了图**的模型误判成没看图（误报）。
⇒ 只有**明确报了 0** 才算没看图；undefined ⇒ 无法判定 ⇒ 不报警。

前端据此提示「当前视觉模型不支持图片，识别结果不可信」。

---

## 六、验证结果

```
HTTP 200   8.6 秒
ok=true   柜体数=1   把握=high   sawNoImage=false
· C1  宽=2400mm(source=annotation)  高=2400  深=600
    shelves count=3 / hanging count=1 / shelves count=3
notes: 图纸标注清晰，尺寸明确 / 背板厚度9mm / 三开门设计，含挂衣区和叠放区
```

**对照 EXPORT-DEMO 文档里的 ground truth**（「尺寸链齐全（2400 总宽、288/287 门宽、2400 高）」）
⇒ **宽 2400 / 高 2400 完全吻合**。

★ 特别值得注意：`width.source = annotation` ——
模型是**真的读到了图上的尺寸标注**，不是猜的。
而这正是调研报告里 CAD2Program 的结论（带标注 vs 仅几何：81.94% -> 97.21%）在本项目的复现。

---

## 七、这一轮的方法论收获

### ① 「既有失败」不等于「可以不管」

前几轮我**三次**看到 `HARD_MAX_TOKENS_CAP is not defined`，
每次都因为「git stash 后基线也失败」而放过。

★ 那是一个**全功能阻断**（所有 AI 端点 500），持续了一整天。

⇒ 「既有」只说明**不是这次改的**，不说明**不用管**。
判断依据应该是「**它有多严重**」，不是「它是谁引入的」。

### ② 配置类缺陷要能在启动时看出来

`AI_VISION_MODEL` 没配 ⇒ 视觉功能看着在、实际是坏的。
现在启动信息单列一行，配置没分开时直接提示。

### ③ 验收要测「故障现场」，不是测「代码形状」

我试过三个不够格的判据：

| 判据 | 为什么不够 |
|---|---|
| 扫源码找未闭合注释 | 正则字面量里的 / 会被误认成注释起止（误报一堆） |
| 块注释开合配平 | 同上 |
| 扫源码找符号声明 | 注释吞掉代码后源码里确实没有，但正则/字符串处理太脆 |

⇒ 唯一诚实的判据：**真起服务、打真端点**。
这也解释了为什么既有验收全都漏了：
它们都是**单元级**的（直接 import 函数），**绕过了 HTTP 路由**。
