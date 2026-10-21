/**
 * ══════════════════════════════════════════════════════════════════════
 *  批次A · A1 验收：本地删除必须真正落库（且防空覆盖保护不能被误伤）
 *
 *  背景（已复现的事故）：
 *    用户在网页端删掉最后一个柜体 → PUT /api/workspace 返回 200，
 *    但云端仍是旧数据。根因是 syncClientProject 里的"防空覆盖"闸：
 *      const incomingIsEmpty = project.cabinets.length === 0 && currentSnap.cabinets.length > 0;
 *      if ((clientHasLocalEdits === false || (incomingIsEmpty && !force)) && liveModelVersion > 0) {
 *        return { ok: true, unchanged: true, hydratedFromServer: true, ... };  // 静默回滚
 *      }
 *    它把「用户主动删空」当成「本地没加载完」一起回滚了。
 *
 *  这套断言直接调 WorkspaceStore.syncClientProject（不经 HTTP），
 *  每条都要求能从红变绿（见 verify:sync-delete-mutations 的变异思路，
 *  本次采用手工变异验证，结论记录在 task-4 的完成报告中）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
import { WorkspaceStore } from '../src/workspace/workspace.ts';
import { emptyProject, createCabinet, rectRoom } from '../src/core/docFactory.ts';
import { hashProjectSnapshot } from '../server/projectHash.mjs';
import { writeFileAtomic } from '../server/writeQueue.mjs';

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

const TMP = mkdtempSync(join(tmpdir(), 'furnicad-a1-sync-'));
const WS_PATH = join(TMP, 'workspace.json');

function makeStore(): WorkspaceStore {
  return WorkspaceStore.create({
    filePath: WS_PATH,
    rules,
    persist: (c: string) => writeFileAtomic(WS_PATH, c),
    projectHash: hashProjectSnapshot,
    owner: 'test-owner',
    account: 'test-owner',
    // 从"裸空项目"起步：没有任何房间与柜体，等价于刚建好的工作区
    project: emptyProject({ ruleSetId: 'factory_default_v1' }),
  });
}

/** 造一份「1 个房间 + n 台柜体」的项目，模拟浏览器端的真实模型。 */
function projectWithCabinets(n: number): Project {
  const p = emptyProject({ ruleSetId: 'factory_default_v1' });
  const room = rectRoom({ name: '厨房', x: 0, y: 0, w: 4000, h: 3000, id: 'room_kitchen' });
  p.rooms.push(room);
  /**
   * Unit/backUnit ID 必须在项目内全局唯一（否则 CommandBus 直接判只读）。
   * createCabinet 的 takenUnitIds 就是唯一 ID 的印章：每造一台就把它的分区
   * id 累积进去，下一台才不会又拿到 unit_001。
   */
  const takenUnitIds = new Set<string>();
  for (let i = 0; i < n; i++) {
    const cab = createCabinet({
      id: `cab_${i + 1}`,
      name: `柜${i + 1}`,
      roomId: room.id,
      x: 100 + i * 900,
      y: 100,
      rules,
      params: { width: 800, height: 2000, depth: 600 },
      takenUnitIds,
    });
    for (const unit of cab.layout.units) takenUnitIds.add(unit.id);
    p.cabinets.push(cab);
  }
  return p;
}

/** 从磁盘重新读一遍，确认是真落库而不是只在内存里改了。 */
function cabinetsOnDisk(): number {
  const env = JSON.parse(readFileSync(WS_PATH, 'utf8')) as { project?: { cabinets?: unknown[] } };
  return env.project?.cabinets?.length ?? -1;
}

const store = makeStore();

section('① 增加 2 台柜体 → 云端必须 2 台');
{
  const r = await store.syncClientProject(projectWithCabinets(2), {
    clientHasLocalEdits: true,
    expectedLiveVersion: 0,
    reason: '验收：新增 2 台柜体',
  });
  ok('① 首次同步被接受（ok:true）且未被注水回滚',
    r.ok === true && r.hydratedFromServer === false,
    JSON.stringify({ ok: r.ok, hydrated: r.ok ? r.hydratedFromServer : undefined }));
  ok('① 云端柜体数 = 2，liveModelVersion = 1',
    r.ok === true && r.project.cabinets.length === 2 && store.getLiveModelVersion() === 1,
    r.ok ? `cabinets=${r.project.cabinets.length}, v=${store.getLiveModelVersion()}` : '');
  ok('① 落盘文件里也是 2 台（不是只改内存）', cabinetsOnDisk() === 2, `disk=${cabinetsOnDisk()}`);
}

