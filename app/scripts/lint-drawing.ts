/**
 * CLI：stdin 读 { project, rulesPath? } → stdout 写 { ok, cabinets, primsChecked, issues }。
 *
 * 为什么单独开一个进程：server/*.mjs 是纯 ESM，几何与派生全在 TypeScript 里
 * （同 scripts/emit-neutral.ts 的理由）。这是"在 Node 里跑 TS"这一件事，不是构建步骤。
 *
 * 与 cad.validate 的分工：validate 回答"柜子做不做得出"，这里回答"图纸印出来能不能读"。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Issue, Project, RuleSet } from '../src/core/types.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { lintPrims } from '../src/core/geometry/drawingLint.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { project?: Project; rulesPath?: string };
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write('ERR: stdin 不是合法 JSON\n');
    process.exit(2);
  }
  if (!input.project) {
    process.stderr.write('ERR: 缺少 project\n');
    process.exit(2);
  }
  const rules = JSON.parse(readFileSync(input.rulesPath ?? RULES_PATH, 'utf8')) as RuleSet;
  const cabinets = input.project.cabinets ?? [];
  const issues: Issue[] = [];
  let primsChecked = 0;

  for (const cab of cabinets) {
    let vs;
    try {
      vs = buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
    } catch (e: unknown) {
      // 派生失败本身就是最严重的图纸缺陷：纸上根本没有这只柜子。
      issues.push({
        severity: 'ERROR',
        code: 'DRAW_VIEW_BUILD_FAILED',
        target: cab.id,
        targetKind: 'cabinet',
        message: `柜体「${cab.name}」派生视图失败：${e instanceof Error ? e.message : String(e)}`,
        fixHint: '这份柜体在图纸上会缺图，先修几何再说排版。',
      });
      continue;
    }
    const kinds = Object.keys(vs.prims) as Array<keyof typeof vs.prims>;
    for (const kind of kinds) {
      const prims = vs.prims[kind];
      if (!prims || prims.length === 0) continue;
      primsChecked += prims.length;
      issues.push(...lintPrims(prims, { view: `${cab.name}·${vs.meta[kind]?.nameZh ?? String(kind)}`, target: cab.id }));
    }
  }

  const bySeverity = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const i of issues) bySeverity[i.severity] += 1;
  process.stdout.write(JSON.stringify({ ok: true, cabinets: cabinets.length, primsChecked, summary: bySeverity, issues }, null, 2));
}

main().catch((e: unknown) => {
  process.stderr.write(`ERR: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
