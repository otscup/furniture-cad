/**
 * ══════════════════════════════════════════════════════════════════════
 *  批次A · A2 / A3 验收：实时草稿在主画布可见 + 事件流有界、去重、诚实的翻译
 *
 *  为什么断言打在这里而不是打 .tsx：
 *   A2/A3 真正会出错的判据都是**纯函数**（哪种视图下草稿带可见、SSE 载荷怎么翻译成
 *   一条事件、列表怎么截断去重）。这些逻辑住在 src/ui/liveAgentLog.ts，
 *   RoomWorkspace.tsx / App.tsx 只是消费它。判据放在纯函数里 → 能直接 import 断言，
 *   临时改坏判据，下面的断言立刻变红（本项目的硬规矩）。
 *
 *  覆盖：
 *   ① A2 草稿带在 sheet / 3d / plan 三种主画布视图下都必须可见（原先只有 sheet 有）；
 *   ② A2 草稿带必须一眼可辨"不是正式图"（标签写明尚未入库 + 视图相关的提示）；
 *   ③ A3 事件倒序、最多 50 条；
 *   ④ A3 同一步事件重复推送只记一次；
 *   ⑤ A3 去重键集合不会无限膨胀；
 *   ⑥ A3 翻译诚实：没有项目内容的事件不编造、失败步骤必须标成失败。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGENT_EVENT_LIMIT,
  appendAgentEvent,
  agentEventFromSsePayload,
  liveDraftStageMode,
} from '../src/ui/liveAgentLog.ts';
import type { AgentStreamEvent, AgentStreamEventInput } from '../src/ui/liveAgentLog.ts';

const APP = join(import.meta.dirname, '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: unknown, detail = ''): void {
  if (cond === true) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n${t}`);
}

const VIEWS = ['sheet', '3d', 'plan'] as const;

section('① A2 · 实时草稿带在三种主画布视图下都必须可见');
{
  for (const view of VIEWS) {
    const mode = liveDraftStageMode(view);
    ok(`① ${view} 视图下草稿带是钉住的（pinned=true）`, mode.pinned === true, JSON.stringify(mode));
  }
  ok('① 只有 sheet 视图额外展开整张四视图，3D/平面视图不塞一张无关大图',
    liveDraftStageMode('sheet').inlineSheet === true
    && liveDraftStageMode('3d').inlineSheet === false
    && liveDraftStageMode('plan').inlineSheet === false,
    JSON.stringify(VIEWS.map((v) => [v, liveDraftStageMode(v).inlineSheet])));
}

section('② A2 · 草稿带必须一眼可辨"这是草稿，不是已入库的正式图"');
{
  for (const view of VIEWS) {
    const mode = liveDraftStageMode(view);
    ok(`② ${view} 视图标签写明"尚未入库"`, mode.bandLabel.includes('尚未入库'), mode.bandLabel);
    ok(`② ${view} 视图提示都点名"不会改动你的正式模型"`, mode.hint.includes('不会改动你的正式模型'), mode.hint);
  }
  ok('② 三种视图的提示各不相同（不是复制粘贴的同一句废话）',
    new Set(VIEWS.map((v) => liveDraftStageMode(v).hint)).size === 3);
}

section('③ A3 · 事件流倒序且最多 50 条');
{
  const seen = new Set<string>();
  let events: AgentStreamEvent[] = [];
  for (let i = 0; i < AGENT_EVENT_LIMIT + 20; i++) {
    const input: AgentStreamEventInput = { key: `step-${i}`, kind: 'tool', text: `第 ${i} 步`, tool: 'cad.create_cabinet', toolOk: true };
    events = appendAgentEvent(events, input, seen, 1_700_000_000_000 + i).events;
  }
  ok(`③ 连推 ${AGENT_EVENT_LIMIT + 20} 条后仍然只有 ${AGENT_EVENT_LIMIT} 条`,
    events.length === AGENT_EVENT_LIMIT, `len=${events.length}`);
  ok('③ 最新的一条在最前面（倒序）',
    events[0]!.id === `step-${AGENT_EVENT_LIMIT + 19}`,
    `first=${events[0]!.id}`);
  ok('③ 最旧的被挤出的是第 20 条（截尾而不是截头）',
    events[events.length - 1]!.id === 'step-20',
    `last=${events[events.length - 1]!.id}`);
  ok('③ AGENT_EVENT_LIMIT 就是 50（写进契约的常量，不是随手数字）', AGENT_EVENT_LIMIT === 50, String(AGENT_EVENT_LIMIT));
}

section('④ A3 · 同一步事件重复推送只记一次（App 与 AIPanel 订阅的是同一条 SSE）');
{
  const seen = new Set<string>();
  const input: AgentStreamEventInput = { key: 'dup-key', kind: 'tool', text: 'cad.create_cabinet ✓', tool: 'cad.create_cabinet', toolOk: true };
  const first = appendAgentEvent([], input, seen, 1);
  const second = appendAgentEvent(first.events, input, seen, 2);
  ok('④ 第一次被记下', first.appended === true && first.events.length === 1);
  ok('④ 同一键第二次被丢弃（不重复计数、不重复渲染）',
    second.appended === false && second.events.length === 1,
    `appended=${second.appended}, len=${second.events.length}`);
  const different = appendAgentEvent(second.events, { ...input, key: 'dup-key-2' }, seen, 3);
  ok('④ 换一个键仍然能记下（去重不等于把后续步骤都吃掉）',
    different.appended === true && different.events.length === 2);
  ok('④ 同一个数组实例被原样返回时不做无谓重渲染', second.events === first.events);
}

section('⑤ A3 · 去重键集合有上界（长会话不会把内存吃掉）');
{
  const seen = new Set<string>();
  let events: AgentStreamEvent[] = [];
  for (let i = 0; i < AGENT_EVENT_LIMIT * 4 + 10; i++) {
    events = appendAgentEvent(events, { key: `k${i}`, kind: 'draft', text: `x${i}` }, seen, i).events;
  }
  ok('⑤ 灌入远超上限的键之后，键集合被清过（不会无限增长）',
    seen.size <= AGENT_EVENT_LIMIT * 4,
    `seen=${seen.size}`);
  ok('⑤ 但已经展示的事件条数仍然守在上限内', events.length === AGENT_EVENT_LIMIT, `len=${events.length}`);
  /**
   * ⑤b 是这套判据最容易写错的地方：键集合触顶后如果直接 clear()，
   * 列表里已经展示的 50 行按键就全丢了 —— 断线重连重推同一批步骤时，
   * 用户会在面板里看到重复行，以为 Agent 重复执行了。
   * 断言：触顶重播种之后，**当前可见的每一条**都仍然在键集合里。
   */
  ok('⑤ 键集合触顶重播种后，当前可见的每一条仍被记住（不会出现可见重复行）',
    events.every((event) => seen.has(event.id)),
    `visible=${events.length}, remembered=${seen.size}`);
  /**
   * 重推要拿**列表最旧的那条**（最不容易被"最近才加过的键"顺手保住）来试：
   * 触顶重播种如果只保住了尾部几条，这里立刻露馅。
   */
  const replay = appendAgentEvent(events, {
    key: events[events.length - 1]!.id,
    kind: 'draft',
    text: '重连后的重复推送',
  }, seen, 999);
  ok('⑤ 重连重推已展示过的步骤 ⇒ 被去重挡下（面板不会凭空多一行）',
    replay.appended === false && replay.events.length === events.length,
    `appended=${replay.appended}, len=${replay.events.length}`);
}

