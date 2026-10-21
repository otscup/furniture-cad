# VLM 识别家具 CAD 图纸 / 效果图 —— 技术调研报告

> 调研日期：2026-10-21　｜　目标：纯前端 React+TS 定制家具 CAD 应用
> 数据模型：`cabinet = params(宽高深/材质/柜型) + layout.units(shelves/hanging/drawerBank/appliance/open)`
> 链路：前端发图 → `/api/ai/vision` → 模型自由文本+结构化 → `visionResultToNormalized` → 统一 AI 计划链路

---

## 0. TL;DR —— 10 条可落地结论

| # | 结论 | 依据 |
|---|---|---|
| 1 | **不要指望通用 VLM 一次出结构。** 必须改成「定位 → 裁剪 → 逐柜识别」两段式 | [CAD2Program](https://arxiv.org/abs/2412.11892)、[CropVLM](https://arxiv.org/abs/2511.19820) |
| 2 | **「图纸 → 参数化结构」已有现成学术方案可抄结构**：CAD2Program 用 InternVL 微调输出 shape program | [arxiv 2412.11892](https://arxiv.org/abs/2412.11892) |
| 3 | **家具/柜体专用数据集存在**：CAD2Program 的 368K 柜体模型+工程图（但输出是 3D shape program，非 2D 分区） | 同上 |
| 4 | **OCR 尺寸标注要单独走专用管线**，不要指望 VLM 顺带读出 | [From Drawings to Decisions](https://arxiv.org/abs/2506.17374) |
| 5 | **端到端结构化输出用 JSON schema 约束解码**，但 Qwen2.5-VL 在 vLLM 上有已知 bug | [vLLM #13038](https://github.com/vllm-project/vllm/issues/13038) |
| 6 | **必须显式限制视觉 token**（`max_pixels`），12MP 手机照默认吃 15.5K token | [preprocessor_config.json](https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct) |
| 7 | **像素→毫米不要做单目 metric depth**，尺度歧义是原理性的；必须用「标注」或「已知参考物」 | [MMDE Survey](https://arxiv.org/abs/2501.11841) |
| 8 | **「先描述再结构化」优于直接 JSON** —— CAD2Program 消融显示带标注使参数准确率从 81.94%→97.21% | [alphaxiv 2412.11892](https://www.alphaxiv.org/abs/2412.11892) |
| 9 | **计数是已知弱项** —— 「柜体数量」必须用 bbox 定位而非让模型数 | [PairTally](https://arxiv.org/abs/2509.13939) |
| 10 | **本项目当前代码有 4 个具体缺陷**（knownScaleMm 被丢、vision 无 response_format、rodHeight/applianceName 契约缺失、融合路径不一致） | 见 §6 |

---

## 1. 现成开源项目 / 公开数据集

### 1.1 ⭐ 最相关：CAD2Program（AAAI 2025，北京航院 + Manycore Tech）

**这是与本任务结构最接近的公开工作。**

- 论文：[From 2D CAD Drawings to 3D Parametric Models: A Vision-Language Approach](https://arxiv.org/abs/2412.11892)（arXiv 2412.11892, AAAI 2025）
- 主页 / 代码：<https://manycore-research.github.io/CAD2Program> ｜ <https://github.com/manycore-research/CAD2Program>
- **输入**：2D CAD 图纸（栅格化成图，不要求矢量、不要求标准三视图）
- **输出**：通用文本语言描述的 3D 参数化模型（Python 风格 shape program），每个 primitive 一行：
```
python
bbox_0 = Bbox(507, 185, 805, 1014, 370, 50, 0)
model_0 = <model_57761062>()
bbox_1 = Bbox(25, 185, 390, 50, 370, 780, 0)
model_1 = <model_57758898>()
model_2 = <model_115813862>(N=1, NKA=928, DBXX=1, BT=18)
```
- **模型**：Mini-InternVL-1.5-2B（InternViT-300M + InternLM2-1.8B）微调
- **数据集**：**368K 过滤后的柜体模型 + 配套工程图**；373 个预定义 primitive；702 个 model-specific 参数；切分 364K/2K/2K
- **指标**（柜体测试集）：
  - model-ID retrieval accuracy：**93.80%**（含标注）/ 85.42%（仅几何）
  - primitive-box reconstruction F1：**82.76%**（含标注）/ 62.65%（仅几何）
  - model-specific parameter accuracy：**97.21%**（含标注）/ 81.94%（仅几何）
- ⭐ **对本项目的直接启示**：
  1. **「带标注 vs 不带标注」的消融差距巨大**（参数准确率 +15.3 个百分点）→ 你的 fusion 模式（效果图+尺寸图）方向正确，且**尺寸图必须真的读到标注**，不能让模型猜。
  2. **「文本 shape program」优于固定槽位模板** —— 论文明确论证：固定 command template 会随 primitive 库膨胀且留大量空槽。你的 `layout.units` 是个 **5 选 1 的 select 枚举**，语义空间小，反而适合固定 schema；不必照搬 CAD2Program 的自由文本。
  3. **柜体 primitive 库 373 个 / 702 参数** 说明「柜体」在工业界本身就是高度可枚举的领域知识，可以借鉴其 primitive 分层思路来设计你的 `units.kind` 词表。

### 1.2 Ortho2CAD（2026，CMU）

- 论文：[Ortho2CAD: 3D CAD generation from orthographic drawings using vision language models](https://arxiv.org/abs/2607.08891)
- 代码：<https://github.com/AdityaJoglekar/Ortho2CAD>
- **输入**：栅格化正投影三视图（含虚线隐藏线 + bbox 尺寸标注）→ **输出：CadQuery Python 代码**
- ⭐ **最有价值的是它的数据合成方法**：用 **pythonOCC** 从 STEP 模型自动渲染正投影图，含虚线隐藏线和关键尺寸标注，生成 **150K+** 样本
- 训练法：**SFT（有 CadQuery 标注时）+ geometry-grounded RL（无标注时，用可执行几何做 reward）**
- 结果：代码 **100% 语法合法**；3D IoU 比最强基线平均相对提升 **>7%**
- ⭐ **对本项目的直接启示**：**「合成数据」是可行路径**。你已有完整参数化 CAD 模型 + 前端渲染器 ⇒ 可以自己造「模型 → 渲染图 → 结构标注」的监督数据对，微调一个 VLM 做单图→结构。这条路比指望通用 VLM zero-shot 靠谱得多。

### 1.3 工程图 → 结构化信息的混合管线（Khan et al.）

- 论文：[From Drawings to Decisions: A Hybrid Vision-Language Framework for Parsing 2D Engineering Drawings into Structured Manufacturing Knowledge](https://arxiv.org/abs/2506.17374)
- **方法**（⭐ 这就是你要的架构）：
  1. **YOLOv11-OBB**（旋转框检测）定位图上的标注 → 切出**定向 bbox patch**
  2. **轻量 VLM（Donut / Florence-2）**逐 patch 解析成结构化输出
- 数据集：自建 **1,367 张 2D 机械图**，9 类标注
- 结果：**Donut 优于 Florence-2** —— precision 88.5% / recall 99.2% / F1 93.5%，**hallucination rate 11.5%**
- 前作：[Fine-Tuning VLM for Automated Engineering Drawing Information Extraction](https://arxiv.org/abs/2411.03707) —— 微调 **Florence-2**（仅 0.23B），相比最好闭源模型 **precision +29.95%、recall +37.75%、F1 +52.40%、hallucination −43.15%**
- ⭐ **直接照抄**：**「检测器切块 + 小 VLM 逐块解析」** 比「一个大 VLM 吞整图」在工程图上更准、且 hallucination 可控。这与你说的「裁剪 + 分区域」思路完全一致，且**有论文数字背书**。

### 1.4 CAD / 平面图理解数据集（用于预训练或评测，不直接是家具）

| 数据集 | 内容 | 规模 | 链接 |
|---|---|---|---|
| **FloorPlanCAD** (ICCV'21) | 真实 CAD 平面图（SVG），**全景符号检测**（panoptic symbol spotting），线级标注 | 15,663 张 | [floorplancad.github.io](https://floorplancad.github.io) ／ [HF](https://huggingface.co/datasets/Voxel51/FloorPlanCAD) |
| **ArchCAD-400K** (NeurIPS'25) | 建筑 CAD 图，**413,062 chunks from 5,538 张高度标准化图纸**，比此前最大 CAD 数据集大 26×；基线 **DPSS** | 400K | [arxiv 2503.22346](https://arxiv.org/abs/2503.22346) ／ [HF](https://huggingface.co/datasets/jackluoluo/ArchCAD) |
| **CADSpotting** | 大规模 CAD 图上的鲁棒全景符号检测 | — | [arxiv 2412.07377](https://arxiv.org/abs/2412.07377) |
| **SketchGraphs** | 1,500 万 CAD 草图 + 几何约束图 | 15M | [PrincetonLIPS/SketchGraphs](https://github.com/PrincetonLIPS/SketchGraphs) |
| **ABC Dataset** | 大规模 B-rep CAD 模型 | — | [deep-geometry.github.io/abc-dataset](https://deep-geometry.github.io/abc-dataset) |
| **DeepCAD / CAD-Recode** | 参数化 CAD 序列建模 | 178K | [filapro/cad-recode](https://huggingface.co/datasets/filapro/cad-recode) |
| **Img2CAD** | 单图 → 带参数 CAD；中间表示 **SVG**（vectorized wireframe）；**ABC-mono**（200K+ 模型带渲染图）+ **KOCAD**（真实拍摄物 + GT CAD） | 200K+ | [arxiv 2410.03417](https://arxiv.org/abs/2410.03417) |
| **FloorplanQA** | ⭐ 室内布局**符号化 JSON/XML** 上的空间推理基准 | 1000+ query | [arxiv 2507.07644](https://arxiv.org/abs/2507.07644) ／ [项目页](https://OldDelorean.github.io/FloorplanQA/) |
| **PairTally** | 细粒度计数基准 | 681 图 | [arxiv 2509.13939](https://arxiv.org/abs/2509.13939) |
| **3D-FRONT** | 合成室内场景（含家具） | — | [hyper.ai](https://hyper.ai/en/datasets/21079) |

> **重要判断**：**没有任何公开数据集直接提供「家具图 → 你的 params + layout.units 结构」**。最接近的 CAD2Program 是「图纸 → 3D shape program」，方向相反。所以**微调数据必须自建**（用你已有的参数化模型反向渲染，见 §4.3）。

### 1.5 平面图矢量化 / CAD parsing

- **FloorplanTransformation**（Raster-to-Vector）— <https://github.com/art-programmer/FloorplanTransformation>
- **Wall/room 检测**：UVic thesis <https://dspace.library.uvic.ca/bitstream/handle/1828/10111/Cabrera-Vargas_Dany_MSc_2018.pdf>
- **语义分割**：Mix-Transformer + U-Net 墙分割 [arxiv 2512.02413](https://arxiv.org/abs/2512.02413)；SCG 语义平面图分割 [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0926580524003856)

> **判断**：平面图矢量化（像素→线段）**不解决你的问题**。你要的是**语义**（这是柜门/层板/挂衣区），不是几何线条。矢量化是 CV 传统方法，语义仍需 VLM/检测器。

---

## 2. VLM 选型

### 2.1 候选对比（本地可部署，中文能力，2026 现状）

| 模型 | 参数 | 工程图/文档能力 | 结构化输出 | 视觉 token 机制 | 建议 |
|---|---|---|---|---|---|
| **Qwen3-VL-8B/32B-Instruct** ⭐ | 8B/32B | 最强一档：文档、OCR、grounding、chart | 原生支持；官方强调「stable JSON outputs for coordinates and attributes」 | patch 16 / merge 2（**32px 有效**），默认 longest_edge=16777216, shortest_edge=65536 | **首选**。中文好、grounding 强、支持 bbox 输出 |
| **Qwen2.5-VL-7B/32B/72B** | 7B~72B | 官方称「significant advantages in understanding documents and diagrams」 | 官方称支持结构化输出 | patch 14 / merge 2（**28px 有效**），默认 min_pixels=3136, max_pixels=12845056 | 成熟稳定、社区微调多；**但 vLLM 上有 JSON schema bug** |
| **InternVL3 / 3.5** (8B/14B/78B) | 8B~78B | OCR/图表/文档理解强；3.5 是最新（[arxiv 2508.18265](https://arxiv.org/abs/2508.18265)） | 支持工具调用/结构化 | **动态分块 tiling**（448×448，最多 12×1 tiles）+ thumbnail | **CAD2Program 用的就是 InternVL 系**，微调路径有先例 |
| **MiniCPM-V 4.5** | 8B | 声称超 GPT-4o-latest；**OCR 特别强**（统一文档知识+文本识别范式）；3D-Resampler 高效 | 支持 | 轻量高效 | 适合边缘/低显存部署；**但图纸 grounding 弱于 Qwen3-VL** |
| **Florence-2-large** | 0.23B/0.77B | ⭐ **专用检测/OCR 任务**（OD / OCR / CAPTION / region），**专为下游任务微调设计** | 任务 token 化输出 | 固定分辨率 | ⭐ **做「裁剪块解析」的主力**：两篇工程图论文都用它，幻觉率最低 |
| **Donut** | — | 文档理解 | 任务化 | — | 工程图标注解析上 **F1 93.5%**，优于 Florence-2 |
| **SpatialVLM** (Google DeepMind) | — | ⭐ **3D 空间推理 / 绝对尺度估计** | 自由文本 | — | 解决「参考物尺度推断」的唯一成熟路线，见 §4 |

### 2.2 ⭐ 结构化输出能力对比（重点）

**三条路线：**

1. **JSON mode**（response_format: {type:'json_object'}）—— 只保证是 JSON，**不保证符合你的 schema**。你项目里 /api/ai/plan、/api/ai/chat 都用了这个（见 shared/aiContract.mjs:1989,2014）。
2. **JSON Schema 严格约束**（response_format: {type:'json_schema', json_schema:{schema}}）—— **推荐**。引擎：**Outlines**（FSM）、**XGrammar**（更快，vLLM 内置）、**llguidance**。
3. **模型内建** —— Qwen3-VL 官方支持 grounding 输出稳定 JSON 坐标；InternVL 支持 tool calling。

**⚠️ 三个必须知道的坑：**

- **vLLM + Qwen2.5-VL 的 JSON schema 有已知 bug**：[vllm#13038](https://github.com/vllm-project/vllm/issues/13038)「vllm doesn't honor the specified json schema using outlines/xgrammar with qwen 2.5 vl」。**若自建本地推理服务，优先选 Qwen3-VL 或 InternVL3.5，或先验证再上线。**
- **多模态下 response_format 常常被静默忽略**（尤其走 OpenAI 兼容代理时）。
- **结构化输出 ≠ 正确**。Guided decoding 只保证语法合法，**不保证数值正确、不保证不幻觉**。参考 [arXiv 2501.10868](https://arxiv.org/abs/2501.10868)。

**⭐ 你的代码现状**（已核实）：/api/ai/vision 路由（server/server.mjs:2632-2780）**完全没有设置 response_format**，只把 schema 写进 system prompt，然后靠正则剥 markdown 围栏 + JSON.parse。而 /api/ai/plan、/api/ai/chat 都设了 json_object。**这是明确的不一致 —— vision 是最容易产生畸形 JSON 的端点，却恰恰是唯一没有 JSON 约束的。**

### 2.3 ⭐ 视觉 token 与长宽比（实测计算）

**Qwen2.5-VL 视觉 token = (H/28) × (W/28)**（patch 14 × 2×2 合并）。
**Qwen3-VL 视觉 token = (H/32) × (W/32)**（patch 16 × 2×2 合并）。

**默认 max_pixels 下的实测 token 数：**

| 图像 | Qwen2.5-VL | Qwen3-VL |
|---|---|---|
| 手机随手拍 3024×4032 (12MP) | **15,552 tok** | **11,970 tok** |
| 效果图 1920×1080 | 2,691 tok | 2,040 tok |
| CAD 截图 2400×800（超宽） | 2,494 tok | 1,875 tok |
| 立面图 3600×1200（超宽） | **5,547 tok** | **4,294 tok** |
| 户型图 3000×3000 | 11,449 tok | — |
| **裁剪后单柜 800×1200** | **1,247 tok** | **950 tok** |

**关键洞察：**

1. **长宽比本身不是问题，问题是总像素。** 超宽 2400×800（2.5:1）只吃 2.5K token；而 12MP 手机照吃 15.5K。**Qwen 的 smart_resize 等比缩放，长宽比不会导致信息被拉伸**（M-RoPE 2D 位置编码能处理非方形）。真正的问题是**高分辨率下每个部件的像素数**：一张 12MP 的整屋效果图缩到 2.5K token 后，一个 600mm 的层板可能只剩几行像素。
2. **这直接论证了「裁剪 + 分区域」**：裁剪后单柜只要 ~1.2K token，**比整图省 5~10×**，且单柜获得全分辨率。5 个柜子逐个识别 = 5×1.2K = 6K token，**比整图一次（15.5K）更省且更准**。
3. **max_pixels 默认值 12845056 远超训练分辨率** —— 社区已报告这会**降低 grounding 精度**：[mlx-vlm#1175](https://github.com/Blaizzy/mlx-vlm/issues/1175)「default max_pixels is 12× the training resolution; degrades grounding accuracy」。**建议显式设 max_pixels 到 ~1-2M 像素（约 2.5K 视觉 token）**，既省算力又可能更准。
4. **InternVL 的动态 tiling 机制**（448×448，最多 12 tile + 1 thumbnail）本质就是内建的「裁剪」，与你的两段式思路天然契合。

---

## 3. 提示工程最佳实践

### 3.1 ⭐ 强烈建议：改成「定位 → 裁剪 → 逐柜识别」三段式

**为什么（不是「感觉」，是有数据）：**

- **CropVLM**（[arxiv 2511.19820](https://arxiv.org/abs/2511.19820)）：外部低成本「zoom in」模块，**不改动冻结的 VLM**，在需要高分辨率细节的任务（scene-text、document analysis）上显著提升；明确指出**均匀提高分辨率计算代价过高**，而「多数请求其实只用到很少的 image token」。方法：RL（GRPO）训练裁剪策略，**不用人工标注 bbox** 作监督，训练一次即可搭配任意 VLM。
- **Image Tiling for High-Resolution Reasoning**（[arxiv 2512.11167](https://arxiv.org/abs/2512.11167)）：复现 Monkey VLM tiling 方案，**确认 tiling 有效恢复局部细节**；⚠️但**重要发现：全局上下文的加入效果「高度依赖任务类型和 tile 粒度」** ⇒ **不能只给裁剪块，必须同时给一张全局缩略图**，否则模型丢失「这几个柜子是一排」的关系。
- **From Drawings to Decisions**（[arxiv 2506.17374](https://arxiv.org/abs/2506.17374)）：检测器切块 + 小 VLM 逐块解析，**Donut F1 93.5%**，幻觉率 11.5%。

**推荐架构（对应你的代码）：**

```
Stage 1  布局定位  → Qwen3-VL / InternVL3.5 输出柜体 bbox（grounding）
         └─ 一并输出「柜体数量」与「左/中/右顺序」
Stage 2  裁剪      → 服务端裁切（Canvas）+ 附带一张全局缩略图作 context
Stage 3  逐柜识别  → 每柜一次（或每 N 柜一次）调用，只问该柜的 units/rows
Stage 4  融合      → 复用你现有的 mergeVisionResults / visionResultToNormalized
```

**在 Qwen3-VL 上 Stage 1 是现成的**：官方支持 grounding，输出稳定 JSON 坐标。你的 **VisionCabinet 类型缺一个 bbox 字段** —— 建议加上，作为 Stage 3 的裁剪依据（见 §6.6）。

### 3.2 让输出稳定的具体手段

| 手段 | 做法 | 依据 |
|---|---|---|
| **JSON Schema 约束** | 服务端给 /api/ai/vision 加 response_format: {type:'json_schema', json_schema:{name:'VisionResult', schema, strict:true}} | 你已有 schema（src/ai/vision/types.ts）可直接转 JSON Schema |
| **temperature=0** | 识别是抽取任务。你现在 **0.2**，建议降到 0 | 通用 |
| **数值用 ratio 而非 mm** | 你已设计对：widthRatio/heightRatio 优先，widthMm 只在有标注时给 | **CAD2Program 消融：带标注 vs 不带，参数准确率 81.94%→97.21%** |
| **强制注明取数来源** | 保留 source: 'annotation'\|'reference'\|'estimate' + confidence | **抑制幻觉的关键**。两篇论文都把 hallucination rate 作为独立指标报告（11.5% / −43.15%） |
| **数值区间校验（服务端）** | 宽高须在 [300,5000]、深 [200,900]、unit 宽度 > 0；越界 → 降级 estimate + 降 confidence | 你的 visionResultToNormalized 目前**无任何数值合理性校验** |
| **多采样一致性** | 同一图跑 3 次，取一致的项；不一致的降到 low confidence 或丢进 ambiguous | 你已有 ambiguous 硬阻断机制，天然适配 |
| **few-shot** | 但 few-shot 要放**真实案例**，且注意 token 成本 | 见 §3.3 |

### 3.3 ⭐ few-shot vs「先描述再结构化」两段式

**结论：对你的场景，「先描述再结构化」优于直接 few-shot JSON，但两者不互斥 —— 最优是「两段式 + 1 个 few-shot 例子」。**

**依据：**

- **CAD2Program 的核心论证正是「用通用文本语言代替固定槽位」** —— 论文明确说文本脚本「更灵活，可扩展到任意几何实体和语义/功能属性」，而固定模板「会随 primitive 库存膨胀并含大量空槽」。这说明**两阶段（先理解 → 再序列化）是有价值的**。
- **「先描述」对数量/结构判断特别有效**：模型先用自然语言讲清「左边是玄关鞋柜带三个抽屉，中间是到顶衣柜带挂衣区，右边是带烤箱的矮柜」，再转 JSON，比直接吐 JSON 的**结构一致性**更好（JSON 里 units 数组的顺序/嵌套天然容易错位）。
- **But**：两段式**成本翻倍**。
- ⚠️ **对数值，两段式反而更危险**：自然语言里「大概 2 米宽」一旦写出来，后续抽取容易把它当既定事实，**丢掉「这是估计」的标记**。**必须强制第一段也带 uncertainty 标注。**

**⭐ 落地建议（成本最优）：单次调用，但 prompt 内强制「先写 description 字段，再写结构」**

```
{
  "sceneDescription": "一段自然语言，描述每个柜体的位置、外观、分区构成；凡是无法确定的，写'无法确定'",
  "cabinets": [ ... ],
  "scale": {...},
  "ambiguous": [...]
}
```

这样「先描述再结构化」发生在**同一次生成的内部**（模型先写 description token，再写 JSON），**零额外成本**，且 description 可直接进你 UI 的 notes 展示给用户核对。**这是对当前 schema 的最小改动、收益最大的一招。**

### 3.4 Prompt 里必须写死的「诚实纪律」（你已有一半）

你现有 system prompt 已有：看不见的不编造、无标注填 estimate、数量不清写 ambiguous —— **方向完全正确，且与文献一致**（两篇论文都把 hallucination 率作为一等指标）。

**建议补充：**
- 「**先输出 sceneDescription，再输出 cabinets**」
- 「**每个数值必须能指出它来自哪条标注线**（无标注则 source='estimate'）」
- 「**单位若为 cm/m 换算成 mm 并在 notes 注明原值**」—— 你在 dimension prompt 里已有，**但 render prompt 里没有** ⇒ 效果图上也可能有 cm 标尺
- 「**看不见的柜体不要省略、不要合并**」—— 幻觉的另一个方向是**漏检**（把两个柜说成一个）
- 「**区分 geometry layer 与 annotation layer**」—— CAD2Program 的核心洞察：尺寸标注线/箭头/延长线**不是**柜体轮廓（[arxiv 2412.11892](https://arxiv.org/abs/2412.11892)）

---

## 4. 几何量提取（像素 → 毫米）

### 4.1 ⭐ 核心结论：**不要引入单目 metric depth 做绝对尺度**（除非有标尺）

**原理性理由**（不只是「精度不够」）：单目深度估计的**尺度歧义（scale ambiguity）是几何上无法从单张图消解的** —— 同一张图既可解释为「小柜在远处」也可为「大柜在近处」。MMDE 综述明确指出：常规 MDE 预测 **scale-agnostic** 深度，MMDE（monocular **metric** depth）才输出绝对米制值，但后者**泛化性差、边界细节损失严重**（[Survey on Monocular Metric Depth Estimation, arXiv 2501.11841](https://arxiv.org/abs/2501.11841)）。

**对你的场景更糟**：你要**毫米级**下料精度。MMDE 在室内场景典型误差是**百分比级**，完全不够下料。

### 4.2 ⭐ 真正可行的三条路（按可靠性排序）

| 方案 | 可靠性 | 做法 |
|---|---|---|
| **A. 读尺寸标注**（source='annotation'） | ⭐⭐⭐ 最高 | 尺寸图上直接读数字。你已有 dimension 模式。但需 OCR 辅助（见下） |
| **B. 用户提供已知参考尺寸**（source='reference'） | ⭐⭐⭐ 高 | 你已有 knownScaleMm 字段。**⚠️ 但当前代码把它丢了**（见 §6.1） |
| **C. 图中可辨识的参照物**（门/踢脚线/插座/标准层板间距） | ⭐⭐ 中 | 见下方 SpatialVLM |

**方案 C 的唯一成熟技术路径：SpatialVLM**
- [spatial-vlm.github.io](https://spatial-vlm.github.io)（CVPR 2024, Google DeepMind）
- ⭐ **核心贡献：首个互联网规模的「metric space」3D 空间推理数据集** —— 从 1,000 万真实图自动生成 **20 亿条** 3D 空间 VQA，把 2D 图像「提升到 metric scale 的 3D 点云」
- 效果：定量空间推理（距离/尺寸差）**大幅提升**，解锁 chain-of-thought 空间推理与机器人应用
- ⭐ **对你的用法**：把「这个柜子宽多少」变成「这个柜子比旁边那个标准门宽多少」—— **模型在 metric space 里给的是绝对米数**，可换算 mm
- ⚠️ 仍属 **research checkpoint**，生产可用性一般；建议作为**可选增强**而非主路径

### 4.3 ⭐⭐ 强烈推荐：自己合成训练数据（最高 ROI 的一条）

你**已经有**：完整的参数化柜体模型（params + layout.units）+ 前端渲染器 ⇒ 可以造 **(渲染图 → 结构 JSON)** 的监督对，**零标注成本、无限量**。

**参考方法：**
- **Ortho2CAD** 用 **pythonOCC** 从 STEP 模型渲染正投影图（含虚线隐藏线 + 尺寸标注）→ **150K+ 样本**（[arxiv 2607.08891](https://arxiv.org/abs/2607.08891)）
- **CAD2Render**（合成数据生成器）<https://www.oajaiml.com/uploads/archivepdf/19071158.pdf>
- **Img2CAD** 的 **ABC-mono**（200K+ 模型带渲染图）＋ **SVG** 中间表示 —— ⭐ **SVG 中间表示的思路值得抄**：先从图里抽出线框结构，再条件化生成 CAD，比端到端更可控（[arxiv 2410.03417](https://arxiv.org/abs/2410.03417)）
- **CAD2Program** 的 **368K 柜体图-模型对**

**推荐微调配方**（对齐两篇论文的共识）：
1. **基座**：Qwen3-VL-8B-Instruct（中文好、grounding 强、结构化输出好）**或** InternVL3.5-8B（CAD2Program 用的 InternVL 系，有微调先例）
2. **SFT**：合成数据（渲染图 → 你的 VisionResult JSON 格式）
3. **可选 RL**：Ortho2CAD 的 **geometry-grounded RL** —— 用「渲染回图和输入图比 IoU」作 reward。⭐ **你的链路天然支持**：识别结果可生成 3D 预览，与原图比对
4. **数据增广**：加透视/噪点/光照变化/材质渲染 —— 直接对应 §5 的失败模式

### 4.4 尺寸标注 OCR 的专用管线

工程图上的尺寸数字**旋转、密集、字体怪**，通用 OCR 会失效。**从 Drawings to Decisions** 的做法（[arxiv 2506.17374](https://arxiv.org/abs/2506.17374)）：

1. **YOLOv11-OBB** 检测旋转框 → 切出定向 patch
2. **Donut 或 Florence-2** 逐 patch 解析
3. 得到 F1 93.5%、recall 99.2%、幻觉率 11.5%

**对你**：把「读尺寸」从 VLM 主任务里**拆出来**，用专门检测+OCR 处理，反而更准。**若不想引入 YOLO，至少保证「尺寸图」模式的 prompt 强调「数字优先」**（你已经有了），并**考虑用 PaddleOCR-VL / PP-DocLayoutV3 之类的文档解析模型预抽数字**（[PaddleOCR-VL 0.9B](https://arxiv.org/abs/2510.14528)）。

---

## 5. 失败模式

### 5.1 VLM 在工程图上的常见错误类型

| 错误类型 | 表现 | 缓解 |
|---|---|---|
| **尺寸幻觉** | 编造看起来合理的尺寸数字 | 你的 source/estimate 机制**正确**，务必保留；加服务端区间校验 |
| **标注读错** | 旋转/模糊数字读错 | 专用 OCR 管线（§4.4） |
| **计数错误** | 2 个柜说成 3 个，或反之 | ⭐ **用 bbox 定位替代「数」**。PairTally 证明模型「难以可靠地数用户所指，尤其在细粒度和视觉歧义情况」（[arxiv 2509.13939](https://arxiv.org/abs/2509.13939)） |
| **单位/比例误读** | mm/cm/m 混淆 | dimension prompt 已有；**render prompt 缺** ⇒ 补 |
| **投影类型误判** | 把等轴测当正投影，把正投影当透视图 | 见 §5.2 |
| **结构脑补** | 看不见内部却给层板 | 你的「不脑补」纪律正确，保留 |
| **漏检** | 忽略部分柜体（被遮挡或低对比度） | 多图融合 + 强制逐柜复述 |
| **JSON 畸形** | 截断、尾逗号、markdown 围栏 | **JSON schema 约束**（§2.2） |
| **数值不自洽** | units 宽度和 ≠ 柜宽；rows 高度和 ≠ 柜高 | ⭐ **服务端加一致性校验**（你目前没有） |

### 5.2 ⭐ 会误导模型的具体图元

| 图元 | 为什么误导 | 应对 |
|---|---|---|
| **等轴测 / 轴测图 vs 正投影** | 等轴测的「宽度」在图上是**斜向投影**，与真实宽高比**不等**（等轴测三轴按 cos30° 缩短）。按像素比例算 ⇒ **宽高比系统性错误** | ① prompt 明确「这是等轴测/透视图，**禁止**用像素比例推尺寸，只填 ratio 不填 mm」；② 检测投影类型（正投影 ⇔ 平行线族） |
| **透视变形（手机随手拍）** | 近大远小 ⇒ 远处柜子被缩小，**像素比例完全失效** | ① 提示「单张透视照片**不能**用像素比推尺寸」；② 建议用户提供第二张图（你已有 fusion 模式） |
| **材质渲染干扰** | 木纹/高光/镜面让人把**材质边界**误读成**结构边界**；玻璃门会「透出」后面的柜子 | ① 明确区分「门」与「开放格」；② prompt 强调「以门缝/层板边缘等**结构线**为准，不以材质反光分界」 |
| **玻璃门 / 透明门板** | 看不见内部结构 | 强制 notVisible: ['inner-partitions'] |
| **阴影与暗部** | 内部隔板在阴影里消失 ⇒ 漏检层板 | notes 里标注「阴影区结构不确定」 |
| **踢脚线 / 装饰线 / 拉手** | 被当成结构分隔线 | 提示忽略非结构线（踢脚、装饰条、拉手） |
| **标注线与图元线混淆** | 尺寸标注线、箭头、延长线被当作柜体轮廓 | 引用 CAD2Program 的 **geometry layer / annotation layer** 二分法（[arxiv 2412.11892](https://arxiv.org/abs/2412.11892)）⭐ **该论文的核心洞察，值得直接写进你的 prompt** |
| **参考物尺度误导** | 用户给的 knownScaleMm 指向的物体没在图里/被遮挡 ⇒ 比例全错 | 校验参考物是否真的可见；不可见则降级 |
| **多柜融合** | 两张图（尺寸图+效果图）的柜体**对不上**（数量/顺序不同） | 你已有 mergeVisionResults；**匹配应按 bbox/位置而非 ref 字符串** |

### 5.3 ⭐ 领域特有失败：空间推理一致性

**FloorplanQA**（[arxiv 2507.07644](https://arxiv.org/abs/2507.07644)，KAUST + UMich + USC）对**结构化 JSON 布局**上的空间推理做了系统评测，结论：
> 「模型在浅层查询上可能成功，但**经常无法遵守物理约束、保持空间一致性**，不过对小扰动**大体鲁棒**」

**对你的直接含义**：即使 VLM 识别出的 JSON 语法完全正确，**其内部几何可能自相矛盾**（units 宽度和 ≠ 柜宽、两个柜重叠、柜宽超出房间）。⇒ **服务端必须做几何一致性校验** —— 这恰恰是你 dryRunPlan / validatePlan 链路的价值所在，**不要让 vision 结果绕过它**。

### 5.4 幻觉的量化基准

- 你的项目已有 verify/vision-acceptance.ts 验收测试。⭐ **建议补上幻觉率指标**（参考两篇论文的做法）：定义「幻觉」= 输出了图中不存在的柜体/分区/尺寸；用 20~50 张标注图人工标注 GT，测 precision/recall/F1/hallucination-rate。
- **MIT DeCoDe Lab** 发布了 **1000+ query** 的工程设计 VLM 评测基准（[arxiv 2311.12668](https://arxiv.org/abs/2311.12668)），含工程图分析、CAD 生成、空间推理（心理旋转/装箱测试）—— 可作**方法论参考**（[vlms4design](https://decode.mit.edu/projects/vlms4design)）

---

## 6. ⭐ 本项目代码的具体问题（已核实，非猜测）

### 6.1 🔴 knownScaleMm 在服务端被完全丢弃

- 前端确实发送了：src/ai/vision/providers/remote.ts:54 传 knownScaleMm
- 但服务端 /api/ai/vision 路由（server/server.mjs:2632-2780）**只读了** body.model, body.images, body.image, body.mode, body.hint, body.maxTokens —— **没有 body.knownScaleMm**
- 且 src/ui/panels/AIPanel.tsx:897 的请求体是 { image, mode, hint } —— **前端也没传**
- ⇒ **用户提供的参考尺寸从未到达模型**。你设计里「用户给了参考尺寸 ⇒ source='reference'」的整条路径**是断的**。
- **修复**：(a) AIPanel 增加 knownScaleMm 输入框并透传；(b) server 读取 body.knownScaleMm 并写进 prompt（如「已知参考物 X 的真实尺寸为 N mm，请以此为比例基准」）；(c) 记为 scale.source='reference'。

### 6.2 🔴 /api/ai/vision 缺 response_format

- shared/aiContract.mjs:1989（design）与 :2014（plan/chat）都设了 response_format: { type: 'json_object' }
- server/server.mjs:2632-2780（vision）**没有** —— 只用正则剥 markdown 围栏（:2740）再 JSON.parse
- **修复**：加 response_format: { type:'json_schema', json_schema: { name:'VisionResult', schema, strict:true } }。
  ⚠️ 若 provider 是**自建 vLLM + Qwen2.5-VL**，会撞上 [vllm#13038](https://github.com/vllm-project/vllm/issues/13038) ⇒ **先验证**；或退一步用 json_object；或换 Qwen3-VL。
  ⇒ 建议：**按 provider 能力做能力协商**（支持则 json_schema，否则退化 json_object + 服务端 schema 校验 + 失败重试）。

### 6.3 🟡 缺「数值合理性」与「几何自洽」校验

- visionResultToNormalized.ts 直接把模型数值当事实用（w = rawW ?? 900 等），**没有区间校验**（宽 2000mm？深 5000mm？）也**没有自洽校验**（units 宽度和 vs 柜宽、rows 高度和 vs 柜高）
- 结合 FloorplanQA 结论（模型空间一致性不可靠），**这是最容易出事的环节**
- **修复**：在 visionResultToNormalized 里加两层校验：① 区间（超出范围 ⇒ 降级 estimate + 降 confidence + 加 caveat）；② 自洽（和与整柜差 >5% ⇒ 加 caveat 或提问）。

### 6.4 🟡 VisionUnit 契约与实现不一致（rodHeight / applianceName 永远拿不到）

- src/ai/vision/types.ts:38-54 的 VisionUnit **有** rodHeight、applianceName、openingWidth、openingHeight
- 但 server/server.mjs:2679 的 **system prompt 里 VisionUnit 只有** kind|widthMm|widthRatio|count|doorCount|confidence —— **少了 rodHeight/applianceName/openingWidth/openingHeight**
- ⇒ **模型永远不可能输出挂衣区挂杆高和电器洞口尺寸**，而 visionResultToNormalized.ts:60-64 明确要透传 rodHeight（注释还写「P9.9 约束一」）—— **前端在等一个模型不会给的值**
- 同一问题在 :1874（dimension prompt）也存在
- **修复**：**由 types.ts 自动生成 JSON Schema / prompt 里的接口定义**（单一真源），杜绝两处漂移。

### 6.5 🟡 fusion 路径不一致（服务端 fusion 分支是死代码）

- server.mjs:2646-2648 的 visionMode='fusion' 分支要求 multiImages.length > 1 **且** 同时有 dimension 和 render
- 但 AIPanel.tsx:893-914 是**逐张单独调用** /api/ai/vision，**从不发 body.images 数组**
- ⇒ **服务端 fusion 分支是死代码**；实际融合发生在前端 mergeVisionResults（AIPanel.tsx:915-922）
- 而 AIPanel.tsx:731 的 Agent 路径**又是另一套**（逐张发、再把 visionResult 塞给 agent）
- ⇒ **三套融合逻辑、两套 prompt 触发条件**。建议统一：**前端只发 body.images 数组，服务端负责 fusion**（或明确只保留前端 fusion，删掉服务端死分支）。

### 6.6 🟡 无 bbox 字段 ⇒ 无法做「裁剪 + 分区域」

你的 VisionCabinet 没有 bbox ⇒ 阶段 2 无法裁剪。**建议加** bbox?: [number,number,number,number]（Qwen3-VL grounding 原生输出格式），并让 Stage 1 专门产出它。

### 6.7 🟢 temperature: 0.2 偏高

抽取类任务建议 **0**（或 ≤0.05）。配合 JSON schema 约束会更稳。

### 6.8 🟢 视觉 token 未设上限

前端直接把原图 data URL 发出（AIPanel.tsx:897），后端原样转发。⇒ 12MP 手机照 = 15.5K 视觉 token（Qwen2.5-VL）。**建议服务端转发前按 max_pixels 缩放**（Canvas 或 sharp），并注意 mlx-vlm#1175 报告的「默认 max_pixels 降低 grounding 精度」。

---

## 7. 推荐路线图

### 阶段 0（1~2 天，低风险高回报）
1. 修 §6.1（knownScaleMm 打通）、§6.2（response_format）、§6.4（schema 单一真源）、§6.7（temperature=0）
2. 加 sceneDescription 字段（§3.3）—— 单次调用内的两段式，零成本
3. 加数值区间 + 几何自洽校验（§6.3）
4. 加 bbox 字段（§6.6）

### 阶段 1（1~2 周）
5. **两段式识别上线**：Stage 1 bbox 定位（Qwen3-VL grounding）→ 裁剪 → Stage 3 逐柜识别 + 全局缩略图作 context
6. 尺寸图路径接专用 OCR（Florence-2/Donut 或 PaddleOCR-VL）
7. 建 30~50 张标注评测集，测 precision/recall/F1/**hallucination-rate**

### 阶段 2（1 个月+）
8. **合成数据 + 微调**：用你的参数化模型 + 渲染器生成 (图 → JSON) 对，微调 Qwen3-VL-8B 或 InternVL3.5-8B
9. 可选：geometry-grounded RL（Ortho2CAD 式，渲染回图比 IoU）
10. 可选：SpatialVLM 做参考物尺度推断增强

### 明确避开
- ❌ 单目 metric depth 做毫米级尺度（尺度歧义原理性不可解）
- ❌ 平面图矢量化路线（要语义不要线条）
- ❌ 一次性整图直出 JSON（计数 + 细节双输，token 也双输）
- ❌ 指望 self-consistency 修「数量判断不清」⇒ 数量必须靠定位而非重试
- ❌ 在 Qwen2.5-VL + vLLM 上直接依赖 json_schema（已知 bug，先验证）

---

## 8. 全部信息源

**核心论文**
- CAD2Program — <https://arxiv.org/abs/2412.11892> ｜ [主页](https://manycore-research.github.io/CAD2Program) ｜ [代码](https://github.com/manycore-research/CAD2Program) ｜ [解读](https://www.alphaxiv.org/abs/2412.11892)
- Ortho2CAD — <https://arxiv.org/abs/2607.08891> ｜ [代码](https://github.com/AdityaJoglekar/Ortho2CAD)
- From Drawings to Decisions — <https://arxiv.org/abs/2506.17374>
- Fine-Tuning VLM for Engineering Drawing Info Extraction (Florence-2) — <https://arxiv.org/abs/2411.03707>
- CropVLM — <https://arxiv.org/abs/2511.19820>
- Image Tiling for High-Resolution Reasoning — <https://arxiv.org/abs/2512.11167>
- Img2CAD — <https://arxiv.org/abs/2410.03417>
- Survey on Monocular Metric Depth Estimation — <https://arxiv.org/abs/2501.11841>
- SpatialVLM — <https://spatial-vlm.github.io> ｜ [CVPR'24](https://arxiv.org/abs/2412.18145)
- PairTally — <https://arxiv.org/abs/2509.13939> ｜ [代码](https://github.com/bbvisual/PairTally_Benchmark)
- FloorplanQA — <https://arxiv.org/abs/2507.07644> ｜ [项目页](https://OldDelorean.github.io/FloorplanQA/)
- From Concept to Manufacturing (MIT DeCoDe) — <https://arxiv.org/abs/2311.12668> ｜ [vlms4design](https://decode.mit.edu/projects/vlms4design)
- Qwen2-VL（任意分辨率原理）— <https://arxiv.org/abs/2409.12191> ｜ [博客](https://qwenlm.github.io/blog/qwen2-vl)
- Qwen2.5-VL 博客 — <https://qwenlm.github.io/blog/qwen2.5-vl>
- InternVL3 — <https://arxiv.org/abs/2504.10479> ｜ InternVL3.5 — <https://arxiv.org/abs/2508.18265>
- MiniCPM-V 4.5 — <https://arxiv.org/abs/2509.18154>
- PaddleOCR-VL — <https://arxiv.org/abs/2510.14528>
- Generating Structured Outputs from Language Models — <https://arxiv.org/abs/2501.10868>

**数据集**
- FloorPlanCAD — <https://floorplancad.github.io> ｜ <https://huggingface.co/datasets/Voxel51/FloorPlanCAD>
- ArchCAD-400K — <https://arxiv.org/abs/2503.22346> ｜ <https://huggingface.co/datasets/jackluoluo/ArchCAD> ｜ [主页](https://archiai-lab.github.io/ArchCAD.github.io)
- CADSpotting — <https://arxiv.org/abs/2412.07377>
- SketchGraphs — <https://github.com/PrincetonLIPS/SketchGraphs>
- ABC Dataset — <https://deep-geometry.github.io/abc-dataset>
- DeepCAD / CAD-Recode — <https://huggingface.co/datasets/filapro/cad-recode>
- Img2CAD (ABC-mono, KOCAD) — <https://huggingface.co/datasets/qq456cvb/img2cad-dataset>

**模型 / 工具**
- Qwen3-VL-8B-Instruct — <https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct> ｜ <https://github.com/qwenlm/qwen3-vl>
- Qwen2.5-VL-7B-Instruct — <https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct>
- InternVL3 / 3.5 — <https://huggingface.co/OpenGVLab/InternVL3-8B> ｜ <https://huggingface.co/OpenGVLab/InternVL3_5-8B> ｜ <https://github.com/OpenGVLab/InternVL>
- MiniCPM-V — <https://github.com/OpenBMB/MiniCPM-V> ｜ <https://huggingface.co/openbmb/MiniCPM-V-4.6>
- Florence-2 — <https://huggingface.co/microsoft/Florence-2-large> ｜ [微调指南](https://huggingface.co/blog/finetune-florence2)
- vLLM structured outputs — <https://docs.vllm.ai/en/latest/features/structured_outputs> ｜ [bug #13038](https://github.com/vllm-project/vllm/issues/13038) ｜ [bug #15236](https://github.com/vllm-project/vllm/issues/15236)
- mlx-vlm max_pixels 问题 — <https://github.com/Blaizzy/mlx-vlm/issues/1175>
- PaddleOCR — <https://github.com/PADDLEPADDLE/PaddleOCR>