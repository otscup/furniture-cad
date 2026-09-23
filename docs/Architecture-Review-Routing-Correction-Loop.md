# 架构评议：模型路由 · 确定性 CAD 后端 · 纠错闭环

> 本轮**只做分析，未改动任何代码**。
> 所有结论都基于对现有工程的逐文件勘察，凡引用处均给文件路径与行号。没有假设的文件名。

---

## 0. 结论先行

| 你问的 | 我的判断 |
|---|---|
| 常用模型 + 推理模型怎么分配 | 需要路由，但 long-text 把 `deterministic` 列成一种「模型路由」是**放错层了** —— 计算压根不经过模型。正确抽象是 `none`（根本不发请求）/ `standard` / `reasoning` / `human_confirmation` |
| Jev 适合吗 | **现在不适合**（量级不对、候选太少、成本>收益）。留口子，但**别现在写那个接口** —— 只有一个实现时，接口形状一定是猜的 |
| 计算靠 CAD 后端而非模型 | **这个前提你早就做到了，而且比 long-text 要求的更严**。后端不该大改；真正该加的是给后端一个**解释通道**（`/api/explain`） |
| 后端怎么按使用习惯优化 | 拆开两件被混淆的事：后端需要的不是「自适应」，是**把 AI 的错变成后端的断言** |
| 我现在给 AI 加记忆这方法行不行 | **方向对，机制有天花板。** 实测：纠错**只进"拦"的通道，从未进过模型的提示词** —— 所以它只能"拦"，永远不能"教"。而 AI 犯的错大部分是拦不住的 |
| 商业化 / 每人一个调教好的 | 先解决一个**真实错配**：账号在服务端，记忆在浏览器。优先级建议 **4 层 + 来源溯源**，不是 long-text 的 6 层 |

---

## 1. 代码勘察报告

### 1.1 long-text 列的 7 条风险 —— 逐条核实

| long-text 担心的风险 | 实际状态 | 证据 |
|---|---|---|
| AI 直接计算最终板件尺寸 | **不可能**。18 个动作里没有任何一个接受坐标/尺寸数组；发给 AI 的快照是**白名单投影**，派生字段在结构上不可能出现 | `shared/aiContract.mjs:79-249`（动作表只有语义参数）；`src/ai/snapshot.ts:7-26` + 三条常驻不变量 I1–I3 |
| AI 直接修改底层几何 | **不可能**。动作编译成 Command 后仍要过 `isWritablePath` 白名单（第三层不认识"AI"） | `shared/aiContract.mjs:20-21`；`src/core/commandBus.ts` 的写权限白名单 |
| AI 绕过 Rule Engine | **不可能**。校验器校验的是**生成器的输出**，而不是"自己另算一遍" | `src/core/rules/validate.ts:9-13`（注释写明了理由） |
| AI 直接生成 DXF | **不可能**（DXF 尚未接入 app，Phase 1 遗留） | 无 DXF 代码路径 |
| 用户记忆覆盖生产规则 | **不可能，而且是刻意设计的**。`CheckSpec` 只有「拦」的方向，没有任何"放行"能力；规则集对 AI 只读 | `src/ai/memory.ts:47-78`（4 种 check 全是拒绝语义）；`aiContract.mjs:26` |
| 模型输出未经过结构化校验 | **有两层**：服务端校验一次，前端拿到 `actions` 后**再走一遍** `validatePlan` | `shared/aiContract.mjs:451-491`，`:475-479` 的注释专门解释为什么通过的动作不许附加任何元信息 |
| Command 没有版本或审计日志 | **部分成立**。有审计，但字段远不够 | 实测 `memory/audit.jsonl` 出现过的字段全集：`at, actor, action, result, model, actions, rejected` |

**小结：7 条里 6 条已经有防线，唯一真缺口是审计字段不够。**

### 1.2 确定性后端现状（比 long-text 假设的强）

`src/core/rules/validate.ts` 的校验分三类，绝不能混：

| 类 | 位置 | 作用 |
|---|---|---|
| A 恒等式断言 | `validate.ts:30-124` | 证明**几何生成器自己没算错** |
| B 生产硬规则 | `validate.ts:135-189` | 可判定、可阻断的真实工艺限制 |
| C 缓存自检 | `validate.ts:191-195` | `LAYOUT-CACHE-STALE`：重算 layout 与传入的不一致就报"这是程序缺陷" |

