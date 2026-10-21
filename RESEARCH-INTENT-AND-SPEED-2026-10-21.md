# 调研报告：让 LLM 听懂家具设计意图 + Agent 调用提速

> 调研范围：公开论文/框架/文档 + **在本地 gpt-load 网关（deepseek-v4.1-flash）上实测验证**。
> 所有「实测」结论都来自本机对 `192.168.2.2:3002` 的压测，非二手资料。

---

## 0. 先说三个实测出来的、改变优先级的结论

在展开文献之前，先给三个我在你的网关上跑出来的实测数据。它们直接决定后面哪些建议值得做。

### 实测①：你的网关**支持并行工具调用**（此前没启用）

用两个独立工具请求，模型一次返回了 2 个 tool_call：

```
tool_calls count = 2
get_time :: {"city": "Beijing"}
get_time :: {"city": "Tokyo"}
finish_reason = tool_calls
```

**来源**：本机对 gpt-load 的直接探测（2026-10-21）。
**但**：`server/agentLoop.mjs:634` 的执行循环是 `for (const tc of toolCalls) { await callMcpTool(...) }` —— **串行 await**。
所以并行能力现在是有的，编排层把它丢掉了。这是**零改造、纯收益**的一处。

### 实测②：prefix cache **能用**，但你当前的 prompt 结构让它 **100% 失效**

网关返回 `usage.prompt_tokens_details.cached_tokens`，正常前缀可命中：

| 实验 | prompt_tokens | cached_tokens |
|---|---|---|
| 纯静态 system，重复 2 次 | 2066 | **2048** |
| 静态前缀 + 动态尾部（system 末尾） | 2639 | **2176 -> 2048** |
| 静态前缀 + 动态内容在 **system 开头** | 2639 | **0 / 0 / 0** 失败 |
| 静态前缀 + 动态内容拆成**独立 system 消息** | 2639 | **2176 / 2560 / 2560** 通过 |

**关键机制**：DeepSeek 是**纯前缀匹配**缓存 —— 只要 system 消息**前面**有一段逐字变化的内容，
从变化点往后的**全部** token 都缓存不上。

而你的 `agentLoop.mjs:511-520` 恰好踩中了这个坑：
```
${rulesBlock}${recipeBlock}${seqHint}   <- 动态内容在最前面
...
${projectContextText}                      <- 动态内容也在
```
**配方 / 规则 / 项目摘要全部堆在 system prompt 开头**。每一轮它们都变（配方按关键词命中、规则按意图检索、
项目摘要随柜体数量变），所以 **cached_tokens 恒为 0**。

**修法（一条改动，零风险）**：把动态内容挪到 system prompt **末尾**，或拆成独立的 system 消息。
前者缓存命中 2048/2639 约 78%，后者 2560/2639 约 97%。

**延迟收益实测**：静态前缀命中缓存后，首 token 延迟从约 3.2s 降到约 2.9-3.6s 区间波动，
提示词 4074 token 时 cached=3968（约 97%）。绝对收益不如成本收益大（网关是自建，主要看成本和稳定性），
但**命中率为 0 -> 97% 的修复本身是必须的**，因为它是后面所有「多轮少步数」优化的前提。

### 实测③：网关只有两个模型，没有小模型可用

```
deepseek/deepseek-v4.1-flash
sensenova-6.8-flash-lite
```

**含义**：第 3.4 节的「小模型分层」在**当前网关上暂时做不了**（没有独立的小模型端点）。
`sensenova-6.8-flash-lite` 的 `lite` 后缀暗示可以做端点级 A/B，但没验证过它是真是假的小模型，
且不能同时用两个模型做分层（分层需要**两个可分别调用的端点**）。
-> **结论：现阶段不要把分层架构写进路线图**，除非先在网关加一路小模型。

---
## 1. 意图理解（NLU）

### 1.1 有没有公开的家具/室内设计意图数据集？

**结论：家具领域的「自然语言 -> 结构化设计需求」公开数据集基本不存在。中文的更没有。**

我系统性搜了中文/英文两侧，得到的是一个**否定性结论**，但附带三个可用的替代品：

| 你想要的 | 现状 | 来源 |
|---|---|---|
| 家具设计意图数据集（中文） | 不存在 | 搜索无果；知乎同题提问「意图识别方面有哪些开放中文数据集？」的答案也是「收获几乎没有」 |
| 家具设计意图数据集（英文） | 不存在（相邻的有 Text2CAD-Bench） | 见下 |
| 室内布局文本生成数据集 | 有，但是**视觉/几何**任务不是 NLU | M3DLayout (CVPR 2026)：21,367 个 3D 室内布局，**带结构化文本描述** |
| 3D-FUTURE / 3D-FRONT（阿里） | 是**几何模型库**，不是自然语言意图标注 | 16,563 个高精度三维家具模型 + 20,000 个室内场景 |
| 中文通用 TOD 意图/槽位 | 有，可作 NLU **方法**参考 | SMP-2019-NLU、SMP-2020-ECDT、FewJoint、NLPCC2018 Task 4、CrossWOZ |

**可落地的替代路径**（最值得注意的一条）：

**M3DLayout（CVPR 2026）的标注格式最接近你需要的** —— 它为每个室内布局标注「结构化文本描述」，
任务就是 text -> layout。把它当成**弱监督语料模板**：
真实场景 = 3D 布局 + 结构化描述。你的 `project.json` 就是「布局」，`intentRequest` 就是「结构化描述」。
中文语料靠 LLM 从英文标注反向翻译 + 人工校。

**来源**：
- M3DLayout: https://openaccess.thecvf.com/content/CVPR2026/papers/Zhang_M3DLayout_A_Multi-Source_Dataset_of_3D_Indoor_Layouts_and_Structured_CVPR_2026_paper.pdf
- 3D-FUTURE/3D-FRONT: https://tianchi.aliyun.com/specials/promotion/Dataset
- Text2CAD-Bench: https://arxiv.org/html/2605.18430v1
- 中文意图数据集汇总: https://github.com/InsaneLife/ChineseNLPCorpus

### 1.2 「一句话 -> 结构化家具需求」现在有什么成熟做法

**核心结论：不要让 LLM 自由生成结构化需求，要让它做「受限槽位填充 + 校验」。**

