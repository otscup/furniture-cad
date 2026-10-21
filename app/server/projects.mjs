/**
 * ══════════════════════════════════════════════════════════════════════
 *  多项目管理（项目目录）
 *
 *  ── 设计 ──
 *   用户按客户组织项目："某某小区李先生" 是一个项目，项目下有多个房间。
 *   每个项目是一个独立的 workspace 文件，存于 data/projects/{id}.json。
 *   当前激活的项目由 data/active-project.json 记录。
 *
 *  ── 兼容 ──
 *   旧版单文件 data/workspace.json 在首次启动时自动迁移为第一个项目。
 *
 *  ── API ──
 *   GET  /api/projects          列出项目（id, name, roomCount, updatedAt）
 *   POST /api/projects          创建项目 {name} → {id, name}
 *   POST /api/projects/:id/activate  切换当前项目
 *   DELETE /api/projects/:id    删除项目（不能删当前激活的）
 *
 * ── 三条硬纪律（2026-10-20 审计整改，勿删）──────────────────────────────
 *  1. **projectId 只能由 parseProjectId() 产出**。它同时做字符白名单与
 *     "解析后仍在 projectsDir 内"的断言。历史事故：DELETE 分支直接
 *     decodeURIComponent 就进 join()，`..%2f..%2f..%2faccounts` 把账号库删掉，
 *     重启后 auth 降级成 local-open（免鉴权）。所以 GET/DELETE/activate
 *     三条路由**必须**共用这一处判断，不许各写一遍。
 *  2. **文件格式只有一个写入口**：createProject 走 serializeProjectFile()，
 *     不许再手搓 {project, version} 信封。历史事故：信封缺 format 字段，
 *     WorkspaceStore.load 一律拒收，导致"新建的项目永远无法激活"。
 *  3. **所有写盘走 writeQueue**（tmp + rename 原子替换 + 每路径串行）。
 *     历史事故：裸 writeFileSync 与 workspace.json 的写队列互踩。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, statSync, renameSync } from 'node:fs';
import { join, resolve, sep, basename } from 'node:path';
import { writeFileAtomic } from './writeQueue.mjs';

/** projectId 允许的字符集。与 server.mjs 的 activate 分支历史口径一致。 */
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 项目文件名的扩展名 */
const PROJECT_EXT = '.json';

function projectsDir(dataDir) {
  return join(dataDir, 'projects');
}

function activeProjectPath(dataDir) {
  return join(dataDir, 'active-project.json');
}

function ensureProjectsDir(dataDir) {
  const dir = projectsDir(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 把外部传入的 projectId 归一化成**可安全用于拼路径**的值。
 *
 * @param {unknown} raw 原始值（可能已 decode、也可能没有）
 * @returns {{ok:true, id:string} | {ok:false, code:string, error:string}}
 *
 * 做三件事，缺一不可：
 *   ① 解码（调用方可能传的是 URL 片段）—— 解码失败即拒；
 *   ② 字符白名单 —— 从根上排除 `/`、`\\`、`..`、空字节；
 *   ③ 解析后断言仍在 projectsDir 内 —— 即使白名单将来被放宽，这里仍兜底。
 */
export function parseProjectId(dataDir, raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(raw ?? ''));
  } catch {
    return { ok: false, code: 'PROJECT_ID_INVALID', error: '项目 ID 编码无效' };
  }
  if (!PROJECT_ID_RE.test(decoded)) {
    return { ok: false, code: 'PROJECT_ID_INVALID', error: '项目 ID 无效（只允许字母、数字、下划线、连字符，1~64 位）' };
  }
  // 双保险：白名单已排除路径分隔符，这里再断言一次解析结果落在 projects 目录内。
  const dir = ensureProjectsDir(dataDir);
  const target = resolve(dir, decoded + PROJECT_EXT);
  if (target !== resolve(dir, basename(target)) || !target.startsWith(resolve(dir) + sep)) {
    return { ok: false, code: 'PROJECT_ID_INVALID', error: '项目 ID 解析后越出项目目录' };
  }
  return { ok: true, id: decoded };
}