你在 long-text 里点名要检查的 7 项，**逐条都能指到位置**：

| long-text 要求检查 | 落点 |
|---|---|
| 侧板是否正确扣除顶/底板厚度 | `validate.ts:37-39`（`箱体高 + 抬高 = 总高`、`内空高 + 2×板厚 = 箱体高`、`内空宽 + 2×板厚 = 总宽`）+ `:41-42` 宽度链 |
| 中立板是否按跨度规则生成 | `validate.ts:166-168`（`RULE-SHELF-SPAN`）⚠️ **是 WARNING，见 §4.1** |
| 门板间隙是否由规则计算 | `validate.ts:81-88`（`Σ门宽 + 2×外缝 + (n-1)×中缝 = 净宽`）+ 共享的 `doorWidths()` |
| 抽屉空间是否由后端计算 | `validate.ts:91-117`，含 `RULE-RUNNER-TOO-LONG`（滑轨长 > 柜深）与 `RULE-DRAWER-NO-ROOM` |
| 板件是否超出最大开料尺寸 | `validate.ts:140-145`（区分有无木纹方向：`x.grain === 'length'` 时不可旋转） |
| 修改柜体后派生板件是否重生成 | 缓存自检 `validate.ts:191-195` + `npm run verify` 105 项里的"缓存失效"组 |
| DXF 是否始终从最新模型生成 | 尚未接入（Phase 1 遗留） |

**这套东西的设计质量很高，我不主张大改。** 值得单独指出的一个细节：`validate.ts:44-59` 用「**面积守恒**」而不是「第一块宽度等于公式值」来断言背板拆块 —— 因为拆成 n 列 × m 行之后单块尺寸不再等于整板公式值。这是踩过坑之后才写得出来的断言。

### 1.3 纠错的现状 —— 真缺口在这里

```
src/ai/memory.ts          Correction + 4 种 CheckSpec
       │
       ├─→ src/state/memoryStore.ts:39   bus.setGate(compileCorrections(corrections).gate)
       │                                  ← 唯一的去处
       │
       └─→ shared/aiContract.mjs:502     buildSystemPrompt()   ← 不接受任何参数
                                          （全仓唯一调用点：:599 的 buildChatRequest）
```

实测：全仓搜索 `corrections` 的所有使用点，**除了 gate，没有任何一处把它送到模型面前**。

> ### 结论：现在这套记忆，只能「拦」，永远不能「教」。
> 这是整个进化机制的结构性天花板。

而 `CheckSpec` 的 4 种类型（`noNewIssue` / `maxValue` / `minValue` / `pathForbidden`）**全部要求"这件事可判定"**。AI 犯的错大部分不可判定 —— 详见 §2.4。

### 1.4 账号 / 多租户现状

| 项 | 状态 | 证据 |
|---|---|---|
| 角色表 | 就位（`owner/admin/designer/viewer`） | `server/auth.mjs:33 ROLES` |
| 订阅档位与额度 | 就位（`free/pro/team/unlimited`，含 `models` 白名单） | `auth.mjs:41 PLANS`、`:455 checkModel()` |
| 用量记账 | 就位 | `auth.mjs:471 recordUsage()`、`:485 normalizeUsage()`（跨月/跨日归零在**读取处**判，不依赖定时器 —— 好设计） |
| `tenantId` 字段 | **已就位**，但只有一个租户 | `auth.mjs:252 tenantId: 'tenant_default'`；`:540` 自述"字段已就位" |
| 纠错的用户归属 | **完全没有** | `src/ai/memory.ts` / `correctionStore.ts` / `memoryStore.ts` 里 **0 处** `userId` / `tenantId` |
| 纠错的存储位置 | **浏览器 `localStorage`** | `correctionStore.ts:16 KEY = 'furniture-cad.corrections.v1'` |
| 服务端记忆接口 | **单一全局文件**，无用户维度 | `server/server.mjs:918-937`（GET/PUT `/api/memory` → `memory/corrections.jsonl`） |