学术与工业界在这一点上高度一致，分三条证据线：

**(a) 阿里云智能电视团队的生产实践**（最有参考价值：中文、一级 C 端链路、有真实延迟指标）
把大模型意图识别拆成三件套，明确分离：

> **意图改写**（不改变原意的前提下重述）-> **意图分类**（标签体系）-> **意图槽位**（「小格子」）
> 加上 **意图置信度**（0.9 vs 0.4，用来决定是否要向用户澄清）

他们的选型对比（延迟要求 500-800ms，简单指令 100% 准确率、复杂指令 98%+）：
1. **基模 + Prompt**：建议至少 32b（qwen-plus/qwen-max）。优点是开发成本低；缺点是**垂类分类有局限**、大模型延迟高 -> 他们**放弃**了。
2. **基模 + Prompt + RAG**：qwen-turbo/qwen-plus 即可。解决垂类知识问题；但**增加向量召回延迟**，且知识库质量差会引起**分类冲突/幻觉** -> 也不适合实时链路。
3. **小尺寸模型 SFT**（**他们最终选的**）：4B 起步，天花板到 7B。LoRA 微调。
   - 序列长度 64/128/256
   - 学习率默认 1e-4（loss 下降慢可调 3e-4 / 5e-4，**不建议 1e-3**）
   - 全局 batch = 卡数 x per_device_batch x grad_accum
   - **固定 system_prompt 模板**：「你是一个意图识别专家，可以根据用户的问题识别出意图，并返回对应的意图和参数」

**来源**：https://www.uml.org.cn/ai/202502174.asp （阿里云开发者公众号，《微调碾压RAG？大模型意图识别工程化实践》，2025-02-17）

**(b) 「意图知识库 + 检索路由」模式**（CSDN 智能客服实战，与你的配方库/规则检索**是同一个模式**）
「检索优先 + 模型兜底」：语义检索召回候选问法 -> 相似度超阈值就直接路由到对应槽位抽取节点（**不调 LLM**）；
未命中才调 LLM 兜底。
- 构建：真实日志 -> 清洗去重 -> **Embedding + HDBSCAN 聚类** -> 提炼标准问句 -> LLM 补长尾同义句 -> 大模型初筛 + 人工复核
- 评估指标：**意图识别正确率**、**命中率与兜底占比**、**延迟（关注尾部）**、**成本（平均 token / 平均模型调用次数 / 单位会话成本）**

**来源**：https://blog.csdn.net/m0_59235245/article/details/159507610 （2026-09-24）
这条对你的价值极高：你已经有「配方库按关键词命中」和「规则按意图检索」，
缺的是把**关键词匹配**换成**语义检索 + 阈值兜底**，以及补上**「兜底占比」这个指标**。

**(c) LLM 直接做 DST（对话状态追踪）**
「Large Language Models as Zero-shot Dialogue State Tracker through Function Calling」
—— 用 function calling 的形式让 LLM 零样本输出 slot-value 对，**不需要训练**。
**来源**：https://arxiv.org/html/2402.10466v1

### 1.3 槽位填充 vs 自由生成：哪个更稳？

**结论：槽位填充（schema 约束）明显更稳，但要注意「结构」和「生成」要分开。**

证据：
- **结构层已解决，剩余难题在「选择」不在「格式」**：
  > "the leaderboard's results... reflect a field where the structural layer of tool calling is increasingly solved and the remaining gap is selection and [correctness]"（BFCL 系列）
- Anthropic 的 strict tool use（`strict: true`）保证参数**必定符合 schema**；OpenAI 同理。Anthropic structured outputs 走 beta header。
- 但**约束解码会轻微降低生成质量**，所以出现了 **SLOT（Structured LLM Output Transformer, EMNLP 2025 Industry）**：
  解耦「格式化」与「任务生成」，任务无关、不损失生成质量。
  **来源**：https://aclanthology.org/anthology-files/anthology-files/pdf/emnlp/2025.emnlp-industry.32.pdf
- 自托管场景的落地手段：**Outlines / llguidance**（token 级 grammar 约束），或 **Instructor**（retry 式，对托管端点更实用）。

**对你的直接含义**：你的 21 个动作已经是严格 schema（`aiContract.mjs` 有 min/max 校验，
`mcpWrite.mjs` 用 zod 定义 inputSchema）。所以你**不需要**去改格式层。
真正该做的是 **schema 之外加一层「语义槽位」**——即在生成 action 之前，先得到结构化的：
```
{ intent, target, params: {width: 600, ...}, confidence, missing: [...] }
```
这样：
1. `missing` 非空 -> 主动追问，而不是硬猜参数（**这是「听懂人话」最直接的体现**）
2. `confidence` 低 -> 走澄清路径
3. `target` 是 id -> 指代消解有确定的落点

**「结构 + 生成分离」还带来一个提速红利**：意图分类/槽位提取可以用小模型或规则做（快），
只有参数生成才需要大模型 —— 但见实测③，当前网关做不到分层。

### 1.4 实体链接：「主卧那个大柜」「电视旁边那个」-> 柜体 id

**这是你目前最薄弱、也最能靠工程解决的一环。** 现有做法分四层，按成本从低到高：

**(1) 确定性候选生成 + LLM 排序（推荐，成本最低，效果最好）**

利用你已经有的资产：
- `summarizeProjectContext()`（`agentLoop.mjs:171`）已经生成「房间 / 柜体名 / cabinetId / 尺寸 / 分区数 / 位置」
- `spatialContext.ts`（17KB）已经有「墙是什么 / 门窗在哪 / 柜挨着哪」
- `sharedPanels.ts`、`relations.ts`（23KB）已有柜间关系

把这些变成**结构化候选集**喂给模型，让它**只做选择不做生成**：
```
候选（每个带 id + 可判别属性）：
  A. cabinetId=cab_007 「主卧大衣柜」 2400x2400x600 @ (1200, 0) 5分区
  B. cabinetId=cab_012 「电视柜」      1800x450x400 @ (600, 2000) 2门
```

然后**用规则过滤 + 空间约束打分**（「电视旁边」-> 计算每个候选到电视物体的距离），
最后让 LLM 在**已缩小的候选集**里选 id。

