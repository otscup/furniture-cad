/**
 * ══════════════════════════════════════════════════════════════════════
 *  Agent 循环编排器（内置 AI Agent 模式）
 *
 *  ── 设计 ──
 *   用户意图 → AI（走 AI_MODEL 网关，function calling）→ 调 MCP 工具 →
 *   失败则 AI 读错重试（最多 3 轮）→ validate 校验 → 返回步骤 + 总结
 *
 *  ── 复用 ──
 *   · MCP 工具：经 localhost HTTP 调 /mcp，100% 复用既有代码、鉴权、审计
 *   · Vision：复用 /api/ai/vision 链路
 *   · AI 网关：复用 AI_BASE_URL / AI_API_KEY / AI_MODEL 配置
 *   · 确定性后端：不动（几何、校验器原样）
 *
 *  ── 不变量 ──
 *   · Agent 只决定"调哪个工具、传什么参数、错了怎么修"，不碰几何计算
 *   · 3 轮修不好就停，把错误原样抛给用户，不硬编
 *   · 每步调用和结果都记录，前端可折叠展示
 * ══════════════════════════════════════════════════════════════════════
 */

const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_TOTAL_STEPS = 15;

/**
 * MCP 工具定义（给 AI 看的 function calling schema）。
 * 从 MCP 的 tools/list 动态获取，保证与实际一致。
 */
export async function getMcpToolSchemas(mcpBaseUrl, token) {
  const r = await fetch(`${mcpBaseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`获取 MCP 工具列表失败：${j.error.message}`);
  return j.result.tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  }));
}

/**
 * 调用 MCP 工具（经 localhost HTTP）。
 */
export async function callMcpTool(mcpBaseUrl, token, toolName, args) {
  const r = await fetch(`${mcpBaseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const j = await r.json();
  if (j.error) {
    return { ok: false, error: j.error.message, code: j.error.code };
  }
  // MCP 返回 content 数组，取第一个 text
  const text = j.result?.content?.[0]?.text ?? '';
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: true, data: { raw: text } };
  }
}

/**
 * 调用 AI（OpenAI 兼容的 function calling）。
 */
