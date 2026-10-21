# 前端确认 UI + Agent 通道修复（2026-10-21）

## 一、最重要的一件事：Agent 模式在这台网关上从来跑不通

**这是本轮最有价值的发现，比"加确认按钮"重要得多。**

### 现象
`/api/ai/agent` 一律返回 500：
```
AI 调用失败 HTTP 400: {"message":"invalid request error","type":"invalid_request_error"}
```
错误信息里**没有任何指向具体原因的线索**。

### 定位过程
逐个工具单发，把 18 个工具挨个试：

| 工具名 | 结果 |
|---|---|
| `cad.get_state` | **400** |
| `cad_get_state` | **200** |
| `cad.validate` | **400** |
| `t`（无点号） | **200** |

**根因：本地网关（gpt-load）不接受工具名里的点号。**

而本项目 18 个 MCP 工具**全部**叫 `cad.xxx`。

### 这意味着什么
在换这个网关之前，**Agent 模式一次都没成功过** —— 不是"有时慢"，是**每次都 400**。
而 400 的错误信息完全没提工具名，所以看起来像"模型不给力"。

### 修法
发给模型时把 `.` 换成 `_`，收回来再映射回原名。

**为什么不改 MCP 工具名**：`cad.get_state` 是 P10.0 的对外契约，被 verify:mcp 的 127 条断言、外部 MCP 客户端、文档全部引用。为了让一个网关能跑而改对外契约，是本末倒置。

### 修复效果
同一个"建一个衣柜"的请求：

| | 修复前 | 修复后 |
|---|---|---|
| 结果 | 500 / 0 步 | **ok / 6 步 / 26 秒** |
| 工具调用 | 全部 400 | create_cabinet → validate → delete → get_state → create_cabinet → validate 全成功 |

---

## 二、前端确认 UI

### 链路
```
用户说话 → Agent 提 intentRequest（JSON 块）
        → agentLoop 从最终回答里捞出（三级解析：原样/围栏/平衡花括号）
        → server 过 validateIntentRequest（唯一那份校验）
        → 回传前端（合法给 intentRequest，非法给 intentRequestError）
        → AIPanel 渲染确认卡片
        → 用户点「确认这个目标」
        → makeCandidateIntent → confirmIntent → replaceProject
        → 立即枚举候选
```

### 界面
- **正常**：「AI 想确立一个设计目标（等你确认）」——显示 goal / 作用对象 / AI 的理解，两个按钮：`确认这个目标` / `不用了`
- **被拒**：「AI 提了一个设计目标，但不符合契约」——显示具体错误码与原因

文案明确写了：「确认后系统会把这个目标写进模型，并立即枚举几种满足它的摆法给你预览。**不会自动改动任何柜体** —— 你还要在候选里自己挑一份。」

### 红线保持
- AI 只能产 candidate（`makeCandidateIntent` 没有参数能造成 active）
- 用户点确认才走 `confirmIntent`
- `intentRequest` 里不许有 x/y/rotation/wallId（契约层拒绝）

---

## 三、实测结果

| 输入 | 输出 |
|---|---|
| 「请把『柜体必须完整落在房间内』这个设计目标记录下来，别改柜子」 | `{"goal":"room-inside","scope":{"kind":"cabinet","cabinetId":"cab_001"}}` ✓ 4.4s |
| 「帮我看看能不能给这个房间设一个『别挡门窗』的设计目标」 | `{"goal":"opening-clear",...}` ✓ 13.1s |
| 「这个衣柜摆放不合理，我希望它别跑到屋子外面去」 | AI **没提**意图，而是查了坐标后反驳："这个衣柜目前完全在屋子内" —— **这是正确行为**，它没有盲从 |

---

## 四、验收：43 条断言（新增 5 条）

`verify/intent-channel-acceptance.ts` 第 8 节，已接入 `verify:all`：

- agentLoop 源码含「工具名净化」
- 含「线上名→原名的反向映射表」
- 含「收工具调用时用映射表还原原名」
- 含「净化后的工具集」
- 含「调模型时确实用了净化后的工具集」

**全部是源码级断言**，不是测试里重写一遍逻辑。变异验证：把 sanitize 改成恒等 → 第 1 条红。

> 第一版我在测试里自己写了一遍 replace —— 那种断言证明的是"我的 replace 能工作"，不是"agentLoop 真的在净化"。有人删掉源码里的净化，那条照样绿。改成源码扫描才真正钉住。

---

## 五、回归

`tsc` 干净、`build` 通过、`verify:intent-channel` 43/43、`verify:design-intent` 162/162、`verify:ai` / `verify:mcp` / `verify:sheet-layout` / `verify:sync-delete` 全绿。

---

## 六、还没做 / 已知限制

1. **AIPanel 里 `requestPlan` 是死代码** —— 界面走 `/api/ai/agent`，`requestPlan`（走 `/api/ai/plan`）从来没被调用。plan 通道我也加了 intentRequest 解析且有测试覆盖，但界面只有 agent 通道生效。
2. **确认意图后自动枚举候选**用 `generateCompare()`，依赖 `currentKnowledge()` 的 active 意图。刚确认的意图在同一帧内可能还没进快照 —— 我用 `setTimeout(0)` 错开，但没有严格验证。
3. **候选预览的视觉合理性未验证** —— 只断言"满足目标"，没看画出来好不好看。
4. **端到端样本小** —— 每类场景只测了 1-2 条 prompt。

---

## 七、建议写进 MEMORY

> 本地网关（gpt-load）不接受 function calling 的工具名里的点号。`cad.xxx` 会被 400 拒绝，且错误信息不含线索。agentLoop 里有 sanitize 层处理。

否则下次换网关或别人接手会重新踩 —— 这个坑的表现是"AI 不干活"，很容易被误判成模型能力问题。