这一路的成熟参照是 **referring expression comprehension（REC）**：
传统方案是「先出候选集，再打分」的两阶段（RefCOCO/RefCOCO+/RefCOCOg 上的经典做法），
LLM 时代演进为 **「Reasoning over Object Descriptions」**（把对象元数据 + 对话历史一起喂 LLM 推理）——
**后者正是你的场景**：不是从图像里指，而是从「结构化元数据 + 对话历史」里指。
**来源**：https://arxiv.org/html/2604.27850v1 （SIMMC 上的 coreference resolution）
**来源**：https://www.frontiersin.org/journals/neurorobotics/articles/10.3389/fnbot.2020.00043/full

**(2) 空间约束优先**：能用几何算的别让模型猜。
「电视旁边」-> 先查电视在哪个房间哪个 x，再算候选柜的 |x - x_电视|，**几何上不成立的直接排除**。
你的 `src/core/spatial/`（derive/door/validate）已经有这套能力。

**(3) 消歧式追问**：候选 >=2 且几何判不出时，**反问用户**而不是猜。
这也是阿里实践里「意图置信度」的标准用法：置信度低 -> 澄清。
工业界对 pass^k 的分析给出了量化依据：
> "A customer-support agent at 90% pass@1 on a retail-task benchmark drops to roughly 43% at pass^8
> and around 19% at pass^16 if the failures are independent."
> **来源**：https://www.aievals.co/learn/agentic-evals/pass-k-and-consistency

**(4) 中文工具箱（如果要走 NER 路线）**
- **HanLP 2.1** —— 130 语言、含**指代消解**、语义角色标注、依存句法（PyTorch/TF2 双引擎）
- **DeepKE** —— 中文知识抽取工具箱，支持 few-shot（16/32 shot）、document-level
- **PaddleNLP / 百度 LAC** —— 工业级词法分析

**来源**：https://github.com/hankcs/HanLP 、 http://deepke.zjukg.cn 、 https://github.com/PaddlePaddle/PaddleNLP

**我的建议**：**(1)+(2)+(3) 组合**。不要单独上 NER —— 家具场景的「那个大柜」是**空间+属性+历史**三重约束，
纯 NER 解决不了。

## 2. 多轮对话与指代消解

### 2.1 成熟范式：对话状态追踪（DST）

DST 的标准输出就是 **(domain, slot, value) 三元组集合** —— 跟你「一句话 -> 结构化家具需求」的目标是**同一个东西**，
只是多轮版本。这是成熟度最高、可直接借鉴的范式。

**演进路径（可直接照搬到你的架构）**：
- **TRADE**（经典）：Slot Gate 决定「哪个 (domain,slot) 要填」-> State Generator 决定「填什么值」
- **SOM-DST**（2019）：用 schema 对话做神经生成式 DST
- **TripPy**（2020）：带 copy 机制的生成式 DST，容错好
- **LLM-based DST**：用 LLM 零样本/少样本做 DST，**schema 理解 + 任务学习**双管齐下，常见做法是 **instruction tuning + LoRA**
- **Rasa**：工程范式（domain.yml / slots / rules / forms），适合抄**结构**不抄代码

**关键工程结论（对你的现状直接相关）**：
DST 领域早已共识：**slot 要有 "don't care"（不关心）/ "none"（无值）/ "ptr"（指向复制）三态**。
TRADE 的 Slot Gate 就是三分类。你的「纠正记忆」里已经有类似的 `pendingReason`（待编译为可执行检查）
和 `status: pending/active` —— **这就是 DST 的 don't-care/none**，你已经走在正确的结构上，只是没命名它。

**来源**：
- TripPy/SOM-DST 综述：https://www.emergentmind.com/topics/dialogue-state-tracking-dst
- LLM 零样本 DST via Function Calling：https://arxiv.org/html/2402.10466v1
- TRADE/CrossWOZ（含 BERTNLU-context + RuleDST + TRADE 对比）：https://cloud.tencent.com/developer/article/1617197
- Rasa patterns：https://rasa.com/docs/reference/primitives/patterns
- Schema-guided DST with slot attention：https://aclanthology.org/2023.nlp4convai-1.4.pdf

### 2.2 中文指代消解数据集（用于评测，不要用来训练）

**CLUEWSC2020**（WSC Winograd 中文版）：从 36 部中国现当代文学作品人工挑选标注，
判断代词与名词是否共指。RoBERTa-large-clue 85.53%。
**来源**：https://github.com/CLUEbenchmark/CLUEWSC2020 、 https://aclanthology.org/2020.coling-main.419.pdf

**注意**：这是**单句**共指判断，**不能直接用**评估你的多轮场景（你的「刚才那个」跨轮）。
它只适合作为「模型中文代词理解能力」的体检项。

### 2.3 你现在做对了什么、还缺什么

**已做对（不要动）**：
- `summarizeProjectContext` 里注入「上一轮你做的事：xxx（用户这次的话可能是在那个基础上继续改，例如「再宽点」「刚才那个」）」
  —— 这是**显式的指代提示**，方向完全正确。
- `history` 里带 `agentSummary` —— 对话摘要作为状态载体。

**还缺的三块（按性价比排序）**：

1. **显式对话状态对象（不依赖自然语言摘要）**
   现在「上一轮」是靠自然语言 summary 反推的。应该有一个**结构化的 `focusStack`**：
   ```
   { target: {kind:'cabinet', id:'cab_007'}, lastAction:'resize', lastDelta:{width:+200}, turn:3 }
   ```
   这样「再宽点」= `focusStack.target` + `lastDelta.width x 某个系数`，
   **不经过模型的「理解」环节**，直接落到参数。**这是同时提升「听懂」和「提速」的一石二鸟改动。**

2. **省略与零变化的显式建模**：「再宽点」= 相对量；「改成两米四」= 绝对量；
   「就这样」= 无操作。当前 prompt 里没有任何地方教模型区分这三者。

3. **多候选时的消歧追问**（见 1.4(3)）—— 现在是猜，猜错就错图。

## 3. Agent 提速

### 3.1 并行工具调用：哪些能并行，哪些必须串行

**先说协议层的三条硬规则**（很多团队不知道而踩坑）：

