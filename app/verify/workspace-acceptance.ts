/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S1 专项验收（Workspace + 并发写保护）
 *
 *  覆盖方案验收标准的 A（Workspace）/ B（CommandBus）/ C（Draft 隔离）/ D（并发）。
 *  真实验收，不是静态扫描：
 *   · Workspace 创建/加载/版本单调/逐值一致；
 *   · 所有模型写只经现有 CommandBus（含 WRITABLE/DENY 白名单，越权路径被拒）；
 *   · draft 与 live 物理隔离、apply 乐观锁、stale 结构化拒绝（DRAFT_STALE）；
 *   · 并发：读-改-写负载下串行队列保证无丢写、失败不吞后续。
 *
 *  变异版 verify/workspace-mutations.ts 会改坏本文件依赖的源码，
 *  要求本套件「跑完且判红」（失败数 > 0），以证明这些断言真的看得见事故。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, RuleSet, Command } from '../src/core/types.ts';
import { WorkspaceStore, DRAFT_STALE, type ApplyResult } from '../src/workspace/workspace.ts';
import { emptyProject, createCabinet, rectRoom } from '../src/core/docFactory.ts';
import { hashProjectSnapshot } from '../server/projectHash.mjs';
import { enqueueWrite, writeFileAtomic } from '../server/writeQueue.mjs';

