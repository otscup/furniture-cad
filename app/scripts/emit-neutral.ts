/**
 * CLI：stdin 读 { project, which, modelVersion } → stdout 写中立交换 JSON。
 *
 * 为什么单独开一个进程，而不是让 server.mjs 直接 import TS：
 *   server/server.mjs 是纯 ESM JavaScript，而几何与派生全在 TypeScript 里。
 *   用 `--experimental-strip-types` 跑这个入口，既不用给后端引入构建步骤，
 *   也不用把 .ts 编译产物塞进仓库 —— 它只是"在 Node 里跑 TS"这一件事。
 *
 * 为什么要独立进程而不是让浏览器上传算好的 neutral：
 *   ① 几何必须在**后端**从语义模型重算一遍，才谈得上"派生自同一份真相源"；
 *      接受浏览器上传的图元等于接受一份没人校验过的几何。
 *   ② 浏览器上传几万个点的图元没必要，模型本身只有几 KB。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
// DXF 真正消费制造层：几何 → 制造件 → 回投影板件 → 中立导出（P7 确立的唯一路径）。
// 不再走旧的 toNeutralExport（绕过制造层会让 DXF 板件与开料单分叉）。
import { manufacturingToNeutralExportDefault } from '../src/core/manufacturing/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { project?: Project; which?: Array<'plan' | 'sheet'>; modelVersion?: string; rulesPath?: string; planRoomIds?: string[] };
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
  const which = input.which && input.which.length > 0 ? input.which : ['plan', 'sheet'];
  const out = manufacturingToNeutralExportDefault(input.project, rules, which, input.modelVersion ?? 'unknown', input.planRoomIds);
  process.stdout.write(JSON.stringify(out));
}

main().catch((e: unknown) => {
  process.stderr.write(`ERR: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