> ### 这是一个必须点出来的架构错配：
> ```
> 账号 / 会话 / 额度 / 审计  →  服务端（auth.mjs）
> 纠错 / 记忆              →  浏览器（localStorage）
> ```
> 后果：**换电脑、换浏览器、清一次缓存，调教了半年的记忆全没了，而账号还在。**
> 对"自用"已经是缺陷；对"订阅制"是致命的 —— 用户会认为"你们把我的设置弄丢了"。

### 1.5 两份系统提示词，在两个地方

| 通道 | 系统提示词的构建位置 | 服务端行为 |
|---|---|---|
| `/api/ai/plan` | `shared/aiContract.mjs:502` `buildSystemPrompt()`（服务端，由契约生成） | 服务端自己拼 |
| `/api/ai/chat` | `src/ai/aiClient.ts:185 CHAT_SYSTEM`（**前端**） | 服务端只转发 `body.messages`（`server.mjs:657-700`） |

**这不是 bug，但它意味着：任何"给提示词加料"的改动都要改两处。** 做 §2.4 的 lessons 注入时如果不留意，会出现"对话通道学会了、规划通道没学会"的鬼故事。

---

## 2. 逐条回答

### 2.1 常用模型与推理模型怎么分配

#### 先纠正一个前提

long-text 把 `deterministic` 列为一种 `RouteKind`。**这是放错层了。**

现有架构里，"算板件尺寸"压根**不经过模型** —— 它是一条独立的确定性通道。把它做成路由的一个选项，等于承认"板件尺寸有可能被路由到模型去算"，而这恰恰是整份 long-text 自己最反对的事。

正确的分层：

```
第 0 层  命令类型      → 要不要用模型？  由动作语义决定，不是路由的事
第 1 层  难度信号      → 用哪个模型？    纯确定性代码算，零成本
第 2 层  模型（可选）  → 两可区间才参与  低置信度不许降级
```

#### 第 1 层的难度信号（建议全部来自已有数据，不新增模型调用）

| 信号 | 来源 | 触发 |
|---|---|---|
| 动作条数 | `plan.actions.length` | ≥3 升档 |
| 涉及柜体数 | `target.cabinetName` 去重 | ≥2 升档 |
| 含破坏性动作 | `ACTIONS[name].dangerous` | 直接 `human_confirmation` |
| 含 `addUnit` / `removeUnit` | 契约 | 升档 |
| 上一次同类请求被拒 | 审计里 `result != ok` | 升级 |
| 会话内连续失败 | 计数器 | 2 次 → `reasoning` |
| 快照字节数 | `snapshotBytes()` | 只影响裁剪，不影响选型 |

#### 建议的接口（比 long-text 的更省，且能立刻落地）

```ts
/** 只决定"用哪个模型（或不用）"，不决定"要不要计算" */
type RouteKind = 'none' | 'standard' | 'reasoning' | 'human_confirmation';

interface RouteDecision {
  route: RouteKind;
  reason: string;                     // 给人看的一句话
  signals: Record<string, number>;    // 每个信号的取值 —— 出事时能复盘
  model: string | null;               // route === 'none' 时为 null
  fallback: RouteKind;
  router: 'rules' | 'llm' | 'external';   // 现在恒为 'rules'
}
```

`none` 的含义要写清楚：**它不是"用一个便宜模型硬算"，是"根本不发请求"。** 这正是 long-text 里 `deterministic` 想做、但放错位置的那件事。

#### 配置化（`config/routing.json`，不硬编码）

```json
{
  "escalate": {
    "actionsMin": 3,
    "cabinetsMin": 2,
    "dangerousForces": "human_confirmation",
    "addRemoveUnitForces": "reasoning",
    "consecutiveFailures": 2
  },
  "models": { "standard": "${AI_MODEL_STANDARD}", "reasoning": "${AI_MODEL_REASONING}" }
}
```

`.env` 加 `AI_MODEL_STANDARD` / `AI_MODEL_REASONING`，**不配就回落 `AI_MODEL`**。

> **这是这个改造能不能做的关键：必须做到"没配双模型时，行为与现在逐字节一致"。**
> 那样你现有的 396 项浏览器验收 + 354 项 Node 验收**一条都不用改**。
> 这类"零行为变化"的改造才值得做；否则你会在改路由的同时把验收基线一起搅乱。

### 2.2 Jev 适合吗

**实测调研结论**（TypeSafe 2026-09-15 发布，当前 `jev-1.13.0`）：

