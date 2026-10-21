# 视觉模型选型：买哪个、多少钱（2026-10-22）

> 起因：本地网关（gpt-load）上的模型**要停了**，需要自购一个能识图的模型。
> 本文给出**官方价**、**按本项目真实用量的成本**、以及推荐。

---

## 一、先算清楚：我们到底要什么

| 需求 | 具体 | 为什么 |
|---|---|---|
| **能看图** | 必须支持 image input | 现有 deepseek/glm-5.2 都传不进图（image_tokens 恒为 0） |
| **OpenAI 兼容** | `/v1/chat/completions` + `image_url` | 现有代码直连，改动最小 |
| **够准** | 认得出柜体结构（挂衣/层板/抽屉分区）+ 读尺寸标注 | 现有 sensenova 实测 5/5 全对 |
| **够快** | < 30 秒 | sensenova 实测 8.6-26 秒 |
| **不贵** | 见下面算账 | 视觉调用频次不高（一轮对话 1-2 次） |

★ **文本通道不用动**（deepseek-v4.1-flash pass^5 = 100%），只换视觉通道。

---

## 二、候选对比（**官方价**，元/百万 tokens）

| 模型 | 平台 | 输入 | 输出 | 缓存命中 | 上下文 | 备注 |
|---|---|---|---|---|---|---|
| **GLM-4.6V-FlashX** | 智谱 | **0.15** | **1.5** | **0.03** | 131K | 9B 轻量视觉，支持图片/视频/文档，**带 Function Call** |
| **Qwen3-VL-32B** | 硅基流动 | **0.2** | **0.6** | — | 262K | OpenAI 兼容，最便宜的大模型视觉 |
| Qwen3-VL-8B | 硅基流动 | 0.18 | 0.68 | — | 262K | 轻量版 |
| **GLM-5.3-Flash** | 智谱 | 0.8 | 2.8 | 0.23 | **1M** | GLM-5 首个**原生多模态**模型 |
| GLM-4.6V | 智谱 | 1.0 | 3.0 | 0.2 | 128K | 视觉精度 SOTA，原生 Function Call |
| qwen3-vl-plus | 阿里百炼 | 1.468 | 11.743 | — | 32K+ | 阶梯计价，最贵 |

## 三、按**本项目真实用量**算账

实测用量：视觉识别一次 = `pt=3628`（209KB 图）+ `cc=640`（JSON 输出）。

| 模型 | 每次识别 | 1000 次 | 10000 次 |
|---|---|---|---|
| **Qwen3-VL-32B** | **0.0011 元** | **1.11 元** | 11.1 元 |
| Qwen3-VL-8B | 0.0011 元 | 1.09 元 | 10.9 元 |
| **GLM-4.6V-FlashX** | **0.0015 元** | **1.50 元** | 15.0 元 |
| GLM-5.3-Flash | 0.0047 元 | 4.69 元 | 46.9 元 |
| GLM-4.6V | 0.0055 元 | 5.55 元 | 55.5 元 |
| qwen3-vl-plus | 0.0128 元 | 12.84 元 | 128.4 元 |

★ **结论：就算最贵的 qwen3-vl-plus，一万次识图也才 128 块。**
这个用量下，**模型准不准比价格重要得多** —— 差 10 倍价格也就差一百多块。

---

## 四、推荐

### 首选：硅基流动（SiliconFlow）的 `Qwen3-VL-32B`

**理由**：

1. **最便宜**（0.0011 元/次），而且它是 **Qwen3-VL** ——
   调研报告里明确提过：「Qwen3-VL 是**唯一**在 UI 截图和设计稿上做 SFT 的开源 VLM」，
   对**图纸/设计稿**这类图的适配最好。
2. **OpenAI 兼容** ⇒ 现有代码**一行不用改**，改 `.env` 就行。
3. **新用户送 14 元** ⇒ 够跑 12000 次识图，先白测再决定。
4. 有 **8B / 32B** 两档，可以按效果选。

**注册**：https://cloud.siliconflow.cn

### 备选：智谱 BigModel 的 `GLM-4.6V-FlashX`

**理由**：

1. 0.0015 元/次（比 Qwen3-VL-32B 贵 40%，但**比 qwen3-vl-plus 便宜 8.5 倍**）。
2. **原生 Function Call** ⇒ 将来做「识别 → 直接建柜」不用再拼 JSON。
3. 智谱**新用户送 2000 万 Token**（≈ 折 58 元），且 GLM-4-Flash 永久免费。

**注册**：https://open.bigmodel.cn

### 不推荐：阿里百炼 `qwen3-vl-plus`

比前两个贵 8-12 倍，而**每张图的 token 数是同一个量级**（图才是大头，不是文字）。
除非要用百炼的企业能力，否则没必要。

---

## 五、买完之后怎么接

**只改 `.env` 两行**：

```bash
AI_BASE_URL=https://api.siliconflow.cn/v1     # 或 https://open.bigmodel.cn/api/paas/v4
AI_API_KEY=你的key
AI_MODEL=deepseek/deepseek-v4.1-flash          # 文本通道（也可以换成硅基的 Qwen3-30B）
AI_VISION_MODEL=Qwen/Qwen3-VL-32B-Instruct    # 视觉通道 ← 换这个
```

**然后必须验三件事**（我上一轮已经把工具做好了）：

```bash
# ① 视觉模型真的能看图吗（打真网关，6 项）
npm run verify:vision-probe

# ② 识别结果对吗（真图 + ground truth，5 项）
node server/server.mjs &          # 先起服务
npm run eval:vision
```

★ 这两个脚本**就是**为了「换模型」这件事做的 ——
换完模型不用猜，**跑一下就知道**。

### ⚠️ 一个坑：新模型可能拒绝 `temperature`

kimi-k3 就是 `only 1 is allowed`。接新模型前先探一下：

```bash
curl -s <base>/chat/completions -H "Authorization: Bearer $KEY" -d '{
  "model": "<新模型>", "messages": [{"role":"user","content":"hi"}], "max_tokens": 32
}'
```

不传 `temperature` 就行（大多数模型默认 1）。
本项目 `server/server.mjs` 目前**硬传** `temperature: env.AI_TEMPERATURE`，
如果新模型拒绝，需要改成「不传」（这一步等定了模型再做）。

---

## 六、如果本地网关还能用

**先别买。** 现在的组合是能用的：

- 文本：`deepseek/deepseek-v4.1-flash`（pass^5 = 100%）
- 视觉：`sensenova-6.8-flash-lite`（识别 5/5 全对）

自购 API 的好处是**稳定 + 不限量**（本地网关是共享的，会被限流/下线）。
按上面的算账，**一年识图成本也就几十块** —— 属于一次性几十块、永久不用操心的量级。