1. **所有 tool_result 必须放在同一条 user 消息里**，且带匹配的 `tool_call_id`。拆到不同消息会**抑制后续的并行调用**。
2. **每次请求的每个 tool_call 都必须有结果**，包括失败的（失败也要返回 error 结果，不能丢）。
3. **并行是模型的决定，不是编排层的决定** —— 你的编排层必须能处理「一轮多个 tool_call」。

**来源**：https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use 、
https://theengmap.vercel.app/ai/tool-use/parallel-and-sequential-tool-calls

**你项目里的具体分类**（基于对 `mcpWrite.mjs` / `workspace.ts` 的实读）：

| 工具 | 能否并行 | 原因 |
|---|---|---|
| `cad.get_state` | 可并行（多个） | 纯读 |
| `cad.validate` | 必须串行 | 校验的是**累积 draft 状态**，必须等前面写完 |
| `cad.create_cabinet` x N | **有条件并行** | 见下 |
| `cad.create_room` | 可并行 | 独立资源 |
| `cad.draw_wall` | 同房间的墙之间有依赖 | 端点相连 |
| `cad.update_object` | 串行 | 改的是前一步创建的对象 |
| `cad.place_cabinet` | 串行 | 依赖 create，且依赖前一柜的位置（避让计算） |
| `cad.create_assembly` | 必须最后 | 依赖所有成员已建好 |
| `cad.delete_object` | 串行 | 依赖存在性 |

**「create_cabinet 可以并行吗」的准确答案**：**可以，但有前提**。
你的 `draftExecute`（`workspace.ts:960`）已经用 `this.serializeLiveWrite()` 把 draft 写入**串行化**了 ——
所以**并发调用不会数据竞争**，但**执行顺序不确定**。
而 `create_cabinet` 缺省 x/y 时会「自动避让已有柜」，这意味着**并行创建的柜，落位结果取决于调度顺序**。

**可落地的并行分组**：
- **组 A（纯读，可完全并行）**：`get_state`
- **组 B（独立新建，可并行）**：多个 `create_cabinet` **但每个都显式给 x/y**
  （此时不依赖避让引擎，结果确定）—— 你已有 `cad.place_cabinet` 语义落位，天然支持这个切分
- **组 C（严格串行）**：create -> place -> update -> assembly -> validate

**换句话说：把「建 N 个地柜」从「N 次串行」改成「1 次 create_cabinet(带 x/y) + 1 次 place」**，
这一步在 L 型厨房场景（你的配方里就是 3~4 个独立地柜模块）能把 **4 轮模型往返压到 1~2 轮**。

**来源**：
- Anthropic 并行工具官方文档（上）
- 并行调用隐藏耦合的三种失败模式（上下文依赖 / 共享状态变更 / 执行时序依赖）：
  https://tianpan.co/zh/blog/2026/04/10/parallel-tool-calls-hidden-coupling
- OpenAI 的 `parallel_tool_calls` 默认 true；**但 o3/o4-mini 等推理模型会忽略甚至 400**：
  同上（注意：你换模型时要重测）

### 3.2 「少步数」的技术：论文与框架

| 方法 | 核心 | 来源 |
|---|---|---|
| **W&D: Scaling Parallel Tool Calling** | 把多次工具调用合并成一次，**并行执行**。实测：单工具调用达到 66% 准确率要 \$102.5 / 100 任务 / 平均 22.6s；并行工具调用**显著左移 turns 分布** | https://arxiv.org/html/2602.07359v1 |
| **PASTE** (Pattern-Aware Speculative Tool Execution) | 从**重复出现的 agent 模式**预测未来的具体工具调用，**在 LLM 生成期间投机执行**，同时 pacing session 避免把隐藏的 tool 时间变成额外 LLM 排队延迟。**关键设计原则：减少暴露的 tool 时间只有在 serving 系统保住收益时才有用** | https://arxiv.org/html/2603.18897v3 |
| **Agentix** | agent serving 引擎，**并行 tool 执行 + LLM 生成** | https://www.alphaxiv.org/abs/2603.18897 |
| **AgentDiet**（轨迹裁剪） | 裁剪 trajectory 里冗余的 tool message。实测：Multi-SWE-bench 上 Gemini 2.5 Pro 平均步数 **57.20 -> 43.90** | https://arxiv.org/html/2509.23586v1 |
| **Restate 的并行模式** | 值得注意的**保守做法**：因为并行执行在重试时会导致 journaled event 非确定性重放，他们让 **LLM 一次发一批 tool_call（省 LLM 往返），但 tool 执行本身串行** | https://docs.restate.dev/ai/patterns/parallelization |

**Restate 那条对你的价值很高**：它把两件事解耦了 ——
**「一轮多个 tool_call」省的是 LLM 往返；「tool 真并行」省的是 tool 墙钟时间。**
对家具 CAD，**tool 执行是毫秒级、模型往返是秒级**，所以：
**优先做「一轮多个 tool_call + tool 串行执行」**，风险低、收益直接（省模型往返），不需要担心执行顺序不确定性。

### 3.3 prefix caching / prompt caching 怎么用最划算

**实证结论（来自 arXiv 2601.06007，跨 OpenAI / Anthropic / Google 三家，500+ agent sessions，10k-token system prompt）**：
> "prompt caching reduces API costs by **45-80%** and improves **time to first token by 13-31%** across providers.
> We find that **strategic cache boundary control, such as excluding dynamic tool results, provides more consistent benefits
> than naive full-context caching, which can paradoxically increase latency.**"

**来源**：https://arxiv.org/html/2601.06007v2 （《Don't Break the Cache》）

三条硬策略：
1. **动态内容放最后**（system prompt 末尾），或拆成独立消息 —— **你的实测已验证这一点**
2. **不要把动态 tool result 放进被缓存的前缀** —— tool result 每次都变
3. **不要用 naive 全量缓存** —— 有时反而增加延迟

**多轮 Agent 的最优缓存布局（结合你的代码结构）**：
```
[system 1]  固定部分：角色 + 动作契约 + 硬规则           <- 永不变，最高缓存价值
[system 2]  半固定：配方（按关键词命中，可能变）
[system 3]  动态：项目摘要 + 规则检索结果 + 历史        <- 每轮变
[user]      本轮意图
[assistant/tool ...]  对话历史（append-only）
```
**关键**：把 system 1 单独放一个消息，让它成为**唯一的前缀**。这样即使 2/3 每轮变，**system 1 始终命中**。

