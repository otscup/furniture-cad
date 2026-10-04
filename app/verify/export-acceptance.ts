import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Project, RuleSet } from '../src/core/types.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  导出验收 —— "导出成功"不能只看"文件存在"
 *
 *  这一组要钉住的事，按危险程度排：
 *
 *   ① **中文不许被写成 \U+XXXX。** ezdxf 默认 cp1252，这一条踩过实测的坑
 *      （docs/Phase0-Spike-Report.md）。图纸上一旦出现转义串，工人看到的就是
 *      "主卧衣柜"变成 "\U+4E3B\U+5367…"，而且是**打印出来才发现**。
 *
 *   ② **图层颜色不许用 ACI 7。** 7 是黑/白随背景反转，白底打印会隐形。
 *      颜色策略必须显式分配，且这一条要断言而不是"相信代码"。
 *
 *   ③ **图元数必须逐类对上。** neutral 里有几个 poly / fill / text，
 *      DXF 里就该有几个 LWPOLYLINE / HATCH / TEXT —— 少一个就是丢了一条线。
 *      只断言"实体总数 > 0"挡不住"丢一半线"这种缺陷。
 *
 *   ④ **$INSUNITS 必须是毫米。** 单位错了，图纸按米打开就是 1:1000 的灾难。
 *
 *   ⑤ 三件套（模型版本 / 生成器 / 规则集）必须写进文件 ——
 *      光靠文件名做不到"可复现"，文件会被改名。
 *
 *   ⑥ 后端接口要走真 HTTP 验一次：链路里有 spawn 两个子进程、临时目录、
 *      中文文件名 RFC 5987 —— 任何一环都可能单独坏掉。
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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
  console.log(`\n${t}`);
}

/**
 * Python 解释器跨平台解析（与 server.mjs 的 pythonExe() 同一优先级，Codex 验收§三①）。
 * 显式路径必须存在才用；裸命令名无法 existsSync，直接保留作兜底。
 * 找不到就如实报错，不许"假装导出成功"。
 */
function resolvePython(): string {
  const cand = [
    process.env.APP_PYTHON,
    join(root, '.venv', 'Scripts', 'python.exe'),
    join(root, '..', '.venv', 'Scripts', 'python.exe'),
    join(root, '..', '.venv', 'bin', 'python'),
    'python3',
    'python',
  ]
    .filter((c): c is string => Boolean(c))
    .filter((c) => (c.includes('/') || c.includes('\\') ? existsSync(c) : true));
  return cand[0] ?? 'python';
}

const PY = resolvePython();
const VERIFY_DXF_PY = join(root, 'py', 'verify_dxf.py');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
const project: Project = sampleProject(rules);

const TMP = mkdtempSync(join(tmpdir(), 'furniture-export-verify-'));
/**
 * 为什么用异步 spawn 而不是 execFileSync：
 * 在 --experimental-strip-types 的进程里，execFileSync 起这个 python.exe 会报 EBUSY
 * （Windows + venv launcher 的组合问题），而异步 spawn 一直是好的 ——
 * 与 server.mjs 用的是同一种方式，不为了写起来短一点换一条没验证过的路。
 */
const runPy = (args: string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const p = spawn(PY, args, { cwd: root });
    let out = '';
    let err = '';
    if (input !== undefined) p.stdin?.end(input);
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`python 退出码 ${code}：${(err || out).slice(0, 600)}`))
    );
  });

// ───────────────────────── A. 中立交换格式 ─────────────────────────

section('A. 中立交换格式：几何由 TS 算好，Python 只做序列化');