/**
 * 首次迁移：旧单文件 workspace.json → projects/{id}.json
 *
 * 两个历史缺陷在这条路上（都已修）：
 *   a. 迁移只换文件名、不改文件内 project.id ⇒ 激活时 PROJECT_ID_MISMATCH 必 409。
 *      修法：把 id 写进 project 本体再落盘。
 *   b. 迁移后没有"认领"标记 ⇒ **每个账号**打开都会各导入一份同一份旧数据
 *      （跨租户数据泄露）。修法：与 server.mjs 的账号级迁移同口径 ——
 *      成功后把旧文件改名成 .migrated，后来者再也认领不到。
 */
export async function migrateIfNeeded(dataDir, oldWorkspacePath) {
  const dir = ensureProjectsDir(dataDir);
  // 已有项目，不需迁移
  const existing = readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT));
  if (existing.length > 0) return null;
  // 没有旧文件，也不需迁移
  if (!existsSync(oldWorkspacePath)) return null;

  try {
    const content = readFileSync(oldWorkspacePath, 'utf-8');
    const data = JSON.parse(content);
    const projectName = data?.project?.name || data?.name || '默认项目';
    const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    /**
     * 关键修复 (a)：文件名与文件内 project.id 必须是同一个值。
     * 直接把 id 写进 project 本体，而不是原样拷贝内容。
     */
    const project = data?.project ?? data;
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error('旧工作区文件里没有可迁移的项目数据');
    }
    project.id = id;
    if (!project.name) project.name = projectName;

    /**
     * 关键修复 (c)：**schemaVersion 必须补齐**。
     *
     *   历史缺陷（fix-tests 在变异验证中实测到）：旧 workspace.json 若本来就带
     *   `format` 字段，代码只会补 project、不会补 schemaVersion —— 而
     *   parseProjectFile 要求它在，于是"迁移成功"的文件一载入就报
     *   `project.schemaVersion 缺失`，项目激活仍然失败。
     *
     *   正确做法：**幂等地补齐所有 parseProjectFile 必需的字段**，
     *   而不是靠 "envelope.format 在不在" 去推断。这样无论旧文件长什么样都能载入。
     */
    if (typeof project.schemaVersion !== 'string' || !project.schemaVersion) {
      const { resolveSchemaVersion } = await import('../src/core/projectFile.ts');
      project.schemaVersion = resolveSchemaVersion(project);
    }
    if (!Array.isArray(project.rooms)) project.rooms = [];
    if (!Array.isArray(project.cabinets)) project.cabinets = [];
    if (typeof project.ruleSetId !== 'string' || !project.ruleSetId) {
      project.ruleSetId = 'factory_default_v1';
    }

    const envelope = {
      // 保留旧文件里已有的信封字段（workspaceId / owner / liveModelVersion 等），
      // 只覆盖 project —— 旧文件若本来就是合法 Workspace 信封，这样最保真。
      ...(data && typeof data === 'object' && !Array.isArray(data) ? data : {}),
      project,
    };
    // format/formatVersion/savedAt 一律补齐（不要用"format 在不在"当整体判据）
    const { PROJECT_FILE_FORMAT, PROJECT_FILE_FORMAT_VERSION } = await import('../src/core/projectFile.ts');
    if (envelope.format !== PROJECT_FILE_FORMAT) envelope.format = PROJECT_FILE_FORMAT;
    if (!Number.isInteger(envelope.formatVersion)) envelope.formatVersion = PROJECT_FILE_FORMAT_VERSION;
    if (typeof envelope.savedAt !== 'string' || !envelope.savedAt) envelope.savedAt = new Date().toISOString();

    const projectFile = join(dir, `${id}${PROJECT_EXT}`);
    await writeFileAtomic(projectFile, JSON.stringify(envelope, null, 2));
    await writeAtomicJson(activeProjectPath(dataDir), { activeId: id });

    /**
     * 关键修复 (b)：认领后改名，防止第二个账号再认领同一份旧数据。
     * 与 server.mjs openAccountWorkspace 里的 .migrated 口径一致。
     */
    try {
      renameSync(oldWorkspacePath, oldWorkspacePath + '.migrated');
    } catch {
      /* 改名失败不阻塞迁移本身；最坏情况是下一个账号可能重复认领 */
    }

    return { id, name: project?.name ?? projectName, migratedFrom: oldWorkspacePath };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** 内部：把对象原子写成 JSON（统一走 writeQueue）。 */
