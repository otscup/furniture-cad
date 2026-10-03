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
 *   POST /api/projects/:id/rooms     在项目下创建房间 {name} → room
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

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
 * 首次迁移：旧单文件 workspace.json → projects/{id}.json
 */
export function migrateIfNeeded(dataDir, oldWorkspacePath) {
  const dir = ensureProjectsDir(dataDir);
  // 已有项目，不需迁移
  const existing = readdirSync(dir).filter(f => f.endsWith('.json'));
  if (existing.length > 0) return null;
  // 没有旧文件，也不需迁移
  if (!existsSync(oldWorkspacePath)) return null;

  try {
    const content = readFileSync(oldWorkspacePath, 'utf-8');
    const data = JSON.parse(content);
    // 用项目名或默认名
    const projectName = data?.project?.name || data?.name || '默认项目';
    const id = `proj_${Date.now().toString(36)}`;
    const projectFile = join(dir, `${id}.json`);
    writeFileSync(projectFile, content, 'utf-8');
    // 设为激活项目
    writeFileSync(activeProjectPath(dataDir), JSON.stringify({ activeId: id }), 'utf-8');
    return { id, name: projectName, migratedFrom: oldWorkspacePath };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

export function listProjects(dataDir) {
  const dir = ensureProjectsDir(dataDir);
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  const activeId = getActiveProjectId(dataDir);
  return files.map(f => {
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

export function getActiveProjectId(dataDir) {
  const ap = activeProjectPath(dataDir);
  if (!existsSync(ap)) {
    // 没有记录，取第一个项目
    const projects = listProjects(dataDir);
    return projects.length > 0 ? projects[0].id : null;
  }
  try {
    const data = JSON.parse(readFileSync(ap, 'utf-8'));
    return data.activeId || null;
  } catch {
    return null;
  }
}

export function getProjectFilePath(dataDir, projectId) {
  return join(ensureProjectsDir(dataDir), `${projectId}.json`);
}

export function createProject(dataDir, name) {
  const id = `proj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const fp = getProjectFilePath(dataDir, id);
  const project = {
    schemaVersion: '0.3',
    id,
    name: name.trim() || '未命名项目',
    ruleSetId: 'factory-default',
    rooms: [],
    cabinets: [],
  };
  // workspace 文件格式：{ project, ... } 还是直接 project？看现有格式
  // 先按 { project } 包一层，与 workspaceHost 的期望一致
  const content = JSON.stringify({ project, version: 1 }, null, 2);
  writeFileSync(fp, content, 'utf-8');
  return { id, name: project.name };
}

export function setActiveProject(dataDir, projectId) {
  const fp = getProjectFilePath(dataDir, projectId);
  if (!existsSync(fp)) throw new Error(`项目不存在：${projectId}`);
  writeFileSync(activeProjectPath(dataDir), JSON.stringify({ activeId: projectId }), 'utf-8');
  return { ok: true, activeId: projectId };
}

export function deleteProject(dataDir, projectId) {
  const activeId = getActiveProjectId(dataDir);
  if (projectId === activeId) throw new Error('不能删除当前激活的项目，请先切换到其他项目');
  const fp = getProjectFilePath(dataDir, projectId);
  if (!existsSync(fp)) throw new Error(`项目不存在：${projectId}`);
  unlinkSync(fp);
  return { ok: true };
}
