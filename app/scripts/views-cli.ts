/**
 * CLI：stdin 读 { op, project, cabinetId?, view?, widthPx?, outDir?, rulesPath? } → stdout 写 JSON。
 *
 * 为什么不放在 server/*.mjs 里：几何派生全在 TypeScript（同 lint-drawing.ts 的理由）。
 * 这个进程只做两件事 —— 把图元读出来（get_views 的回读口），或者渲成 PNG（render 的"眼睛"）。
 *
 * op:
 *   list  → 有哪些柜 / 哪些视图 / 各多少图元
 *   prims → 某个视图的全部图元（模型毫米坐标，Y 向上）
 *   svg   → 某个视图的 SVG 字符串（给测试与调试用）
 *   png   → 无头 Chrome 截图的落盘路径
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Prim, Project, RuleSet } from '../src/core/types.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { primsToSvg } from '../src/export/roomBook.ts';

type ViewKind = 'front' | 'top' | 'side' | 'internal';
const VIEW_KINDS: ViewKind[] = ['front', 'top', 'side', 'internal'];

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json');

interface Input {
  op?: 'list' | 'prims' | 'svg' | 'png';
  project?: Project;
  cabinetId?: string;
  view?: ViewKind;
  widthPx?: number;
  outDir?: string;
  rulesPath?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fail(msg: string, code = 2): never {
  process.stderr.write(`ERR: ${msg}\n`);
  process.exit(code);
}

/** Chrome 位置：环境变量优先，其次各平台常见安装路径。找不到就明确报错，不静默降级。 */
function findChrome(): string {
  const env = process.env.FURNICAD_CHROME;
  if (env && existsSync(env)) return env;
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  fail('找不到 Chrome/Edge，无法渲染 PNG。用 FURNICAD_CHROME 指定可执行文件路径。', 3);
}

function main(): void {
  // 同步读 stdin（spawn 时调用方一次性写完全部输入并关闭）。
  const raw = readFileSync(0, 'utf8');
  let input: Input;
  try {
    input = JSON.parse(raw) as Input;
  } catch {
    fail('stdin 不是合法 JSON');
  }
  if (!input.project) fail('缺少 project');
  const rules = JSON.parse(readFileSync(input.rulesPath ?? RULES_PATH, 'utf8')) as RuleSet;
  const op = input.op ?? 'list';
  const cabinets = input.project.cabinets ?? [];
  if (cabinets.length === 0) fail('项目里还没有柜体');

  const picked = input.cabinetId ? cabinets.filter((c) => c.id === input.cabinetId) : cabinets;
  if (picked.length === 0) fail(`找不到柜体：${input.cabinetId}`);

  const derive = (cab: (typeof cabinets)[number]) => {
    try {
      return buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
    } catch (e: unknown) {
      fail(`柜体「${cab.name}」派生视图失败：${e instanceof Error ? e.message : String(e)}`, 4);
    }
  };

  if (op === 'list') {
    const list = picked.map((cab) => {
      const vs = derive(cab);
      return {
        id: cab.id,
        name: cab.name,
        size: { width: cab.params.width, height: cab.params.height, depth: cab.params.depth },
        views: VIEW_KINDS.map((k) => ({
          kind: k,
          nameZh: vs.meta[k].nameZh,
          primCount: vs.prims[k].length,
        })),
      };
    });
    process.stdout.write(JSON.stringify({ ok: true, op, cabinetCount: picked.length, cabinets: list }));
    return;
  }

  const cab = picked[0]!;
  const view: ViewKind = input.view ?? 'front';
  if (!VIEW_KINDS.includes(view)) fail(`不支持的视图：${String(input.view)}（可选 ${VIEW_KINDS.join('/')}）`);
  const vs = derive(cab);
  const prims: Prim[] = vs.prims[view];

  if (op === 'prims') {
    process.stdout.write(JSON.stringify({
      ok: true, op, cabinetId: cab.id, cabinetName: cab.name,
      view, viewNameZh: vs.meta[view].nameZh, primCount: prims.length, prims,
    }));
    return;
  }

  const svg = primsToSvg(prims, 'furnicad-view');

  if (op === 'svg') {
    process.stdout.write(JSON.stringify({ ok: true, op, cabinetId: cab.id, view, primCount: prims.length, svg }));
    return;
  }

  // png：写一封极简 HTML，交给无头 Chrome 截图。落盘目录优先调用方指定，否则系统临时目录。
  const widthPx = Math.max(400, Math.min(4000, input.widthPx ?? 1600));
  const outDir = input.outDir ?? join(tmpdir(), 'furnicad-renders');
  mkdirSync(outDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'furnicad-render-'));
  const htmlPath = join(scratch, 'view.html');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const pngPath = join(outDir, `${cab.name}-${view}-${stamp}.png`);
  writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#fff}svg{width:100vw;height:100vh;display:block}</style>${svg}`,
    'utf8'
  );
  try {
    execFileSync(findChrome(), [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${widthPx},${widthPx}`, `--screenshot=${pngPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ], { stdio: 'pipe', timeout: 120000 });
  } catch (e: unknown) {
    rmSync(scratch, { recursive: true, force: true });
    fail(`Chrome 截图失败：${e instanceof Error ? e.message : String(e)}`, 5);
  }
  rmSync(scratch, { recursive: true, force: true });
  if (!existsSync(pngPath)) fail('Chrome 没有产出 PNG 文件', 5);
  process.stdout.write(JSON.stringify({
    ok: true, op, cabinetId: cab.id, cabinetName: cab.name, view, viewNameZh: vs.meta[view].nameZh,
    primCount: prims.length, path: pngPath, bytes: statSync(pngPath).size, widthPx, heightPx: widthPx,
  }));
}

main();
