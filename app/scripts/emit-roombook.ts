/**
 * CLI：stdin 读 { project, modelVersion } → stdout 写「按房间图纸册」HTML。
 *
 * 与 emit-neutral 同一模式：几何必须在后端从语义模型重算，
 * 不接受浏览器上传的图元（那份几何没人校验过）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
import { buildRoomBook, roomBookHtml } from '../src/export/roomBook.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let input: { project?: Project; modelVersion?: string; rulesPath?: string; layoutRoomIds?: string[] };
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
  const book = buildRoomBook(input.project, rules, input.modelVersion ?? 'unknown');
  process.stdout.write(roomBookHtml(book, { layoutRoomIds: input.layoutRoomIds }));
}

main().catch((e: unknown) => {
  process.stderr.write(`ERR: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
