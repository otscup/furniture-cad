/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.9 Preflight 修复阶段 · 回归 + 变异验收
 *
 *  这批断言要钉住 10 个既有缺陷的修复（P0×4 / P1×5 / P2×4 中的非阻塞项），
 *  并证明"测试不是假的"—— 每个关键修复都带一个**变异**：把代码改回出错状态，
 *  回归测试必须变红（判红 = 测试真的能抓到 bug），然后还原。
 *
 *  ── 修复清单（与任务项一一对应）──
 *    P0-1  抽屉面板高度重复扣缝          → generate.ts / layout.ts / validate.ts
 *    P0-2  /api/settings & SMTP 缺管理鉴权 → server.mjs
 *    P0-3  canDesign 是纸面权限          → server.mjs（design 闸门）
 *    P0-4  DXF 绕过 Manufacturing        → emit-neutral.ts
 *    P1-5  DXF 临时目录不清理            → server.mjs（mkdtempSync）
 *    P1-6  audit() 伪追加（读改写覆盖）   → auth.mjs
 *    P1-7  电器格画了不存在的门          → generate.ts（elevation 守卫）
 *    P1-8  ezdxf 未锁版本               → Dockerfile
 *    P1-9  export_dxf.py 弱错误边界      → py/export_dxf.py
 *    P2-① securityPolicy 文案与实现不符  → auth.mjs
 *    P2-② verify_dxf.py 死代码          → py/verify_dxf.py
 *    P2-③ 层板立面宽与真实板件不一致      → generate.ts（elevation shelf）
 *    P2-④ quota.mjs tenant_default       → 经核查不存在，跳过（不编造）
 *
 *  ── 纪律 ──
 *    ① 旧测试零删除、零放宽；本脚本只新增 preflight 回归，不碰 P9.4/P9.7/P9.8。
 *    ② 变异判红：child 退出码非 0 = 被测代码回到出错状态时测试抓得到。
 *    ③ 任何变异脚本都不进仓库（临时落盘，finally 还原）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const APP_URL = pathToFileURL(APP + '/').href;
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8'));

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n【${t}】`);
}

// ───────────────────────── 通用：child 运行 ─────────────────────────

/** 跑一段 TS 子进程：把 body（已含 import）落盘成 .mjs，用 strip-types 跑，返回 {code, out} */
function runTsChild(body: string): Promise<{ code: number; out: string }> {
  const f = join(TMP, `preflight-chk-${Math.random().toString(36).slice(2)}.mjs`);
  // __APP_URL__ 必须带引号注入，否则 new URL('...', file:///...) 的第二个参数会变成裸 URL（// 触发注释 → SyntaxError）
  writeFileSync(f, body.replace(/__APP_URL__/g, JSON.stringify(APP_URL)));
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', f], { cwd: APP });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => (out += String(e)));
    p.on('close', (code) => {
      try { rmSync(f); } catch { /* ignore */ }
      resolve({ code: code ?? -1, out });
    });
  });
}

const PY = join(APP, '..', '.venv', 'Scripts', 'python.exe');
function runPy(args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(PY, args, { cwd: APP });
    let out = '';
    let err = '';
    if (input !== undefined) p.stdin?.end(input);
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (err += d));
    p.on('error', (e) => (err += String(e)));
    p.on('close', (code) => resolve({ code: code ?? -1, out: out + (err ? `\n[stderr]\n${err}` : '') }));
  });
}

/** 变异：备份 → 打补丁（from→to）→ 跑 regression（期望变红，code≠0）→ finally 还原 */
async function mutate(label: string, file: string, from: string, to: string, regression: () => Promise<{ code: number; out: string }>): Promise<void> {
  const origRaw = readFileSync(file, 'utf8');
  // 源码是 CRLF：先归一化行尾再匹配/替换，避免多行锚点按 LF 匹配失败；还原时写回原始字节。
  const orig = origRaw.replace(/\r\n/g, '\n');
  if (!orig.includes(from)) {
    ok(`变异【${label}】：补丁锚点存在`, false, `在 ${file} 中找不到：\n${from.slice(0, 120)}`);
    return;
  }
  const mutated = orig.replace(from, to);
  writeFileSync(file, mutated);
  let caught = false;
  let detail = '';
  try {
    const r = await regression();
    caught = r.code !== 0;
    detail = caught ? '' : r.out.slice(0, 400);
  } finally {
    writeFileSync(file, origRaw);
  }
  ok(`变异【${label}】：回到出错状态后回归确实抓得到（判红）`, caught, caught ? '' : `变异后仍判绿——测试是假的：\n${detail}`);
}

const TMP = mkdtempSync(join(tmpdir(), 'furniture-preflight-'));

// ══════════════════════════════════════════════════════════════════════
//  P0-1  抽屉面板高度重复扣缝
// ══════════════════════════════════════════════════════════════════════
section('P0-1 抽屉面板高度重复扣缝（cellH 已扣全部缝，frontH 不得再扣 2×gap）');

const P0_1_CHILD = `
import { readFileSync } from 'node:fs';
const { createCabinet, makeUnit } = await import(new URL('src/core/docFactory.ts', __APP_URL__).href);
const { generateCabinet } = await import(new URL('src/core/geometry/generate.ts', __APP_URL__).href);
const { validateCabinet } = await import(new URL('src/core/rules/validate.ts', __APP_URL__).href);
const { drawerCellHeights } = await import(new URL('src/core/geometry/layout.ts', __APP_URL__).href);
const rules = JSON.parse(readFileSync(new URL('src/core/ruleset/factory-default.json', __APP_URL__)));
const unit = makeUnit({ kind: 'drawerBank', requestedWidth: 600, count: 3, rules, depth: 560, id: 'u1' });
const cab = createCabinet({ id: 'cab1', name: '抽屉柜', roomId: 'r1', x: 0, y: 0, units: [unit], rules });
const geom = generateCabinet(cab, rules);
const issues = validateCabinet(cab, geom, rules);
// 数值回归：净高 600、count 3、gap 3 —— ΣfrontH + 4×gap 必须 = 600（差 2n×gap 即旧 bug）
const cellH = drawerCellHeights(unit, 600, rules);
const sumCell = cellH.reduce((a, b) => a + b, 0);
const identity600 = Math.abs(sumCell + (3 + 1) * unit.drawers.gap - 600) < 1e-6;
const fronts = geom.panels.filter(p => p.group === 'u1' && p.role === 'DrawerFront');
const netH = geom.layout.rows[0].netH;
const sumFront = fronts.reduce((a, p) => a + p.length, 0);
const identityReal = Math.abs(sumFront + (unit.drawers.count + 1) * unit.drawers.gap - netH) < 1e-6;
const noDrawerIdentityFail = !issues.some(i => i.code === 'IDENTITY-FAIL' && String(i.ctx?.label ?? '').includes('抽屉'));
const pass = identity600 && identityReal && noDrawerIdentityFail && fronts.length === 3;
console.log(JSON.stringify({ identity600, identityReal, noDrawerIdentityFail, fronts: fronts.length, sumFront, netH }));
process.exit(pass ? 0 : 1);
`;

{
  const r = await runTsChild(P0_1_CHILD);
  ok('修复后：Σ抽屉面板高 + (n+1)×gap = 净高，且校验无抽屉恒等式失败', r.code === 0, r.out.slice(0, 400));
}
await mutate(
  'P0-1',
  join(APP, 'src/core/geometry/generate.ts'),
  'const frontH = cellH[k];',
  'const frontH = cellH[k] - 2 * d.gap;',
  () => runTsChild(P0_1_CHILD),
);

// ══════════════════════════════════════════════════════════════════════
//  P0-2 / P0-3  /api/settings & SMTP 管理鉴权 + canDesign 设计闸门
//  （需要起真实 HTTP 服务，用临时账号库；viewer 不能改设置、不能设计）
// ══════════════════════════════════════════════════════════════════════
section('P0-2 / P0-3 设置写操作管理鉴权 + 设计接口 canDesign 闸门');

const PORT_PREF = 8799;
function serverEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    APP_ENV_PATH: join(dir, '.env'),
    APP_ACCOUNTS_PATH: join(dir, 'accounts.json'),
    APP_AUDIT_PATH: join(dir, 'audit.jsonl'),
    APP_MEM_PATH: join(dir, 'mem.jsonl'),
    PORT: String(PORT_PREF),
    APP_HOST: '127.0.0.1',
    APP_PYTHON: PY,
  };
}

async function startServer(dir: string): Promise<{ base: string; stop: () => void }> {
  writeFileSync(join(dir, '.env'), 'AI_PROVIDER=deepseek\n');
  const srv = spawn(process.execPath, ['--experimental-strip-types', join(APP, 'server', 'server.mjs')], {
    cwd: APP,
    env: serverEnv(dir),
  });
  let buf = '';
  srv.stdout?.on('data', (d: Buffer) => (buf += d));
  srv.stderr?.on('data', (d: Buffer) => (buf += d));
  const base = `http://127.0.0.1:${PORT_PREF}`;
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) break;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { base, stop: () => { try { srv.kill('SIGTERM'); } catch { /* ignore */ } } };
}

