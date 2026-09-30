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
  const body = toFileProject(project);
  /**
   * schemaVersion **跟着内容走**（P0 定的口径，P2 沿用）：
   *   · 项目里出现了 v0.3 结构（多行柜 / 组合）⇒ 写 `0.3`；
   *   · 否则仍是 `0.2` —— 存量文件读进来再存盘**逐字节不变**。
   * 这样做的原因：版本号不是"程序版本"，是"这份文件里用了哪些结构"。
   * 提前把所有文件升到 0.3，只会让每个旧项目都产生一次无意义的 diff，
   * 而真正需要旧版本拒绝的那两类文件（多行 / 有组合）反而混在里头认不出来。
   */
  body.schemaVersion = resolveSchemaVersion(body);
  const env: ProjectFileEnvelope = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: PROJECT_FILE_FORMAT_VERSION,
    savedAt,
    project: body,
  };
  return JSON.stringify(env, null, 2);
}

/**
 * 这份文件实际用到哪个模型版本。
 *
 * 判定只有一处 —— 若让各处自己写 `if (assemblies) '0.3' else '0.2'`，
 * 版本号迟早在两条路径上给出不同的答案，而版本号错了没有任何报错，
 * 只有"旧版本打开新文件"时那句莫名其妙的失败。
 */
