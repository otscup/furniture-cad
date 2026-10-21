# 提速与智能优化 —— P0 实施记录（2026-10-21）

> 配套规划：`PLAN-SPEED-INTELLIGENCE-2026-10-21.md`
> 外部调研：`app/docs/VLM-家具CAD识别调研.md`、`RESEARCH-INTENT-AND-SPEED-2026-10-21.md`

## 摘要

这一轮实施了规划里的 **P0 五项**，全部有实测数据支撑。

| 项 | 之前 | 之后 | 依据 |
|---|---|---|---|
| **P0-1** prefix cache | `cached_tokens = 0`（每轮全废） | **1024**（首次即命中） | 网关实测：动态在末尾 cached=1152 / 开头 cached=0 |
| **P0-2** 并行 tool_call | 代码已支持 | 确认两个模型都会一轮返回多个 | 实测：3 个 tool_call 一次返回 |
| **P0-3** 模型分工 | 文本与视觉共用一个模型 | 文本 `deepseek` / 视觉 `sensenova` | deepseek NLU 7/12 且 3x 快；只有 sensenova 能看图 |
| **P0-4** vision 端点 | 无 `response_format`、`knownScaleMm` 断链 | 补齐 + 参考尺寸 UI | 网关实测 `json_object` 支持 |
| **P0-5** prompt 契约 | 手写在 server.mjs，与 types.ts 漂移 | **由 types.ts 生成** | 类型里有 `rodHeight` 等 4 个字段，手写版没有 |

---

## 一、P0-1：prefix cache 从 0 到 100%

### 根因

网关做**纯前缀匹配**：system 里只要有一处逐字变化，从变化点往后全部缓存不上。

而 `server/agentLoop.mjs:486-488` 把**每轮都变**的内容堆在 system 最前面：

```
${rulesBlock ? rulesBlock + '\n' : ''}${recipeBlock ? ...}${seqHint ? ...}规则：
```

`rulesBlock`（纠正记忆）`recipeBlock`（配方库）`seqHint`（序列范例）—— 用户改了记忆、换了配方、命中了不同序列，它们就变。

### 实测（gpt-load 网关）

```
动态在 system【开头】（原状）  -> cached = 0      首次未命中
动态在 system【末尾】           -> cached = 1152   首次即命中
动态拆成独立 system 消息        -> cached = 1024   首次即命中
```

### 修法

拆成 `staticRules`（每轮不变）+ `dynamicContext`（每轮变），后者拼在后面。

**为什么不用「拆成多条 system 消息」**（实测也能命中）：
那样「规则：」这个标题会跟动态内容分离，模型读起来像两组不相干的指令。
放在同一条消息里、只换个顺序，语义最接近原文。

---

## 二、P0-2：并行 tool_call 其实已经在工作

### 实测

```
deepseek-v4.1-flash      一轮返回 3 个 tool_call（建 3 个地柜模块）
sensenova-6.8-flash-lite 一轮返回 3 个 tool_call
```

### 代码本来就没问题

`server/agentLoop.mjs` 的 `for (const tc of toolCalls)` 循环，每个 tool_call 都 push 对应的
`role: 'tool'` + `tool_call_id` —— 符合 OpenAI 协议。

### ★ 但**不能**把 tool 执行改成并行

调研报告提到「自动避让让落位依赖调度顺序 ⇒ 静默出错」——核实后确认：
`cad.create_cabinet` 不传 x/y 时会自动找贴墙位置，
两个 create 并行执行时**落位结果取决于调度顺序**。

⇒ **一轮多 tool_call（省模型往返）+ tool 仍串行执行（保顺序）** 是唯一安全的组合。
本轮**不改代码**，只加断言防退化。

---

## 三、P0-3：模型分工

### 实测数据

**看图能力**：

```
deepseek-v4.1-flash      发图后 usage 里 image_tokens = 0  => 根本不看图
sensenova-6.8-flash-lite 发 209KB 衣柜图 -> prompt_tokens 2984（含图）
                       -> 正确识别出：左挂衣+3抽 / 中挂衣+3层板 / 右层板+3抽
```

**语言理解**（12 条真实口语指令，带项目上下文）：