async function authGatePass(base: string): Promise<{ pass: boolean; detail: Record<string, unknown> }> {
  const detail: Record<string, unknown> = {};
  const j = async (path: string, method: string, body?: unknown, token?: string) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  // bootstrap owner
  const reg = await j('/api/auth/register', 'POST', { username: 'owner1', password: 'owner-pass-99' });
  detail.reg = reg.status;
  if (reg.status !== 200 || !reg.json.token) return { pass: false, detail };
  const ownerTok = String(reg.json.token);
  // owner 建 viewer
  const mk = await j('/api/account/accounts', 'POST', { username: 'viewer1', password: 'viewer-pass-99', role: 'viewer' }, ownerTok);
  detail.mkViewer = mk.status;
  const login = await j('/api/auth/login', 'POST', { username: 'viewer1', password: 'viewer-pass-99' });
  detail.viewerLogin = login.status;
  const vTok = String(login.json.token ?? '');
  // viewer 改设置 → 必须 403
  const vSet = await j('/api/settings', 'PUT', { provider: 'attacker' }, vTok);
  detail.viewerSettings = vSet.status;
  // owner 改设置 → 必须不是 403
  const oSet = await j('/api/settings', 'PUT', { provider: 'deepseek' }, ownerTok);
  detail.ownerSettings = oSet.status;
  // viewer 调设计接口 /api/ai/plan → 必须 403
  const vPlan = await j('/api/ai/plan', 'POST', { prompt: 'hi' }, vTok);
  detail.viewerPlan = vPlan.status;
  const pass =
    vSet.status === 403 && oSet.status !== 403 && vPlan.status === 403 && mk.status === 200 && login.status === 200;
  return { pass, detail };
}

