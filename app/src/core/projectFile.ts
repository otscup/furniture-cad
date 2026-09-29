/**
 * ══════════════════════════════════════════════════════════════════════
 *  项目文件（.json）序列化与解析 —— Task #23「项目存盘与加载」的核心层
 *
 *  ── 这个文件里没有一行 DOM / React / fetch ──
 *  它只回答两个问题：
 *    ① serializeProjectFile：把真相源写成文件（信封 + authored 字段）
 *    ② parseProjectFile：把一份来历不明的字符串变成可信任的 Project，
 *       或者干脆拒绝它 —— **导入的文件是攻击面**，不是数据。
 *
 *  ── 校验哲学（与 rules/validate.ts 同一条路线）──
 *    在这里挡下的应该是【结构非法】：缺字段、id 撞车、悬空引用、非整数尺寸。
 *    至于"柜子是否干涉、门是否超宽"这类【业务非法】，交给加载后的
 *    规则引擎现算 —— 派生数据永远不写进文件，也就永远不该在导入时被信任。
 *
 *  ── 为什么拒绝比宽容好 ──
 *    一个被半宽容地接受、然后画出鬼图（NaN 坐标、幽灵柜体）的文件，
 *    比一句"导入失败：房间 id 重复"危险得多。前者把事故推迟到生产现场。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Project } from './types.ts';
import { toFileProject } from './layoutModel.ts';

export const PROJECT_FILE_FORMAT = 'furniture-cad-project';
export const PROJECT_FILE_FORMAT_VERSION = 1;

/** 信封：外层是文件自己的元信息，project 才是真相源本体 */
export interface ProjectFileEnvelope {
  format: typeof PROJECT_FILE_FORMAT;
  formatVersion: number;
  /** ISO 8601 */
  savedAt: string;
  project: Project;
}

/**
 * 存盘：信封 + authored 字段。
 *
 * 写形状的唯一口径在 `core/layoutModel.ts` 的 `toFileProject()`：
 * **单行柜只写 `units`、多行柜才写 `rows`** —— 存量单行文件保存后逐字节不变
 * （键序也沿用原顺序，所以不会产生"只改了排版"的假 diff）。
 */
export function serializeProjectFile(project: Project, savedAt = new Date().toISOString()): string {
  const env: ProjectFileEnvelope = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: PROJECT_FILE_FORMAT_VERSION,
    savedAt,
    project: toFileProject(project),
  };
  return JSON.stringify(env, null, 2);
}

export type ParseResult =
  | { ok: true; project: Project; savedAt: string; warnings: string[] }
  | { ok: false; error: string };

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isPosInt = (v: unknown): v is number => isInt(v) && v > 0;

/** 分区 id 全局唯一（板件 id 从分区 id 派生 —— 分区撞名，开料清单就会少板件） */
function checkIdsUnique(ids: Iterable<{ id: string }>, what: string, seen: Set<string>): string | null {
  for (const obj of ids) {
    if (typeof obj?.id !== 'string' || obj.id === '') return `${what} 缺少 id`;
    if (seen.has(obj.id)) return `${what} id 重复：${obj.id}`;
    seen.add(obj.id);
  }
  return null;
}

/**
 * 两个分区序列是否"同一批分区、同一顺序"。
 * 用于判定多行文件里的 `units` 镜像是否与 `rows[0].units` 一致 ——
 * 只比 id 与条数：镜像的意义就是"旧读者能看到同一批分区"，别的字段不影响这件事。
 */
function sameUnitIds(a: Array<{ id?: unknown }> | undefined, b: Array<{ id?: unknown }> | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((u, i) => u != null && u.id === b[i]?.id);
}