| 项 | 值 |
|---|---|
| 端点 | `POST /v1/systemone` |
| 三个原语 | `Noul`（是/否 + 概率）、`Choice`（≤255 选一 + 概率分布）、`Score`（2–10 有序级） |
| 定价 | $0.042 / M input，**输出免费** |
| 延迟 | 70–500ms，单次往返 |
| 上下文 | 64K |
| 卖点 | **高频**决策：100 万次路由 ≈ $17（Haiku 4.5 ≈ $500） |

#### 判断：现在不适合，但值得留口子

1. **量级不对。** 你一天几十次 AI 调用，一年 Jev 成本约等于 0。它省的是**百万级**的钱，你不是那个量级。
2. **你的路由候选只有 3–4 个，判据是确定性的。** `Choice` 的价值在"从 255 个候选里做**语义**判断"；而你这里的判据是"动作数 ≥ 3"、"含危险动作" —— 这是 `if`，不是判断。**用概率模型做确定性判定是降级。**
3. **引入外部依赖的成本 > 收益。** 多一个 API key、多一个 500ms 往返、多一个故障点，换来"省 0 元"。

#### 未来真正值得用它的地方

| 原语 | 用途 | 我的评价 |
|---|---|---|
| `Score` | **难度打分**，替换 §2.1 那张权重表 | ⭐ **最有价值**。当信号表长到 20 条开始互相打架时，`Score` 比手调权重好维护 |
| `Noul` | **高危操作门**（"这句话是不是在要求不可逆的生产变更？"） | 可用，但你现在有 `dangerous: true` 契约标记 + `human_confirmation` 路由 —— **可判定 > 概率**，现有方案更可靠 |
| `Choice` | **指代解析**（"那个柜子" → `cabinets[i]`） | ❌ **建议不要用**。柜体引用必须精确到 id，用概率模型做解析是**把确定性的事变成概率的** |

**接入方式我同意 long-text 的措辞**：可选 Provider、可关闭、关掉系统照常运行。做法是 `router: 'rules' | 'llm' | 'external'` 三选一、默认 `'rules'`。

> 但**不要现在就写这个接口**。只有一个实现（rules）时，抽象出来的形状一定是猜的 ——
> 这是这个项目里已经反复验证过的教训（`aiContract.mjs` 之所以能一次做对，是因为三方同时要用它）。

### 2.3 CAD 后端怎么优化（"按使用习惯优化"）

#### 先把两件常被混淆的事拆开

- 「按使用习惯优化后端」→ 听起来像让后端**自适应**
- **后端真正需要的是「把 AI 的错变成后端的断言」** → 这才是你想说的

**我不主张大改后端。** 它三类校验（恒等式 / 硬规则 / 缓存自检）已经覆盖了 long-text 点名的全部 7 项。我看到的问题只有三处：

#### 问题 1：`RULE-SHELF-SPAN` 是 WARNING，不是 ERROR

`validate.ts:166-168`。而你在 Phase 0 踩过的坑（背板拆块算法退化）设的是 **ERROR**。

**优先级是反的**：层板跨度超限会真的导致**下垂**，这是制造问题不是美观问题。

→ 建议：按超限比例分档 —— 1.2× 以内 WARNING，以上 ERROR。或者干脆升为 ERROR。

#### 问题 2：AI 在"没有数据"的情况下被要求回答尺寸

`buildSnapshot()` 只给 AI **语义参数**（`params.width/height/depth/bodyLift`），**不给任何派生量**。

这是**对的**，是防腐蚀的关键设计（`snapshot.ts:7-26` 解释了为什么必须白名单）。

但由此推出一个后果，我觉得目前被低估了：

> **所有"侧板多高""门缝留多少"的问题，AI 都只能编。**
> 而用户问得最多的，恰恰就是这类问题。

**这不是模型的缺陷，是我们的缺陷 —— 我们没给它这个数据。**

→ **建议（我加的，不在 long-text 里）：加一个确定性解释通道 `POST /api/explain`。**

输入 `{ cabinetId, question }`，输出"这个柜体的每一块板是怎么算出来的"：

```
侧板长 = 柜体高 2400 − 踢脚 80 − 顶板 18 − 底板 18 = 2284
依据：layout.ts 的 bodyH / innerH 派生 · rules.boardT = 18
恒等式：innerH + 2×18 = bodyH ✓
```

