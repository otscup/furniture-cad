/**
 * 服务端导出前置校验 CLI：stdin 读 { project }，stdout 写 ERROR/WARNING 摘要。
 *
 * 唯一校验来源是现有 CommandBus.derive()，不在导出层另造规则；Node 以
 * --experimental-strip-types 执行，和 emit-neutral.ts 使用同一运行模式。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';

const here = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json');

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const input = JSON.parse(await readStdin()) as { project?: Project };
  if (!input.project || typeof input.project !== 'object') throw new Error('缺少有效的 project');

  const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8')) as RuleSet;
  const issues = new CommandBus(input.project, rules).derive().issues;
  const relevant = issues
    .filter((issue) => issue.severity === 'ERROR' || issue.severity === 'WARNING')
    .map(({ severity, code, target, targetKind, message, fixHint }) => ({
      severity,
      code,
      target,
      targetKind,
      message,
      ...(fixHint ? { fixHint } : {}),
    }));
  process.stdout.write(JSON.stringify({
    blockingErrors: relevant.filter((issue) => issue.severity === 'ERROR').length,
    warnings: relevant.filter((issue) => issue.severity === 'WARNING').length,
    issues: relevant,
  }));
}

main().catch((error: unknown) => {
  process.stderr.write(`ERR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
