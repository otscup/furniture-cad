# 本地模型接入（2026-10-20）

## 配置

已写入 `app/.env`（该文件在 `.gitignore` 里，**不会入库**）：

```
AI_PROVIDER=lan
AI_BASE_URL=http://<lan-host>:3002/v1
AI_MODEL=deepseek/deepseek-v4.1-flash
AI_API_KEY=<your-key>
AI_MAX_TOKENS=8192
AI_TIMEOUT_MS=120000
AI_TEMPERATURE=0.2
```

## 实测结果

### 网关可用性
`GET /v1/models` → 200，返回 3 个模型：
- `deepseek/deepseek-v4.1-flash` ← 选用的这个
- `meta/muse-spark-1.3-contributor`
- `sensenova-6.8-flash-lite`

### 应用内三条链路

| 端点 | 结果 | 耗时 |
|---|---|---|
| `GET /api/settings` | provider=`lan`，baseUrl/model/key 全部正确回显，key 只显示 `**3456` | — |
| `POST /api/models/refresh` | source=`live`，3 个模型全部拉到 | ~1s |
| `POST /api/ai/chat` | 正常返回中文正文 | 3.2s |
| `POST /api/ai/plan` | **产出结构化动作**，详见下 | 9.4s |

### /api/ai/plan 真实产出（这是画柜子的路径）

输入：「做一个宽1800高2000深600的三门衣柜，左边挂衣区，右边层板」

产出：
```json
{
  "action": "cabinet.create",
  "params": {
    "name": "三门衣柜",
    "width": 1800, "height": 2000, "depth": 600,
    "cabinetType": "tall",
    "units": [
      { "kind": "hanging", "width": 1200, "nickname": "挂衣区", "doorCount": 2 },
      { "kind": "shelves", "width": 600, "nickname": "层板区", "doorCount": 1 }
    ]
  },
  "reason": "用户给了明确三围 1800×2000×600，并按"左挂衣、右层板"分成两个分区；三门按 2+1 分配（挂衣区对开门、层板区单门）。"
}
```

**注意它做对了三件事**：
1. 自动判定 `cabinetType: "tall"`（2000 高 > 1800 阈值）
2. 把"左边挂衣右边层板"翻译成两个 unit，宽度 1200+600=1800 自洽
3. 门数按分区大小分配（对开门 2 + 单门 1 = 三门），而不是平均切

## ⚠️ 一个必须知道的特性：这是推理模型

`deepseek/deepseek-v4.1-flash` 会先输出 `reasoning_content` 再输出正文。

**实测证据**：
- `max_tokens=200` 时 → `finish_reason: "length"`，正文**完全为空**，200 个 token 全被推理吃掉
- `max_tokens=1500` 时 → 正常返回（推理 21 + 正文 5）
- 画柜子实测：推理 109 + 正文 127

所以 `AI_MAX_TOKENS` 设成了 **8192**，不是随便填的：

- 设太小（如 512）→ 推理把预算吃光，用户看到"AI 没回答"
- 设太大 → 推理模型会一发不可收拾，把"空回答"换成"超时"

应用本身对此已有处理（`server.mjs:2694`）：正文为空且推理非空时会尝试从 `reasoning_content` 里**抢救 JSON**，并如实回报 `emptyReason`，不会假装成功。

若以后换非推理模型，可以把这个值降回 4096 左右。

## 时间预期

内网推理模型单次 3–10 秒是正常范围。`AI_TIMEOUT_MS` 从默认 60s 放宽到 **120s**，避免复杂柜型（多分区）规划时被截断。

## 换模型的正确姿势

管理后台「AI 设置」里点 **「⟳ 自动拉取」**，不要手填模型名 ——
网关挂了哪些模型只有它自己知道，手填拼错会得到一个含糊的 404。

## 回滚

改 `app/.env` 里的 `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY` 三项即可，
不需要重建镜像（服务端每个请求都重读 `.env`，见 `readEnv()`）。