然后 AI 的角色从**计算者**变成**转述者**。

**为什么这条最重要**：当前最危险的一类错误不是"改错了"，而是 **"答错了而听起来很对"**。
用户问一个尺寸，AI 编一个数字，用户信了 —— 而这次纠错连"AI 犯了什么错"都说不清，因为它没算错，它**只是没数据**。

而且它一次性消掉一整类纠错：`cad_calculation_error` 里绝大部分其实**不是计算错**，是"AI 被要求在没数据的情况下回答"。

#### 问题 3：全量快照

实测：`/api/ai/plan` 的 prompt 是 **2753 token**，其中大部分是与本次无关的柜体明细。

→ 按意图投影：`cabinet.*` 动作只需**目标柜体 + 同房间邻居**（碰撞检测用）；`project.rename` 只需项目名。

这不只是省钱 —— **你这台模型单次 17~27 秒**，prompt 从 2753 降到 ~600 是**可直接感知的提速**。

> **这条比换模型见效快。** 换模型要重新验证全部契约行为；改快照投影是纯减法，风险极低。

#### 关于"按使用习惯优化"本身

它正是 §2.4 的纠错闭环要产出的东西，但它产出的是**后端的断言**，不是后端的自适应。

**不要做"后端自己学着变"，做"后端被明确地改，并且改完有回归测试钉住"。** 这条界线不能糊。

### 2.4 你现在"给 AI 加记忆"这个方法行不行

> **方向完全对，机制有天花板。这是本轮最重要的一条发现。**

**实测证据**（§1.3）：纠错的唯一去处是 `bus.setGate(...)`。`buildSystemPrompt()` **不接受任何参数**。**纠错从未进入模型的提示词。**

#### 后果：只有"可判定"的错能被接住

`CheckSpec` 只有 4 种，全部要求"可判定"。而 AI 犯的错：

| AI 的典型错误 | 能编译成 CheckSpec 吗 |
|---|---|
| 把"主卧衣柜"认成"次卧衣柜" | ❌ 指代错误 |
| 把 2400 理解成 2.4 | ❌ 量纲错误 |
| 该用 `setUnitParam` 却用了 `addUnit` | ❌ 动作选择错误 |
| 用户说"高一点"，它自己挑了 2400 | ❌ 违反"不许臆造数字" |
| 该问清楚却直接执行 | ❌ 交互策略错误 |
| 柜体总高超过 2400 | ✅ `maxValue` |
| 写入了 `params.backPanel.grooveDepth` | ✅ `pathForbidden` |
| 引入了 `RULE-DOOR-MAX-WIDTH` | ✅ `noNewIssue` |

**上面 5 类一条都编译不出 CheckSpec。** 按现有规则它们只能永远停在 `pending` ——
而**没有任何机制能把一个 `pending` 推成 `active`**（`memory.ts:32-39` 的注释明确说了"检不出来的不许进 active"，这是**对的**，但意味着这些错会被永久搁置）。

**所以：你现在这套记忆，只能接住 AI 错误里"可判定"的那一小部分。**

#### 修法：把纠错拆成三条通道，而不是全塞进 gate

| 通道 | 收什么 | 机制 | 生效时机 |
|---|---|---|---|
| **Gate（拦）** | 可判定的越界 / 违规路径 / 规则冲突 | 现有 `CheckSpec`（**保留不动**） | 提交前阻断 |
| **Prompt（教）** ⭐ **新增** | 指代 / 量纲 / 动作选择 / 交互策略 | **反例 few-shot 注入系统提示词** | 每次调用前 |
| **Test（钉）** ⭐ **新增** | CAD 计算错 / 规则错 | 转成回归断言 | 改代码时 |

**为什么"教"这条最关键**：gate 只能在**事后**拦，而提示词里的反例是在**事前**改变模型的输出。

> 你反复遇到的"同一个错犯三次"，**只有这条通道能解决** ——
> 因为模型唯一会读的地方就是提示词。

#### 具体实现（很小）

```ts
// src/ai/memory.ts —— Correction 上加一个字段
interface TeachCase {
  /** 什么情况下适用（写给模型看的自然语言，会进提示词） */
  when: string;
  /** 上次它是怎么错的 —— **原样保留，这是最有价值的部分** */
  wrong: string;
  /** 应该怎么做 */
  right: string;
}

interface Correction {
  // …现有字段…
  teach?: TeachCase;   // 与 checkSpec 并存或二选一
}
```

