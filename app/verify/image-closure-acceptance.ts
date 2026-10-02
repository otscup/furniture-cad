/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S0 生产镜像依赖闭包验收
 *
 *  ── 它要防的是什么（真实事故）──
 *   `app/Dockerfile` 运行阶段只 COPY `dist/server/shared/py`，**从未**拷 `scripts/` 与 `src/`。
 *   而 `server.mjs` 在运行期用子进程直跑 `scripts/emit-*.ts`，那两个入口又 import
 *   `src/core|export/**` 并**按路径读** `src/core/ruleset/factory-default.json`。
 *   结果：生产镜像里三个导出端点（dxf / cutlist / roombook）全部 500，
 *   而仓库里 58 个 verify 脚本**全在宿主机源码树跑**，一个都看不见这个问题。
 *
 *  这是一条**结构性盲区**：源码树里这些文件恰好在盘上 ⇒「验收全绿」与「生产全坏」
 *  可以同时成立。本套件把它变成一个**本地就会红**的断言。
 *
 *  ── 断言分组 ──
 *   A 闭包基线：从两个 emit 入口算运行期 import 闭包（`import type` 在 strip-types 下被
 *     擦除 ⇒ 不传播），确认关键文件在、且**不含任何前端目录**（证明运行镜像不需要 src/ui 等）。
 *   B Dockerfile 覆盖：运行阶段 COPY 必须覆盖 闭包 ∪ {按路径读资源}，
 *     且关键文件的**镜像内落点精确正确**（emit 脚本靠自身位置推 rulesPath）。
 *   C 范围纪律：运行阶段不许把前端源码 / verify / docs / node_modules / .env / memory 带进镜像。
 *   D 构建上下文：`.dockerignore` 不许排除 `scripts`/`src`；必须排除 `.env`/`memory`（安全）。
 *   E 检查器自检（反恒真）：用**合成 Dockerfile 文本**证明覆盖判定与越界判定**真的会红**。
 *     —— 这一条是「断言不可信比失败更危险」的解药：恒真的检查器等于没有检查器。
 *
 *  ── 判据纪律 ──
 *   · 每条失败先打原始值；· 静态断言只扫**代码**（先剥注释，避免被注释里的 import 骗到）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

const APP = join(import.meta.dirname, '..');

let passed = 0;
let failed = 0;
const fails: string[] = [];
function ok(name: string, cond: unknown, detail: unknown = ''): void {
  if (cond === true) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name}  ── ${JSON.stringify(detail)}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ═══════════════════════════ 工具 ═══════════════════════════
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

/** 相对 import 说明符的解析（与 Node ESM 一致的候选顺序） */
function resolveSpecifier(fromAbs: string, spec: string): string | null {
  const base = posix.join(posix.dirname(fromAbs.replace(/\\/g, '/')), spec);
  const cands = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, posix.join(base, 'index.ts'), posix.join(base, 'index.tsx')];
  for (const c of cands) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* 不存在，继续 */
    }
  }
  return null;
}

const IMPORT_PATTERNS: Array<{ re: RegExp; specGroup: number; typeGroup: number | null }> = [
  // import ... from 'x'   |   export ... from 'x'
  { re: /(^|[\s;}])(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/gm, specGroup: 5, typeGroup: 3 },
  // import 'x'
  { re: /(^|[\n;])\s*import\s*['"]([^'"]+)['"]/gm, specGroup: 2, typeGroup: null },
  // import('x')
  { re: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g, specGroup: 1, typeGroup: null },
];

interface RelImport {
  spec: string; // 原始说明符
  rel: string | null; // 解析后的仓库相对路径；null = 解析不到
  typeOnly: boolean; // `import type` / `export type` ⇒ strip-types 下被擦除
}

/** 唯一的 import 解析实现（一种形状只许一处判断）：剥注释 → 匹配三类 import → 解析相对路径 */
function importsOf(fileRel: string): RelImport[] {
  const text = stripComments(readFileSync(join(APP, fileRel), 'utf8'));
  const out: RelImport[] = [];
  for (const { re, specGroup, typeGroup } of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const spec = m[specGroup];
      if (!spec || !spec.startsWith('.')) continue;
      const abs = resolveSpecifier(join(APP, fileRel), spec);
      out.push({
        spec,
        rel: abs === null ? null : abs.replace(/\\/g, '/').slice(APP.replace(/\\/g, '/').length + 1),
        typeOnly: typeGroup === null ? false : Boolean(m[typeGroup]),
      });
    }
  }
  return out;
}

