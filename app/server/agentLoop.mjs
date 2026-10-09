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
export async function runAgentLoop(opts) {
  const { intent, images, visionResult, draftId, roomId, roomName, token, mcpBaseUrl, aiConfig, onStep, history } = opts;
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

  // 2. 构建系统提示
  const systemPrompt = `你是家具 CAD 的 AI 装配 Agent。用户说出意图后，你调用 MCP 工具在 draft 草稿里搭建柜体。

规则：
- 所有写操作只进 draft，不碰 live。${currentDraftId ? `继续使用 draft ${currentDraftId}。` : '没有 draft 时工具会自动创建。'}
- 先理解意图，拆成工具调用。每步只调一个工具，看结果再决定下一步。
- 一排连续的厨房地柜、吊柜，先分别创建独立柜体模块，再按地柜排、吊柜排分别调用 cad.create_assembly 组成柜组；连接只描述相邻模块关系。
- 组合只用于整体展示/操作，不代表把多个柜箱合成一只柜，也不自动生成连续台面、共享顶板或 CNC 开孔；不要合并柜体模块尺寸或板件。
- 工具报错时读错误信息，调整参数重试。同一问题最多重试 3 轮，修不好就停下说明原因。
- 完成后调用 cad.validate 确认 0 错误。
- 不要编造数据：尺寸不确定就问用户，不要猜。
${roomId ? `- 当前工作区房间为「${roomName || roomId}」（roomId=${roomId}）；新建柜体默认放在此房间，除非用户明确指定其他房间。\n` : ''}

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
    const aiMsg = await callAiWithTools(aiConfig, messages, agentTools);

    // AI 说完了（没有工具调用）→ 成功
    if (!aiMsg.tool_calls || aiMsg.tool_calls.length === 0) {
      const summary = aiMsg.content || '完成';
      return { ok: true, steps, summary, draftId: currentDraftId, rounds: round };
    }

    // 执行工具调用（目前只处理第一个，简单起见）
    const tc = aiMsg.tool_calls[0];
    const toolName = tc.function.name;
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
         'cad.delete_object', 'cad.create_assembly', 'cad.validate'].includes(toolName)) {
      toolArgs.draftId = currentDraftId;
    }

    const step = { round, tool: toolName, args: toolArgs, ok: false };
    const result = await callMcpTool(mcpBaseUrl, token, toolName, toolArgs);

    if (result.ok) {
      step.ok = true;
      step.result = result.data;
      // 记录 draftId
      if (result.data?.draftId) currentDraftId = result.data.draftId;
      consecutiveFailures = 0; // 成功清零
    } else {
      step.ok = false;
      step.error = result.error;
      step.code = result.code;
      consecutiveFailures++;
    }
    steps.push(step);
    if (onStep) onStep(step);

    // 把工具结果喂回 AI
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [tc],
    });
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify(result.ok ? result.data : { error: result.error, code: result.code }),
    });

    // 连续 3 次失败 → 停下，尝试清理 draft（回滚半截变更）
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      // 回滚：删除本轮创建的 draft，避免脏数据残留
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
        summary: `连续 3 次失败，已回滚。最后错误：${result.error}。请检查参数或换个说法。`,
        draftId: null,
        rounds: round,
      };
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