async function callAiWithTools(aiConfig, messages, tools) {
  const { baseUrl, apiKey, model, timeoutMs } = aiConfig;
  const payload = {
    model,
    messages,
    tools: tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    })),
    tool_choice: 'auto',
    temperature: 0.2,
  };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs ?? 120000),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`AI 调用失败 HTTP ${r.status}：${t.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.choices[0].message;
}

/**
 * Agent 主循环。
 *
 * @param opts.intent 用户意图（文字）
 * @param opts.images 图片数组 [{dataUrl, mode, name}]（可选，Agent 直接看图）
 * @param opts.visionResult vision 识别结果（可选，已识别好的结构化数据）
 * @param opts.draftId 继续的 draft（可选）
 * @param opts.roomId / opts.roomName 当前工作区房间（可选；新建柜体未明确指定房间时使用）
 * @param opts.token 用户 Bearer token（调 MCP 用）
 * @param opts.mcpBaseUrl MCP 地址（如 http://127.0.0.1:8787）
 * @param opts.aiConfig { baseUrl, apiKey, model, timeoutMs }
 * @param opts.onStep 步骤回调（流式推送给前端，可选）
 */
function summarizeProjectContext(project, activeRoomId) {
  if (!project || typeof project !== 'object') return '';
  const rooms = Array.isArray(project.rooms) ? project.rooms : [];
  const cabinets = Array.isArray(project.cabinets) ? project.cabinets : [];
  const lines = ['当前工作区空间与柜体摘要（可直接引用，无需额外调 get_state）：'];
  for (const r of rooms) {
    let dimStr = '无墙体';
    if (Array.isArray(r.walls) && r.walls.length > 0) {
      const xs = r.walls.flatMap((w) => [w.start?.x ?? 0, w.end?.x ?? 0]);
      const ys = r.walls.flatMap((w) => [w.start?.y ?? 0, w.end?.y ?? 0]);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      dimStr = `${Math.round(maxX - minX)}×${Math.round(maxY - minY)}mm (世界坐标 X:${Math.round(minX)}..${Math.round(maxX)}, Y:${Math.round(minY)}..${Math.round(maxY)})`;
    }
    const rCabs = cabinets.filter((c) => c.roomId === r.id);
    lines.push(`- 房间「${r.name}」(roomId=${r.id}${r.id === activeRoomId ? '，当前选中房间' : ''})：${dimStr}，现有 ${rCabs.length} 台柜体`);
    if (r.id === activeRoomId && rCabs.length > 0) {
      for (const c of rCabs) {
        const p = c.params || {};
        lines.push(`  · 柜体「${c.name}」(cabinetId=${c.id})：${p.cabinetType || 'base'}，${p.width}×${p.height}×${p.depth}mm，离地=${p.mountHeight ?? 0}mm，位置=(${c.placement?.x ?? 0},${c.placement?.y ?? 0})`);
      }
    }
  }
  return lines.join('\n');
}

export async function runAgentLoop(opts) {
  const { intent, images, visionResult, draftId, roomId, roomName, workspaceProject, token, mcpBaseUrl, aiConfig, onStep, history } = opts;
  const steps = [];
  let currentDraftId = draftId || null;
  let round = 0;

  // 1. 获取 MCP 工具定义
  const tools = await getMcpToolSchemas(mcpBaseUrl, token);
  // Agent 只需要写工具 + validate，过滤掉导出和 apply（apply 由用户确认）
  const agentTools = tools.filter(t =>
    ['cad.create_cabinet', 'cad.place_cabinet', 'cad.update_object',
     'cad.delete_object', 'cad.validate', 'cad.get_state',
     'cad.create_room', 'cad.draw_wall', 'cad.submit_proposal',
     'cad.duplicate_object', 'cad.create_assembly', 'cad.list_drafts'].includes(t.name)
  );

  /**
   * ── 工具名净化（2026-10-20 实测发现的真缺陷）──
   *
   * ★ 现象：/api/ai/agent 在本地网关（gpt-load）上**从来跑不通**，
   *   一律报 `HTTP 400 invalid_request_error`，且错误信息里不带任何细节。
   *
   * ★ 实测定位（逐个工具单发）：
   *   `{"name":"cad.get_state"}`  → 400
   *   `{"name":"cad_get_state"}`  → 200
   *   即：**网关不接受工具名里的点号**。而本项目的 MCP 工具全部命名为
   *   `cad.xxx`（这是 MCP 侧的既定契约，不能改）。
   *
   * ★ 修法：发给模型时把 `.` 换成 `_`，收回来再**映射回原名**。
   *   映射表是本函数内的单次事实，不外泄、不落盘 ——
   *   模型侧看到的永远是 `cad_create_cabinet`，MCP 侧收到的永远是
   *   `cad.create_cabinet`，两边都不用改。
   *
   * ★ 为什么不改 MCP 的工具名：`cad.get_state` 等名字是 P10.0 的契约，
   *   已被 verify:mcp 的 127 条断言、外部 MCP 客户端、文档全部引用。
   *   为了让一个网关能跑而改对外契约，是本末倒置。
   */
  const toolNameToWire = new Map();   // 原名 -> 线上名
  const wireToToolName = new Map();   // 线上名 -> 原名
  for (const t of agentTools) {
    const wire = t.name.replace(/\./g, '_');
    /**
     * ── 撞名检测（2026-10-21 补）──
     *
     * `cad.a_b` 与 `cad_a.b` 净化后都是 `cad_a_b`。
     * 一旦撞名，第二个会覆盖第一个，表现为**模型调了 A、系统执行了 B** ——
     * 而且不报错、日志里看起来一切正常。这类失败模式比崩溃危险得多。
     *
     * 当前 18 个工具（cad.get_state / cad.create_cabinet / …）不会撞，
     * 但这是将来加工具时最容易踩的一脚，所以在源头拦死：
     * 宁可启动时就炸，也不要悄悄调错工具。
     */
    const existing = wireToToolName.get(wire);
    if (existing !== undefined && existing !== t.name) {
      throw new Error(
        `Agent 工具名净化冲突：${t.name} 与 ${existing} 都会映射成 ${wire}，` +
        '模型将无法区分这两个工具（可能调 A 执行 B）。请重命名其中一个 MCP 工具，或调整净化规则。'
      );
    }
    toolNameToWire.set(t.name, wire);
    wireToToolName.set(wire, t.name);
  }
  const agentToolsForWire = agentTools.map((t) => ({
    ...t,
    name: toolNameToWire.get(t.name) ?? t.name,
  }));

  // 2. 构建系统提示
  const projectContextText = summarizeProjectContext(workspaceProject, roomId);
  const systemPrompt = `你是家具 CAD 的 AI 装配 Agent。用户说出意图后，你调用 MCP 工具在 draft 草稿里搭建柜体。

