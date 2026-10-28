/**
 * cad.get_views / cad.render / cad.set_project 的自检。
 *
 * 三件事各自证明"确实通了"，而不是"文件里有这段代码"：
 *   1. get_views 能把图元读回来（模型毫米坐标，含文字图元）—— 这是写工具缺的那一半；
 *   2. render 能落盘一张真 PNG（无 Chrome 的环境只跳过这一条并明说）；
 *   3. set_project 的 customerHeight 一旦设置，人体工学规则真的会被触发（ERGO-* 出现）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleProject } from '../src/core/docFactory.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { setCustomerHeight } from '../src/core/commands.ts';
import type { Project, RuleSet } from '../src/core/types.ts';
import { drawingViews, renderView } from '../server/exportCore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const rules = JSON.parse(readFileSync(join(app, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const project: Project = sampleProject(rules);

async function main(): Promise<void> {
  // 1) list：每只柜都有四个视图，名称是人话
  const list = (await drawingViews(project)) as any;
  const cab = list?.cabinets?.[0];
  ok('get_views 列清单：至少一只柜', Array.isArray(list?.cabinets) && list.cabinets.length >= 1);
  ok('get_views 列清单：四视图齐全', cab?.views?.length === 4, JSON.stringify(cab?.views?.map((v: any) => v.kind)));
  ok('get_views 列清单：视图名是中文人话', cab?.views?.every((v: any) => typeof v.nameZh === 'string' && v.nameZh.length > 0),
    JSON.stringify(cab?.views?.map((v: any) => v.nameZh)));
  ok('get_views 列清单：内部结构图有图元', (cab?.views?.find((v: any) => v.kind === 'internal')?.primCount ?? 0) > 50);

  // 2) prims：把图元读回来，形状与文字都在
  const prims = (await drawingViews(project, { view: 'internal', op: 'prims' })) as any;
  ok('get_views 读图元：数量与清单一致', prims?.primCount === prims?.prims?.length);
  ok('get_views 读图元：含折线', (prims?.prims ?? []).some((p: any) => p.k === 'poly'));
  ok('get_views 读图元：含文字（否则模型读不到标注）', (prims?.prims ?? []).some((p: any) => p.k === 'text'));

  // 3) png：真落盘。找不到浏览器就明说跳过（环境问题，不是代码失败）。
  const chrome = process.env.FURNICAD_CHROME ?? '';
  const chromeLikely = chrome
    ? existsSync(chrome)
    : ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
       '/usr/bin/google-chrome', '/usr/bin/chromium'].some((p) => existsSync(p));
  if (!chromeLikely) {
    console.log('  · 跳过 PNG 渲染断言：本机没找到 Chrome/Edge（可用 FURNICAD_CHROME 指定）');
  } else {
    const png = (await renderView(project, { view: 'front', widthPx: 800 })) as any;
    ok('render 返回落盘路径', typeof png?.path === 'string' && png.path.endsWith('.png'), JSON.stringify(png).slice(0, 200));
    ok('render 真的写出了 PNG', existsSync(png?.path ?? '') && statSync(png.path).size > 5000,
      png?.path ?? '(无路径)');
  }

  // 4) set_project：身高一设，人体工学规则必须真的跑起来
  const bus = new CommandBus(structuredClone(project), rules);
  const before = bus.issues().filter((i) => String(i.code).startsWith('ERGO-')).length;
  bus.execute(setCustomerHeight(bus.getState().customerHeight, 600, 'mcp'));
  const after = bus.issues().filter((i) => String(i.code).startsWith('ERGO-'));
  ok('set_project 写入 customerHeight', bus.getState().customerHeight === 600);
  ok('set_project 触发人体工学规则（身高 600mm 时应有 ERGO-* 告警）', after.length > 0, `before=${before} after=${after.length}`);

  console.log(`\n[drawing-tools] ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('ERR:', e instanceof Error ? e.message : e);
  process.exit(1);
});