| 模型 | 命中 | 耗时 | 失败形态 |
|---|---|---|---|
| **deepseek-v4.1-flash** | **7/12** | 4-18 s | 诚实回答「做不到」/ 主动追问 |
| sensenova-6.8-flash-lite | 5/12 | 7-91 s | **6 次 PARSE_FAIL** |

sensenova 那 6 次失败全是：推理 token 把 8192 预算吃光，JSON 还没输出完就 `finish=length`。

**纯 JSON 小任务**上 sensenova 反而更省（61-84 vs 151-163 completion token）——
所以问题不是模型笨，是**长提示词 + 复杂任务下推理失控**。

### 修法

```
// server/server.mjs 的 vision 路由
const model = body.model || env.AI_VISION_MODEL || env.AI_MODEL || s.model;
```

新增环境变量 `AI_VISION_MODEL`。前端可在请求体里显式指定（`body.model` 优先级最高）。

---

## 四、P0-4：vision 端点的三处修复

### ① 补 `response_format`

vision 此前是**唯一**没设 `response_format` 的 AI 端点
（`aiContract.mjs` 的 design/plan 通道都设了 `json_object`）。

讽刺的是 vision 恰恰是**最容易**产出畸形 JSON 的端点——输出长、嵌套深、
还常被模型包在 ```json``` 围栏里。

**网关实测**：

```
response_format: {type:'json_object'}  -> 支持
response_format: {type:'json_schema'}  -> **HTTP 400**（网关不认严格 schema）
```

⇒ 只能用 `json_object`。它只是提示、不保证严格合规，
所以后面的正则剥围栏 + 服务端形状校验**仍然要留着**（没删）。

同时 `temperature` 从 0.2 降到 0 —— 这是**抽取**任务不是创作任务，
0.2 的随机性只会让同一张图两次识别出不同结构。

### ② 修 `knownScaleMm` 断链

**这是完整断掉的一条链**：

```
providers/remote.ts:54   传了 knownScaleMm  ✓
AIPanel.tsx:734           请求体只有 {image, mode, hint}  ✗
AIPanel.tsx:897           同上  ✗
server.mjs                从没读过这个字段  ✗
```

⇒ 「用户给参考尺寸」整条路径走不通（只有 ImportPanel 那条能用）。

**修法**（三处）：

- 前端加 `knownScaleMm` 输入框（「参考尺寸 mm」），两处请求体带上
- 服务端读 `body.knownScaleMm`，写进**用户消息**（不是 system）
- 提示词说明：换算后 source 填 `reference`、scale.known 填 true

★ 写进**用户消息**而不是 system：system 是静态前缀，
动态内容放后面才能命中 prefix cache（P0-1 实测）。

### ③ 前端提示：尺寸来源

```
【已知参考尺寸】用户告知图中某个参照物的真实宽度是 900mm。
请用它换算图中各柜的真实尺寸，并把对应尺寸的 source 填 "reference"、
scale.known 填 true、scale.referenceMm 填 900。
若那个参照物其实不在图里，请照实说看不到，不要硬套。
```

最后一句很重要——不写这句，模型会**硬套**一个不存在的参照物。

---

## 五、P0-5：prompt 契约单一真源

### 漂移造成的后果（不是理论风险）

| 位置 | VisionUnit 的字段 |
|---|---|
| `src/ai/vision/types.ts:38-54` | kind, widthMm, widthRatio, count, doorCount, **rodHeight**, **applianceName**, **openingWidth**, **openingHeight**, confidence |
| `server.mjs:2679` 的手写 prompt | kind, widthMm, widthRatio, count, doorCount, confidence |

**⇒ 模型永远给不出挂衣杆高度和电器洞口尺寸**，
而 `visionResultToNormalized.ts:60-64` 明确要透传 `rodHeight`（「P9.9 约束一」）。
前端在等一个模型不会给的值。

### 修法

在 `types.ts` 里加 `visionResultSchemaText()`，
把接口定义渲染成提示词文本；服务端直接调用，**不再手写**。

要加字段 ⇒ 改类型（TS 报错）⇒ 改生成器 ⇒ 提示词自动跟上。

**两处手写 prompt 都改了**（dimension 模式与 render 模式各一处）。

---

## 六、★ 顺带发现并修掉的一个「源码扫描守不住重构」

### 现象

P0-1 拆分提示词后，`verify:agent-smart` 有两条断言变红：