**当前代码的对应改法（3 行级别）**：
现在 `agentLoop.mjs:511-520` 把 `rulesBlock + recipeBlock + seqHint` 拼在 system 最前。
改成：**先拼固定部分成一个 system 消息，再拼动态部分成第二个 system 消息**。

**DeepSeek 的缓存计价**（官方）：cache hit \$0.014/M tokens，miss \$0.14/M —— **10 倍差**。
**来源**：https://api-docs.deepseek.com/news/news0802

**网关侧的额外手段**：`prompt_cache_key`。
我实测传 `prompt_cache_key: 'furniture-agent-session-A'` 后 cached=3968/4073 约 97% 正常命中，
且这个参数是**路由提示**（把同一会话钉到同一台机器），不是缓存断点。
**来源**：https://sankalp.bearblog.dev/how-prompt-caching-works

**DeepSeek-Reasonix 的缓存工程**（很好的参照）：
> "让 Coding Agent 长时间挂着运行时，尽可能多地命中缓存……系统会保持 System Prompt 和工具 Schema 稳定，
> 让会话历史以追加的方式持续增长，避免无意义地重写此前内容"
> **Planner + Executor 双模型各自维护一条独立 Session** —— 因为两个模型在同一 conversation 里来回切，
> 上下文结构容易变化导致缓存失效。
> 用户实测 cache hit ratio 达 **99.82%**。
> **来源**：https://news.qq.com/rain/a/20260810A09NO500

### 3.4 小模型做分类、大模型做生成：分层架构有公开实践吗

**有，成熟且有多套实现。**

| 方案 | 机制 | 来源 |
|---|---|---|
| **RouteLLM** (LMSys) | 开源路由框架，预训练路由模型预测「该走强模型还是弱模型」，基于 Chatbot Arena 人类偏好数据训练。**四种架构**：矩阵分解 / BERT 分类器 / LLM judge / SW(相似度加权)。Apache 2.0，OpenAI 兼容 API，可直接替换 | https://github.com/lm-sys/RouteLLM |
| **Martian** | 调优型路由（frontier model 的性能 + 小模型成本） | https://www.resumelens.org/blog/ai/llm-routing-cascades |
| **pre-call classifier 路由** | 调用 LLM 前用分类器看 query 特征（复杂度、意图、长度、主题）直接分流，**零额外 LLM 调用** | 同上 |
| **阿里云智能电视实践** | 小尺寸 SFT 模型做意图识别（4B->7B，LoRA），基模只做参数生成 —— 见 1.2(a) | https://www.uml.org.cn/ai/202502174.asp |

**你的现实约束（实测③）**：网关只有 `deepseek-v4.1-flash` 和 `sensenova-6.8-flash-lite`，
**分层需要两个可分别调用的端点**。

**可落地的替代方案（不需要第二个模型）**：
既然分层做不到，就用**「检索替代分类」**——即 1.2(b) 的「意图知识库 + 检索路由」。
你的 `recipes.mjs` 的 `matchRecipes()` 现在是**关键词匹配**。
改成 **embedding 相似度 + 阈值**：命中直接走（0 次模型调用），未命中才走模型。
**这在架构上等价于「小模型分类」，但不需要小模型。**

### 3.5 上下文工程（省 token 的另一条路）

**Anthropic 官方**：「Effective context engineering for AI agents」
> "find the smallest set of high-signal tokens that will support the model's ability to complete a task"
> 三个手段：**compaction**（压缩）、**structured note-taking**（结构化笔记）、**sub-agent**（子代理隔离）

**Code Execution with MCP**：把中间结果留在代码里处理，**只回传答案+证据+回执**，
token 从 150,000 -> 2,000（**-98.7%**）。
**来源**：https://www.anthropic.com/engineering/code-execution-with-mcp

**对你的直接映射**：你的 `summarizeProjectContext` **已经是 structured note-taking**，
做得很好。但它把**全部**柜体都塞进去 —— 房间多柜体多时上下文会膨胀。
**改成「按需拉取」**：初始只给房间列表 + 数量，模型要细节时调 `cad.get_state`。
（不过 `get_state` 读的是 live、改完读不到最新状态，这是你已经踩过的坑 —— 所以要做成
「draft 版本的状态读取」。）

**Tool Search / 按需加载工具**：Anthropic 2025-11 推出 Tool Search Tool（Progressive Disclosure），
只加载需要的工具定义。**Stacklok MCP Optimizer** 是开源对标。
**来源**：https://dev.to/stacklok/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison-2f32

注意：**你的 Agent 通道只用了 12 个工具**（`agentLoop.mjs:388-391` 的白名单），
不是全量 21 个动作（那 21 个在 `aiContract.mjs` 的另一套通道）。
**所以「按需加载工具」对你收益有限**，优先级低于「动态内容挪到末尾」。

## 4. 规则/约束注入

### 4.1 few-shot vs 显式规则 vs 检索增强

**工业实践的答案（三方独立验证，结论一致）**：

> "Write the system prompt like an operating manual, not a personality sketch."
> "Show the model **2-5 examples** instead of describing the output you want."
> "**Ground answers in retrieved data — and give the model a way out.**"
> "For most workflow agents, a well-structured system prompt plus RAG outperforms a fine-tuned model
> that's expensive to retune every time the business rules change."

**来源**：https://musketeerstech.com/blogs/prompt-engineering-best-practices

**阿里云实践的顺序**（同一篇，1.2(a) 方案一）：
**(1) CoT 思维链 -> (2) Few-Shot 少样本 -> (3) 特定准则重点说明 -> (4) 输出示例**

**结论（按你的场景排序）**：
1. **显式规则**（你的 `projectRules`）—— 硬约束，必须显式，且**要标优先级**
2. **检索增强**（你的配方库 + 规则检索）—— 垂类知识，命中才注入
3. **Few-shot** —— **你目前几乎没用，这是个缺口**

**具体建议**：你的 `recipes.mjs` 每个配方有 `steps` + `traps`，但**没有 few-shot 示例**。
加一个「成功样例」字段（user -> 期望的动作序列），比再加 3 条 `traps` 更有效 ——
因为模型是**抄**示例，不是**读**规则。