export function parseProjectFile(raw: string): ParseResult {
  // ① JSON 语法
  let env: unknown;
  try {
    env = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `不是合法的 JSON：${(e as Error).message}` };
  }
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return { ok: false, error: '文件内容不是 JSON 对象' };
  }
  const o = env as Record<string, unknown>;

  // ② 信封：这是本项目导出的文件吗？
  //    拿任何别的 .json（vite 配置、package.json…）来开档，必须在这里被拦下。
  if (o.format !== PROJECT_FILE_FORMAT) {
    return { ok: false, error: `这不是本系统导出的项目文件（format = ${JSON.stringify(o.format ?? null)}）` };
  }
  if (o.formatVersion !== PROJECT_FILE_FORMAT_VERSION) {
    return {
      ok: false,
      error: `文件格式版本 ${JSON.stringify(o.formatVersion ?? null)} 不受支持（当前支持 v${PROJECT_FILE_FORMAT_VERSION}）`,
    };
  }

  // ③ project 本体
  const p = o.project as Project | undefined;
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return { ok: false, error: '缺少 project 字段' };
  if (typeof p.schemaVersion !== 'string' || p.schemaVersion === '') return { ok: false, error: 'project.schemaVersion 缺失' };
  if (typeof p.name !== 'string' || p.name === '') return { ok: false, error: 'project.name 缺失' };
  if (!Array.isArray(p.rooms)) return { ok: false, error: 'project.rooms 必须是数组' };
  if (!Array.isArray(p.cabinets)) return { ok: false, error: 'project.cabinets 必须是数组' };

  const warnings: string[] = [];
  if (typeof p.ruleSetId !== 'string' || p.ruleSetId === '') {
    warnings.push('project.ruleSetId 缺失，将按当前规则集加载并重新校验');
  }

  const roomIds = new Set<string>();
  const wallIds = new Set<string>();
  const cabIds = new Set<string>();
  const unitIds = new Set<string>();

  // ④ 房间与墙
  for (const r of p.rooms as unknown[]) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return { ok: false, error: 'rooms 里有非法成员' };
    const room = r as { id: unknown; name: unknown; walls: unknown };
    if (typeof room.id !== 'string' || room.id === '') return { ok: false, error: `房间缺少 id` };
    if (roomIds.has(room.id)) return { ok: false, error: `房间 id 重复：${room.id}` };
    roomIds.add(room.id);
    if (typeof room.name !== 'string' || room.name === '') return { ok: false, error: `房间 ${room.id} 缺少 name` };
    if (!Array.isArray(room.walls)) return { ok: false, error: `房间 ${room.id} 的 walls 不是数组` };
    const dupWall = checkIdsUnique(room.walls as { id: string }[], `房间 ${room.id} 的墙`, wallIds);
    if (dupWall) return { ok: false, error: dupWall };
    for (const w of room.walls as Array<Record<string, unknown>>) {
      if (typeof w !== 'object' || w === null) return { ok: false, error: `房间 ${room.id} 的墙有非法成员` };
      for (const key of ['start', 'end'] as const) {
        const v = w[key] as { x: unknown; y: unknown } | undefined;
        if (typeof v !== 'object' || v === null) return { ok: false, error: `墙 ${String(w.id)} 的 ${key} 缺失` };
        if (!isInt(v.x) || !isInt(v.y)) {
          return { ok: false, error: `墙 ${String(w.id)} 的 ${key} 坐标不是整数（${JSON.stringify(v)}）—— 生产尺寸里禁止浮点误差` };
        }
      }
      if (!isPosInt(w.thickness)) return { ok: false, error: `墙 ${String(w.id)} 的 thickness 必须是正整数` };
      if (!isPosInt(w.height)) return { ok: false, error: `墙 ${String(w.id)} 的 height 必须是正整数` };
    }
  }

  // ⑤ 柜体
  for (const c of p.cabinets as unknown[]) {
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return { ok: false, error: 'cabinets 里有非法成员' };
    const cab = c as {
      id: unknown;
      name: unknown;
      roomId: unknown;
      placement: unknown;
      params: unknown;
      layout: unknown;
    };
    if (typeof cab.id !== 'string' || cab.id === '') return { ok: false, error: `柜体缺少 id` };
    if (cabIds.has(cab.id)) return { ok: false, error: `柜体 id 重复：${cab.id}` };
    cabIds.add(cab.id);
    if (typeof cab.name !== 'string' || cab.name === '') return { ok: false, error: `柜体 ${cab.id} 缺少 name` };
    if (typeof cab.roomId !== 'string' || !roomIds.has(cab.roomId)) {
      return { ok: false, error: `柜体 ${cab.id} 的 roomId "${String(cab.roomId)}" 不指向任何房间（悬空柜体）` };
    }
    const pl = cab.placement as { x: unknown; y: unknown; rotation: unknown } | undefined;
    if (typeof pl !== 'object' || pl === null) return { ok: false, error: `柜体 ${cab.id} 缺少 placement` };
    if (!isInt(pl.x) || !isInt(pl.y)) {
      return { ok: false, error: `柜体 ${cab.id} 的落位坐标不是整数（${JSON.stringify(pl)}）` };
    }
    if (!isInt(pl.rotation)) return { ok: false, error: `柜体 ${cab.id} 的旋转角不是整数` };

    const params = cab.params as Record<string, unknown> | undefined;
    if (typeof params !== 'object' || params === null) return { ok: false, error: `柜体 ${cab.id} 缺少 params` };
    for (const key of ['width', 'height', 'depth'] as const) {
      if (!isPosInt(params[key])) return { ok: false, error: `柜体 ${cab.id} 的 params.${key} 必须是正整数（实际 ${JSON.stringify(params[key] ?? null)}）` };
    }
    if (typeof params.backPanel !== 'object' || params.backPanel === null) {
      warnings.push(`柜体 ${cab.id} 缺少 params.backPanel，将按当前规则集补默认值`);
    }

    /**
     * 分区（v0.3）：文件里可能写 `units`（单行 = v0.2 形状）、写 `rows`（多行），
     * 或两者都写（多行时 `units` 是 rows[0] 的镜像）。
     *
     * 读侧**权威**在 core/layoutModel.ts —— 这里只做【结构非法】校验，不折算形状：
     * 折算会改动内存里的对象，而 `projectfile-acceptance` 要求"读出来与存进去逐字段
     * 相等"。形状折算属于读取方的口径，不属于校验器的职责。
     */
    const layout = cab.layout as { units?: unknown; rows?: unknown } | undefined;
    if (typeof layout !== 'object' || layout === null) return { ok: false, error: `柜体 ${cab.id} 缺少 layout` };
    const hasUnits = Array.isArray(layout.units);
    const rows = Array.isArray(layout.rows) ? (layout.rows as Array<Record<string, unknown>>) : null;

    if (rows) {
      if (rows.length === 0) return { ok: false, error: `柜体 ${cab.id} 的 layout.rows 是空的 —— 至少保留一行` };
      const rowIds = new Set<string>();
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) return { ok: false, error: `柜体 ${cab.id} 的 rows 里有非法成员` };
        if (typeof row.id !== 'string' || row.id === '') return { ok: false, error: `柜体 ${cab.id} 有行缺少 id` };
        if (rowIds.has(row.id)) return { ok: false, error: `柜体 ${cab.id} 的行 id 重复：${row.id}` };
        rowIds.add(row.id);
        const h = row.height;
        if (!(h === 'fill' || (typeof h === 'number' && Number.isInteger(h) && h > 0))) {
          return {
            ok: false,
            error: `柜体 ${cab.id} 的行 ${row.id} 的 height 必须是正整数或 'fill'（实际 ${JSON.stringify(h ?? null)}）`,
          };
        }
        if (!Array.isArray(row.units) || row.units.length === 0) {
          return { ok: false, error: `柜体 ${cab.id} 的行 ${row.id} 分区是空的 —— 至少保留一个分区，否则不是柜子` };
        }
        /**
         * 跨行撞 id 是**清单事故**（板件 id 由分区 id 派生 → 两块不同的板共用一条
         * 记录 → 生产下错料）。`unitIds` 是项目级的 Set，所以这条同时保证
         * 行内唯一、行间唯一、跨柜唯一 —— 一道检查管三层。
         */
        const dupRowUnit = checkIdsUnique(row.units as { id: string }[], `柜体 ${cab.id} 的行 ${row.id} 的分区`, unitIds);
        if (dupRowUnit) return { ok: false, error: dupRowUnit };
      }
      if (hasUnits && !sameUnitIds(layout.units as Array<{ id: unknown }>, rows[0]!.units as Array<{ id: unknown }>)) {
        warnings.push(`柜体 ${cab.id} 的 layout.units 与 rows[0].units 不一致，已按 rows 为准`);
      }
    } else {
      if (!hasUnits) return { ok: false, error: `柜体 ${cab.id} 缺少 layout.units` };
      const flat = layout.units as unknown[];
      if (flat.length === 0) return { ok: false, error: `柜体 ${cab.id} 的分区是空的 —— 至少保留一个分区，否则不是柜子` };
      const dupUnit = checkIdsUnique(flat as { id: string }[], `柜体 ${cab.id} 的分区`, unitIds);
      if (dupUnit) return { ok: false, error: dupUnit };
    }
  }

  const savedAt = typeof o.savedAt === 'string' ? o.savedAt : '';
  return { ok: true, project: p, savedAt, warnings };
}
