/**
 * P9.5 变异测试（§十八）—— 把源码**真的改坏**，确认判据真的会红
 *
 *  ── 为什么不能只写"我们验过了" ──
 *    §十 的 `49–58` 是"判据能不能红"的**自检**（把坏样本喂给检查器）。
 *    它证明的是**检查器**有效，不证明**被检查的代码**真的在受约束。
 *    这里做的是另一件事：**物理改坏生产代码**，看验收脚本会不会红 ——
 *    红 = 这条约束真的被钉住了；不红 = 判据是瞎的（比失败更危险）。
 *
 *  ── 与 `verify:ai-planner` 的分工 ──
 *    验收脚本只**读**源码；本文件**写**源码（改坏 → 跑 → 还原）。
 *    所以它**不进 `verify:all`**：跑得慢（13 次全量验收 + 1 次 tsc），
 *    而且不该被任何人顺带触发。用 `npm run verify:ai-planner-mutation` 显式跑。
 *
 *  ── 安全（写源码的工具必须自己兜底）──
 *    · 改之前先把原文写一份 `<file>.bak95` 到磁盘，`finally` 里从备份还原并删除备份；
 *    · **启动时先扫残留备份并还原**（万一上次被强杀，这次进来第一件事就是恢复现场）；
 *    · 锚点必须**唯一命中**，否则夹具自己报"夹具失效"（防止变异打偏还报绿）；
 *    · 跑完对比"原文 === 现文"（逐字节），不一致直接判失败。
 *
 *  ── 本机工程注意（实测踩到的）──
 *    · `spawnSync` / `execSync` 在本机一律 **EBUSY**（沙箱拦同步建进程）→ 只用异步 `execFile`；
 *    · 源文件是 **CRLF**：锚点按 LF 书写，匹配前归一化，写回时还原原行尾。
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const NODE = process.execPath;
const TSC = join(APP, 'node_modules', 'typescript', 'bin', 'tsc');
const ACCEPT = join(APP, 'verify', 'ai-planner-acceptance.ts');
const PROBE = join(APP, 'src', 'core', 'planner', '__mutateprobe.ts');

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: APP, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ err, out: `${stdout ?? ''}\n${stderr ?? ''}` })
    );
  });
}

async function runAcceptance() {
  const { out } = await run(NODE, [ACCEPT]);
  const m = /通过 (\d+) \/ 失败 (\d+)/.exec(out);
  const reds = out
    .split(/\r?\n/)
    .filter((l) => /^\s{2}- /.test(l))
    .map((l) => l.replace(/^\s{2}- /, '').trim());
  return { pass: m ? Number(m[1]) : -1, fail: m ? Number(m[2]) : -1, reds };
}

async function runTsc() {
  const { err, out } = await run(NODE, [TSC, '--noEmit'], { GOMEMLIMIT: '1500MiB' });
  const errs = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l));
  return { exit: err ? 1 : 0, errs };
}

const F_CONTRACT = 'shared/aiContract.mjs';
const F_MODEL = 'src/core/planner/model.ts';
const F_PLAN = 'src/core/planner/plan.ts';
const F_INDEX = 'src/core/planner/index.ts';
const F_BUDGET = 'src/ai/actionBudget.ts';

const BAK_SUFFIX = '.bak95';
const TOUCHED = [F_CONTRACT, F_MODEL, F_PLAN, F_INDEX, F_BUDGET].map((f) => join(APP, f));

// ── 启动兜底：上一次若被强杀在"改坏"与"还原"之间，这里第一件事就是恢复现场 ──
for (const p of TOUCHED) {
  if (existsSync(p + BAK_SUFFIX)) {
    writeFileSync(p, readFileSync(p + BAK_SUFFIX, 'utf8'), 'utf8');
    unlinkSync(p + BAK_SUFFIX);
    console.log(`⚠ 检测到上次未清理的变异备份，已还原：${p}`);
  }
}
if (existsSync(PROBE)) {
  unlinkSync(PROBE);
  console.log(`⚠ 检测到上次未清理的类型探针，已删除：${PROBE}`);
}

/** 10 条 §十八 指定变异 + 2 条补充（类型层 / 写入口）。锚点一律 LF 书写。 */
const MUTATIONS = [
  { id: 'V1', name: 'Planner 输出 x/y（契约放过坐标）', file: F_CONTRACT,
    from: "const PLANNER_GEOMETRY_KEYS = new Set([\n  'x',\n  'y',\n", to: "const PLANNER_GEOMETRY_KEYS = new Set([\n",
    expect: ['3.', '49.'] },
  { id: 'V2', name: 'Planner 输出 rotation（契约放过旋转）', file: F_CONTRACT,
    from: "  'rotation',\n  'angle',\n", to: '',
    expect: ['32.', '50.'] },
  { id: 'V3', name: 'Planner 直接生成 placement（契约放过 placement(s)）', file: F_CONTRACT,
    from: "  'path',\n  'placements',\n  'placement',\n  'geometry',\n  'coordinates',\n  'wallId',\n",
    to: "  'path',\n  'geometry',\n  'coordinates',\n  'wallId',\n",
    expect: ['5.', '51.'] },
  { id: 'V4', name: '绕过 Resolver（规划层自己改坐标）', file: F_PLAN,
    from: '  const set = generateCandidateLayouts(project, candidateRequest);\n',
    to: '  const set = generateCandidateLayouts(project, candidateRequest);\n  for (const c of set.candidates) for (const pl of c.placements) { pl.resolved.x = pl.resolved.x + 5; }\n',
    expect: ['13.', '12.'] },
  { id: 'V5', name: 'AI 修改 score（契约多出 score/total 键）', file: F_CONTRACT,
    from: "export const PLANNER_REQUEST_KEYS = ['scope', 'intentIds', 'cabinetIds', 'generationGoals', 'maxCandidates'];",
    to: "export const PLANNER_REQUEST_KEYS = ['scope', 'intentIds', 'cabinetIds', 'generationGoals', 'maxCandidates', 'score', 'total'];",
    expect: ['11.', '6b.'] },
  { id: 'V6', name: '用 inactive preference（把 entries 一律当 active 转发）', file: F_PLAN,
    from: '  const scores = scoreCandidateLayoutSet(project, set, entries);',
    to: "  const scores = scoreCandidateLayoutSet(project, set, entries.map((e) => ({ ...e, status: 'active' })));",
    expect: ['27.', '28.'] },
  { id: 'V7', name: 'unknown 自动变成 into-room（计划里擅自默认门向）', file: F_PLAN,
    from: '  const plan: PlannerPlan = { request, unresolved, candidates: set.candidates, scores, explanations };',
    to: "  const plan: PlannerPlan = { request, unresolved, candidates: set.candidates, scores, explanations: [...explanations, '（默认假设）门向内开 into-room'] };",
    expect: ['19.'] },
  { id: 'V7b', name: 'unknown 自动变成 into-room（把假设写进模型）', file: F_PLAN,
    from: '  const set = generateCandidateLayouts(project, candidateRequest);\n',
    to: '  const set = generateCandidateLayouts(project, candidateRequest);\n  for (const room of project.rooms) for (const wall of room.walls) for (const o of wall.openings ?? []) { if (o.swingDirection === undefined) o.swingDirection = \'into-room\'; }\n',
    expect: ['19b.'] },
  { id: 'V8', name: 'Planner 自动 winner（导出面长出 pickBest）', file: F_INDEX,
    from: "export * from './model.ts';", to: "export * from './model.ts';\nexport function pickBest(): void {}",
    expect: ['41.', '37b.'] },
  { id: 'V9', name: 'Planner 自动 adopt（导出面长出 adoptPlan）', file: F_INDEX,
    from: "export * from './plan.ts';", to: "export * from './plan.ts';\nexport function adoptPlan(): void {}",
    expect: ['42.', '37b.'] },
  { id: 'V10', name: '超 action budget 静默截断（装箱时丢弃装不下的组）', file: F_BUDGET,
    from: '    if (cur.length + g.length > safeLimit) {\n      batches.push(cur.map((i) => actions[i]!));\n      cur = [];\n    }\n',
    to: '    if (cur.length + g.length > safeLimit) {\n      continue;\n    }\n',
    expect: ['46.', '47.', '48.'] },
  { id: 'V11', name: '【写入口】core/planner 直接 import CommandBus', file: F_PLAN,
    from: "import type { Project } from '../types.ts';",
    to: "import { CommandBus } from '../commandBus.ts';\nimport type { Project } from '../types.ts';",
    expect: ['35.', '37d.'] },
  { id: 'V11b', name: '【类型层】rotation/坐标不再是 never（临时探针必须编译不过）', file: null,
    probe: "import type { PlannerRequest } from './model.ts';\nexport const bad: PlannerRequest = { scope: 'project', x: 100, rotation: 90, polygon: [], wallId: 'w1' };\n",
    expect: [] },
];