**关键的分级原则（阿里云那篇的核心洞察）**：
> 意图分类（快，规则/小模型）-> 意图槽位（结构化）-> 参数生成（大模型）
> 置信度低 -> 澄清

**即：不要让大模型一步到位同时做「理解意图 + 定参数 + 选动作」**。

### 4.2 「从历史纠正里自动蒸馏成规则」

**有成熟的做法的。**

| 方法 | 机制 | 来源 |
|---|---|---|
| **Reflexion** | Actor 产生轨迹 -> Evaluator 评估 -> Self-Reflection 写一段**第一人称的简短诊断**（「我错在 X，下次应该 Y」）-> 存入 memory bank -> 下次作为额外上下文。**记忆通常只留 1~3 条**以控制长度 | https://arxiv.org/abs/2303.11366 |
| **Voyager** | 技能库 = **可执行代码程序**，用描述的 embedding 索引；**自验证成功后才入库**；检索时用「任务计划 + 环境反馈」的 embedding 查询技能库，可组合简单技能成复杂行为 | https://arxiv.org/abs/2305.16291 |
| **Self-Refine** | 同一个 LLM 当 generator / refiner / feedback provider，迭代自我修正，平均提升约 **20% 绝对值**，**无需监督数据** | https://arxiv.org/abs/2303.17651 |
| **AutoRULE / rule distillation** | 从文本规则中提取知识再编码进 LLM | https://aclanthology.org/2025.coling-main.61 |

**Voyager 的「可执行技能」对你的序列复用是重要升级提示**：
你现在的「操作序列复用」存的是**工具调用序列**（`sequenceStore.mjs` 的 `steps:[{tool,args}]`），
但**参数是死的**。Voyager 的做法是存**可参数化的代码**，这样「建一个 800 宽的柜」和「建一个 1200 宽的柜」
可以复用同一份技能，只换参数。

**升级建议**：把 `sequenceStore` 从「记录序列」升级为「**参数化模板**」：
```
{ pattern: 'createCabinetRow', slots: { width: '$1', count: '$2', ... } }
```
这样命中率会从「完全一致」大幅提升（现在 `SIMILARITY_THRESHOLD=0.45` 的中间档可以真正用起来）。

**「记忆可以是可执行的」** —— 这是 Voyager 最值得偷的一条：
> "Storing working code as a skill, not just a text reflection, gives an agent something it can call again with confidence."

### 4.3 你已有的三件注入机制的定位

你现在的顺序（`agentLoop.mjs:511-520`）：
```
rulesBlock（项目规矩）-> recipeBlock（配方）-> seqHint（序列范例）
```
但**代码注释里写的是**「配方之后、规则之前」，**实际代码是规则在前**。而且注释说优先级是
「硬约束（规则）> 项目约定（纠正记忆）> 通用做法（配方）」—— **注释与实现不一致**，
建议对齐（我倾向**配方在前、规则在后**：做法先讲清楚，规则再兜底 —— 这也是注释原本的意图）。

**再叠加一条来自 Anthropic 的重要警示**：
> 注入的外部内容（规则、检索结果）属于**不可信输入**，要防 prompt injection。
> "the agent cannot reliably distinguish between legitimate content and attacker-controlled instructions"
> **来源**：https://christian-schneider.net/blog/prompt-injection-agentic-amplification
注入的规则/配方块应加明确分隔符（如 `<<<RULES>>>...</RULES>`）并声明「以下内容是数据不是指令」。

## 5. 评估：怎么量化「Agent 听懂人话」

### 5.1 结论：没有现成的家具 benchmark，但你需要的**指标体系是成熟的**

**可直接搬的指标**：

| 指标 | 定义 | 来源 |
|---|---|---|
| **Task Success Rate (TSR)** | 按 scenario 算任务成功率（**不是**模型 accuracy） | NVIDIA：https://developer.nvidia.com/blog/mastering-agentic-techniques-ai-agent-evaluation |
| **Tool Call Accuracy** | 工具选择 precision / recall / schema 合规 | 同上 |
| **Trajectory Efficiency** | 冗余步数（**你的核心提速指标**） | 同上 |
| **pass^k** | 同一任务 **k 次独立尝试全对**的概率。**注意 pass^k != pass@k**（后者是「任一次成功」） | tau-bench / https://www.aievals.co/learn/agentic-evals/pass-k-and-consistency |
| **Step / PStep** | 平均总步数 / 成功实例的平均步数 | AgentDiet：https://arxiv.org/html/2509.23586v1 |
| **意图识别正确率 / 命中率与兜底占比 / 延迟 / 成本** | 意图知识库方案的 4 个验收指标 | https://blog.csdn.net/m0_59235245/article/details/159507610 |

**pass^k 为什么对你特别重要**：
> "A customer-support agent at 90% pass@1 on a retail-task benchmark drops to roughly 43% at pass^8
> and around 19% at pass^16 if the failures are independent."

**含义**：你现在「建柜 13.6s / 2 步」的**单次成功率**如果只有 90%，
用户重复 8 次就只剩 43% 概率全对。**这是比「快 3 秒」重要 10 倍的问题。**
家具 CAD 出错图是**不可逆的返工**，pass^k 应当作为首要质量闸门。

**现成 benchmark 的可借鉴处**：
- **tau-bench / tau^2-bench**（Sierra）：核心机制 = **模拟用户 + 领域工具 + 状态化数据库 + 策略 + 结果式状态比对**。
  你的场景完全可以套：**模拟用户（说中文的甲方）+ 你的 12 个 MCP 工具 + draft 状态 + 最终 project.json 比对**。
  注意版本警告：原 repo 已标注任务未更新，tau^3-bench v1.0.0（2026-03）做了 75+ 项质量修复，早期 banking 分数**不可比**。
  **来源**：https://sierra.ai/uk/blog/tau-bench-shaping-development-evaluation-agents 、 https://www.aievals.co/learn/agentic-evals/pass-k-and-consistency
- **BFCL V3**（Berkeley Function-Calling Leaderboard）：多轮多步函数调用评测，AST 精确匹配 + 可执行函数评测。
  **来源**：https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html
- **HANDBOOK**：长上下文 agentic 指令遵循，**824 条程序化断言、零 LLM judge**。
  **这个思路值得抄**：家具 CAD 的「听懂没有」**完全可以用程序化断言**判定
  （「宽度必须是 600」「必须恰好 3 个柜」「mountHeight 必须 1500」「必须调了 validate」），
  不需要 LLM 打分 —— 又准又便宜。
  **来源**：https://www.youtube.com/watch?v=blptpDoHsc