规则：
- 所有写操作只进 draft，不碰 live。${currentDraftId ? `继续使用 draft ${currentDraftId}。` : '没有 draft 时工具会自动创建。'}
- 先理解意图，拆成工具调用。支持按顺序创建柜体、调整参数、建立组合。
- 新建房间（cad.create_room）只需传 name 与 w、h（x、y 可省略或传 0，系统会自动将新房间排布在已有房间右侧，绝不重叠）。
- 新建柜体（cad.create_cabinet）默认放在当前房间「${roomName || roomId}」（roomId=${roomId}）；若不传 x、y，系统会自动在当前房间内寻找不撞墙、不重叠的贴墙位置（且吊柜 mountHeight>0 会自动对齐在地柜正上方）。
- 一排连续的厨房地柜、吊柜，先分别创建独立柜体模块，再按地柜排、吊柜排分别调用 cad.create_assembly 组成柜组；连接只描述相邻模块关系。
- 组合只用于整体展示/操作，不代表把多个柜箱合成一只柜，也不自动生成连续台面、共享顶板或 CNC 开孔；不要合并柜体模块尺寸或板件。
- 当用户同时提供两张图（效果图 + 尺寸图）时：以【效果图】确定柜体外观布局（地柜/吊柜排布、门扇、抽屉、开放格、电器位），以【尺寸图】上的毫米标注数值作为精确宽/高/深尺寸！
- 工具报错时读错误信息，调整参数重试。同一问题最多重试 3 轮，修不好就停下说明原因。
- 完成后调用 cad.validate 确认 0 错误。
- 【设计目标 intentRequest】当用户的诉求是**方向性的**（"柜子别跑到屋外去""别挡门窗""要贴墙"），而不是要你立刻改某只柜时，
  你可以在**最终回答**里附一个 JSON 代码块表达设计目标，系统会把它作为**待用户确认**的意图：
  \`\`\`json
  {"intentRequest": {"goal": "room-inside", "scope": {"kind": "cabinet", "cabinetId": "cab_001"}, "statement": "柜体必须完整落在房间内"}}
  \`\`\`
  可用 goal（只能用这些）：
  - room-inside：柜体完整落在房间内（别跑到屋外/压到墙上）
  - near-opening / opening-clear：柜体不挡门窗洞口
  - wall-contact：柜体贴墙
  - standalone：柜体与其它柜体不相接
  - door-swing-clear / kitchen-workflow / storage-priority / circulation-priority：**暂不支持**，提了也只会被告知"没有构造器"，别反复提
  **绝对不要**在 intentRequest 里写 x / y / rotation / wallId —— 摆法由系统算。
  意图**不会自动生效**：用户要在界面上点确认才算数，所以你提完就如实告诉他"已提为待确认目标"，不要宣称已经改好。
  如果用户只是让你建柜子/改尺寸，**不要**提 intentRequest。
${roomId ? `- 当前工作区房间为「${roomName || roomId}」（roomId=${roomId}）；新建柜体默认放在此房间，除非用户明确指定其他房间。\n` : ''}${projectContextText ? `${projectContextText}\n` : ''}

${visionResult ? `Vision 识别结果（用户发的图里看到的）：\n${JSON.stringify(visionResult, null, 2)}\n` : ''}${images && images.length > 0 ? `用户附了 ${images.length} 张图（${images.map(i => `${i.name || '图片'}:${i.mode === 'dimension' ? '尺寸图' : '效果图'}`).join('、')}），请结合图片理解意图。尺寸图上的标注数字优先采用。\n` : ''}
当前 draft：${currentDraftId ?? '无（工具会自动创建）'}`;

  const messages = [
    { role: 'system', content: systemPrompt },
  ];
  // 历史对话（上下文）：让 Agent 理解追问
  if (history && Array.isArray(history) && history.length > 0) {
    messages.push({
      role: 'system',
      content: `以下是之前的对话历史（最近 ${history.length} 轮），用于理解用户的追问和指代：\n` +
        history.map((h, i) =>
          `[${i + 1}] ${h.role === 'user' ? '用户' : 'AI'}：${h.text}${h.agentSummary ? `\n    （${h.agentSummary}）` : ''}`
        ).join('\n'),
    });
  }
  // 用户消息：文字 + 图片（OpenAI vision 格式）
  if (images && images.length > 0) {
    const content = [{ type: 'text', text: intent }];
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: intent });
  }

  // 3. 主循环
  // ── 修正：MAX_ROUNDS 原误用为"总调用次数"，导致 3 次成功调用后判失败。
  // 现在：consecutiveFailures 记连续失败（成功清零），totalSteps 防无限循环。
  let consecutiveFailures = 0;
  let totalSteps = 0;

  while (totalSteps < MAX_TOTAL_STEPS) {
    round++;
    totalSteps++;
    const aiMsg = await callAiWithTools(aiConfig, messages, agentToolsForWire);

    // AI 说完了（没有工具调用）→ 成功
    if (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0) {
      const summary = aiMsg.content || '完成';
      /**
       * ── 从 Agent 的最终回答里捞设计意图（2026-10-20）──
       *
       * ★ 这一段修的是"**提示词承诺了、链路却没接**"：
       *   buildSystemPrompt() 从 P9.3 起就告诉模型"你可以额外输出 intentRequest"，
       *   但界面走的是 **本 Agent 通道**（/api/ai/agent），不是 /api/ai/plan ——
       *   所以那段承诺在真实使用中**从未兑现**，模型写了也被丢。
       *
       * 做法：在最终回答里找 JSON 块，取其中的 intentRequest，交给调用方校验。
       * **这里不做校验**（形状规则只有一份：shared/aiContract.mjs 的
       * validateIntentRequest，由 server.mjs 调用），这里只负责"找出来"。
       */
      const found = extractIntentRequest(aiMsg.content);
      return {
        ok: true,
        steps,
        summary,
        draftId: currentDraftId,
        rounds: round,
        ...(found ? { intentRequestRaw: found } : {}),
      };
    }

    // 支持单轮单次或多次 tool_calls，顺序执行并自动串联 currentDraftId
    const toolCalls = aiMsg.tool_calls;
    messages.push({
      role: 'assistant',
      content: aiMsg.content ?? null,
      tool_calls: toolCalls,
    });
    let lastError = '';
    for (const tc of toolCalls) {
      /**
       * 把模型回传的**线上名**映射回真正的 MCP 工具名（见上方 toolNameToWire 的说明）。
       * 映射缺失时原样使用 —— 那说明模型编了一个不存在的工具，
       * 后面的 MCP 调用会如实报"未知工具"，比在这里静默丢弃好。
       */
      const wireName = tc.function.name;
      const toolName = wireToToolName.get(wireName) ?? wireName;
      let toolArgs;
      try {
        toolArgs = JSON.parse(tc.function.arguments);
      } catch {
        toolArgs = {};
      }
      // Agent 模型有时会省略房间字段；没有明确房间目标时，将前端当前房间设为工具参数，
      // 避免 cad.create_cabinet 的通用 MCP 默认值把柜体放到项目第一个房间。
      if (toolName === 'cad.create_cabinet' && roomId && !toolArgs.roomId && !toolArgs.roomName) {
        toolArgs.roomId = roomId;
        if (roomName) toolArgs.roomName = roomName;
      }
      // 透传 draftId
      if (currentDraftId && !toolArgs.draftId &&
          ['cad.create_cabinet', 'cad.place_cabinet', 'cad.update_object',
           'cad.delete_object', 'cad.create_assembly', 'cad.duplicate_object',
           'cad.submit_proposal', 'cad.create_room', 'cad.draw_wall', 'cad.validate'].includes(toolName)) {
        toolArgs.draftId = currentDraftId;
      }

      const step = { round, tool: toolName, args: toolArgs, ok: false };
      const result = await callMcpTool(mcpBaseUrl, token, toolName, toolArgs);

      if (result.ok) {
        step.ok = true;
        step.result = result.data;
        if (result.data?.draftId) currentDraftId = result.data.draftId;
        step.draftId = currentDraftId;
        consecutiveFailures = 0;
      } else {
        step.ok = false;
        step.error = result.error;
        step.code = result.code;
        step.draftId = currentDraftId;
        lastError = result.error;
        consecutiveFailures++;
      }
      steps.push(step);
      if (onStep) {
        try {
          await onStep(step, currentDraftId);
        } catch {
          /* 回调失败不影响主流程 */
        }
      }

      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result.ok ? result.data : { error: result.error, code: result.code }),
      });

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (currentDraftId) {
          try {
            await callMcpTool(mcpBaseUrl, token, 'cad.discard_draft', { draftId: currentDraftId });
            steps.push({ round, tool: 'cad.discard_draft', args: { draftId: currentDraftId }, ok: true, result: { note: '已回滚半截变更' } });
          } catch {
            /* 回滚失败不掩盖主错误 */
          }
          currentDraftId = null;
        }
        return {
          ok: false,
          steps,
          summary: `连续 3 次失败，已回滚。最后错误：${lastError}。请检查参数或换个说法。`,
          draftId: null,
          rounds: round,
        };
      }
    }
  }

  // 达到总步数上限（AI 一直在调工具但不说完成）
  return {
    ok: false,
    steps,
    summary: `已执行 ${MAX_TOTAL_STEPS} 步仍未完成，AI 似乎陷入循环。请简化意图后重试。`,
    draftId: currentDraftId,
    rounds: round,
  };
}