section('② 删掉 1 台 → 云端必须 1 台');
{
  const r = await store.syncClientProject(projectWithCabinets(1), {
    clientHasLocalEdits: true,
    expectedLiveVersion: 1,
    reason: '验收：删除 1 台柜体',
  });
  ok('② 删除被接受（ok:true、unchanged:false、未注水）',
    r.ok === true && r.unchanged === false && r.hydratedFromServer === false,
    r.ok ? JSON.stringify({ unchanged: r.unchanged, hydrated: r.hydratedFromServer }) : '');
  ok('② 云端柜体数 = 1，liveModelVersion = 2',
    r.ok === true && r.project.cabinets.length === 1 && store.getLiveModelVersion() === 2,
    r.ok ? `cabinets=${r.project.cabinets.length}, v=${store.getLiveModelVersion()}` : '');
  ok('② 落盘文件里也是 1 台', cabinetsOnDisk() === 1, `disk=${cabinetsOnDisk()}`);
}

section('③ 删到 0 台 → 云端必须是 0 台（这条修复前是红的）');
{
  const r = await store.syncClientProject(projectWithCabinets(0), {
    clientHasLocalEdits: true,
    expectedLiveVersion: 2,
    reason: '验收：删除最后一台柜体',
  });
  ok('③ 删空被接受（ok:true 且**没有**被注水回滚）',
    r.ok === true && r.hydratedFromServer === false,
    r.ok ? JSON.stringify({ unchanged: r.unchanged, hydrated: r.hydratedFromServer }) : JSON.stringify(r));
  ok('③ 返回体里的柜体数 = 0（如实反映，不撒谎）',
    r.ok === true && r.project.cabinets.length === 0,
    r.ok ? `cabinets=${r.project.cabinets.length}` : '');
  ok('③ WorkspaceStore 的 live 快照柜体数 = 0',
    store.getState().cabinets.length === 0, `live=${store.getState().cabinets.length}`);
  ok('③ 落盘文件里也是 0 台（真的落库了）', cabinetsOnDisk() === 0, `disk=${cabinetsOnDisk()}`);
  ok('③ liveModelVersion 单调 +1（=3），删除也是一次真实提交',
    store.getLiveModelVersion() === 3, `v=${store.getLiveModelVersion()}`);
}

section('④ 删空后必须能靠"再来一次同步"恢复（undo 不被闸门卡死）');
{
  const r = await store.syncClientProject(projectWithCabinets(2), {
    clientHasLocalEdits: true,
    expectedLiveVersion: 3,
    reason: '验收：撤销删除，恢复 2 台柜体',
  });
  ok('④ 删空之后重新同步 2 台仍被接受（闸门没有锁死/没有粘滞）',
    r.ok === true && r.hydratedFromServer === false && r.project.cabinets.length === 2,
    r.ok ? `cabinets=${r.project.cabinets.length}, hydrated=${r.hydratedFromServer}` : JSON.stringify(r));
}

section('⑤ 防空覆盖保护不能被误伤（clientHasLocalEdits:false + 空项目 + 云端有数据）');
{
  const before = store.getLiveModelVersion();
  const naked = emptyProject({ ruleSetId: 'factory_default_v1' });
  const r = await store.syncClientProject(naked, {
    clientHasLocalEdits: false,
    expectedLiveVersion: before,
    reason: '验收：空本地浏览器连接（声明无本地编辑）',
  });
  ok('⑤ 仍走注水保护：hydratedFromServer === true 且 unchanged === true',
    r.ok === true && r.hydratedFromServer === true && r.unchanged === true,
    r.ok ? JSON.stringify({ hydrated: r.hydratedFromServer, unchanged: r.unchanged }) : JSON.stringify(r));
  ok('⑤ 云端 2 台柜体没有被空本地冲掉，版本号也没有虚增',
    r.ok === true && r.project.cabinets.length === 2 && store.getLiveModelVersion() === before,
    r.ok ? `cabinets=${r.project.cabinets.length}, v=${store.getLiveModelVersion()} (before=${before})` : '');
  ok('⑤ 落盘文件仍是 2 台（保护必须真的不动盘）', cabinetsOnDisk() === 2, `disk=${cabinetsOnDisk()}`);
}

section('⑥ 完全没声明 clientHasLocalEdits 时，裸空项目仍按"未初始化"注水');
{
  const before = store.getLiveModelVersion();
  const r = await store.syncClientProject(emptyProject({ ruleSetId: 'factory_default_v1' }), {
    expectedLiveVersion: before,
    reason: '验收：裸空项目（没有任何客户端声明）',
  });
  ok('⑥ 裸空项目（无编辑声明）仍被注水保护拦下',
    r.ok === true && r.hydratedFromServer === true && r.project.cabinets.length === 2,
    r.ok ? JSON.stringify({ hydrated: r.hydratedFromServer, cabinets: r.project.cabinets.length }) : JSON.stringify(r));
}

section('⑦ 乐观锁没被动过：基线落后 + 未声明 force ⇒ WORKSPACE_VERSION_CONFLICT');
{
  const before = store.getLiveModelVersion();
  const r = await store.syncClientProject(projectWithCabinets(1), {
    clientHasLocalEdits: true,
    expectedLiveVersion: before - 1,
    reason: '验收：故意用过时基线覆盖',
  });
  ok('⑦ 过时基线被拒（ok:false + code=WORKSPACE_VERSION_CONFLICT）',
    r.ok === false && r.code === 'WORKSPACE_VERSION_CONFLICT',
    JSON.stringify(r.ok ? { ok: r.ok } : { ok: r.ok, code: r.code }));
  ok('⑦ 被拒时云端柜体仍是 2 台（拒绝 ≠ 静默覆盖）',
    r.project.cabinets.length === 2 && cabinetsOnDisk() === 2,
    `returned=${r.project.cabinets.length}, disk=${cabinetsOnDisk()}`);
}