const neutral = toNeutralExport(project, rules, ['plan', 'sheet'], 'v42');
ok('meta 带三件套（模型版本 / 生成器 / 规则集）', Boolean(neutral.meta.traceability?.modelVersion) && neutral.meta.traceability.modelVersion === 'v42', JSON.stringify(neutral.meta.traceability));
ok('单位是毫米、$INSUNITS=4', neutral.meta.units === 'mm' && neutral.meta.insUnits === 4);
ok('两张图纸都在（平面图 + 四视图）', neutral.sheets.length === 2, JSON.stringify(neutral.sheets.map((s) => s.name)));
ok('每张图纸的图元都非空', neutral.sheets.every((s) => s.prims.length > 0), JSON.stringify(neutral.sheets.map((s) => [s.name, s.prims.length])));
ok('每张图纸都带 bbox（没有它没法取景）', neutral.sheets.every((s) => s.bbox !== null));
ok('开料单非空（板件数 > 0）', neutral.panels.length > 0, `${neutral.panels.length} 块`);
ok(
  '板件尺寸都是正整数 mm（0 或负数的板件没法开料）',
  neutral.panels.every((p) => Number.isInteger(p.length) && Number.isInteger(p.width) && p.length > 0 && p.width > 0),
  JSON.stringify(neutral.panels.filter((p) => !(p.length > 0 && p.width > 0)).slice(0, 2))
);

// ───────────────────────── B. DXF 序列化 + 回读 ─────────────────────────

section('B. DXF 序列化与回读（ezdxf 双向验证）');

const neutralPath = join(TMP, 'neutral.json');
writeFileSync(neutralPath, JSON.stringify(neutral), 'utf8');
const dxfPath = join(TMP, 'out.dxf');
const buildInfo = JSON.parse(await runPy([join(root, 'py', 'export_dxf.py'), neutralPath, dxfPath, 'R2007']));
ok('导出脚本退出码 0 并返回统计', Boolean(buildInfo?.entities), JSON.stringify(buildInfo?.primStats ?? buildInfo));

const check = JSON.parse(await runPy([VERIFY_DXF_PY, dxfPath]));

ok('DXF 版本是 R2007（AC1021，原生 UTF-8）', check.dxfversion === 'AC1021', check.dxfversion);
ok(`实体总数 ${check.entities} 与 neutral 图元数一致`, check.entities === neutral.sheets.reduce((a, s) => a + s.prims.length, 0), `DXF ${check.entities} vs neutral ${neutral.sheets.reduce((a, s) => a + s.prims.length, 0)}`);
ok(
  '【关键】逐类对上：poly→LWPOLYLINE / fill→LWPOLYLINE轮廓 / text→TEXT（少一个就是丢一条线）',
  // fill 走线框模式：转成闭合 LWPOLYLINE，不再是 HATCH（手机看图软件会把实心 HATCH 渲染成灰块）
  (check.counts.LWPOLYLINE ?? 0) === neutral.sheets.reduce((a, s) => a + s.prims.filter((p) => p.k === 'poly' || p.k === 'fill').length, 0) &&
    (check.counts.HATCH ?? 0) === 0 &&
    (check.counts.TEXT ?? 0) === neutral.sheets.reduce((a, s) => a + s.prims.filter((p) => p.k === 'text').length, 0),
  JSON.stringify({ dxf: check.counts, neutral: neutral.sheets.map((s) => s.prims.reduce((a, p) => ((a[p.k] = (a[p.k] ?? 0) + 1), a), {})) })
);
ok(
  '【关键】中文没有被写成 \\U+XXXX（这个坑打印出来才会发现）',
  check.escapedTexts.length === 0,
  JSON.stringify(check.escapedTexts.slice(0, 3))
);
ok('图纸里确实有中文文字（不是"全空的通过"）', check.textCount > 0 && /[\u4e00-\u9fff]/.test(check.sampleTexts.join('')), JSON.stringify(check.sampleTexts));
ok('【关键】图层颜色没有用到 ACI 7（黑/白随背景反转，白底隐形）', check.colorSevenUsed === false, JSON.stringify(check.layerColors));
ok('$INSUNITS = 4（毫米。单位错了整张图就是 1:1000 的灾难）', check.insUnits === 4, String(check.insUnits));
ok(
  '三件套写进了文件自定义属性（光靠文件名做不到可复现，文件会被改名）',
  Boolean(check.custom?.FurnitureModelVersion) && check.custom.FurnitureModelVersion === 'v42',
  JSON.stringify(check.custom)
);