/**
 * 从一段自然语言 + 可能的 JSON 里捞出 intentRequest。
 *
 * ── 为什么不能简单 JSON.parse ──
 *   Agent 的最终回答通常是"人话 + 一个 JSON 代码块"，甚至只有人话。
 *   直接 parse 一定失败；用正则硬抠字段又会在嵌套对象上出错。
 *   所以这里做三级尝试：原样 → 代码围栏 → 第一个平衡花括号。
 *
 * **只负责找出来，不校验** —— 形状规则只有一份（shared/aiContract.mjs 的
 * validateIntentRequest），由 server.mjs 调用。这里若私自放宽/收紧，
 * 就会出现"两处判定"，迟早不一致。
 *
 * @returns {object|null} 原始（未校验）的 intentRequest
 */
function extractIntentRequest(content) {
  const text = String(content ?? '');
  if (!text) return null;
  // 只在明确出现这个词时才尝试解析，避免对每条回答都做一次 JSON 提取
  if (!text.includes('intentRequest')) return null;
  const parsed = safeParseJsonAnywhere(text);
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed.intentRequest;
  return raw && typeof raw === 'object' ? raw : null;
}

/** 尽力从一个可能夹着代码围栏/说明文字的回答里解析出 JSON 对象。 */
function safeParseJsonAnywhere(text) {
  try { return JSON.parse(text); } catch { /* 继续试 */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) {
    try { return JSON.parse(fence[1]); } catch { /* 继续试 */ }
  }
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}
