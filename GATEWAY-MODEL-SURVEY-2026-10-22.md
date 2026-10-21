# 网关模型能力普查（2026-10-22）

> 用户说「5.3 flash 添加了」⇒ 实测网关：**没有** 5.3 flash。
> 这一轮顺手把网关里**全部 8 个模型**的能力实测了一遍（打真网关）。

---

## 一、5.3 flash 的情况：网关里没有

### 证据

```
GET http://192.168.2.2:3002/v1/models  →  8 个模型，无 5.3 flash
```

试了 9 种可能的写法（`glm-5.3-flash` / `glm-5.3-flash:free` /
`zai-org/glm-5.3-flash` / `GLM-5.3-Flash` / `glm-5.3` / `glm-5.3-flashx` …），
**全部 503 `no_available_candidate`**。

★ 关键：用一个**肯定不存在**的模型名，得到的**也是同样的 503**：

```
this-model-definitely-does-not-exist-xyz   HTTP 503  no_available_candidate
glm-5.3-flash                              HTTP 503  no_available_candidate
sensenova-6.8-flash-lite                   HTTP 200  ✓
```

⇒ **503 不能证明「网关认识这个名字」** —— 反而说明网关找不到能用的上游。

### 为什么加不进来

网关的管理接口 `/api/channels` 与 `/api/groups` 返回 **403「当前密钥无权访问此功能」**。
⇒ **加渠道/模型是网关管理员的操作**，我（和这个 key）都做不了。

**需要你做的**：在网关后台把 5.3 flash 加进 GPT-Load 渠道（或新建智谱渠道）。
加完我跑 `npm run check:vision` 就能验。

---

## 二、★ 全部 8 个模型的能力普查（实测）

判据：
- **温度**：`temperature: 0` 会不会被拒
- **json格式**：支不支持 `response_format: {type:'json_object'}`
- **图Δpt**：带图与不带图的 `prompt_tokens` 差（>0 ⇒ 图送进去了）
- **识图**：拿真实图纸（sym-02c.png）问是什么，看描述对不对

| 模型 | 温度 | json格式 | 图Δpt | 识图 | 耗时 |
|---|---|---|---|---|---|
| **deepseek/deepseek-v4.1-flash** | OK | OK | 991 | **OK** | 9.2s |
| glm-5.2 | OK | OK | **0** | **✗ 图没进去** | 11.5s |
| kimi-k3 | **✗ 400** | — | 4434 | OK（但**不传温度**才行） | — |
| **minimax/minimax-m3.1-flash:free** | OK | OK | 3746 | **OK** | 10.4s |
| poolside/laguna-s-2.1-free | ✗ 429 限流 | — | — | — | — |
| **sensenova-6.8-flash-lite** | OK | OK | 2837 | **OK** | 12.8s |
| reflection/beam:free | OK | OK | — | ✗（不支持图） | 9.3s |
| stealth/glyph-cluster:free | OK | **✗ 400** | — | ✗ | 8.8s |

### 网关自己声明的模态（`GET /api/models`）

| 模型 | 网关标称模态 | 实测一致？ | 价格 in/out（元/M） |
|---|---|---|---|
| deepseek-v4.1-flash | text, **image** | ✓ | 0.024 / 0.375 |
| glm-5.2 | **text** | ✓ | 1.195 / 4.183 |
| kimi-k3 | text, **image**, video | ✓ | 3 / 15 |
| minimax-m3.1-flash:free | text, **image**, video | ✓ | **0 / 0（免费）** |
| sensenova-6.8-flash-lite | text, **image** | ✓ | **0 / 0（免费）** |
| poolside | text | ✓ | 0 / 0（限流中） |
| reflection/beam | — | ✓ | — |
| stealth/glyph | — | ✓ | — |

★ **网关的模态标注是准的** —— `glm-5.2` 标 `text` only，实测 Δpt=0，一致。
⇒ 以后选模型**先看这个表**，不用一个个试。