async function writeAtomicJson(path, obj) {
  await writeFileAtomic(path, JSON.stringify(obj, null, 2));
}

export function listProjects(dataDir) {
  const dir = ensureProjectsDir(dataDir);
  const files = readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT));
  /**
   * 这里**不能**调 getActiveProjectId —— 历史事故：getActiveProjectId 在没有
   * active-project.json 时回调 listProjects，两者互相递归，新账号第一次
   * GET /api/projects 直接 RangeError（栈溢出）。改为单向下读文件。
   */
  const activeId = readActiveProjectId(dataDir);
  return files.map((f) => {
    const id = f.replace(/\.json$/, '');
    const fp = join(dir, f);
    try {
      const content = JSON.parse(readFileSync(fp, 'utf-8'));
      const project = content?.project ?? content;
      const rooms = project?.rooms ?? [];
      const stat = statSync(fp);
      return {
        id,
        name: project?.name || id,
        roomCount: rooms.length,
        cabinetCount: (project?.cabinets ?? []).length,
        updatedAt: stat.mtimeMs,
        isActive: id === activeId,
      };
    } catch {
      return { id, name: id, roomCount: 0, cabinetCount: 0, updatedAt: 0, isActive: id === activeId, broken: true };
    }
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 只读 active-project.json，**不做任何 listProjects 回调**。
 * 这是递归 bug 的修复点：兜底分支改为直接看目录里第一个文件名。
 */
export function readActiveProjectId(dataDir) {
  const ap = activeProjectPath(dataDir);
  if (existsSync(ap)) {
    try {
      const data = JSON.parse(readFileSync(ap, 'utf-8'));
      if (data && typeof data.activeId === 'string' && data.activeId) return data.activeId;
    } catch {
      /* 文件损坏 ⇒ 走下面的兜底 */
    }
  }
  // 兜底：取目录里第一个项目文件名（不再调 listProjects）
  try {
    const dir = ensureProjectsDir(dataDir);
    const first = readdirSync(dir).filter((f) => f.endsWith(PROJECT_EXT)).sort()[0];
    return first ? first.replace(/\.json$/, '') : null;
  } catch {
    return null;
  }
}

/** 兼容旧名（外部只读调用方仍可用）。 */
export function getActiveProjectId(dataDir) {
  return readActiveProjectId(dataDir);
}

export function getProjectFilePath(dataDir, projectId) {
  const parsed = parseProjectId(dataDir, projectId);
  if (!parsed.ok) throw new Error(parsed.error);
  return join(ensureProjectsDir(dataDir), `${parsed.id}${PROJECT_EXT}`);
}

/**
 * 新建项目。
 *
 * 文件格式**必须**走 serializeProjectFile() —— 它是项目文件形状的唯一出口
 * （format / formatVersion / schemaVersion / layout 塌陷都在那里）。
 * 历史事故：手搓 {project, version:1} 缺 format 字段 ⇒ WorkspaceStore.load 拒收
 * ⇒ "新建的项目永远无法激活"。
 */
export async function createProject(dataDir, name) {
  const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const fp = getProjectFilePath(dataDir, id);
  const { emptyProject } = await import('../src/core/docFactory.ts');
  const { serializeProjectFile } = await import('../src/core/projectFile.ts');
  const project = emptyProject({ name: String(name ?? '').trim() || '未命名项目', ruleSetId: 'factory_default_v1', id });
  const content = serializeProjectFile(project);
  await writeFileAtomic(fp, content);
  return { id, name: project.name };
}

export async function setActiveProject(dataDir, projectId) {
  const fp = getProjectFilePath(dataDir, projectId);
  if (!existsSync(fp)) throw new Error(`项目不存在：${projectId}`);
  await writeAtomicJson(activeProjectPath(dataDir), { activeId: projectId });
  return { ok: true, activeId: projectId };
}

export async function deleteProject(dataDir, projectId) {
  const activeId = readActiveProjectId(dataDir);
  if (projectId === activeId) throw new Error('不能删除当前激活的项目，请先切换到其他项目');
  const fp = getProjectFilePath(dataDir, projectId);
  if (!existsSync(fp)) throw new Error(`项目不存在：${projectId}`);
  unlinkSync(fp);
  return { ok: true };
}
