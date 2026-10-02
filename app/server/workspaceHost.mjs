/**
 * ══════════════════════════════════════════════════════════════════════
 *  Workspace 主机（P10.0 · S2）—— 服务端持有唯一的 Workspace 持久实体
 *
 *  ── 它在整体里的位置 ──
 *   S1 建好了 `src/workspace/workspace.ts` 的 `WorkspaceStore`（持有 Semantic Model，
 *   不重新定义它），但当时**没有接进 server**。S2 把 MCP 接到真实 Workspace 上，
 *   就必须先在服务端把这个实体装起来 —— 本文件只做这件事，不做别的：
 *     · 从这里装载/新建 **同一个** WorkspaceStore（不建 MCP 专属内存模型）；
 *     · 落盘走 S1 的进程内串行写队列（server/writeQueue.mjs 的 writeFileAtomic）；
 *     · 装载失败**不静默重建**（那等于把用户的工作区悄悄换掉），把错误如实交回调用方。
 *
 *  ── 为什么规则集按路径读，而不是 import ──
 *   与 scripts/emit-*.ts 同一条既有规则（那两个入口也是按路径读
 *   `src/core/ruleset/factory-default.json`）。规则集 JSON 不进 import 图，
 *   任何"只拷 import 闭包"的方案都会漏掉它 —— verify:image-closure 已单独守住这条。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic } from './writeQueue.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/** 规则集落点（唯一真相源，与 emit 入口共用同一份）。 */
export const RULES_PATH = join(ROOT, 'src', 'core', 'ruleset', 'factory-default.json');

/**
 * 装载（或首次新建）服务端 Workspace。
 *
 * @param {object} opts
 * @param {string} opts.filePath  Workspace 文件落点（JSON）
 * @param {string} [opts.owner]   新建时的归属账号（local-open 模式下为 'local-open'）
 * @param {string} [opts.account]
 * @param {(event: object) => void} [opts.onEvent] 装载/新建/失败事件（供审计）
 * @returns {Promise<{ok:true, workspace:any} | {ok:false, error:string, filePath:string}>}
 */
export async function openWorkspace(opts) {
  const { filePath, owner = 'local-open', account = 'local-open', onEvent = () => {} } = opts;
  /**
   * 事件通知是**旁路**，绝不能反过来决定装载结果。
   * 真踩过：审计文件不可写时（数据目录只读 / 路径某一层是文件），onEvent 里那声
   * `auth.audit(...)` 会抛，于是整只工作区变成"装载失败" —— 一个纯通知把主体功能带崩了。
   * 所以通知一律吞掉异常：装载成功就是成功，落不下那行审计由 /api/health 的
   * dataWritable 如实报出，不需要在这里二次表达。
   */
  const notify = (event) => {
    try {
      onEvent(event);
    } catch {
      /* 见上：通知失败不改变装载结果 */
    }
  };
  const { WorkspaceStore } = await import('../src/workspace/workspace.ts');
  const rules = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
  /** 落盘仍经同一个进程内串行写队列 —— 与账号库写入口是同一条保护。 */
  const persist = (content) => writeFileAtomic(filePath, content);

  /**
   * draft 持久化（P10.0 · S4）。
   * 位置：workspace 文件同目录下的 `drafts/`（§8.3 要求"落在数据卷上"；
   * S1 用的是单文件布局而非 `workspaces/<id>/` 目录，这里取同目录是同一意图的最小实现）。
   * 写仍经串行写队列；content 为 null = 删除（apply/discard 后）。
   */
  const draftsDir = join(dirname(filePath), 'drafts');
  const persistDraft = async (draftId, content) => {
    const safeId = String(draftId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const p = join(draftsDir, `${safeId}.json`);
    if (content === null) {
      // 删除：调用方（apply/discard 后）已 await 完之前的 save，不存在写竞争；幂等
      const { unlinkSync } = await import('node:fs');
      try {
        unlinkSync(p);
      } catch {
        /* 文件不存在也不报错 */
      }
      return;
    }
    mkdirSync(draftsDir, { recursive: true });
    await writeFileAtomic(p, content);
  };
  const loadDrafts = async () => {
    if (!existsSync(draftsDir)) return [];
    return readdirSync(draftsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ draftId: f.replace(/\.json$/, ''), content: readFileSync(join(draftsDir, f), 'utf8') }));
  };
  const draftIO = { persistDraft, loadDrafts };

  if (existsSync(filePath)) {
    try {
      const workspace = WorkspaceStore.load({
        filePath,
        rules,
        persist,
        readRaw: () => readFileSync(filePath, 'utf8'),
        ...draftIO,
      });
      const dl = await workspace.loadPersistedDrafts();
      notify({
        action: 'workspace.load',
        result: 'ok',
        workspaceId: workspace.workspaceId,
        liveModelVersion: workspace.getLiveModelVersion(),
        filePath,
        draftsRestored: dl.loaded.length,
        draftsSkipped: dl.skipped.length,
      });
      return { ok: true, workspace, filePath };
    } catch (e) {
      /**
       * 文件存在但读不了 ⇒ **不重建、不覆盖**。
       * 静默重建会把用户的工作区换成一个空样例，而且看不出发生过什么。
       * 如实回报，由 /mcp 工具返回结构化错误，服务器其余部分照常工作。
       */
      notify({ action: 'workspace.load', result: 'fail', filePath, error: String(e?.message ?? e) });
      return { ok: false, error: String(e?.message ?? e), filePath };
    }
  }

  const workspace = WorkspaceStore.create({ filePath, rules, persist, owner, account, ...draftIO });
  await workspace.save();
  notify({
    action: 'workspace.create',
    result: 'ok',
    workspaceId: workspace.workspaceId,
    liveModelVersion: workspace.getLiveModelVersion(),
    filePath,
  });
  return { ok: true, workspace, filePath };
}