section('⑧ 用户显式 force（冲突界面点"用本地覆盖云端"）仍然优先');
{
  const before = store.getLiveModelVersion();
  const r = await store.syncClientProject(projectWithCabinets(1), {
    clientHasLocalEdits: true,
    expectedLiveVersion: before - 1,
    force: true,
    reason: '验收：用户在冲突界面显式选择覆盖云端',
  });
  ok('⑧ force 时即使基线落后也接受，且真的把云端改成 1 台',
    r.ok === true && r.project.cabinets.length === 1 && cabinetsOnDisk() === 1,
    r.ok ? `cabinets=${r.project.cabinets.length}, disk=${cabinetsOnDisk()}` : JSON.stringify(r));
}

section('⑨ 冲突界面"用本地覆盖云端" + 本地恰好是空 ⇒ 也必须真的清空（force 不能被注水保护吃掉）');
{
  /**
   * 这是 A1 修复的另一半：冲突弹窗里用户明确选了"用本地版本覆盖云端"，
   * 但那一刻本地可能恰好是空项目（例如刚删完）。若注水保护连 force 也拦，
   * 那个按钮就会在本该生效的场景下静默失效 —— 与本次要修的"删除被吞掉"是同一类事故。
   */
  const before = store.getLiveModelVersion();
  ok('⑨ 前置：云端此刻确实有柜体（不然这条断言没有意义）',
    store.getState().cabinets.length > 0, `live=${store.getState().cabinets.length}`);
  const r = await store.syncClientProject(emptyProject({ ruleSetId: 'factory_default_v1' }), {
    clientHasLocalEdits: true,
    expectedLiveVersion: before,
    force: true,
    reason: '验收：用户在冲突界面选择用本地（空）覆盖云端',
  });
  ok('⑨ force + 空项目被接受且没有被注水回滚',
    r.ok === true && r.hydratedFromServer === false,
    r.ok ? JSON.stringify({ hydrated: r.hydratedFromServer, unchanged: r.unchanged }) : JSON.stringify(r));
  ok('⑨ force + 空项目真的把云端清成 0 台（落盘也一致）',
    r.ok === true && r.project.cabinets.length === 0 && cabinetsOnDisk() === 0,
    r.ok ? `cabinets=${r.project.cabinets.length}, disk=${cabinetsOnDisk()}` : JSON.stringify(r));
}

section('⑩ force 必须压过 clientHasLocalEdits:false（这正是冲突按钮真实发出的组合）');
{
  /**
   * App.tsx 的 forceOverwriteServerOnConflict() 调 syncLocalToServer(true)，
   * 而 clientHasLocalEdits 是按"本地模型 vs 最后一次确认的云端指纹"算的 ——
   * 用户在冲突弹窗点"用本地覆盖云端"时，本地**完全可能**恰好等于云端指纹
   * （于是算出 false，因为"没有本地编辑"），此时发出去的就是 force:true + false。
   *
   * 所以 force 的优先级必须高于 clientHasLocalEdits:false 那条分支，
   * 否则"覆盖云端"按钮在这种组合下静默失效。
   */
  const seed = await store.syncClientProject(projectWithCabinets(2), {
    clientHasLocalEdits: true,
    expectedLiveVersion: store.getLiveModelVersion(),
    reason: '验收：为 ⑩ 准备云端 2 台柜体',
  });
  ok('⑩ 前置：云端确有 2 台柜体',
    seed.ok === true && store.getState().cabinets.length === 2, `live=${store.getState().cabinets.length}`);
  const before = store.getLiveModelVersion();
  const r = await store.syncClientProject(emptyProject({ ruleSetId: 'factory_default_v1' }), {
    clientHasLocalEdits: false,
    expectedLiveVersion: before,
    force: true,
    reason: '验收：冲突界面用本地（空）覆盖云端 —— force 与 clientHasLocalEdits:false 同时出现',
  });
  ok('⑩ force:true + clientHasLocalEdits:false + 空项目 ⇒ 仍被接受（force 赢）',
    r.ok === true && r.hydratedFromServer === false,
    r.ok ? JSON.stringify({ hydrated: r.hydratedFromServer, unchanged: r.unchanged }) : JSON.stringify(r));
  ok('⑩ 云端真的被清成 0 台（落盘一致）—— 说明 force 分支优先级高于"声明无本地编辑"',
    r.ok === true && r.project.cabinets.length === 0 && cabinetsOnDisk() === 0,
    r.ok ? `cabinets=${r.project.cabinets.length}, disk=${cabinetsOnDisk()}` : JSON.stringify(r));
}

rmSync(TMP, { recursive: true, force: true });

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
