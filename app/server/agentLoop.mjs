import { deriveFocusFromHistory, renderFocusStack } from '../shared/focusStack.mjs';
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

import { recipeBlockFor } from '../shared/recipes.mjs';
import { renderProjectRules } from '../shared/ruleRetrieval.mjs';
import { renderSequenceHint } from '../shared/sequenceStore.mjs';



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
/**
 * 把一个分区的 kind 翻成人话（模型看得懂的说法）。
 * @param {string} kind
 * @returns {string}
 */
function describeUnitKind(kind) {
  switch (kind) {
    case 'hanging': return '挂衣区';
    case 'drawers': return '抽屉区';
    case 'appliance': return '电器位';
    case 'open': return '开放格';
    case 'shelves': return '层板格';
    default: return String(kind ?? '分区');
  }
}

/**
 * ── 当前方案摘要（方案四）──
 *
 * ★ 修的是「Agent 多轮对话会失忆」──
 *   上一版只给「有哪些柜、多大、什么类型」，模型于是：
 *     · 不知道某个柜子**里面分了几个格**，要再调一次 get_state 去看；
 *     · 不知道**上一轮自己刚改了什么**，于是把用户已经说过的事又做一遍
 *       （典型表现：改完宽度后用户说「再宽点」，它却又按第一次的尺寸重算）。
 *
 * ★ 补了两样东西 ──
 *   ① 每个柜的**分区结构**（几格、什么类型、有几门、有几抽屉）——
 *      免掉 get_state 的一次往返，而且 get_state 读的是 live 不是 draft，
 *      改了之后其实读不到最新状态。
 *   ② **上一轮改了什么**（从 history 里取）——
 *      让「再宽点」「刚才那个」这类指代有落点。
 *
 * @param {object} project 工作区项目
 * @param {string} activeRoomId 当前房间
 * @param {Array} history 对话历史（可选）
 * @returns {string}
 */
export function summarizeProjectContext(project, activeRoomId, history = []) {
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
        /**
         * ★ 2026-10-21 修：分区在 `cab.layout.units`，**不在** `cab.units`。
         *
         *   原来这里读 `c.units` —— 那个字段**根本不存在**
         *   （实测 `Array.isArray(cab.units) === false`），
         *   于是 units 恒为空数组 ⇒ **分区结构从来没进过提示词**。
         *   表现：模型说「我读不到当前分区的层板数」—— 它说的是事实。
         *
         *   修完之后，模型才能算「再加两层」这类**相对量**。
         */
        const layout = c.layout ?? {};
        const units = Array.isArray(layout.units) ? layout.units : [];
        const rows = Array.isArray(layout.rows) ? layout.rows : [];
        let unitStr = '';
        /**
         * ★ 顺序很重要：先判 rows，再判 units。
         *
         *   实测（2026-10-21）：多行柜的 layout 里**同时有** `units` 与 `rows`
         *   —— `units` 是第一行的副本（长度 1），`rows` 才是完整的行结构。
         *   所以先判 units 会永远命中那个「1 个分区」的副本，
         *   多行柜的真实结构就丢了（模型看不到第 2 行）。
         */
        if (rows.length > 0) {
          // 多行柜：分区在 rows[j].units 里
          const rowDesc = rows.map((row, ri) => {
            const us = Array.isArray(row.units) ? row.units : [];
            const ps = us.map((u) => {
              let s = describeUnitKind(u.kind);
              if (u.shelves && u.shelves.count) s += `/${u.shelves.count}层板`;
              if (u.drawers && u.drawers.count) s += `/${u.drawers.count}抽`;
              if (u.doors && u.doors.count) s += `/${u.doors.count}门`;
              if (u.rod && u.rod.count) s += '/挂衣杆';
              return s;
            });
            return `第${ri + 1}行(${ps.join('、') || '空'})`;
          });
          unitStr = `，上下 ${rows.length} 行（${rowDesc.join('，')}）`;
        } else if (units.length > 0) {
          const parts = units.map((u) => {
            let s = describeUnitKind(u.kind);
            if (u.doors && u.doors.count) s += `/${u.doors.count}门`;
            if (u.drawers && u.drawers.count) s += `/${u.drawers.count}抽`;
            if (u.shelves && u.shelves.count) s += `/${u.shelves.count}层板`;
            if (u.rod && u.rod.count) s += '/挂衣杆';
            if (u.appliance) s += '/' + (u.appliance.kind === 'fridge' ? '冰箱' : u.appliance.kind === 'washer' ? '洗衣机' : '电器');
            return s;
          });
          unitStr = `，${units.length} 个分区（${parts.join('、')}）`;
        }
        lines.push(`  · 柜体「${c.name}」(cabinetId=${c.id})：${p.cabinetType || 'base'}，${p.width}×${p.height}×${p.depth}mm，离地=${p.mountHeight ?? 0}mm，位置=(${c.placement?.x ?? 0},${c.placement?.y ?? 0})${unitStr}`);
      }
    }
  }
  /**
   * 上一轮改了什么 —— 让「再宽点」「刚才那个」有落点。
   *
   * 只取最近一轮带 agentSummary 的记录（更早的已经沉淀进上面的柜体列表了）。
   */
  const lastSummary = Array.isArray(history)
    ? [...history].reverse().find((h) => h && h.agentSummary && String(h.agentSummary).trim())
    : null;
  if (lastSummary) {
    lines.push(`上一轮你做的事：${String(lastSummary.agentSummary).trim()}`);
    lines.push('（用户这次的话可能是在那个基础上继续改，例如「再宽点」「刚才那个」。）');
  }
  return lines.join('\n');
}