```ts
// shared/aiContract.mjs —— buildSystemPrompt 改成收参数
export function buildSystemPrompt(lessons = []) {
  // …现有 18 个动作清单，原样保留…
  if (lessons.length) {
    lines.push('');
    lines.push('【本项目你以前犯过的错 —— 不要再犯】');
    for (const l of lessons) {
      lines.push(`- 当${l.when}：不要${l.wrong}；应该${l.right}`);
    }
  }
}
```

调用点从 `buildSystemPrompt()` 改成 `buildSystemPrompt(lessonsFor(snapshot))`；
对话通道同步改 `aiClient.ts:185-228` 的 `CHAT_SYSTEM`（**两个地方，别漏**，见 §1.5）。

#### 三条防腐要求（缺一条这套就会烂掉）

1. **上限 8 条**，按命中次数排序。提示词不是垃圾桶 —— 超过 8 条会挤占动作清单，**模型反而更容易出错**。
   ⚠️ 但要**显式告诉用户"有 N 条没带上"**，不能静默截断（这是这个项目一贯的立场）。
2. **每条必须带 `wrong`（具体错法）**。不许只写"要正确理解柜体指代"这种话 —— 那种话对模型**零信息量**。
3. **必须能被关掉。** 面板上一个开关，或 `POST /api/ai/plan` 带 `{ lessons: false }`，能复现"只带 gate 不带 lessons"的同一次请求。
   **否则你永远不知道为什么这次变好了、下次变坏了。**

> 这是我在这个项目里最想加的一条改造。
> 它把"AI 进化"从**一句愿望**变成**一个可复现、可度量、可回退的机制**。

### 2.5 商业化 / 订阅制 / 每个人一个调教好的

#### 先解决架构错配（§1.4）

```
账号 / 会话 / 额度 / 审计  →  服务端
纠错 / 记忆              →  浏览器 localStorage
```

**只要你想"登录后我的调教跟着我走"，这个错配必须先对齐。** 这是商业化的**前置**，不是可选项。

#### 优先级设计：我建议 4 层，不是 6 层

long-text 给的是 `平台 > 工厂 > 项目 > 团队 > 用户 > 模型建议`。

**我认为 6 层会变成维护地狱**：当用户问"这个 2300 是谁定的"，6 层里任何一层都可能是答案，最后**没人敢改任何一层**。

我的方案：

```
1  platform       平台硬规则（代码 + RuleSet 版本化）            不可被下层覆盖
2  factory/tenant 工厂硬规则（RuleSet 文件，按 tenantId 隔离）    不可被下层覆盖
3  project        项目设置（键白名单，只覆盖"默认值"）
4  user           用户偏好（默认值 / 启发式，**不参与校验**）
```

**两处我改了 long-text：**

- **去掉独立的 `team` 层。** 早期"团队 = 一个 tenant"。真有"跨工厂集团"需求时再拆 —— 现在拆是在猜。
- **`model_suggestions` 不进这条链。** long-text 把它放在最底层是**危险的**：底层配置会被上层静默覆盖，用户**永远不知道"这个 2400 是模型猜的"**。
  它不是配置，是**建议** —— 必须**显式标注来源**地呈现，而不是参与取值。

#### 加一条 long-text 没有、但必须有的：来源溯源

每次取值同时记 `{ key, value, source }`。界面能回答"这个 2300 是谁定的"。

> **没有溯源的分层配置，三个月后没人敢改任何一层** —— 因为改哪层都不知道会动到什么。

#### 存储方案（按阶段）

| 阶段 | 方案 | 理由 |
|---|---|---|
| 现在（单机自用） | **不动**。localStorage + JSONL | 够用。而且换存储会动验收基线 |
| 上线前 | **SQLite 单文件** | long-text 提 Postgres —— 但你是**单机 Windows + 无 VPS**，Postgres 要额外装服务、要运维。SQLite 满足"多读单写"，且**将来迁 Postgres 只需改一个文件**，表结构不用改 |

表结构（够用就好，别预留）：

