# 新增两个模型的能力实测（2026-10-22）

## 摘要

用户新增了 `glm-5.2` 和 `kimi-k3`，实测两者的能力，结论是**都不能替代现有配置**。

| 模型 | 识图 | 纯文本 JSON | 速度 | 结论 |
|---|---|---|---|---|
| `sensenova-6.8-flash-lite` | ✅ | ✅ | 1.3-26s | **保持视觉通道** |
| `deepseek/deepseek-v4.1-flash` | ❌ | ✅ | 2.1s | **保持文本通道** |
| `glm-5.2` | ❌ | ✅ | 3.7-18.7s | 文本可用，**不能做视觉** |
| `kimi-k3` | 未能测 | 未能测 | — | **上游持续限流** |

### glm-5.2 的 NLU 成绩（k=1，20 条用例）

| 场景 | pass^1 |
|---|---|
| 单柜（该做就做） | 82% |
| 多柜（该问就问） | 100% |
| 多轮（跨轮指代） | 100% |

**两次失败都是「JSON 截断」** —— 推理 token 吃光 8192 预算。
比 deepseek（单柜 pass^5 91%）略低，且**更慢**（3.7-18.7s vs 2.1-5s）。

⇒ **不换**。

---

## 一、glm-5.2：文本能看，图片不能

### 证据（真实图纸 sym-02c.png，209KB）

```
--- glm-5.2 ---
  18728ms  pt=37  cc=996  finish=stop
  "抱歉，我目前无法看到您提到的图片。请您上传该柜体图纸，我才能为您描述柜子有几格以及里面是什么。"
--- sensenova-6.8-flash-lite ---
  26507ms  pt=2941  cc=640  finish=stop
  "这是一张总宽2400mm的三门平开衣柜图纸，内部共分为三个柜格，左右两格是上下分层的叠放储物区，中间格是挂衣区……"
```

★ 决定性证据是 **`prompt_tokens`**：

| 模型 | prompt_tokens | 含义 |
|---|---|---|
| sensenova | **2941** | 图片**编码进去了** |
| glm-5.2 | **37** | 图片**压根没进去** |

37 token = 只有那一句文字。图片没被网关转发给模型。

★ glm-5.2 的回答是**诚实的**（「无法看到图片」），不是乱猜 —— 这点比 deepseek 好，
但**功能上仍然是不通的**。

### 纯文本能力：没问题

```
glm-5.2  ✓纯JSON  3708ms  cc=204 推理=182
  "{\"动作\":\"cabinet.create\",\"宽\":1800,\"高\":2400,\"深\":600}"
```

中文键名的 JSON 一次到位。

---

## 二、kimi-k3：两个坑

### 坑 1：只允许 temperature = 1

```
HTTP 400: {"message":"field Temperature invalid, only 1 is allowed for this model"}
```

★ 这对**现有代码是个真问题**：`server/server.mjs` 的 AI 端点都传了 `temperature`
（`AI_TEMPERATURE` 默认 0.2）。换到 kimi-k3 会**直接 400**。

⇒ 如果要用 kimi-k3，`/api/ai/*` 端点必须**不传** temperature（或传 1）。
这是**待办**，不是现在要改的（还没决定用不用它）。

### 坑 2：上游持续限流

连续 4 次重试（每次间隔 8 秒）全部 429：

```
inference exceeds tpm/rpm limit
upstream_rate_limited
```

⇒ 识图与文本能力**都没测出来**。等额度恢复再测。

---

## 三、为什么没改配置

现在的配置是对的：

```
AI_MODEL=deepseek/deepseek-v4.1-flash        # 文本（语言理解）—— NLU 7/12
AI_VISION_MODEL=sensenova-6.8-flash-lite      # 视觉（识图）—— 识别 5/5 全对
```

- **glm-5.2 不能做视觉**（图片没进去），换上去视觉功能直接坏。
- **glm-5.2 做文本可以**，但 deepseek 已经 7/12、2-18 秒，没理由换。
- **kimi-k3 测不出来**，且它的 temperature 限制会让现有端点 400。

⇒ **配置不动**。等 kimi-k3 额度恢复、且确认它的识图能力后再评估。

---

## 四、顺带发现：现有的 temperature 是个隐患

`server/server.mjs` 硬传 `temperature: env.AI_TEMPERATURE`（默认 0.2）。
有些模型**只接受 1**（kimi-k3），有些**不接受 temperature**（glm-5.2 传了也不报错但行为未知）。

⇒ 下次要接新模型时，先看它接不接受 temperature。
本轮**没改** —— 因为现在用的两个模型都接受，改了是给不存在的问题写代码。

---

## 五、★ 顺带做出来的东西：视觉能力探测

测试这两个模型时发现一件事：**「视觉模型配错了」这个故障是**看不出来的**。

接口 200、结果结构完整、连置信度都是 `high` ——
但模型其实**没看图**，对着输入乱猜。

（实测：glm-5.2 答「抱歉，我看不到图片」；deepseek 答「这是 SVG 源码文本，不是效果图」。）

### 判据：prompt_tokens 的增量

同一句话，带图与不带图各发一次，看 token 差多少：

```
模型                        纯文本 pt   带图 pt   差值   结论
sensenova-6.8-flash-lite      87        153      66    图送到了，也承认看见了
deepseek-v4.1-flash           35        219     184    图送到了，但**答不出颜色**
glm-5.2                      17         17       0    **图压根没送**
```

★ 网关**不报** `image_tokens`，只有这一条能用。
（所以上一轮那个「`image_tokens === 0` ⇒ 没看图」的判据是**死代码**，永不触发 —— 已改成不依赖它。）

### 探针图：8x8 纯红 PNG（75 字节）

为什么不用 1x1：1x1 时 sensenova 的 token 增量只有 66（太小，分不开）；
8x8 增量明显，且**模型还能说出颜色**（1x1 时 sensenova 回答是空字符串）。

### 接在哪

`/api/test`（管理后台的「测试」按钮）—— 那里本来就在做「模型真的回话了吗」的探测，
加一个视觉探测是同一件事的自然延伸。

```json
{
  "vision": {
    "model": "sensenova-6.8-flash-lite",
    "plainPromptTokens": 87,
    "imagePromptTokens": 153,
    "delta": 66,
    "imageReachedModel": true,     // 图送到了没有
    "modelSawColor": true,         // 模型承认看见了没有
    "said": "这张图是纯正的亮红色……"
  }
}

★ **「图送到了」与「模型看懂了」是两件事，分开报** ——
deepseek 就是「送到了但不认」，只报前者会漏掉它。

### 验收

`verify:vision-probe`（6 项，**打真网关**）：

- 配了 `AI_VISION_MODEL` 且与 `AI_MODEL` 不同
- 纯文本请求成功
- 带图 token **明显更多**（图确实送进去了）
- 模型能说出颜色（真看见了）

★ 为什么用真网关测：判据是**网关行为**（token 增量），
mock 出来的 token 数是编的，测了等于没测。