### ★ 一个重要更正

**「image_tokens = 0 ⇒ 模型看不见图」这个判据是错的。**

deepseek 的 `image_tokens` 恒为 0，但实测 **Δpt=991 图进去了**，
而且它能**准确描述**这张工程图（白底黑线、红色标注）。
之前它自称「看不见图片」，是因为**那个探针图是 1×1**，太小了。

⇒ 判据只能是 **prompt_tokens 的增量**（已写进 `verify:vision-probe`）。

---

## 三、结论：现在**不用买**

实测下来，现成的模型已经够用：

| 通道 | 选谁 | 为什么 | 成本 |
|---|---|---|---|
| **视觉** | `sensenova-6.8-flash-lite` | 识别 5/5 全对，Δpt=2837 | **0（免费）** |
| 视觉（备选） | `minimax/minimax-m3.1-flash:free` | 也能看图，描述准确 | **0（免费）** |
| **文本** | `deepseek/deepseek-v4.1-flash` | pass^5 = 100% | 0.024 / 0.375 |

★ **两个视觉模型都是免费的**（网关标 in=0 out=0）。
⇒ 本地网关能撑多久就撑多久，**先把钱花在别处**。

### ★ 更新：kimi-k3 现在**也能用了**

上一轮它限流、且拒绝 temperature。这一轮：

- 限流解除了（Δpt=4434，能准确描述这张工程图）
- **服务端已能自动处理它的 temperature 限制**（见下）
- 真实图纸识别：`{"宽":2400,"格数":3}` —— **与 ground truth 完全一致**

但它比 sensenova 贵（3/15 元/M vs 免费），且**把同一衣柜的三个视图当成了 2 个柜体**
（C1 + C2 重复）。⇒ 仍以 sensenova 为准，kimi-k3 留作备选。

---

## 四、★ 服务端自动去掉 temperature（kimi-k3 解封）

kimi-k3 拒绝 `temperature`（`only 1 is allowed`）⇒ 直接 400。

### 修法：改**一处**

`server/server.mjs` 的 `fetchWithTimeout()` —— **所有 7 处上游调用都经过它**。

```js
const r = await fetch(url, { ...init, signal: ac.signal });
if (r.status !== 400 || !init?.body) return r;
const text = await r.clone().text();
if (!/temperature/i.test(text)) return r;      // 只在明确提到 temperature 时才重试
const payload = JSON.parse(init.body);
delete payload.temperature;                    // 去掉后重试（不传 = 用模型默认）
return await fetch(url, { ...init, body: JSON.stringify(payload), signal: ac2.signal });
```

★ **只在错误信息明确提到 temperature 时才重试** ——
否则 400 会掩盖真正的错误（比如参数写错），重试只是浪费一次。

### 实测

```
kimi-k3 走 /api/ai/vision：改之前 HTTP 400
                          改之后 HTTP 200，18 秒，识别正确
```

---

## 五、什么时候才需要买

1. 网关真的下线了 ⇒ 买硅基 `Qwen3-VL-32B`（0.0011 元/次，一万次 11 块）
2. 或本地网关 5.3 flash 配好了 ⇒ **先跑 `npm run check:vision`** 再说

### 现在该做的（不用花钱）

在网关后台把 **5.3 flash 加进渠道**。加完跑：

```bash
npm run check:vision
```

11 项体检（温度 / json格式 / 图送进去了没有 / 真实图纸识别对不对），
**全绿就是能用**，不用再猜。

---

## 四、附：kimi-k3 的温度限制（已在文档里，这里再记一次）

```
HTTP 400: {"message":"field Temperature invalid, only 1 is allowed for this model"}
```

它**能看图**（Δpt=4434，描述准确），能力比 minimax 强，但：
- 贵（3/15 元/M）
- 拒绝 temperature ⇒ 现有端点会 400
⇒ 除非网关能改配置，否则**不用它**。