```sql
users(id, tenant_id, username, password_hash, role, plan, status, created_at)
sessions(token_hash, user_id, expires_at, created_at)

corrections(id, tenant_id, user_id, project_id, kind, status,
            nl, teach_json, check_spec_json, origin, created_at)
  -- 索引 (tenant_id, user_id, status)

preferences(tenant_id, user_id, project_id, key, value, source, updated_at)
  -- 主键 (tenant_id, user_id, project_id, key)

regression_cases(id, tenant_id, source_correction_id, name, input_json,
                 expected_json, enabled, created_at)

ai_calls(id, at, tenant_id, user_id, project_id, route, router, model,
         ok, ms, prompt_tokens, completion_tokens,
         semantic_model_version, rule_set_version,
         command_proposal_json, validation_result)
```

#### 关于隔离，最关键的一条不是"存哪"

**是"每条查询都必须带 `tenant_id`"。**

不要靠人记得写 `WHERE tenant_id = ?`。**在数据访问层强制**：所有函数第一个参数是 `ctx: { tenantId, userId }`，**没有 ctx 就查不出数据**。

这和你项目一贯的做法一致 —— `isWritablePath` 也是**结构性保证**，不是纪律。

#### long-text §9 第 9 条我完全同意

> "不要把未经审核的用户纠错自动升级成全平台规则"

而且你现有的 `status: pending | active | retired` **已经在做这件事**，只是缺"审核"这个动作和"跨用户提升"这条路。
**别加自动提升，加人工审核。**

---

## 3. 我对 long-text 的取舍

| long-text 的要求 | 我的处理 | 理由 |
|---|---|---|
| `RouteKind.deterministic` | ❌ **改成 `none`** | 放错层。计算不经过模型，不是"路由的一种结果" |
| 6 层配置优先级 | ❌ **改成 4 层 + 来源溯源** | 6 层是维护地狱 |
| `model_suggestions` 进优先级链 | ❌ **不做** | 建议不该参与取值，应显式标注来源 |
| 现在就接 Jev | ❌ **不做** | 量级不对 / 候选太少 / 成本 > 收益 |
| 预留 `userId/teamId/factoryId/projectId` 四个键 | ❌ **只加 `tenantId` + `userId`** | 四个都空着 = 没人知道该填哪个。其余等有真实语义再加 |
| 引入 ORM / 迁移框架 | ❌ **不做** | 表结构简单到可以手写 SQL。ORM 会吃掉这个项目的"零依赖"优点 |
| §10 的 10 项评估指标 | ⚠️ **只补日志字段，不做仪表盘** | 自用阶段没人看仪表盘；但**日志字段不可回填**，必须现在就补 |
| `CorrectionType` 八分类 | ⚠️ **减到 5 类** | 见下 |
| 模型路由层 | ✅ **做**（表驱动 + 可配置 + 不配双模型时零行为变化） | |
| 纠错三通道（gate / prompt / 回归） | ✅ **做** —— 我加的最重要一条 | |
| 审计字段补齐 | ✅ **做** | 不做，以后算不出任何指标 |
| `/api/explain` 确定性尺寸解释 | ✅ **做** —— 我加的 | 当前最危险的错误类型 |
| 快照按意图投影 | ✅ **做** —— 我加的 | 比换模型更快见效 |
| 记忆的账号归属 | ✅ **做**（商业化前置） | 账号在服务端、记忆在浏览器 |

#### `CorrectionType` 为什么减到 5 类

long-text 的 8 类里有两组边界划不出来：

- `user_preference` vs `design_preference` —— 用户说"我喜欢门缝小一点"，算哪个？
- `model_capability_error` vs `command_generation_error` —— 模型不会用工具 = 工具说明写得不清楚，经常是**同一件事的两个说法**

```ts
type CorrectionType =
  | 'preference'        // 偏好：只影响默认值，不拦（合并原两类 preference）
  | 'reference'         // 指代 / 量纲 / 动作选择      → 进 Prompt(teach)
  | 'cad_calculation'   // 后端算错                  → 进 Test(回归)
  | 'production_rule'   // 规则错 / 规则缺            → 改 RuleSet（版本化）
  | 'unknown';          // 还没判明 —— **必须是默认值**
```

**关键：`type` 决定它去哪个通道，所以分类必须"互斥且可断言"。** 8 类做不到互斥，5 类可以。