interface ClosureResult {
  runtime: string[]; // 仓库相对路径（posix 分隔），已排序
  erased: string[]; // 只被 import type 引用 ⇒ strip-types 下被擦除
  bare: string[]; // 裸模块说明符
  unresolved: string[]; // 解析不到的相对路径（应为空）
}

/** 运行期闭包：只有「运行期边」才传播（type-only 边被擦除 ⇒ 不传播） */
function computeRuntimeClosure(entries: string[]): ClosureResult {
  const runtime = new Set<string>();
  const erased = new Set<string>();
  const bare = new Set<string>();
  const unresolved: string[] = [];
  const queue: string[] = [];
  for (const e of entries) {
    runtime.add(e);
    queue.push(e);
  }
  while (queue.length) {
    const cur = queue.shift() as string;
    for (const im of importsOf(cur)) {
      if (im.rel === null) {
        if (im.spec.startsWith('.')) unresolved.push(`${im.spec}（from ${cur}）`);
        else bare.add(im.spec);
        continue;
      }
      if (im.typeOnly) {
        if (!runtime.has(im.rel)) erased.add(im.rel);
        continue; // 擦除 ⇒ 不传播
      }
      if (!runtime.has(im.rel)) {
        runtime.add(im.rel);
        erased.delete(im.rel);
        queue.push(im.rel);
      }
    }
  }
  return { runtime: [...runtime].sort(), erased: [...erased].sort(), bare: [...bare].sort(), unresolved };
}