/**
 * ── 重放一套操作序列 ──
 *
 * 全程在**新 draft** 里跑：
 *  · 不传 draftId，让 MCP 自动建一个新草稿；
 *  · 每一步都串上 draftId，后续步骤都落在同一个草稿里；
 *  · 任何一步失败就停，并且**丢弃这个草稿**（半截改动绝不能留）。
 *
 * @param {object} seq 序列记录 {steps:[{tool,args}]}
 * @param {object} ctx {mcpBaseUrl, token, roomId, roomName, onStep}
 * @returns {Promise<{ok:boolean, steps:Array, summary:string, draftId:string|null, discardError:string}>}
 */
export async function replaySequence(seq, ctx) {
  const { mcpBaseUrl, token, roomId, roomName, onStep } = ctx;
  const steps = [];
  let draftId = null;
  let lastError = '';

  for (const s of Array.isArray(seq?.steps) ? seq.steps : []) {
    if (!s || !s.tool) continue;
    const args = { ...(s.args ?? {}) };
    // 不带 draftId 起步 ⇒ MCP 自动建新草稿
    delete args.draftId;
    if (draftId) args.draftId = draftId;
    if (s.tool === 'cad.create_cabinet' && roomId && !args.roomId && !args.roomName) {
      args.roomId = roomId;
      if (roomName) args.roomName = roomName;
    }

    const result = await callMcpTool(mcpBaseUrl, token, s.tool, args);
    const step = { round: 0, tool: s.tool, args, ok: false, replayed: true };
    if (result.ok) {
      step.ok = true;
      step.result = result.data;
      if (result.data?.draftId) draftId = result.data.draftId;
      step.draftId = draftId;
    } else {
      step.ok = false;
      step.error = result.error;
      step.code = result.code;
      lastError = result.error;
      steps.push(step);
      if (onStep) {
        try { await onStep(step, draftId); } catch { /* 回调失败不影响主流程 */ }
      }
      /**
       * 失败：丢弃半截草稿。
       *
       * ★ 为什么不能只看 draftId ──
       *   第一步就失败时，MCP 那边已经建了草稿但**没回传 draftId**
       *   （失败响应里只有 error）。此时若只判 `if (draftId)`，
       *   草稿就漏在服务器上了 —— 用户界面上看不到，
       *   却又实实在在存在（会出现在草稿列表里）。
       *
       *   所以：拿不到 draftId 时，先 cad.list_drafts 找出最新的那个草稿，
       *   再丢它。拿不到列表就放弃（不猜 id，避免丢错别人的草稿）。
       */
      let discardError = '';
      let discardTarget = draftId;
      if (!discardTarget) {
        try {
          const listed = await callMcpTool(mcpBaseUrl, token, 'cad.list_drafts', {});
          const list = Array.isArray(listed?.data?.drafts) ? listed.data.drafts
            : Array.isArray(listed?.data) ? listed.data : [];
          if (list.length > 0) {
            const newest = [...list].sort((a, b) => (b.createdAt ?? b.at ?? 0) - (a.createdAt ?? a.at ?? 0))[0];
            const id = newest?.draftId ?? newest?.id;
            if (id) discardTarget = id;
          }
        } catch {
          /* 拿不到列表就不猜 id，避免丢错草稿 */
        }
      }
      if (discardTarget) {
        try {
          await callMcpTool(mcpBaseUrl, token, 'cad.discard_draft', { draftId: discardTarget });
        } catch (e) {
          discardError = String(e?.message ?? e);
        }
      }
      return {
        ok: false,
        steps,
        summary: '复用历史操作失败：' + lastError,
        draftId: null,
        discardError,
      };
    }
    steps.push(step);
    if (onStep) {
      try { await onStep(step, draftId); } catch { /* 回调失败不影响主流程 */ }
    }
  }

  return {
    ok: steps.length > 0,
    steps,
    summary: steps.length > 0
      ? '已按本项目上次的成功做法直接完成（' + steps.length + ' 步，未再调用模型）。'
      : '复用没有可重放的步骤。',
    draftId,
    discardError: '',
  };
}
/**
 * ── 工具失败时给模型的下一步建议（方案五）──
 *
 * ★ 修的是「原地重试」──
 *   之前失败时只把 error 原文回给模型。模型看到
 *   「width 超出上限 6000」，最常见的反应是**再发一次一模一样的调用**——
 *   因为报错里没有任何信息能告诉它该改成多少。
 *   连撞 3 次就耗尽 MAX_CONSECUTIVE_FAILURES，整轮作废。
 *
 * ★ 这里补的是「怎么改」──
 *   按错误码给出可执行的补救方向，模型才有机会一次改对。
 *   注意：这里**不重写** error 原文（原文里已经有合法值了），
 *   只补一个 hint 字段，两边信息都在。
 *
 * @param {string} error 错误原文
 * @param {string} code 错误码
 * @returns {string} 建议文本；无法判断时返回空串
 */