### 5.2 建议的评测集设计（针对你的项目）

**别做大而全的 benchmark，做「三张卡」**：

**卡 1：意图理解集（N 约 100 条）**
每条 = 用户原话 + 期望结构化槽位。
覆盖：省略（「再宽点」）、指代（「刚才那个」「电视旁边那个」）、量词（「宽一点」到底宽多少）、
多意图（「建个衣柜，底下带抽屉」）、越界（「给我算个装修报价」）。
指标：**意图准确率**、**槽位 F1**、**OOS 率**。

**卡 2：轨迹正确性集（N 约 50 条）**
指标：**Task Success Rate**、**pass^k（k=3~5）**、**平均步数**、**工具错误率**。
判定：**程序化断言**（照 HANDBOOK 的做法），断言 final `project.json` 的具体字段。

**卡 3：端到端性能集**
指标：**p50/p95 延迟**、**模型调用次数**、**cached_tokens 命中率**、**token/次**。

**「听懂人话」最直接的指标（我觉得你缺的就是这个）**：
**「需要澄清时的正确澄清率」** —— 场景给一个**信息不足**的请求（「建个柜子」没说宽高深），
正确行为是**追问**而不是瞎猜。指标 = 该追问时追问了的比例。
这比「意图准确率」更贴近用户的真实感受（用户不怕你问，怕你瞎做）。

**中文 OOS（越界）检测**：
CLINC-150 / Banking77 是标准 OOS benchmark，但中文需要自建。
参考 DETER（双编码 + 阈值重分类）在 CLINC-150 上 unknown F1 > 93%（比最近嵌入方法高 10%）。
**来源**：https://arxiv.org/html/2405.19967v2

## 6. 可落地结论（按 ROI 排序）

### P0 —— 立刻可做，收益最大

| # | 动作 | 依据 | 预期收益 |
|---|---|---|---|
| **1** | **把动态内容（配方/规则/项目摘要）从 system prompt 开头挪到末尾，或拆成独立 system 消息** | 实测②：动态在前 -> cached=**0**；拆开 -> cached=**97%** | 缓存命中 0->97%；成本 -45~80%（论文 2601.06007）；TTFT -13~31% |
| **2** | **执行层改并行：一轮多个 tool_call 同时发给模型，tool 执行仍串行** | 实测①（网关支持）；Restate 模式 | L 型厨房（建 3~4 个柜）从 4 轮往返压到 1~2 轮；**低风险**（不改变执行顺序语义） |
| **3** | **建 N 个独立柜时显式给 x/y，把「create + place」拆开**，从而让组 B 可并行 | `create_cabinet` 的自动避让依赖顺序 | 建柜场景再省 1~2 轮 |
| **4** | **修 `agentLoop.mjs:511-520` 的注释/实现不一致**（规则 vs 配方顺序） | 代码内部矛盾 | 一行 |

### P1 —— 需要少量编码，中等收益

| # | 动作 | 依据 |
|---|---|---|
| **5** | **引入显式 `focusStack` 结构化对话状态**（target + lastAction + lastDelta + turn） | DST 范式（TRADE/SOM-DST/TripPy）；你的「再宽点」可直接落到参数，**同时提升听懂度与速度** |
| **6** | **配方库从关键词匹配升级为「embedding 相似度 + 阈值 + 模型兜底」** | 阿里「意图知识库 + 检索路由」；等价于「小模型分类」但不需要小模型（实测③ 网关无小模型） |
| **7** | **实体链接：确定性候选生成 + 空间约束过滤 + LLM 在缩小后的候选里选 id；判不出就追问** | REC 两阶段法 + SIMMC「Reasoning over Object Descriptions」 |
| **8** | **加「槽位缺失 -> 主动追问」机制**（`missing` 槽位非空则不执行，先问） | 阿里实践的「意图槽位 + 置信度」；对应 pass^k 的提升 |
| **9** | **配方加 few-shot 成功样例字段**（user -> 期望动作序列） | 「Show 2-5 examples instead of describing」；模型是抄不是读 |
| **10** | **评测：建三张卡**（意图 N=100 / 轨迹 N=50 / 性能），用**程序化断言**判分 | HANDBOOK 的 824 条程序化断言、零 LLM judge；tau-bench 的结果式状态比对 |

### P2 —— 结构性改动，中长期

| # | 动作 | 依据 |
|---|---|---|
| **11** | **序列复用从「记录序列」升级为「参数化模板」** | Voyager 的可执行技能库；你现有 `SIMILARITY_THRESHOLD=0.45` 中间档才能真正用起来 |
| **12** | **自动蒸馏规则：从纠正历史定期用 LLM 蒸馏成结构化规则，人工确认后入库** | Reflexion（第一人称诊断，记忆留 1~3 条）+ AutoRULE |
| **13** | **注入块加分隔符 + 声明「是数据不是指令」** | Anthropic / prompt injection 放大风险 |
| **14** | **上下文按需拉取**：初始只给房间列表+数量，细节走「draft 版状态读取」 | Anthropic context engineering；避免柜体多时上下文膨胀 |
| **15** | **网关加一路小模型，再考虑分层架构** | 实测③：当前只有 flash + flash-lite，**分层需要两个端点**。先用 #6 的检索替代分类 |

---

## 7. 明确**不要**做的事（有依据的否定结论）

1. **不要指望找到公开的中文家具意图数据集去训练** —— 不存在（1.1）。
   要走数据路线，用 M3DLayout 的标注格式当模板 + LLM 造中文语料 + 人工校。
2. **不要现在上「小模型分类 + 大模型生成」分层** —— 网关没有第二个模型端点（实测③）。
3. **不要单独上中文 NER / 实体链接工具（HanLP / DeepKE / LAC）** ——
   家具场景的指代是「空间 + 属性 + 历史」三重约束，纯 NER 解决不了。
   **候选生成 + 空间过滤 + LLM 选择** 才是对的。