// ───────────────────────── C. 后端接口（真 HTTP） ─────────────────────────

section('C. 后端导出接口：真 HTTP 走一遍整条链路');

const PORT = 8823;
const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    APP_MEM_PATH: join(TMP, 'mem.jsonl'),
    APP_ACCOUNTS_PATH: join(TMP, 'accounts.json'),
    APP_AUDIT_PATH: join(TMP, 'audit.jsonl'),
  },
});
await new Promise<void>((resolve) => {
  const t = setTimeout(() => resolve(), 6000);
  child.stdout.on('data', (d: Buffer) => {
    if (String(d).includes('监听')) {
      clearTimeout(t);
      resolve();
    }
  });
});

try {
  const post = async (path: string, body: unknown): Promise<{ status: number; headers: Headers; buf: Buffer }> => {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  };

  const dxfRes = await post('/api/export/dxf', { project, which: ['plan', 'sheet'], modelVersion: 'v7' });
  ok('POST /api/export/dxf 返回 200', dxfRes.status === 200, String(dxfRes.status));
  ok('Content-Type 是 application/dxf', (dxfRes.headers.get('Content-Type') ?? '').includes('dxf'), String(dxfRes.headers.get('Content-Type')));
  ok('响应体是 DXF（以 SECTION/HEADER 开头），不是一段错误 JSON', dxfRes.buf.subarray(0, 20).toString('latin1').includes('SECTION'), dxfRes.buf.subarray(0, 40).toString('latin1'));
  ok(
    '中文文件名走 RFC 5987（否则下载下来是乱码）',
    /filename\*=UTF-8''/.test(dxfRes.headers.get('Content-Disposition') ?? ''),
    String(dxfRes.headers.get('Content-Disposition'))
  );
  ok('DXF 体量合理（> 10KB，说明不是只有几条线的空壳）', dxfRes.buf.length > 10 * 1024, `${dxfRes.buf.length} bytes`);

  const viaHttp = join(TMP, 'via-http.dxf');
  writeFileSync(viaHttp, dxfRes.buf);
  const check2 = JSON.parse(await runPy([VERIFY_DXF_PY, viaHttp]));
  ok('走 HTTP 拿到的 DXF 同样通过回读校验（中文 / 颜色 / 单位）', check2.escapedTexts.length === 0 && check2.colorSevenUsed === false && check2.insUnits === 4, JSON.stringify({ esc: check2.escapedTexts.length, c7: check2.colorSevenUsed }));

  const csvRes = await post('/api/export/cutlist', { project });
  ok('POST /api/export/cutlist 返回 200', csvRes.status === 200, String(csvRes.status));
  const csv = csvRes.buf.toString('utf8');
  ok('CSV 带 BOM（没有它 Excel 打开中文就是乱码）', csv.charCodeAt(0) === 0xfeff, `首字符码点 ${csv.charCodeAt(0)}`);
  ok(
    `CSV 行数 = 表头 + 板件数（${neutral.panels.length + 1}）`,
    csv.trim().split(/\r?\n/).length === neutral.panels.length + 1,
    String(csv.trim().split(/\r?\n/).length)
  );
  ok('CSV 表头是中文（工人看得懂的表，不是给程序看的）', /板件ID/.test(csv) && /厚\(mm\)/.test(csv), csv.split(/\r?\n/)[0]);

  const badRes = await post('/api/export/dxf', { which: ['plan'] });
  ok('缺 project 时如实报 400（不是返回一个空文件）', badRes.status === 400, String(badRes.status));
} finally {
  child.kill();
  rmSync(TMP, { recursive: true, force: true });
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log('导出成立：几何由 TS 算好、Python 只做序列化、中文/颜色/单位/三件套全部过关。');
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