const APP = join(import.meta.dirname, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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

const TMP = mkdtempSync(join(tmpdir(), 'furnicad-s1-'));
const WS_PATH = join(TMP, 'workspace.json');

function buildProject(): Project {
  const p = emptyProject({ ruleSetId: 'factory_default_v1' });
  const room = rectRoom({ name: '厨房', x: 0, y: 0, w: 4000, h: 3000, id: 'room_1' });
  p.rooms.push(room);
  const cab = createCabinet({
    id: 'cab_1',
    name: '柜A',
    roomId: 'room_1',
    x: 100,
    y: 100,
    rules,
    params: { width: 800, height: 2000, depth: 600 },
  });
  p.cabinets.push(cab);
  return p;
}

function makeStore(project?: Project): WorkspaceStore {
  return WorkspaceStore.create({
    filePath: WS_PATH,
    rules,
    persist: (c: string) => writeFileAtomic(WS_PATH, c),
    projectHash: hashProjectSnapshot,
    owner: 'test-owner',
    account: 'test-owner',
    project,
  });
}

function setWidthCmd(id: string, w: number): Command {
  return {
    op: 'cabinet.update',
    source: 'system',
    target: { kind: 'cabinet', id },
    changes: [{ path: 'params.width', op: 'set', value: w, unit: 'mm' }],
  } as Command;
}

const widthOf = (p: Project): number => (p.cabinets.find((c) => c.id === 'cab_1')!.params as { width: number }).width;

// ═══════════════════════════ A. Workspace ═══════════════════════════
section('A. Workspace 持久实体');
{
  const store = makeStore(buildProject());
  ok('A1. 新建 Workspace 成功（含稳定 workspaceId）', typeof store.workspaceId === 'string' && store.workspaceId.length > 0, store.workspaceId);
  ok('A2. 持有的 Semantic Model 与 core schema 一致（cab_1 在）', store.getState().cabinets.some((c) => c.id === 'cab_1'));
  ok('A3. liveModelVersion 初始可确定（=0）', store.getLiveModelVersion() === 0, store.getLiveModelVersion());

  // 触发一次落盘（execute 成功才 flush）
  const r = await store.execute(setWidthCmd('cab_1', 900));
  ok('A3b. 一次提交后 liveModelVersion 单调 +1（=1）', r.ok && store.getLiveModelVersion() === 1, store.getLiveModelVersion());

  // 从磁盘重新加载
  const loaded = WorkspaceStore.load({ filePath: WS_PATH, rules, persist: (c) => writeFileAtomic(WS_PATH, c), readRaw: () => readFileSync(WS_PATH, 'utf8'), projectHash: hashProjectSnapshot });
  ok('A4. 保存→重新加载后模型逐值一致（width=900）', loaded.getState().cabinets.find((c) => c.id === 'cab_1')!.params.width === 900);
  ok('A4b. 重新加载后 liveModelVersion 也还原（=1）', loaded.getLiveModelVersion() === 1, loaded.getLiveModelVersion());
  ok('A4c. 重新加载后 workspaceId 稳定', loaded.workspaceId === store.workspaceId);

  // A5 不存在第二套 Semantic Model 字段定义：文件信封只有 projectFile 字段 + 元数据
  const env = JSON.parse(readFileSync(WS_PATH, 'utf8')) as Record<string, unknown>;
  const allowed = new Set(['format', 'formatVersion', 'savedAt', 'project', 'workspaceId', 'owner', 'account', 'liveModelVersion', 'updatedAt']);
  const extra = Object.keys(env).filter((k) => !allowed.has(k));
  ok('A5. 信封仅含 projectFile 字段 + Workspace 元数据（无第二套模型 schema）', env.format === 'furniture-cad-project' && typeof env.project === 'object' && extra.length === 0, extra);
}

// ═══════════════════════════ B. CommandBus（服务端复用）══════════════════════════
section('B. 服务端写模型只经现有 CommandBus');
{
  const store = makeStore(buildProject());
  // 先落盘一次以便后续加载
  await store.execute(setWidthCmd('cab_1', 800));

  const r1 = await store.execute(setWidthCmd('cab_1', 1200));
  ok('B1. 服务端修改真实柜体参数成功（width=1200）', r1.ok && widthOf(store.getState()) === 1200, widthOf(store.getState()));
  ok('B2. 修改只经 CommandBus（live 与 bus 同源、版本已前进）', store.getLiveModelVersion() === 2);
  ok('B3. 派生校验与 core 一致（合法变更 0 blocking error）', r1.ok && r1.blockingErrors === 0, r1.blockingErrors);

  // B4 非法 Command 被拒
  const bad: Command = { op: 'this.op.does.not.exist', source: 'system', target: undefined, changes: [] } as Command;
  const rBad = await store.execute(bad);
  ok('B4. 非法 Command 被拒', rBad.ok === false, (rBad as { error?: string }).error);

  // B5 直接越权字段无法通过（DENY 白名单：panels 是派生层）
  const rogue: Command = {
    op: 'cabinet.update',
    source: 'system',
    target: { kind: 'cabinet', id: 'cab_1' },
    changes: [{ path: 'panels.foo', op: 'set', value: 1 }],
  } as Command;
  const rRogue = await store.execute(rogue);
  ok('B5. 越权字段（panels.*）经 CommandBus 白名单被拒', rRogue.ok === false, (rRogue as { error?: string }).error);
  ok('B5b. 越权写未穿透到模型（width 仍=1200）', widthOf(store.getState()) === 1200);
}

// ═══════════════════════════ C. Draft 隔离（乐观锁）══════════════════════════
section('C. Draft 隔离 + 乐观锁');
{
  const store = makeStore(buildProject());
  await store.execute(setWidthCmd('cab_1', 900)); // live = 1
  const N = store.getLiveModelVersion();

  const d1 = await store.createDraft('author');
  ok('C1. live 建立 version=N', N === 1);
  ok('C2. draft 从 base=N 开始', d1.baseModelVersion === N, d1.baseModelVersion);

  const dr1 = await store.draftExecute(d1.draftId, setWidthCmd('cab_1', 1500));
  ok('C3. draft 内修改模型成功', dr1.ok);
  ok('C4. live 仍保持原值（=900，draft 不碰 live）', widthOf(store.getState()) === 900, widthOf(store.getState()));
  ok('C5. draft 看到修改后的值（=1500）', widthOf(store.draftState(d1.draftId)!) === 1500);

  const f1 = store.getDraftFreshness(d1.draftId)!;
  const a1: ApplyResult = await store.applyDraft(d1.draftId, {
    draftId: d1.draftId, runId: f1.runId, revision: f1.revision, draftHash: f1.draftHash,
    localVersion: 0, remoteVersion: f1.liveModelVersion,
  });
  ok('C6. apply 且 live=N → 成功，version=N+1', a1.ok === true && (a1 as { newVersion: number }).newVersion === N + 1, JSON.stringify(a1));
  ok('C6b. apply 后 live 反映 draft 终态（=1500）', widthOf(store.getState()) === 1500);

  const d2 = await store.createDraft('author');
  ok('C7. 重新创建 draft base=N+1', d2.baseModelVersion === N + 1, d2.baseModelVersion);

  await store.execute(setWidthCmd('cab_1', 700)); // live 再前进 → N+2
  ok('C8. live 先发生修改 → version=N+2', store.getLiveModelVersion() === N + 2, store.getLiveModelVersion());

  const f2 = store.getDraftFreshness(d2.draftId)!;
  const a2: ApplyResult = await store.applyDraft(d2.draftId, {
    draftId: d2.draftId, runId: f2.runId, revision: f2.revision, draftHash: f2.draftHash,
    localVersion: 0, remoteVersion: f2.liveModelVersion,
  });
  ok('C9. 旧 draft（base=N+1）apply → 结构化 DRAFT_STALE 拒绝', a2.ok === false && a2.code === DRAFT_STALE, JSON.stringify(a2));
  ok('C10. 拒绝后 live 不变（仍=N+2，width=700）', store.getLiveModelVersion() === N + 2 && widthOf(store.getState()) === 700);
  ok('C10b. 拒绝后 draft 不被静默覆盖（仍可取）', store.getDraft(d2.draftId) !== null);

  const a3: ApplyResult = await store.applyDraft('nonexistent', {
    draftId: 'nonexistent', runId: 'run_nonexistent', revision: 0, draftHash: '0'.repeat(64),
    localVersion: 0, remoteVersion: store.getLiveModelVersion(),
  });
  ok('C11. 不存在的 draft apply → 结构化拒绝（非崩溃）', a3.ok === false && a3.code === DRAFT_STALE);
}

// ═══════════════════════════ D. 并发写保护（串行队列）══════════════════════════
section('D. 并发写保护（进程内串行写队列）');
{
  // 读-改-写负载：每个任务读当前计数 +1 再写回。串行队列保证无丢写；
  // 若队列被移除（变异），并发读会全部看到旧值 → 最终计数 < N（丢写）。
  const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

  async function concurrentCounter(path: string, n: number): Promise<number> {
    await Promise.all(
      Array.from({ length: n }, () =>
        enqueueWrite(path, async () => {
          await tick(); // 让出，放大并发重叠窗口（变异版会在此交错）
          const cur = JSON.parse(readFileSync(path, 'utf8')) as { count: number };
          cur.count += 1;
          await tick(); // 读与写之间再让出一次，确保无队列时读全重叠、写互相覆盖
          writeFileSync(path, JSON.stringify(cur));
        }),
      ),
    );
    return (JSON.parse(readFileSync(path, 'utf8')) as { count: number }).count;
  }

  const N = 25;
  const wsFile = join(TMP, 'ws-concurrent.json');
  writeFileSync(wsFile, JSON.stringify({ count: 0 }));
  const wsCount = await concurrentCounter(wsFile, N);
  ok('D1. Workspace 文件并发读-改-写无丢写（最终计数=N）', wsCount === N, wsCount);

  const acFile = join(TMP, 'accounts-concurrent.json');
  writeFileSync(acFile, JSON.stringify({ count: 0 }));
  const acCount = await concurrentCounter(acFile, N);
  ok('D2. 账号库文件并发读-改-写无丢写（最终计数=N）', acCount === N, acCount);

  // D3 失败隔离：一个写任务抛错，不应吞掉后续队列
  const isoFile = join(TMP, 'isolation.json');
  writeFileSync(isoFile, JSON.stringify({ ok: false }));
  await enqueueWrite(isoFile, async () => {
    throw new Error('boom');
  }).catch(() => {});
  await enqueueWrite(isoFile, async () => {
    writeFileSync(isoFile, JSON.stringify({ ok: true }));
  });
  ok('D3. 一个写失败不吞掉后续队列（后续写仍生效）', (JSON.parse(readFileSync(isoFile, 'utf8')) as { ok: boolean }).ok === true);
}

// ═══════════════════════════ 汇总 ═══════════════════════════
console.log(`\n══════════════════════════════════════════════════════`);
console.log(`  P10.0 S1 验收：通过 ${pass} / 失败 ${fail}`);
rmSync(TMP, { recursive: true, force: true });
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：Workspace 持久实体、CommandBus 复用、Draft 隔离、并发写保护均满足。');