section('⑥ A3 · 翻译必须诚实（不编造、失败要标失败）');
{
  const withProject = agentEventFromSsePayload({
    type: 'draft.updated',
    draftId: 'draft_1',
    revision: 3,
    project: { cabinets: [{}, {}, {}] },
  });
  ok('⑥ draft.updated 带 project → 记一条草稿事件并如实报柜数',
    withProject !== null && withProject.kind === 'draft' && withProject.text.includes('3 台柜体'),
    JSON.stringify(withProject));

  const noProject = agentEventFromSsePayload({ type: 'draft.updated', draftId: 'draft_1' } as never);
  ok('⑥ 服务端降级推送（只有 draftId 没有项目）→ **不编造**事件，返回 null',
    noProject === null, JSON.stringify(noProject));

  const failedStep = agentEventFromSsePayload({
    type: 'agent.step',
    draftId: 'draft_1',
    draftProject: { cabinets: [{}] },
    step: { tool: 'cad.create_cabinet', ok: false, round: 2 },
  });
  ok('⑥ 失败的工具调用被标成失败（toolOk=false，文本带 ✗）',
    failedStep !== null && failedStep.toolOk === false && failedStep.text.includes('✗'),
    JSON.stringify(failedStep));
  ok('⑥ 步骤轮次被带出来（用户能看到"第 N 步"）',
    failedStep !== null && failedStep.round === 2, JSON.stringify(failedStep));

  const okStep = agentEventFromSsePayload({
    type: 'agent.step',
    draftId: 'draft_1',
    draftProject: { cabinets: [{}] },
    step: { tool: 'cad.create_cabinet', ok: true, round: 1 },
  });
  ok('⑥ 成功的工具调用文本带 ✓，且与失败步骤的键不同（各自成条）',
    okStep !== null && okStep.text.includes('✓') && okStep.key !== failedStep?.key);

  const init = agentEventFromSsePayload({
    type: 'init',
    latestDraft: { draftId: 'draft_9', revision: 7, project: { cabinets: [{}, {}] } },
  });
  ok('⑥ init 事件说出"连上时草稿里已有几台柜体"',
    init !== null && init.kind === 'init' && init.text.includes('2 台柜体'), JSON.stringify(init));

  const deleted = agentEventFromSsePayload({ type: 'draft.deleted', draftId: 'draft_9' });
  ok('⑥ draft.deleted 记一条删除事件',
    deleted !== null && deleted.kind === 'draft-deleted' && deleted.text.includes('draft_9'), JSON.stringify(deleted));

  const unknown = agentEventFromSsePayload({ type: 'workspace.updated', liveModelVersion: 4 });
  ok('⑥ 与 Agent 无关的事件（workspace.updated）不进事件流',
    unknown === null, JSON.stringify(unknown));
}

section('⑦ 接线：判据必须真的被 RoomWorkspace / App 消费（不是写完就忘）');
{
  const roomWs = readFileSync(join(APP, 'src', 'ui', 'RoomWorkspace.tsx'), 'utf8');
  const app = readFileSync(join(APP, 'src', 'ui', 'App.tsx'), 'utf8');
  ok('⑦ RoomWorkspace 用的是 liveDraftStageMode 的判据，而不是把 view 名写死',
    roomWs.includes('liveDraftStageMode(centerViewMode)') && roomWs.includes('draftStage.inlineSheet'));
  ok('⑦ 草稿带被真的渲染出来（data-testid=workspace-live-draft-band）',
    roomWs.includes('data-testid="workspace-live-draft-band"'));
  ok('⑦ 事件流面板被挂进主画布', roomWs.includes('<LiveAgentLog'));
  ok('⑦ App 的 SSE 回调走的是 agentEventFromSsePayload 的翻译',
    app.includes('agentEventFromSsePayload(payload)'));
  ok('⑦ App 把事件流传给了 RoomWorkspace', app.includes('agentEvents={agentEvents}'));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