function normalize(text) {
  return { lf: text.replace(/\r\n/g, '\n'), crlf: text.includes('\r\n') };
}
function denormalize(lf, crlf) {
  return crlf ? lf.replace(/\n/g, '\r\n') : lf;
}

const results = [];
let restoredOK = true;

for (const m of MUTATIONS) {
  if (m.probe) {
    // ── 类型层探针：写一个"试图表达几何"的临时文件，tsc 必须报错 ──
    try {
      writeFileSync(PROBE, m.probe, 'utf8');
      const t = await runTsc();
      const geoErrs = t.errs.filter((l) => /__mutateprobe/.test(l));
      results.push({
        ...m,
        ok: geoErrs.length >= 1,
        mechanism: 'tsc（类型层）',
        reds: geoErrs.slice(0, 4),
      });
    } finally {
      if (existsSync(PROBE)) unlinkSync(PROBE);
    }
    continue;
  }

  const path = join(APP, m.file);
  const raw = readFileSync(path, 'utf8');
  const { lf, crlf } = normalize(raw);
  const hits = lf.split(m.from).length - 1;
  if (hits !== 1) {
    results.push({ ...m, ok: false, why: `锚点匹配 ${hits} 次（应为 1）—— 夹具失效，必须修正` });
    continue;
  }
  const bak = path + BAK_SUFFIX;
  try {
    writeFileSync(bak, raw, 'utf8'); // 先落盘备份，再改坏
    writeFileSync(path, denormalize(lf.replace(m.from, m.to), crlf), 'utf8');
    const run1 = await runAcceptance();
    const redText = run1.reds.join('\n');
    const missing = m.expect.filter((e) => !redText.includes(e));
    results.push({
      ...m, ok: run1.fail > 0 && missing.length === 0,
      pass: run1.pass, fail: run1.fail, reds: run1.reds, missing,
      mechanism: 'verify:ai-planner',
    });
  } finally {
    writeFileSync(path, readFileSync(bak, 'utf8'), 'utf8'); // 从磁盘备份还原
    unlinkSync(bak);
    if (readFileSync(path, 'utf8') !== raw) restoredOK = false;
  }
}

console.log('\n════════ P9.5 变异测试结果 ════════');
let bad = 0;
for (const r of results) {
  console.log(`${r.ok ? '✓' : '✗'} ${r.id} ${r.name}`);
  if (r.ok) {
    console.log(`     被 ${r.mechanism} 抓到：${(r.reds ?? []).slice(0, 3).map((s) => s.replace(/^\s+/, '').slice(0, 70)).join('  |  ')}`);
  } else {
    bad++;
    console.log(`     未达预期：${r.why ?? `期望断言未变红（缺 ${(r.missing ?? []).join(' / ')}）`}`);
    console.log(`     实际红名单：${(r.reds ?? []).map((s) => s.slice(0, 50)).join(' | ') || '(无)'}`);
  }
}

console.log(`\n还原检查：${restoredOK ? '全部源文件已按字节还原 ✓' : '✗ 有文件未还原！'}`);
const final = await runAcceptance();
console.log(`还原后复跑：通过 ${final.pass} / 失败 ${final.fail}`);

const ok = bad === 0 && restoredOK && final.fail === 0;
console.log(ok ? '\n═══ 变异测试全部符合预期 ═══' : `\n═══ 变异测试有 ${bad} 条不符合预期 ═══`);
process.exit(ok ? 0 : 1);