export function resolveSchemaVersion(project: Project): string {
  const hasRows = project.cabinets.some((c) => Array.isArray(c.layout?.rows) && c.layout.rows.length > 1);
  const hasAssemblies = Array.isArray(project.assemblies) && project.assemblies.length > 0;
  return hasRows || hasAssemblies ? '0.3' : '0.2';
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
  const openingIds = new Set<string>();
  const cabIds = new Set<string>();
  const unitIds = new Set<string>();
  /** 柜体 → 房间（组合缺 roomId 时用它从成员反推，可确定、不是猜） */
  const cabRoomOf = new Map<string, string>();

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
      // 门窗洞口（P8.7，可选字段）：旧文件没有它；有则校验**形状**（id/kind/整数）。
      // span 是否落在墙内属于语义校验 → 空间校验器报 SPATIAL-OPENING-SPAN issue，
      // 不在这里拒绝整个文件 —— 让用户能在界面里把洞口调回来，而不是打不开项目。
      if (w.openings !== undefined) {
        if (!Array.isArray(w.openings)) return { ok: false, error: `墙 ${String(w.id)} 的 openings 不是数组` };
        for (const o of w.openings as unknown[]) {
          if (typeof o !== 'object' || o === null) return { ok: false, error: `墙 ${String(w.id)} 的洞口有非法成员` };
          const op = o as { id: unknown; kind: unknown; offset: unknown; width: unknown };
          if (typeof op.id !== 'string' || op.id === '') return { ok: false, error: `墙 ${String(w.id)} 的洞口缺少 id` };
          if (openingIds.has(op.id)) return { ok: false, error: `洞口 id 重复：${op.id}` };
          openingIds.add(op.id);
          if (op.kind !== 'door' && op.kind !== 'window') {
            return { ok: false, error: `洞口 ${op.id} 的 kind 必须是 "door" 或 "window"（收到 ${JSON.stringify(op.kind)}）` };
          }
          if (!isInt(op.offset) || (op.offset as number) < 0) {
            return { ok: false, error: `洞口 ${op.id} 的 offset 必须是 ≥0 的整数（沿墙从起点量起，mm）` };
          }
          if (!isInt(op.width) || (op.width as number) <= 0) {
            return { ok: false, error: `洞口 ${op.id} 的 width 必须是正整数（mm）` };
          }
        }
      }
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
    // 落位 provenance（P8.5-B，可选）：字段非法 → 视为缺失（unknown），不阻断打开。
    // 它只是「来源说明」，缺了顶多不知道这柜怎么来的，比因一个坏字段拒绝整个文件安全。
    {
      const pp = (c as Record<string, unknown>).placementProvenance;
      if (pp !== undefined && (typeof pp !== 'object' || pp === null || !('authority' in (pp as object)))) {
        delete (c as Record<string, unknown>).placementProvenance;
      }
    }
    if (typeof cab.id !== 'string' || cab.id === '') return { ok: false, error: `柜体缺少 id` };
    if (cabIds.has(cab.id)) return { ok: false, error: `柜体 id 重复：${cab.id}` };
    cabIds.add(cab.id);
    cabRoomOf.set(cab.id, cab.roomId as string);
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

  /**
   * ⑦ 组合（v0.3，P2）—— 缺省即无组合，旧文件不受影响。
   *
   * ── 分层：这里只挡【会引发事故的】，其余交给校验器 ──
   *   · 挡：id 重复、成员指向不存在的柜体、关系指向组合外的柜体、kind/edge 取值非法。
   *     这些是"装进去就会静默错"的 —— 悬空引用会让整组操作少动一个柜，
   *     id 撞车会让改一个动到另一个。
   *   · 不挡：缺 name / 缺 roomId / 缺 connections / 空成员。
   *     这些**不会崩**，只是不完整 —— 用可确定的值兜底并给 warning，
   *     业务上的对错由加载后的 `validateAssemblies()` 说（它会对空组合报 ERROR）。
   *
   * ── 为什么必须这么宽容 ──
   *   迁移验收 E 组有一条"未来字段不炸旧读者"的护栏：文件里躺着一个**字段不全**
   *   的 assemblies（旧版本或人工改的），新版本必须还能打开。
   *   把"缺 name"变成"打不开"，等于让回滚路径上的文件全部变成废纸 ——
   *   这比留一条 warning 糟得多。拒绝只留给真的会出事故的那些。
   */
  if (Array.isArray(p.assemblies)) {
    const asmIds = new Set<string>();
    for (const a of p.assemblies as unknown[]) {
      if (typeof a !== 'object' || a === null || Array.isArray(a)) return { ok: false, error: 'assemblies 里有非法成员' };
      const asm = a as { id?: unknown; name?: unknown; roomId?: unknown; memberIds?: unknown; connections?: unknown };
      if (typeof asm.id !== 'string' || asm.id === '') return { ok: false, error: '组合缺少 id' };
      if (asmIds.has(asm.id)) return { ok: false, error: `组合 id 重复：${asm.id}` };
      asmIds.add(asm.id);
      // 缺 name：用 id 顶上（不是"猜一个名字"，是回退到已有的唯一标识）
      if (typeof asm.name !== 'string' || asm.name === '') {
        (a as { name: string }).name = asm.id;
        warnings.push(`组合 ${asm.id} 缺少 name，已用 id 顶替`);
      }
      const memberIds = Array.isArray(asm.memberIds) ? (asm.memberIds as unknown[]) : [];
      if (!Array.isArray(asm.memberIds)) warnings.push(`组合 ${asm.id} 缺少 memberIds，已按空组合处理`);
      if (!Array.isArray(asm.connections)) {
        (a as { connections: unknown[] }).connections = [];
        warnings.push(`组合 ${asm.id} 缺少 connections，已按没有关系处理`);
      }
      const seenMember = new Set<string>();
      for (const mid of memberIds) {
        if (typeof mid !== 'string' || !cabIds.has(mid)) return { ok: false, error: `组合 ${asm.id} 的成员 ${JSON.stringify(mid ?? null)} 不是项目里的柜体` };
        if (seenMember.has(mid)) return { ok: false, error: `组合 ${asm.id} 的成员重复：${mid}` };
        seenMember.add(mid);
      }
      // 缺/错 roomId：从成员身上取（可确定的，不是猜）；取不到就留空，由校验器报错
      const inferredRoom = memberIds.length > 0 ? cabRoomOf.get(String(memberIds[0])) : undefined;
      if (typeof asm.roomId !== 'string' || !roomIds.has(asm.roomId)) {
        if (inferredRoom) {
          (a as { roomId: string }).roomId = inferredRoom;
          warnings.push(`组合 ${asm.id} 的 roomId 缺失或指向不存在的房间，已按第一个成员所在房间取「${inferredRoom}」`);
        } else {
          warnings.push(`组合 ${asm.id} 的 roomId 指向不存在的房间，且没有成员可推断`);
        }
      }
      if (!Array.isArray(asm.connections)) return { ok: false, error: `组合 ${asm.id} 的 connections 必须是数组` };
      const connIds = new Set<string>();
      for (const c of asm.connections as unknown[]) {
        if (typeof c !== 'object' || c === null || Array.isArray(c)) return { ok: false, error: `组合 ${asm.id} 的 connections 里有非法成员` };
        const conn = c as { id: unknown; kind: unknown; a: unknown; b: unknown; origin: unknown };
        if (typeof conn.id !== 'string' || conn.id === '') return { ok: false, error: `组合 ${asm.id} 有连接缺少 id` };
        if (connIds.has(conn.id)) return { ok: false, error: `组合 ${asm.id} 的连接 id 重复：${conn.id}` };
        connIds.add(conn.id);
        if (conn.kind !== 'corner' && conn.kind !== 'butt' && conn.kind !== 'stack') {
          return { ok: false, error: `组合 ${asm.id} 的连接 ${conn.id} 的 kind 非法（只能是 corner / butt / stack）` };
        }
        for (const side of [conn.a, conn.b]) {
          if (typeof side !== 'object' || side === null) return { ok: false, error: `组合 ${asm.id} 的连接 ${conn.id} 缺少一端` };
          const end = side as { cabinetId: unknown; edge?: unknown };
          if (typeof end.cabinetId !== 'string' || end.cabinetId === '') {
            return { ok: false, error: `组合 ${asm.id} 的连接 ${conn.id} 缺少 cabinetId` };
          }
          if (!seenMember.has(end.cabinetId)) {
            return { ok: false, error: `组合 ${asm.id} 的连接 ${conn.id} 指向了组合外的柜体 ${end.cabinetId}` };
          }
          if (end.edge !== undefined && end.edge !== 'back' && end.edge !== 'front' && end.edge !== 'left' && end.edge !== 'right') {
            return { ok: false, error: `组合 ${asm.id} 的连接 ${conn.id} 的 edge 非法（只能是 back / front / left / right）` };
          }
        }
        if (conn.origin !== undefined && conn.origin !== 'authored' && conn.origin !== 'inferred') {
          return { ok: false, error: `组合 ${asm.id} 的连接 ${conn.id} 的 origin 非法（只能是 authored / inferred）` };
        }
      }
    }
  }

  const savedAt = typeof o.savedAt === 'string' ? o.savedAt : '';
  return { ok: true, project: p, savedAt, warnings };
}