export function failureHint(error, code) {
  const e = String(error ?? '');
  switch (code) {
    case 'NO_CABINET':
      return '把 target.cabinetName 换成**实际存在的柜体名字**（可先调 cad.get_state 看有哪些柜子）；如果用户指的是刚建的那只，用它返回的名字。';
    case 'NO_UNIT':
      return '把 target.unit 补上：1 起的序号或分区昵称。';
    case 'NO_ROOM':
      return '项目里还没有房间。先调 cad.create_room 建一个，或在调用里带上 roomId / roomName。';
    case 'COMMAND_REJECTED':
      if (/重叠|碰撞|干涉|撞/.test(e)) {
        return '这个位置放不下。改用语义落位（cad.place_cabinet 交给 placement 引擎算位置），或先挪开冲突的柜子，不要硬给 x/y。';
      }
      if (/板材|幅面|放不下|超长/.test(e)) {
        return '这个尺寸超出板材幅面或工艺上限。把它改小一点（常见做法是拆成两个柜体，或减小 width/height），再调用。';
      }
      return '按错误信息里的提示改参数后重试一次；改不动就换一个做法。';
    case 'BAD_PARAM':
    case 'MISSING_PARAM':
    case 'EXTRA_PARAM':
      return '按错误信息里列出的合法值/参数形状改，**不要换动作**；同一动作最多改两次。';
    case 'DRAFT_STALE':
      return '这个 draft 已经不是最新的了。调 cad.list_drafts 看看有哪些可用的 draft，或者不要传 draftId 让它新建一个。';
    case 'UNKNOWN_TOOL':
      return '这个工具名不存在。只能用 cad.create_cabinet / cad.place_cabinet / cad.update_object / cad.delete_object / cad.create_room / cad.draw_wall / cad.create_assembly / cad.duplicate_object / cad.validate / cad.get_state / cad.list_drafts。';
    case 'INVALID_PARAMS':
      return '参数形状不对。按工具声明的 schema 重新组织参数（只放声明里有的键）。';
    default:
      if (/unknown|未知工具/i.test(e)) return '这个工具名不存在。只能用 cad.create_cabinet / cad.place_cabinet / cad.update_object / cad.delete_object / cad.create_room / cad.draw_wall / cad.create_assembly / cad.duplicate_object / cad.validate / cad.get_state / cad.list_drafts。';
      if (/重叠|碰撞|干涉/.test(e)) return '这个位置放不下。改用 cad.place_cabinet 的语义落位，或先挪开冲突的柜子。';
      return '';
  }
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Agent 系统提示词构造（P0-1 / P0-5，2026-10-21）
 *
 *  ── 为什么把它抽出来 ──
 *    此前这段在 runAgentLoop 内部，验收只能**扫源码**来判断
 *    「配方块有没有进提示词」—— 而源码扫描守不住重构：
 *    P0-1 把提示词拆成静态段+动态段后，扫 `recipeBlock ? recipeBlock +`
 *    立刻变红，但功能其实一点没坏。
 *
 *    抽成可 import 的函数后，验收能**真的构造出提示词**再检查内容。
 *    （与项目里 selectProjectRules / pickSequences 同一个套路：
 *    凡是「决定」散落在大函数里的，就提出来。）
 *
 *  ── 静态 / 动态的切分理由 ──
 *    网关（gpt-load）做**纯前缀匹配**：system 里只要有一处逐字变化，
 *    从变化点往后全部缓存不上。而 rulesBlock / recipeBlock / seqHint
 *    **每一轮都变** ⇒ 它们必须在静态规则**之后**。
 *
 *    实测：动态在开头 cached=0；动态在末尾 cached=1024。
 *
 * @param opts 注入内容
 * @returns { staticRules, dynamicContext, systemPrompt }
 *           systemPrompt = staticRules + '\n' + dynamicContext
 */
export function buildAgentSystemPrompt(opts = {}) {
  const {
    rulesBlock = '',
    recipeBlock = '',
    seqHint = '',
    roomId = '',
    roomName = '',
    projectContextText = '',
    visionResult = null,
    images = [],
    currentDraftId = null,
    focusText = '',
  } = opts;
  const staticRules = `你是家具 CAD 的 AI 装配 Agent。用户说出意图后，你调用 MCP 工具在 draft 草稿里搭建柜体。

规则：
- 所有写操作只进 draft，不碰 live。
- 先理解意图，拆成工具调用。支持按顺序创建柜体、调整参数、建立组合。
- 新建房间（cad.create_room）只需传 name 与 w、h（x、y 可省略或传 0，系统会自动将新房间排布在已有房间右侧，绝不重叠）。
- 新建柜体（cad.create_cabinet）默认放在当前房间；若不传 x、y，系统会自动在当前房间内寻找不撞墙、不重叠的贴墙位置（且吊柜 mountHeight>0 会自动对齐在地柜正上方）。
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
  如果用户只是让你建柜子/改尺寸，**不要**提 intentRequest。`;
  const dynamicContext = [
    focusText,
    rulesBlock,
    recipeBlock,
    seqHint,
    roomId ? `- 当前工作区房间为「${roomName || roomId}」（roomId=${roomId}）；新建柜体默认放在此房间，除非用户明确指定其他房间。` : '',
    projectContextText,
    visionResult ? `Vision 识别结果（用户发的图里看到的）：\n${JSON.stringify(visionResult, null, 2)}` : '',
    images && images.length > 0 ? `用户附了 ${images.length} 张图（${images.map(i => `${i.name || '图片'}:${i.mode === 'dimension' ? '尺寸图' : '效果图'}`).join('、')}），请结合图片理解意图。尺寸图上的标注数字优先采用。` : '',
    currentDraftId ? `继续使用 draft ${currentDraftId}。` : '没有 draft 时工具会自动创建。',
    `当前 draft：${currentDraftId ?? '无（工具会自动创建）'}`,
  ].filter(Boolean).join('\n');
  const systemPrompt = staticRules + '\n' + dynamicContext;
  return { staticRules, dynamicContext, systemPrompt };
}

export async function runAgentLoop(opts) {
  const { intent, images, visionResult, draftId, roomId, roomName, workspaceProject, token, mcpBaseUrl, aiConfig, onStep, history, projectRules } = opts;
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
  const projectContextText = summarizeProjectContext(workspaceProject, roomId, history);
  /**
   * ── 标准做法（配方库）注入（方案一）──
   *
   * ★ 为什么 Agent 通道尤其需要 ──
   *   提示词裁剪把建柜从 6 步降到 2 步、33.9s 降到 13.6s，证明
   *   「告诉它怎么走」比「让它自己摸索」有效得多。
   *   而 Agent 通道每一步都要跟模型往返一次，步数就是钱。
   *
   * ★ 注入位置 ──
   *   放在「规则」段之前：配方是**做法**，规则是**约束**，
   *   做法先讲清楚，规则再兜底。配方末尾明说与用户冲突时以用户为准。
   */
  // ★ Agent 通道调的是 **MCP 工具**（cad.*），配方要按 agent 口径渲染
  const recipeBlock = recipeBlockFor(intent, { channel: 'agent' });
  /**
   * ── 纠正记忆注入（2026-10-21）──
   *
   * ★ 这条通道之前**完全没有**纠正记忆 ──
   *   /api/ai/plan 与 /api/ai/design 两条通道都带了 projectRules，
   *   而界面上真正在用的是本 Agent 通道 —— 于是用户在管理后台写的规矩，
   *   Agent 一条都看不到，每次都得在对话里重说。
   *   能力建了但没接到在用的那条路上（本项目的典型失效模式）。
   *
   * 注入位置：配方之后、规则之前。
   *   优先级是「硬约束（规则）> 项目约定（纠正记忆）> 通用做法（配方）」，
   *   但措辞上要让模型知道：这些约定是**这个项目已确认过的**，优先于通用常识。
   */
  const rulesBlock = renderProjectRules(projectRules);
  /**
   * ── 相似序列当范例（方案三的第二档）──
   *
   * 没有完全一致的历史序列时，把**上次做过的类似操作**给模型当范例。
   * 模型会照着抄，步数更少、参数更稳。
   *
   * ★ 与「完全重放」的区别 ──
   *   完全重放 = 0 次模型调用，直接执行；
   *   相似范例 = 模型仍然跑，但手里有一份本项目已验证过的做法。
   *   后者是前者的降级方案，命中不了完全重放时兜底。
   */
  const seqHint = renderSequenceHint(opts.similarSeq);

  /**
   * 提示词构造抽到 buildAgentSystemPrompt（见该函数的注释）——
   * 目的是让验收能**真的构造出提示词**来检查内容，
   * 而不是扫源码找字符串（源码扫描守不住重构：P0-1 拆分提示词时它就误报过）。
   */
  /**
   * ★ 焦点（2026-10-21）—— 上一轮动过哪只柜、改成多少。
   *
   *   跨轮指代（「再宽点」「第一格」「那个抽屉」）全靠它：
   *   没有它，模型每轮都要从自由文本里重新推断焦点 ⇒ 它飘
   *   （NLU 评测卡实测多轮场景 pass^3 只有 75%，是三个场景里最弱的）。
   *
   *   有了它，「再加 200」这种相对量能直接用**当前绝对值**换算成目标值。
   */
  const focusFacts = deriveFocusFromHistory(history, workspaceProject);
  const focusText = renderFocusStack(focusFacts);

  const { systemPrompt } = buildAgentSystemPrompt({
    rulesBlock,
    recipeBlock,
    seqHint,
    roomId,
    roomName,
    projectContextText,
    visionResult,
    images,
    focusText,
    currentDraftId,
  });

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

  /**
   * ── 操作序列复用（方案三）──
   *
   * ★ 命中时**一次模型调用都不用** ──
   *   同一句话问两遍（或换个说法问同一件事），第二次直接重放上次的成功序列。
   *   实测「建柜」一次 13.6s，其中模型思考占大头 —— 重放能把这部分全省掉。
   *
   * ★ 安全底线 ──
   *   ① 只重放白名单里的工具（**删除类一律不重放**：重放删除的语义依赖
   *      当时的项目状态，现在重放很可能删错东西，而且不可逆）；
   *   ② 重放在**新的 draft** 里跑，失败就丢弃重来，**绝不碰 live**；
   *   ③ 命中判定用**完全一致**的指纹（意图文本规范化后相同 + 动作族相同），
   *      保证重放出来的参数真的适用于这次需求。
   *
   * ★ 失败就退回去让模型做 ──
   *   重放失败不是错误，是"这条路走不通"。此时把重放过程记成步骤，
   *   丢弃 draft，照常走模型 —— 用户拿到的仍是正确结果，只是慢一点。
   */
  if (opts.replaySeq) {
    const replay = await replaySequence(opts.replaySeq, {
      mcpBaseUrl, token, roomId, roomName, onStep,
    });
    if (replay.ok) {
      return {
        ok: true,
        steps: replay.steps,
        summary: replay.summary,
        draftId: replay.draftId,
        rounds: 1,
        reused: true,
      };
    }
    // 重放失败 → 丢弃半截 draft，照常走模型
    if (replay.discardError) {
      steps.push({ round: 0, tool: 'cad.discard_draft', args: { draftId: replay.draftId }, ok: false, error: replay.discardError });
    }
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
        content: JSON.stringify(
          result.ok
            ? result.data
            : { error: result.error, code: result.code, hint: failureHint(result.error, result.code) },
        ),
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