而且 `unknown` 必须是**默认**，不能让人随手选一个"看起来差不多"的 —— 这个项目在 `CheckSpec` 上已经做对过一次（`status` 默认 `pending` 而不是 `active`，`memory.ts:147-153`），同类判断要一致。

---

## 4. 如果动手：改造清单（按性价比排序）

### P0 —— 不做的话，后面的都白做

| # | 改造 | 落点 |
|---|---|---|
| 1 | **审计字段补齐**：`request_id` / `route` / `router` / `rule_set_version` / `semantic_model_version` / `command_proposal` / `validation_result` / `latency_ms` / `token_usage` | `server/auth.mjs:471 recordUsage` + `server/server.mjs:835/857/882` 的 `audit(...)` |
| 2 | **纠错三通道** | `src/ai/memory.ts` 加 `teach`；`shared/aiContract.mjs:502` 的 `buildSystemPrompt(lessons)`；`src/ai/aiClient.ts:185` 的 `CHAT_SYSTEM`；`src/ui/panels/MemoryPanel.tsx` 加"教它"入口 |

> 理由：**日志字段不可回填**（今天不记，三个月后想算"Command 校验失败率"就是零）；
> **纠错三通道**是"我给他修复了避免下次犯同样错误"的唯一真正解。

### P1 —— 影响体验与成本

| # | 改造 | 落点 |
|---|---|---|
| 3 | **`/api/explain`** 确定性尺寸解释 | 新接口 + 一个复用 `src/core/geometry/layout.ts` 的推导器 |
| 4 | **双模型 + 表驱动路由**（不配 = 现行为，零破坏） | `.env` 加 `AI_MODEL_STANDARD/REASONING`；`server/server.mjs:191 currentSettings()` 旁加 `routeOf(plan)` |
| 5 | **快照按意图投影** | `src/ai/snapshot.ts` 加 `buildSnapshot(project, rules, { intent })` |

### P2 —— 商业化前置，现在不做但要记着

| # | 改造 | 落点 |
|---|---|---|
| 6 | **记忆归属**：`Correction` 加 `userId`，`/api/memory` 从"单文件"改成"按用户" | `src/ai/memory.ts`、`correctionStore.ts`、`server/server.mjs:918-937` |
| 7 | **换 SQLite** | 上线前 |

### 明确不排期的

Jev 接入 · Postgres · ORM · 6 层配置优先级 · 评估指标仪表盘。

---

## 5. 两个我不请自来的建议

### 5.1 `RULE-SHELF-SPAN` 应该从 WARNING 升成 ERROR

`validate.ts:166-168`。层板跨度超限会真的**下垂** —— 是制造问题，不是美观问题。

你现在把"背板拆块算法退化"设成 ERROR（`IDENTITY-BACKSPLIT-BAD`），却把"层板会下垂"设成 WARNING。**这个优先级是反的。**

### 5.2 别让模型回答它没有数据的问题

这条**比"路由到哪个模型"重要一个数量级**。

你现在 AI 看不到任何派生量 —— 这是**对的**，是防腐蚀的关键。但由此推出一个后果：

> **所有"侧板多高""门缝多少"的问题，AI 都只能编。**
> 而用户问得最多的，恰恰就是这类。

`/api/explain` 是解药。而且它顺手解决了 §2.4 里一整类拦不住的错 ——
因为那些错的根源不在模型，**在我们没给它这个数据**。

---

## 附：勘察结论对照表（一句话版）

| 问题 | 一句话 |
|---|---|
| AI 会算错板件尺寸吗 | 不会，它根本没有算的权限，也没有算所需的数据 |
| 后端算错能发现吗 | 能，三类校验（恒等式 / 硬规则 / 缓存自检），37 条 ERROR 码里 12 个是 `IDENTITY-*` |
| 记忆能拦住 AI 犯错吗 | **只能拦住"可判定"的那部分**（§2.4 举的 8 类典型错误里只有 3 类能拦），其余永远停在 pending |
| 记忆能让 AI 变聪明吗 | **完全不能 —— 它从未被送到模型面前** |
| 账号与记忆对齐吗 | **不对齐。账号在服务端，记忆在浏览器** |
| 路由现在存在吗 | 不存在。单模型，从 `.env` 读 |
| 用户习惯能存下来吗 | 偏好可以，但**现在没有"偏好"这个数据结构**，只有"检查" |