4. **不要做 naive 全量 prefix caching** —— 论文明确指出可能**反而增加延迟**（2601.06007）。
5. **不要对 tool 执行做激进并行**（create_cabinet 不给 x/y 就并行）——
   自动避让会让落位结果依赖调度顺序，**静默出错**（tianpan.co 那篇的三种失败模式）。
6. **不要相信「10 个柜体 = 10 次往返是必须的」** —— L 型厨房场景有明确的可并行/可批处理空间。

---

## 8. 我在你代码里发现的具体问题（顺带）

| 位置 | 问题 |
|---|---|
| `server/agentLoop.mjs:511-520` | 动态内容在 system prompt **开头** -> **prefix cache 100% 失效**（实测） |
| `server/agentLoop.mjs:634` | `for (const tc of toolCalls) { await callMcpTool(...) }` —— **串行执行**，浪费了网关的并行能力 |
| `server/agentLoop.mjs:511` vs 注释 | 注释说「配方之后、规则之前」，代码是**规则在前** |
| `server/agentLoop.mjs:388-391` | Agent 通道工具白名单是 **12 个**，而 21 个动作在另一条通道（`aiContract.mjs`）—— 两条通道的动作模型**不一致** |
| `shared/recipes.mjs` | 无 few-shot 样例字段（4.1 建议补） |
| `shared/sequenceStore.mjs` | 存的是死参数序列，非参数化模板（6. P2 #11） |

---

## 附：全部来源清单

**实测（本机，2026-10-21）**
- gpt-load 网关 `http://192.168.2.2:3002/v1`：并行 tool_call 探测、prefix cache 命中矩阵、延迟对比、模型列表

**并行工具调用**
- Anthropic 并行工具文档 https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use
- 并行/串行工具调用 https://theengmap.vercel.app/ai/tool-use/parallel-and-sequential-tool-calls
- 并行调用隐藏耦合（中文）https://tianpan.co/zh/blog/2026/04/10/parallel-tool-calls-hidden-coupling
- Restate 并行模式 https://docs.restate.dev/ai/patterns/parallelization
- Microsoft function calling https://learn.microsoft.com/en-us/semantic-kernel/concepts/ai-services/chat-completion/function-calling

**少步数**
- W&D 并行工具调用 https://arxiv.org/html/2602.07359v1
- PASTE https://arxiv.org/html/2603.18897v3
- Agentix https://www.alphaxiv.org/abs/2603.18897
- AgentDiet 轨迹裁剪 https://arxiv.org/html/2509.23586v1
- Anthropic 工具设计 https://www.anthropic.com/engineering/writing-tools-for-agents

**缓存与上下文**
- Don't Break the Cache https://arxiv.org/html/2601.06007v1
- DeepSeek 磁盘上下文缓存 https://api-docs.deepseek.com/news/news0802
- 提示词缓存原理 https://sankalp.bearblog.dev/how-prompt-caching-works
- DeepSeek-Reasonix 缓存工程（99.82%）https://news.qq.com/rain/a/20260810A09NO500
- Anthropic 上下文工程 https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Code Execution with MCP（-98.7%）https://www.anthropic.com/engineering/code-execution-with-mcp
- MCP Optimizer vs Tool Search https://dev.to/stacklok/stackloks-mcp-optimizer-vs-anthropics-tool-search-tool-a-head-to-head-comparison-2f32

**意图理解 / NLU**
- 阿里云智能电视意图识别实践（中文）https://www.uml.org.cn/ai/202502174.asp
- 意图知识库 + 检索路由（中文）https://blog.csdn.net/m0_59235245/article/details/159507610
- LLM 零样本 DST via Function Calling https://arxiv.org/html/2402.10466v1
- LLM 做零样本 DST 综述 https://www.emergentmind.com/topics/dialogue-state-tracking-dst
- 意图/槽位数据集综述 https://arxiv.org/html/2207.13211v2
- SLOT 结构化输出 https://aclanthology.org/anthology-files/anthology-files/pdf/emnlp/2025.emnlp-industry.32.pdf
- 中文意图数据集汇总 https://github.com/InsaneLife/ChineseNLPCorpus

**指代消解 / 实体链接**
- Reasoning over Object Descriptions（SIMMC）https://arxiv.org/html/2604.27850v1
- REC + Scene Graph https://www.frontiersin.org/journals/neurorobotics/articles/10.3389/fnbot.2020.00043/full
- CLUEWSC2020 中文指代消解 https://github.com/CLUEbenchmark/CLUEWSC2020
- OOS 检测 DETER https://arxiv.org/html/2405.19967v2

**中文 NLP 工具**
- HanLP 2.1 https://github.com/hankcs/HanLP
- DeepKE http://deepke.zjukg.cn
- PaddleNLP https://github.com/PaddlePaddle/PaddleNLP

**数据集**
- M3DLayout (CVPR 2026) https://openaccess.thecvf.com/content/CVPR2026/papers/Zhang_M3DLayout_A_Multi-Source_Dataset_of_3D_Indoor_Layouts_and_Structured_CVPR_2026_paper.pdf
- Text2CAD-Bench https://arxiv.org/html/2605.18430v1
- 3D-FUTURE / 3D-FRONT https://tianchi.aliyun.com/specials/promotion/Dataset

**规则蒸馏 / 记忆**
- Reflexion https://arxiv.org/abs/2303.11366
- Voyager https://arxiv.org/abs/2305.16291
- Self-Refine https://arxiv.org/abs/2303.17651
- 规则蒸馏 https://aclanthology.org/2025.coling-main.61
- 自改进 agent 框架对比 https://futureagi.com/blog/self-improving-ai-agents-open-source-frameworks

**路由 / 分层**
- RouteLLM https://github.com/lm-sys/RouteLLM
- LLM 路由与级联 https://www.resumelens.org/blog/ai/llm-routing-cascades

**评估**
- tau-bench / tau^2-bench https://sierra.ai/uk/blog/tau-bench-shaping-development-evaluation-agents
- pass^k https://www.aievals.co/learn/agentic-evals/pass-k-and-consistency
- BFCL V3 https://gorilla.cs.berkeley.edu/blogs/13_bfcl_v3_multi_turn.html
- NVIDIA agent 评估 https://developer.nvidia.com/blog/mastering-agentic-techniques-ai-agent-evaluation

**安全**
- Prompt injection 放大 https://christian-schneider.net/blog/prompt-injection-agentic-amplification

