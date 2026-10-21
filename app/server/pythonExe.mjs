/**
 * ══════════════════════════════════════════════════════════════════════
 *  Python 解释器解析 —— 唯一实现
 *
 * ── 历史缺陷（2026-10-20 审计）──
 *   server.mjs / exportCore.mjs / verify/export-acceptance.ts 各写了一份同构实现，
 *   候选表里 `'python3'` 排在 `'python'` 之前，而**裸命令名无法 existsSync，会被直接保留**
 *   ⇒ 在 Windows（只有 `python`，没有 `python3`）上永远返回不存在的 `python3`：
 *       Error: spawn python3 ENOENT
 *   于是 `verify:export` 在本机整体跑不起来，导出链路**从未被真实验证**。
 *
 * ── 本实现的口径 ──
 *   1. 显式路径（含 / 或 \）必须真实存在才用；
 *   2. **裸命令名也要探测**（PATH 里能不能真的执行），不再"保留作兜底"；
 *   3. 优先级：APP_PYTHON → 项目根 .venv → app/.venv → python3 → python → py(Windows 启动器)；
 *   4. 一个都没有 ⇒ 返回 null，由调用方给出明确错误（不许假装导出成功）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** 判断一个裸命令名能否真的执行（Windows 的 where / POSIX 的 command -v）。 */
function commandExists(cmd) {
  try {
    if (process.platform === 'win32') {
      execFileSync('where', [cmd], { stdio: 'ignore', windowsHide: true });
    } else {
      execFileSync('sh', ['-c', `command -v "${cmd}"`], { stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析可用的 Python 解释器。
 * @param {string} appRoot app/ 目录的绝对路径
 * @returns {string | null} 可执行的解释器路径/命令名；找不到返回 null
 */
export function resolvePythonExe(appRoot) {
  const isWin = process.platform === 'win32';
  const candidates = [
    // ① 显式指定永远优先
    process.env.APP_PYTHON,
    // ② 项目根的 .venv（spike 用的就是它）
    join(appRoot, '..', '.venv', isWin ? 'Scripts/python.exe' : 'bin/python'),
    // ③ app/.venv（README 的推荐位置）
    join(appRoot, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python'),
  ].filter(Boolean);

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  // ④ 裸命令名：必须真的能执行才算数（这是历史 bug 的修复点）
  const bare = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
  for (const cmd of bare) {
    if (commandExists(cmd)) return cmd;
  }
  return null;
}