async function runServerGateTest(mutatedServerPath: string | null): Promise<{ code: number; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'furnicad-gate-'));
  let stop = () => {};
  try {
    const { base, stop: s } = await startServer(dir);
    stop = s;
    const res = await authGatePass(base);
    return { code: res.pass ? 0 : 1, out: JSON.stringify(res.detail) };
  } catch (e) {
    return { code: 2, out: String(e) };
  } finally {
    stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

{
  const r = await runServerGateTest(null);
  ok('修复后：viewer 改设置/调设计被 403，owner 不被拦', r.code === 0, r.out.slice(0, 500));
}
await mutate(
  'P0-2/P0-3',
  join(APP, 'server', 'server.mjs'),
  `  const isSettingsWrite =
    (pathname === '/api/settings' || pathname.startsWith('/api/settings/')) &&
    (req.method === 'PUT' || req.method === 'POST');
  const managePaths =
    pathname.startsWith('/api/account/') ||
    pathname.startsWith('/api/security/') ||
    isSettingsWrite;`,
  `  const isSettingsWrite = false;
  const managePaths =
    pathname.startsWith('/api/account/') ||
    pathname.startsWith('/api/security/');`,
  () => runServerGateTest(null),
);

// ══════════════════════════════════════════════════════════════════════
//  P0-4  DXF 必须消费 Manufacturing 层（不再走绕开制造层的 toNeutralExport）
// ══════════════════════════════════════════════════════════════════════
section('P0-4 DXF 入口消费 Manufacturing（emit-neutral 必须走 manufacturingToNeutralExportDefault）');

const EMIT_NEUTRAL = join(APP, 'scripts', 'emit-neutral.ts');
{
  const src = readFileSync(EMIT_NEUTRAL, 'utf8');
  ok('emit-neutral 引入 manufacturingToNeutralExportDefault', src.includes('manufacturingToNeutralExportDefault'));
  ok('emit-neutral 不再引入 toNeutralExport', !src.includes('import { toNeutralExport }'));
}
await mutate(
  'P0-4',
  EMIT_NEUTRAL,
  "import { manufacturingToNeutralExportDefault } from '../src/core/manufacturing/index.ts';",
  "import { toNeutralExport } from '../src/export/neutralSheet.ts';",
  async () => {
    const src = readFileSync(EMIT_NEUTRAL, 'utf8');
    const bad = src.includes('import { toNeutralExport }') && !src.includes('manufacturingToNeutralExportDefault');
    return { code: bad ? 0 : 1, out: '' };
  },
);

// ══════════════════════════════════════════════════════════════════════
//  P1-5  DXF 临时目录清理
// ══════════════════════════════════════════════════════════════════════
section('P1-5 DXF 临时目录（furniture-dxf-*）在导出后不留残留');

let detail_dxf_export_ok = false;
let detail_dxf_residue = -1;
{
  const dir = mkdtempSync(join(tmpdir(), 'furnicad-gate-'));
  let stop = () => {};
  try {
    const { base, stop: s } = await startServer(dir);
    stop = s;
    let payload: unknown = null;
    const samplePath = join(APP, 'verify', 'samples', 'sample-project.json');
    if (existsSync(samplePath)) {
      try { payload = JSON.parse(readFileSync(samplePath, 'utf8')); } catch { payload = null; }
    }
    // 样本不存在则用 docFactory 造一个最小项目
    if (!payload) {
      const childOut = await runTsChild(`
        import { readFileSync } from 'node:fs';
        const { sampleProject } = await import(new URL('src/core/docFactory.ts', __APP_URL__).href);
        const rules = JSON.parse(readFileSync(new URL('src/core/ruleset/factory-default.json', __APP_URL__)));
        process.stdout.write(JSON.stringify(sampleProject(rules)));
      `);
      payload = JSON.parse(childOut.out);
    }
    const tmp = tmpdir();
    // 先快照已存在的 furniture-dxf-*（历史遗留不算本次导出新增），只断言"无新增"。
    const before = new Set(readdirSync(tmp).filter((n) => n.startsWith('furniture-dxf-')));
    const r = await fetch(`${base}/api/export/dxf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: payload, which: ['plan'], modelVersion: 'v-test' }),
    });
    detail_dxf_export_ok = r.ok;
    // 必须消费完响应体，服务端才会触发 stream 'end' → 清理临时目录
    await r.text().catch(() => '');
    // 清理是异步的：轮询等待本次新增的临时目录消失（最多 ~2s）
    let fresh = -1;
    for (let i = 0; i < 40; i++) {
      const now = readdirSync(tmp).filter((n) => n.startsWith('furniture-dxf-'));
      fresh = now.filter((n) => !before.has(n)).length;
      if (fresh === 0) break;
      await new Promise((rr) => setTimeout(rr, 50));
    }
    detail_dxf_residue = fresh;
    ok('DXF 导出成功后临时目录无新增 furniture-dxf-* 残留', r.ok && fresh === 0, `ok=${r.ok} fresh=${fresh}`);
  } catch (e) {
    ok('DXF 临时目录清理', false, String(e).slice(0, 300));
  } finally {
    stop();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  P1-6  audit() 真追加（不得读改写覆盖）
// ══════════════════════════════════════════════════════════════════════
section('P1-6 audit() 只追加：并发写不覆盖他人条目');

const P1_6_CHILD = `
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { AuthStore } = await import(new URL('server/auth.mjs', __APP_URL__).href);
const dir = mkdtempSync(join(tmpdir(), 'furnicad-audit-'));
const auth = new AuthStore({ accountsPath: join(dir, 'a.json'), auditPath: join(dir, 'audit.jsonl') });
auth.audit({ actor: 'u1', action: 'x' });
auth.audit({ actor: 'u2', action: 'y' });
const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\\n').filter(Boolean);
const hasU1 = lines.some(l => l.includes('"actor":"u1"'));
const hasU2 = lines.some(l => l.includes('"actor":"u2"'));
console.log(JSON.stringify({ n: lines.length, hasU1, hasU2 }));
process.exit(lines.length === 2 && hasU1 && hasU2 ? 0 : 1);
`;
{
  const r = await runTsChild(P1_6_CHILD);
  ok('修复后：两次 audit 都落地（2 条，互不覆盖）', r.code === 0, r.out.slice(0, 300));
}
await mutate(
  'P1-6',
  join(APP, 'server', 'auth.mjs'),
  '    appendFileSync(this.auditPath, `${line}\\n`, \'utf8\');',
  '    writeFileSync(this.auditPath, `${line}\\n`, \'utf8\');',
  () => runTsChild(P1_6_CHILD),
);

// ══════════════════════════════════════════════════════════════════════
//  P1-7  电器格带门时立面不应画门（与 buildRow 守卫一致）
// ══════════════════════════════════════════════════════════════════════
section('P1-7 电器格 + 门：不生成 DoorPanel、立面不画门矩形');

const P1_7_CHILD = `
import { readFileSync } from 'node:fs';
const { createCabinet, makeUnit } = await import(new URL('src/core/docFactory.ts', __APP_URL__).href);
const { generateCabinet } = await import(new URL('src/core/geometry/generate.ts', __APP_URL__).href);
const rules = JSON.parse(readFileSync(new URL('src/core/ruleset/factory-default.json', __APP_URL__)));
// 一个只有「电器格 + 门」的分区：修复后既无 DoorPanel，立面也无 L_FRONT 矩形（无抽屉/门）
const u = makeUnit({ kind: 'appliance', requestedWidth: 600, rules, depth: 600, id: 'u1', doors: { count: 2 }, appliance: { topDrawers: 0 } });
const cab = createCabinet({ id: 'cab1', name: '电器柜', roomId: 'r1', x: 0, y: 0, units: [u], rules });
const geom = generateCabinet(cab, rules);
const doorPanels = geom.panels.filter(p => p.group === 'u1' && p.role === 'DoorPanel').length;
const frontPrims = geom.elevation.filter(p => p.layer === 'F-CAB-FRONT').length;
console.log(JSON.stringify({ doorPanels, frontPrims }));
process.exit(doorPanels === 0 && frontPrims === 0 ? 0 : 1);
`;
{
  const r = await runTsChild(P1_7_CHILD);
  ok('修复后：电器格 + 门 不画门（0 DoorPanel / 0 立面门矩形）', r.code === 0, r.out.slice(0, 300));
}
await mutate(
  'P1-7',
  join(APP, 'src/core/geometry/generate.ts'),
  "      if (u.doors && u.kind !== 'appliance') {",
  "      if (u.doors) {",
  () => runTsChild(P1_7_CHILD),
);

// ══════════════════════════════════════════════════════════════════════
//  P1-8  ezdxf 锁版本
// ══════════════════════════════════════════════════════════════════════
section('P1-8 Dockerfile 锁定 ezdxf==1.4.4');
const DOCKERFILE = join(APP, 'Dockerfile');
{
  const src = readFileSync(DOCKERFILE, 'utf8');
  ok('Dockerfile 锁定 ezdxf==1.4.4', src.includes('ezdxf==1.4.4'));
}
await mutate(
  'P1-8',
  DOCKERFILE,
  'pip3 install --break-system-packages --no-cache-dir "ezdxf==1.4.4"',
  'pip3 install --break-system-packages --no-cache-dir ezdxf',
  async () => {
    const src = readFileSync(DOCKERFILE, 'utf8');
    // 变异态：未锁版本（不含 ezdxf==1.4.4）→ 必须判红（code≠0 → caught=true）
    return { code: src.includes('ezdxf==1.4.4') ? 0 : 1, out: '' };
  },
);

// ══════════════════════════════════════════════════════════════════════
//  P1-9  export_dxf.py 错误边界（缺 meta / 坏图元必须给出结构化报错）
// ══════════════════════════════════════════════════════════════════════
section('P1-9 export_dxf.py 弱错误边界：缺 meta / 坏图元给出结构化报错');

{
  // 缺 meta：写到临时文件（脚本读 sys.argv[1] 当文件路径，不读 stdin；还需 sys.argv[2] 作输出路径）
  const badMetaPath = join(TMP, 'bad-meta.json');
  writeFileSync(badMetaPath, JSON.stringify({ sheets: [] }));
  const r1 = await runPy([join(APP, 'py', 'export_dxf.py'), badMetaPath, join(TMP, 'bad-meta.dxf')]);
  ok('缺 meta：脚本非零退出并给出「缺少 meta」报错', r1.code !== 0 && /缺少 meta/.test(r1.out), r1.out.slice(0, 300));
  // 坏图元（缺 layer）
  const badPrimPath = join(TMP, 'bad-prim.json');
  writeFileSync(badPrimPath, JSON.stringify({ meta: { projectName: 'x' }, sheets: [{ name: 'p', prims: [{ k: 'poly', pts: [{ x: 0, y: 0 }] }] }] }));
  const r2 = await runPy([join(APP, 'py', 'export_dxf.py'), badPrimPath, join(TMP, 'bad-prim.dxf')]);
  ok('坏图元（缺 layer）：脚本非零退出并给出「图元损坏」结构化报错', r2.code !== 0 && /图元损坏/.test(r2.out), r2.out.slice(0, 300));
}
await mutate(
  'P1-9',
  join(APP, 'py', 'export_dxf.py'),
  '    if "meta" not in data:\n        raise ValueError("中立交换 JSON 缺少 meta 字段（顶层必须有 meta）")\n    meta = data["meta"]',
  '    meta = data["meta"]',
  async () => {
    const badPath = join(TMP, 'bad-meta-mut.json');
    writeFileSync(badPath, JSON.stringify({ sheets: [] }));
    const r = await runPy([join(APP, 'py', 'export_dxf.py'), badPath, join(TMP, 'bad-meta-mut.dxf')]);
    // 修复态：缺 meta 时报「缺少 meta」结构化错误（exit≠0 且含字样）→ 返回 0。
    // 变异态：守卫被删 → KeyError（exit≠0 但不含「缺少 meta」字样）→ 判红（返回 1 → caught=true）。
    const clean = r.code !== 0 && /缺少 meta/.test(r.out);
    return { code: clean ? 0 : 1, out: r.out };
  },
);

// ══════════════════════════════════════════════════════════════════════
//  P2-① securityPolicy 文案：已支持单条撤销，不许再写"不能远程撤销单条"
// ══════════════════════════════════════════════════════════════════════
section('P2-① securityPolicy 文案与实现一致（已支持单条撤销）');
const AUTH_MJS = join(APP, 'server', 'auth.mjs');
{
  const src = readFileSync(AUTH_MJS, 'utf8');
  ok('securityPolicy 不再声称"不能远程撤销单条"', !src.includes('不能远程撤销单条'));
  ok('securityPolicy 已说明支持单条撤销（revokeSession）', src.includes('单条撤销') && src.includes('revokeSession'));
}
await mutate(
  'P2-①',
  AUTH_MJS,
  "      '⚠ 会话不会轮换（refresh），但已支持单条撤销（account.revokeSession）与整账号踢下线（revokeAllSessions）',",
  "      '⚠ 会话不会轮换（refresh）也不能远程撤销单条，只能整账号踢下线',",
  async () => {
    const src = readFileSync(AUTH_MJS, 'utf8');
    return { code: src.includes('不能远程撤销单条') ? 1 : 0, out: '' };
  },
);

// ══════════════════════════════════════════════════════════════════════
//  P2-② verify_dxf.py 死代码：auditIssues 必须启用（数组，非 None）
// ══════════════════════════════════════════════════════════════════════
section('P2-② verify_dxf.py 启用 auditIssues（死代码已修）');
const VERIFY_DXF = join(APP, 'py', 'verify_dxf.py');
{
  const src = readFileSync(VERIFY_DXF, 'utf8');
  ok('verify_dxf.py 不再有 `if False else None` 死代码', !src.includes('if False else None'));
}
await mutate(
  'P2-②',
  VERIFY_DXF,
  '        "auditIssues": [str(i) for i in Auditor(doc).run()][:20],',
  '        "auditIssues": len(ezdxf.audit(doc, renumber=False)) if False else None,',
  async () => {
    const src = readFileSync(VERIFY_DXF, 'utf8');
    return { code: src.includes('if False else None') ? 1 : 0, out: '' };
  },
);

// ══════════════════════════════════════════════════════════════════════
//  P2-③ 层板立面宽与真实 ShelfPanel 一致（净宽 - 2×gapPerSide）
// ══════════════════════════════════════════════════════════════════════
section('P2-③ 层板立面矩形宽 = 净宽 - 2×gapPerSide（与真实 ShelfPanel 同源）');
const P2_3_CHILD = `
import { readFileSync } from 'node:fs';
const { createCabinet, makeUnit } = await import(new URL('src/core/docFactory.ts', __APP_URL__).href);
const { generateCabinet } = await import(new URL('src/core/geometry/generate.ts', __APP_URL__).href);
const rules = JSON.parse(readFileSync(new URL('src/core/ruleset/factory-default.json', __APP_URL__)));
const u = makeUnit({ kind: 'shelves', requestedWidth: 600, count: 3, rules, depth: 600, id: 'u1' });
const cab = createCabinet({ id: 'cab1', name: '层板柜', roomId: 'r1', x: 0, y: 0, units: [u], rules });
const geom = generateCabinet(cab, rules);
const netW = geom.layout.innerW;
const expectW = netW - 2 * u.shelves.gapPerSide;
// 层板矩形宽 = netW - 2×gapPerSide（与真实 ShelfPanel 同源）；柜体轮廓矩形宽 = innerW/t，必须排除。
// 只筛"宽度命中 expectW"的 F-CAB-STRUCT 矩形，其数量应等于 shelves.count。
const shelfRects = geom.elevation.filter(
  p => p.k === 'poly' && p.layer === 'F-CAB-STRUCT' && Math.abs((p.pts[2].x - p.pts[0].x) - expectW) < 1e-6,
);
const wrong = shelfRects.length !== u.shelves.count;
console.log(JSON.stringify({ netW, expectW, count: shelfRects.length, expected: u.shelves.count, wrong }));
process.exit(!wrong && shelfRects.length > 0 ? 0 : 1);
`;
{
  const r = await runTsChild(P2_3_CHILD);
  ok('修复后：层板立面矩形宽 = 净宽 - 2×gapPerSide', r.code === 0, r.out.slice(0, 300));
}
await mutate(
  'P2-③',
  join(APP, 'src/core/geometry/generate.ts'),
  '        const sw = netW - 2 * u.shelves.gapPerSide;\n        const sx0 = x0 + u.shelves.gapPerSide;',
  '        const sw = netW;\n        const sx0 = x0;',
  () => runTsChild(P2_3_CHILD),
);

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n────────────────────────────────────────`);
console.log(`Preflight 修复验收：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('全部通过。');
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
