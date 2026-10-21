# MCP 点号问题的完整处理 + 后续建议

## 一、MCP 那个点，现在是怎么处理的

### 分两层看，只有一层有问题

| 层 | 名字形态 | 是否有问题 |
|---|---|---|
| **MCP 协议层**（`/mcp` 端点、tools/list、tools/call） | `cad.create_cabinet` | **没问题**，完全正常 |
| **Function calling 层**（发给大模型的 tools 定义） | `cad.create_cabinet` | **有**，网关 400 |

关键点：**MCP 协议本身完全接受点号**，是「把 MCP 工具转成大模型 function calling」这一步出的问题。

### 当前实现（agentLoop.mjs:190-200）

```js
const toolNameToWire = new Map();   // 原名 -> 线上名
const wireToToolName = new Map();   // 线上名 -> 原名
for (const t of agentTools) {
  const wire = t.name.replace(/\./g, '_');   // cad.get_state -> cad_get_state
  toolNameToWire.set(t.name, wire);
  wireToToolName.set(wire, t.name);
}
const agentToolsForWire = agentTools.map((t) => ({
  ...t,
  name: toolNameToWire.get(t.name) ?? t.name,
}));
```

**只在这一个函数内生效**，是纯内存映射，不落盘、不外泄。

### 完整数据流

```
MCP tools/list  →  cad.create_cabinet   （MCP 层，点号正常）
                        ↓ 净化
发给模型         →  cad_create_cabinet   （线上名，无点号）
                        ↓ 模型返回 tool_call
模型回传         →  cad_create_cabinet
                        ↓ wireToToolName.get() 还原
调 MCP           →  cad.create_cabinet   （还原成 MCP 真名）
```

### 已验证的几个细节

1. **回传给模型的 tool 结果消息不带工具名** —— 只带 `tool_call_id` 和 content，所以不需要再转换。
2. **assistant 消息里的 tool_calls 原样回传** —— OpenAI 协议要求回声模型自己发的东西，所以那里保留线上名，正确。
3. **要求确认映射不撞车** —— `cad.a_b` 和 `cad_a.b` 都会变成 `cad_a_b`。当前 18 个工具里没有这种情况，但如果将来加了，会静态冲突。**这是唯一的技术债**。

### 剩下的一个隐患

映射冲突没有检测。如果哪天加了一个工具叫 `cad_a.b`，它和 `cad.a_b` 净化后会撞名，第二个会被第一个覆盖，表现为「模型调了 A 结果执行了 B」。

建议加一行检测：
```js
if (wireToToolName.has(wire) && wireToToolName.get(wire) !== t.name) {
  throw new Error(`工具名净化冲突：${t.name} 与 ${wireToToolName.get(wire)} 都映射到 ${wire}`);
}
```

这条我建议加，因为它的失败模式**极其隐蔽**（调错工具但不报错）。

---

## 二、后续推荐（按性价比排序）

### P0：现在就该做

**1. 工具名冲突检测**（见上，10 分钟）
失败模式太隐蔽，值得防。

**2. 把点号这个坑写进 MEMORY.md**
表现是「AI 不干活」，下次换网关或别人接手会重新踩，而且第一反应会是怀疑模型。

**3. corrections 接进提示词**（我前面提过两次，还没做）
现在管理后台的纠正规则 AI 完全看不到。接上之后，「面板整板不拆」这类约定说一次就够。
这是**唯一一处「系统有学习机制但没接回路」**的地方。

### P1：结构性改进

**4. 删掉 AIPanel 里的死代码 `requestPlan`**
`requestPlan`（走 `/api/ai/plan`）从来没被调用过，界面只走 `/api/ai/agent`。
两条通道并存但没有一条走 plan，等于：plan 通道的所有投入（意图解析、候选请求、评分）**在界面上都是死的**。

两个选择：
- **保留 plan 通道，但界面接上**（复杂规划走 plan，简单建柜走 agent）
- **删掉 plan 通道**，把它的能力合并进 agent

我倾向前者 —— plan 通道的 `candidateRequest`/`plannerRequest` 是设计层入口，删了就把刚接好的意图通道又断了。

**5. Agent 步数上限从 15 降到 8，并把「标准配方」写进提示词**
实测复杂任务 15 步 × 10 秒 = 150 秒，用户等不了。
给提示词标准配方（「L型厨房 = create_room → 3×create_cabinet → assembly.create，共 5 步」）比调超时有用得多。

**6. 提示词按意图裁剪**
现在 `buildSystemPrompt()` 9700 字符每次全发。用户说「建个柜子」时不需要 `export_*`、`sharedPanel.*` 那些说明。预计能把 prompt 从 8.7k 降到 3k token，首字延迟明显下降。

### P2：体验

**7. 候选预览的视觉合理性验证**
我只断言了「满足目标」，没看画出来好不好看。建议跑一批真实场景截图人眼过一遍。

**8. 让 Agent 也支持 `candidateRequest`**
现在 agent 通道只有 intentRequest，`candidateRequest`/`plannerRequest` 仍然只在（死的）plan 通道里。

---

## 三、我不推荐做的

**❌ 不要为了网关改 MCP 工具名**
`cad.xxx` 是 P10.0 对外契约，被 127 条断言 + 外部客户端 + 文档引用。
净化层已经解决了问题，且只影响「发给模型」这一个方向。

**❌ 不要用微调解决「AI 不听话」**
本地网关是 gpt-load 代理，不可微调；而且契约有 28 条动作 + 近百参数约束，微调成本远超收益，契约一改就失效。

**❌ 不要把步数上限调大**
15 步已经是 150 秒。真问题是「步数太多」，不是「时间不够」。

---

## 四、一个总体判断

这几轮下来，我发现一个**模式**：这个项目的问题大多不是「能力不够」，而是
**「能力建好了但没接线」**。

已经发现的同类问题：

| 已有的能力 | 未接线到什么 |
|---|---|
| `corrections.jsonl` 纠错规则 | AI 提示词 |
| `candidateRequest` / `plannerRequest` | 服务端解析（今已修 intentRequest） |
| `intentRequest` | 界面确认（今已修） |
| 8 个设计目标 | 只有 2 个有构造器（今已补到 5 个） |
| `requestPlan` 通道 | 界面调用 |
| `MCP 工具` | 大模型 function calling（今已修） |

这是好事 —— 说明**架构方向是对的，只是没接完**。补线上比重新设计便宜得多。

但也说明一件事：**「有代码」不等于「能用」**。验收判据必须是「目标真干成那件事」，
而不是「函数存在」。这轮我自己也踩了两次（重叠检测器假红、satisfiesGoal 变异没抓住），
都是同一个病。