/** 镜像内实际会有的仓库文件（按运行阶段 COPY 规则展开目录） */
function enumerateCoveredRepoFiles(v: DockerfileView): string[] {
  const out = new Set<string>();
  const walk = (rel: string): void => {
    const abs = join(APP, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      out.add(rel);
      return;
    }
    for (const e of readdirSync(abs, { withFileTypes: true })) walk(`${rel}/${e.name}`);
  };
  for (const c of v.copies) {
    if (c.fromStage) continue;
    const src = c.source.replace(/^\.\//, '').replace(/\/$/, '');
    if (!src || src.startsWith('/')) continue;
    walk(src);
  }
  return [...out].sort();
}

// ═══════════════════════════ Dockerfile 解析 ═══════════════════════════
interface CopyRule {
  source: string; // 相对构建上下文（app/）
  dest: string; // 原样
  fromStage: boolean;
  raw: string;
}

interface DockerfileView {
  workdir: string; // 运行阶段生效的 WORKDIR
  copies: CopyRule[]; // 仅运行阶段的 COPY
  cmd: string;
  stages: number;
}

/** 解析 Dockerfile，只看**最后一个** FROM 之后的指令（= 运行阶段） */
function parseDockerfile(text: string): DockerfileView {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const stageStarts: number[] = [];
  lines.forEach((l, i) => {
    if (/^\s*FROM\s/i.test(l)) stageStarts.push(i);
  });
  const runStart = stageStarts.length ? stageStarts[stageStarts.length - 1] : 0;
  const runLines = lines.slice(runStart);

  let workdir = '/';
  const copies: CopyRule[] = [];
  let cmd = '';
  for (const raw of runLines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const wd = line.match(/^WORKDIR\s+(.+)$/i);
    if (wd) {
      workdir = wd[1].trim();
      continue;
    }
    const cm = line.match(/^CMD\s+(.+)$/i);
    if (cm) {
      cmd = cm[1].trim();
      continue;
    }
    if (!/^COPY\s/i.test(line)) continue;
    let rest = line.replace(/^COPY\s+/i, '').trim();
    let fromStage = false;
    // 剥掉 --from= / --chown= / --chmod= / --link 等选项
    for (;;) {
      const opt = rest.match(/^--([a-zA-Z]+)=("[^"]*"|\S+)\s*/);
      if (opt) {
        if (opt[1] === 'from') fromStage = true;
        rest = rest.slice(opt[0].length);
        continue;
      }
      const flag = rest.match(/^--(link|parents)\s+/);
      if (flag) {
        rest = rest.slice(flag[0].length);
        continue;
      }
      break;
    }
    const parts = rest.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const dest = parts[parts.length - 1];
    for (const src of parts.slice(0, -1)) copies.push({ source: src, dest, fromStage, raw: line });
  }
  return { workdir, copies, cmd, stages: stageStarts.length };
}

/** 仓库相对文件在镜像内的落点；未被任何运行阶段 COPY 覆盖 ⇒ null */
function imagePathFor(view: DockerfileView, file: string): string | null {
  for (const c of view.copies) {
    if (c.fromStage) continue;
    const src = c.source.replace(/^\.\//, '').replace(/\/$/, '');
    const destAbs = posix.isAbsolute(c.dest) ? c.dest : posix.join(view.workdir, c.dest);
    if (file === src) return posix.normalize(destAbs);
    if (file.startsWith(`${src}/`)) return posix.normalize(posix.join(destAbs, file.slice(src.length + 1)));
  }
  return null;
}

// ═══════════════════════════ .dockerignore 匹配 ═══════════════════════════
function ignorePatternMatches(pattern: string, rel: string): boolean {
  const p = pattern.replace(/\\/g, '/').replace(/^\//, '').replace(/\/$/, '');
  if (!p) return false;
  if (!/[*?[]/.test(p)) {
    return rel === p || rel.startsWith(`${p}/`) || rel.split('/').includes(p);
  }
  const toRx = (s: string): RegExp =>
    new RegExp(
      `^${s
        .split('')
        .map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch))
        .join('')
        .replace(/\[\^\/\]\*\[\^\/\]\*/g, '.*')}$`,
    );
  if (toRx(p).test(rel)) return true;
  if (!p.includes('/')) {
    const base = rel.split('/').pop() ?? '';
    return toRx(p).test(base);
  }
  return false;
}

function dockerignoreExcludes(text: string, rel: string): boolean {
  let excluded = false;
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    if (ignorePatternMatches(pattern, rel)) excluded = !negated;
  }
  return excluded;
}

// ═══════════════════════════ 读输入 ═══════════════════════════
const DOCKERFILE_TEXT = readFileSync(join(APP, 'Dockerfile'), 'utf8');
const DOCKERIGNORE_TEXT = readFileSync(join(APP, '.dockerignore'), 'utf8');
const view = parseDockerfile(DOCKERFILE_TEXT);

const ENTRIES = ['scripts/emit-neutral.ts', 'scripts/emit-roombook.ts'];
const closure = computeRuntimeClosure(ENTRIES);

/**
 * 从 emit 入口源码**推导**"按路径读取"的资源（不硬编码 —— 硬编码会被"改个文件名"骗过）。
 * 两个入口的形状是 `const RULES_PATH = join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json')`，
 * 而 `here` = 脚本自身所在目录（生产 = /app/scripts）。所以把它按 `scripts/` 解析成仓库相对路径。
 */
function derivePathReadResources(entries: string[]): Array<{ path: string; from: string }> {
  const out: Array<{ path: string; from: string }> = [];
  for (const e of entries) {
    const text = stripComments(readFileSync(join(APP, e), 'utf8'));
    const re = /join\(\s*here\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const segs = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
      out.push({ path: posix.normalize(posix.join(posix.dirname(e), ...segs)), from: e });
    }
  }
  return out;
}

const PATH_READ = derivePathReadResources(ENTRIES);
const PATH_READ_RESOURCES = PATH_READ.map((p) => p.path);

/** B1 用：闭包 ∪ 推导出的按路径读资源 */
const REQUIRED_FOR_IMAGE = [...closure.runtime, ...PATH_READ_RESOURCES];
/** E1 用：**固定**的必需集（含硬钉的规则集路径）—— 不随推导结果漂移，否则 E 段会跟着新的推导结果一起红，判红原因就说不清了 */
const KNOWN_REQUIRED = [...closure.runtime, 'src/core/ruleset/factory-default.json'];

/** 关键运行期文件（缺一个，导出就在生产断掉）：
 *  来源必须可查 —— server.mjs 里 EMIT_NEUTRAL_TS / EMIT_ROOMBOOK_TS 的钉法，
 *  以及两个 emit 入口的运行期 import 链。 */
const CRITICAL = [
  'scripts/emit-neutral.ts',
  'scripts/emit-roombook.ts',
  'src/core/manufacturing/index.ts',
  'src/core/manufacturing/bridge.ts',
  'src/core/manufacturing/derive.ts',
  'src/core/geometry/project.ts',
  'src/core/geometry/views.ts',
  'src/core/layoutModel.ts',
  'src/export/roomBook.ts',
  'src/export/neutralSheet.ts',
];

const FRONTEND_DIRS = ['src/ui/', 'src/state/', 'src/viewport/'];
const FRONTEND_FILES = ['src/main.tsx', 'src/styles.css'];

// ═══════════════════════════ A 闭包基线 ═══════════════════════════
section('A 闭包基线（运行期 import 闭包）');
console.log(`    闭包文件数 = ${closure.runtime.length}（另 ${closure.erased.length} 个只被 type 引用、strip 后擦除）`);
console.log(`    裸模块 = ${closure.bare.join(', ') || '(无)'}`);

ok('A1. 闭包非空且无解析失败的相对路径', closure.runtime.length > 0 && closure.unresolved.length === 0, {
  unresolved: closure.unresolved,
});
ok('A2. 关键运行期文件全部在闭包内', CRITICAL.every((f) => closure.runtime.includes(f)), {
  missing: CRITICAL.filter((f) => !closure.runtime.includes(f)),
});
{
  const leak = closure.runtime.filter((f) => FRONTEND_DIRS.some((d) => f.startsWith(d)) || FRONTEND_FILES.includes(f));
  ok('A3. 闭包内不含任何前端源码（ui/state/viewport/main.tsx/styles.css）', leak.length === 0, { leak });
}
{
  const outside = closure.runtime.filter((f) => !f.startsWith('scripts/') && !f.startsWith('src/'));
  ok('A4. 闭包全部落在 scripts/ 或 src/ 之下', outside.length === 0, { outside });
}
{
  const tsx = closure.runtime.filter((f) => f.endsWith('.tsx'));
  ok('A5. 闭包内无 .tsx（运行期不涉及 JSX/React）', tsx.length === 0, { tsx });
}
{
  const nonNode = closure.bare.filter((b) => !b.startsWith('node:'));
  ok('A6. 闭包只依赖 node: 内置模块（运行镜像无需额外 npm 依赖）', nonNode.length === 0, { nonNode, bare: closure.bare });
}
{
  const expectedDirs = ['src/core/', 'src/export/'];
  const dirs = [...new Set(closure.runtime.filter((f) => f.startsWith('src/')).map((f) => f.split('/').slice(0, 2).join('/') + '/'))];
  ok('A7. 闭包的 src/ 目录集合恰好是 src/core/ 与 src/export/', dirs.every((d) => expectedDirs.includes(d)), {
    dirs,
    escaped: dirs.filter((d) => !expectedDirs.includes(d)),
  });
}
{
  const erasure = closure.erased;
  ok('A8. 被 strip-types 擦除的文件只有已知 3 个（commandBus/placement/types）', erasure.length === 3 && erasure.every((f) => /commandBus\.ts|placement\.ts|types\.ts$/.test(f)), { erasure });
}

// ═══════════════════════════ B Dockerfile 覆盖 ═══════════════════════════
section('B Dockerfile 运行阶段覆盖');
console.log(`    运行阶段 COPY 规则：\n${view.copies.map((c) => `      ${c.fromStage ? '[stage] ' : '        '}${c.source}  ->  ${c.dest}`).join('\n')}`);

{
  const uncovered = REQUIRED_FOR_IMAGE.filter((f) => imagePathFor(view, f) === null);
  ok('B1. 闭包 ∪ 按路径读资源 全部被运行阶段 COPY 覆盖', uncovered.length === 0, { uncovered });
}
{
  const bad = PATH_READ_RESOURCES.map((f) => [f, imagePathFor(view, f), posix.join(view.workdir, f)] as const).filter(
    ([, got, want]) => got !== want,
  );
  ok('B2. 按路径读资源的落点精确（emit 靠自身位置推 RULES_PATH）', bad.length === 0, { bad });
}
{
  // 显式钉住 P10.0 §1.5 点名的那个坑：规则集 JSON 不出现在 import 图里，只被按路径读。
  const f = 'src/core/ruleset/factory-default.json';
  const got = imagePathFor(view, f);
  ok('B2b. 规则集 JSON 明确在覆盖清单内且落点正确', PATH_READ_RESOURCES.includes(f) && got === posix.join(view.workdir, f), {
    derived: PATH_READ_RESOURCES,
    got,
  });
}
{
  const bad = ENTRIES.map((f) => [f, imagePathFor(view, f), posix.join(view.workdir, f)] as const).filter(([, got, want]) => got !== want);
  ok('B3. 两个 emit 入口落点精确 = /app/scripts/*.ts', bad.length === 0, { bad });
}
{
  const got = imagePathFor(view, 'py/export_dxf.py');
  ok('B4. ezdxf 序列化器 py/export_dxf.py 仍在镜像内（既有行为回归）', got === '/app/py/export_dxf.py', { got });
}
{
  ok('B5. WORKDIR 仍是 /app（ROOT=join(server 目录,"..") 的前提）', view.workdir === '/app', { workdir: view.workdir });
}
{
  const hasServerCmd = /server\/server\.mjs/.test(view.cmd);
  ok('B6. CMD 仍是 node server/server.mjs（未改启动方式）', hasServerCmd, { cmd: view.cmd });
}

// ═══════════════════════════ C 范围纪律 ═══════════════════════════
section('C 范围纪律（不扩大镜像）');
{
  const coveredFrontend = [...FRONTEND_DIRS, ...FRONTEND_FILES].filter((f) => {
    const probe = f.endsWith('/') ? `${f}index.ts` : f;
    return imagePathFor(view, probe) !== null;
  });
  ok('C1. 运行阶段不 COPY 任何前端源码', coveredFrontend.length === 0, { coveredFrontend });
}
{
  const wholeSrc = imagePathFor(view, 'src/core/types.ts') !== null && imagePathFor(view, 'src/ui/App.tsx') !== null;
  ok('C2. 运行阶段没有整目录 COPY src（那会把前端源码也带进去）', !wholeSrc, {
    hint: '判定方式：src/ui/App.tsx 若也被覆盖 ⇒ 说明是 COPY src ./src',
  });
}
{
  const forbidden = ['verify/bus-acceptance.ts', 'docs/P10.0-MCP-Architecture-Review.md', 'spike/x.ts', 'node_modules/foo/index.js', '.env', 'memory/accounts.json'];
  const leak = forbidden.filter((f) => imagePathFor(view, f) !== null);
  ok('C3. 运行阶段不 COPY verify/docs/spike/node_modules/.env/memory', leak.length === 0, { leak });
}

// ═══════════════════════════ D 构建上下文 ═══════════════════════════
section('D 构建上下文（.dockerignore）');
{
  const mustBePresent = [...closure.runtime, ...PATH_READ_RESOURCES];
  const wronglyExcluded = mustBePresent.filter((f) => dockerignoreExcludes(DOCKERIGNORE_TEXT, f));
  ok('D1. .dockerignore 不排除任何运行期依赖（否则 COPY 无源）', wronglyExcluded.length === 0, { wronglyExcluded });
}
{
  const mustBeExcluded = ['.env', 'memory/accounts.json', 'memory/audit.jsonl', 'memory/corrections.jsonl'];
  const notExcluded = mustBeExcluded.filter((f) => !dockerignoreExcludes(DOCKERIGNORE_TEXT, f));
  ok('D2. .dockerignore 仍排除 .env 与 memory/*（本地账号/审计/记忆绝不进镜像）', notExcluded.length === 0, { notExcluded });
}
{
  const excluded = ['node_modules/lodash/index.js', 'dist/assets/app.js', 'verify/bus-acceptance.ts', 'docs/x.md'];
  const notExcluded = excluded.filter((f) => !dockerignoreExcludes(DOCKERIGNORE_TEXT, f));
  ok('D3. .dockerignore 仍排除 node_modules/dist/verify/docs', notExcluded.length === 0, { notExcluded });
}

// ═══════════════════════════ E 检查器自检（反恒真）═══════════════════════════
// 为什么必须有这一段：**恒真的断言比失败更危险**。下面用合成 Dockerfile 证明
// 「覆盖判定」与「越界判定」真的会红 —— 否则 B/C 两组可能只是永远绿。
section('E 检查器自检（证明断言不是恒真）');
{
  const broken: DockerfileView = parseDockerfile(`
FROM node:22-slim AS build
FROM node:22-slim
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY py ./py
`);
  const uncovered = KNOWN_REQUIRED.filter((f) => imagePathFor(broken, f) === null);
  ok('E1. 合成 Dockerfile（缺 COPY scripts/src）⇒ 覆盖判定必须报未覆盖', uncovered.length > 0, { uncovered: uncovered.slice(0, 5) });
  ok('E1b. 且必须报出 emit-neutral 与规则集 JSON', uncovered.includes('scripts/emit-neutral.ts') && uncovered.includes('src/core/ruleset/factory-default.json'), { uncovered });
}
{
  const leaky = parseDockerfile(`
FROM node:22-slim
WORKDIR /app
COPY src ./src
COPY scripts ./scripts
`);
  const wholeSrc = imagePathFor(leaky, 'src/core/types.ts') !== null && imagePathFor(leaky, 'src/ui/App.tsx') !== null;
  ok('E2. 合成 Dockerfile（COPY src ./src）⇒ 整目录判定必须报「带进了前端源码」', wholeSrc, { wholeSrc });
}
{
  const surgical = parseDockerfile(`
FROM node:22-slim
WORKDIR /app
COPY scripts ./scripts
COPY src/core ./src/core
COPY src/export ./src/export
`);
  const got = imagePathFor(surgical, 'src/core/ruleset/factory-default.json');
  ok('E3. 合成 Dockerfile（目录粒度）⇒ 规则集 JSON 判定为已覆盖', got === '/app/src/core/ruleset/factory-default.json', { got });
  const noCore = parseDockerfile(`
FROM node:22-slim
WORKDIR /app
COPY scripts ./scripts
COPY src/export ./src/export
`);
  ok('E4. 合成 Dockerfile（漏 COPY src/core）⇒ 规则集 JSON 判定必须报未覆盖', imagePathFor(noCore, 'src/core/ruleset/factory-default.json') === null);
}
{
  const withIgnore = (pat: string): boolean => dockerignoreExcludes(pat, 'src/core/ruleset/factory-default.json');
  ok('E5. .dockerignore 判定自检：`src` 会命中、`docs` 不会命中', withIgnore('src') === true && withIgnore('docs') === false, {
    src: withIgnore('src'),
    docs: withIgnore('docs'),
  });
}

// ═══════════════════════════ F 成对完整性 + 逃逸登记 ═══════════════════════════
section('F 成对完整性 / 镜像内 import 逃逸登记');
{
  console.log(`    从 emit 源码推导出的按路径读资源：${PATH_READ.map((p) => `${p.path}（来自 ${p.from}）`).join('、') || '(推导为空)'}`);
  ok('F1. 从 emit 源码推导出至少 1 个按路径读取的资源（推导失效即红）', PATH_READ.length > 0, { PATH_READ });
  const missing = PATH_READ.filter((p) => {
    try {
      return !statSync(join(APP, p.path)).isFile();
    } catch {
      return true;
    }
  });
  ok('F2. 推导出的按路径读资源都真实存在（把文件名改错 ⇒ 红）', missing.length === 0, { missing, derived: PATH_READ_RESOURCES });
  ok('F3. src/core/commandBus.ts 在镜像内（随 COPY src/core）', imagePathFor(view, 'src/core/commandBus.ts') !== null);
  ok('F4. src/ai/memory.ts 与 commandBus 成对覆盖（commandBus 运行期 import 它）', imagePathFor(view, 'src/ai/memory.ts') !== null, {
    why: 'src/core/commandBus.ts:13  import { formatGateError } from "../ai/memory.ts"',
  });

  // 逃逸登记：镜像内存在、但它 import 的文件不在镜像内 —— 必须全部是「导出路径永不加载」的惰性死代码。
  //   （例：src/core/designScore/score.ts 运行期 import src/ai/knowledge/*，而 designScore 不在 emit 闭包内
  //     ⇒ 生产永不加载 ⇒ 属可接受冗余。一旦这种文件出现在导出路径上，生产就会当场断。）
  const inImage = enumerateCoveredRepoFiles(view);
  const escapes: Array<{ file: string; target: string }> = [];
  for (const f of inImage) {
    for (const im of importsOf(f)) {
      if (im.typeOnly) continue;
      if (im.rel === null || imagePathFor(view, im.rel) === null) escapes.push({ file: f, target: im.rel ?? `(解析不到 ${im.spec})` });
    }
  }
  const onExportPath = escapes.filter((e) => closure.runtime.includes(e.file));
  ok('F5. 镜像内 import 逃逸的文件必须全部不在导出运行期闭包内（否则生产必断）', onExportPath.length === 0, {
    onExportPath,
    全部逃逸: escapes.map((e) => `${e.file} -> ${e.target}`),
  });
  console.log(`    · 登记：镜像内因惰性死代码造成的 import 逃逸 ${escapes.length} 处（不在导出路径上，可接受）：`);
  for (const e of escapes.slice(0, 10)) console.log(`        ${e.file} -> ${e.target}`);
}

// ═══════════════════════════ 汇总 ═══════════════════════════
console.log(`\n══════════════════════════════════════════════`);
console.log(`  P10.0 S0 镜像闭包验收：通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log(`失败项：\n  · ${fails.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：运行期闭包已被 Dockerfile 覆盖，且未扩大镜像范围。');