```
✗ Agent 通道把配方块插进了系统提示词
✗ projectContextText 进了 Agent 系统提示词
```

### 根因

那两条是**源码字符串扫描**：

```js
agentSrc.includes('recipeBlock ? recipeBlock +')
/projectContextText \?/.test(agentSrc)
```

我改了拼接方式，字符串没了 —— **但功能一点没坏**。

这正是「源码扫描」的固有毛病：它测的是**写法**，不是**行为**。

### 修法

**把提示词构造抽成可 import 的函数** `buildAgentSystemPrompt()`，
验收改成**真的构造出提示词**再检查内容：

```js
const { systemPrompt } = buildAgentSystemPrompt({ recipeBlock: '【配方】衣柜：先建柜再分区' });
ok('配方块插进了系统提示词', systemPrompt.includes('【配方】衣柜'));
```

（与项目里 `selectProjectRules` / `pickSequences` 同一个套路：
**凡是「决定」散落在大函数里的，就提出来。**）

### 变异测试也要跟着改

原来那条变异（把 `projectContextText ? ...` 换成空）会**测不到**了 ——
因为实现换成了函数调用。所以变异改成「把 `projectContextText,` 换成 `'',`」。

★ 这也说明：**变异测试的锚点必须跟着重构一起更新**，
否则它会「测了个寂寞」还显示通过。

---

## 七、验收

| 套件 | 项数 | 内容 |
|---|---|---|
| `verify:agent-cache` | **38** | 位置断言 + 每轮变的内容在动态段 + 静态段无夹带 + 内容未丢 + **网关实测机制验证** |
| `verify:agent-cache-mutations` | **11** | 变异 |
| `verify:agent-smart` | 258 | （原有，含 2 条改写成行为断言） |
| `verify:agent-smart-mutations` | 46 | （原有） |
| `eval:nlu` | 15 条用例 | **新增**：NLU 评测卡（联网） |

### NLU 评测卡基线（deepseek-v4.1-flash）

```
动作命中率：8/12 = 67%
正确澄清率：1/3  = 33%
```

**失败明细暴露的真问题**：

| 用户说 | 模型答 | 性质 |
|---|---|---|
| 「换成玻璃门」 | 「现有动作里没有"修改已建分区门板材质"」 | **能力缺失** |
| 「层板再多加两层」 | 「要加层板得先确定对象…请告诉我现有层板数」 | 上下文没给分区明细 + 能力只支持绝对值 |
| 「建个柜子」 | 直接给了 `cabinet.create` | **该追问却瞎猜** |
| 「加个抽屉」 | 直接给了 `cabinet.addUnit` | **该追问却瞎猜** |
| 「主卧的床旁边那个柜子往左挪一点」 | 「没给具体距离，我不替你定数」 | **正确澄清**（算命中） |

⇒ 下一步的 P1-1（补 `cabinet.addRow` / `cabinet.setUnitDoorMaterial`）
  和 P1-2（把能力边界写进提示词）**直接由这张卡指出来**，不是拍脑袋。

★ 判分用**程序化断言**（动作名命中 / 是否给了动作），
  不用 LLM judge —— 又准又便宜，且能进 CI。

---

## 八、还没做的（及原因）

| 事项 | 原因 |
|---|---|
| 改指纹算法 | 指纹存项目文件里，改算法 ⇒ 已存项目的手工标注全部失配 |
| `json_schema` 约束解码 | 网关 HTTP 400 |
| 并行执行 tool | 落位依赖调度顺序 ⇒ 静默出错 |
| 小模型分层 | 网关没有第二端点（`/models` 实测只有 2 个） |
| 视觉三段式识别 | 需要 grounding 模型（Qwen3-VL 等），当前网关没有 |

---

## 九、下一步（P1）

按这张 NLU 卡的指出来的顺序：

1. **补动作** `cabinet.addRow`（加上下分层）、`cabinet.setUnitDoorMaterial`（改已有分区门板材质）
   —— 模型已经在「问」了，给它能力就不用问
2. **把能力边界写进提示词** —— 「做不到」要变成「做不到 X，但可以 Y（要不要？）」
3. **显式 `focusStack`** —— 「再宽点」不经过模型理解直接落参数
4. **配方库加 few-shot 样例字段** —— 模型是抄示例，不是读规则
5. **视觉三段式识别**（等有 grounding 模型）
