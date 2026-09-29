import type { BBox, Cabinet, Issue, Prim, Project, RuleSet, StylePreset, UnitSpec } from './types.ts';
import { createCabinet, defaultNickname, defaultUnits, makeUnit } from './docFactory.ts';
import { generateCabinet } from './geometry/generate.ts';
import { buildCabinetViews } from './geometry/views.ts';
import { validateCabinet } from './rules/validate.ts';
import { candidateSpots } from './snapPlace.ts';
import { nextId } from './ids.ts';
import { allUnits, canonicalUnits, layoutRows } from './layoutModel.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  方案候选（Variants）—— 「先出正面图 → 出两个风格 → 选完再出四视图」
 *
 *  ── 这个文件存在的唯一理由，是守住一句话 ──
 *
 *      **中间产物是「候选语义方案」，不是「正面图」。**
 *
 *    如果中间产物是正面图，那么"600 的进深从哪来"就没有答案：
 *    正面图里只有宽和高，四视图只能靠猜 —— 而"猜"出来的东西对不上正面图，
 *    正是 views.ts 用结构映射（长对正 / 高平齐 / 宽相等）消灭掉的那类问题。
 *    见 docs/Design-Local-Pick-Edit-and-Staged-Generation.md §3.2
 *
 *  ── 所以这里做的是 ──
 *      一份规格 + N 个风格预设  →  N 份【候选语义模型】
 *      每份候选各自派生出它的正视图（**只用于对比，不看它反推任何东西**）
 *      每份候选各自带着自己的 problem list（选风格时就能看到问题，不用选完才发现）
 *      选定之后才走 CMD.createCabinet 落地 —— **候选不是模型，选定才成为模型**
 *
 *  ── 铁律 ──
 *    1. 候选柜体**不在任何 Project 里**。它是纯产物，落盘/入栈之前不是真相源。
 *    2. 正面图是**派生视图**，只读。这里从不"按图纸反推参数"。
 *    3. 派生失败要说出来，不许静默跳过（与 generateProject 的容错策略相反：
 *       那里是"单柜出错不能拖垮整幅图"，这里是"这一份方案本身有问题，必须报"）。
 * ══════════════════════════════════════════════════════════════════════
 */

const mm = (v: number): number => Math.round(v);

export interface VariantSpec {
  name: string;
  width: number;
  height: number;
  depth: number;
  roomId: string;
  x?: number;
  y?: number;
  /** 省略则用规则集默认（defaultCabinetParams） */
  bodyLift?: number;
}

export interface VariantStats {
  panelKinds: number;
  pieces: number;
  boardAreaM2: number;
  estWeightKg: number;
}

export interface VariantDraft {
  /** 候选 id（只在这个对比会话里有意义，不是模型 id） */
  id: string;
  presetId: string;
  nameZh: string;
  note?: string;
  /** ── 候选语义模型。**还没成为真相源** ── */
  cabinet: Cabinet;
  /** 正视图图元（派生）。只用于对比，不用于反推 */
  front: Prim[];
  /** 正视图图框（派生）。用它取景，保证多个方案的缩略图尺度一致 */
  frontBox: BBox | null;
  issues: Issue[];
  stats: VariantStats;
  /** 一眼看出这份方案和别处差在哪 —— 给界面用 */
  summary: string;
  /** 派生失败的原因。有值时界面必须用告警样式显示，不许当成"没问题" */
  error?: string;
}

/**
 * 分区宽按**比例**算。
 *
 * 最后一个分区吃掉取整余量 —— 与 `defaultUnits` 的做法一致（`c = width - a - b`）。
 * 否则 ΣrequestedWidth ≠ width，在 `fit_total` 下会让整柜窄/宽那么一点点，
 * 而这种"差 1mm"正是这个项目最不能接受的一类问题（见主方案 §F 余量归属）。
 */
function unitsFromPreset(preset: StylePreset, width: number, rules: RuleSet): UnitSpec[] | null {
  const defs = preset.units;
  if (!defs || defs.length === 0) return null; // 省略 = 用 defaultUnits
  const total = defs.reduce((a, u) => a + u.ratio, 0);
  if (!(total > 0)) return null; // 比例全是 0 也当作没配，走默认
  const out: UnitSpec[] = [];
  const taken = new Set<string>();
  let used = 0;
  defs.forEach((u, i) => {
    const isLast = i === defs.length - 1;
    const w = isLast ? width - used : Math.round((width * u.ratio) / total);
    used += w;
    /**
     * `takenIds` 必须逐个累积 —— 少了它，每个分区拿到的都是 `unit_001`。
     * 后果不是"看起来重复"这么轻：板件 id 是 `…_unit_00N_SH1` 拼出来的，
     * 三个分区都叫 unit_001 就会让多块板件撞成同一个 id，
     * 校验器报 `DUP-PANEL-ID`，而**清单里两块不同的板会变成一块** ——
     * 到了生产就是下错料。这种撞法在任何一层都不报错，只是静默共用一条记录。
     * （「通体四门」只有一个分区，所以这个缺陷在它身上完全看不出来。）
     */
    const unit = makeUnit({
      kind: u.kind,
      requestedWidth: w,
      nickname: u.nickname,
      rules,
      count: u.count,
      rodHeight: u.rodHeight,
      takenIds: taken,
      // 门板必须经由 makeUnit 挂 —— 它引用规则集里的 pickHinge()，调用方不该自己挑铰链
      doors: u.doors
        ? {
            count: u.doors.count,
            gapMid: u.doors.gapMid ?? preset.doorDefaults?.gapMid,
            gapOuter: u.doors.gapOuter ?? preset.doorDefaults?.gapOuter,
          }
        : undefined,
    });
    taken.add(unit.id);
    out.push(unit);
  });
  return out;
}

/** 两处派生都会产出 issue，合并后按 `code|target` 去重（不重复报同一件事） */
function mergeIssues(a: Issue[], b: Issue[]): Issue[] {
  const seen = new Set<string>();
  const out: Issue[] = [];
  for (const i of [...a, ...b]) {
    const k = `${i.code}|${i.target}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(i);
  }
  return out;
}

function summarize(cab: Cabinet): string {
  /**
   * 走 canonical 读法（`layoutRows` / `allUnits`）：
   * 多行柜按约定不写 `units` 镜像，直接读 `cab.layout.units` 会拿到 `undefined`
   * → 在方案对比面板里抛异常（整个面板打不开）。单行柜下这与原来的取法逐位相同。
   * 多行时把行号带进文案 —— 否则"5 个分区"会被读成"一整排 5 格"。
   */
  const rows = layoutRows(cab.layout);
  const multi = rows.length > 1;
  const us = allUnits(cab.layout);
  const tag = (u: UnitSpec, ri: number): string => `${multi ? `R${ri + 1} ` : ''}${u.nickname ?? defaultNickname(u.kind)}`;
  const names = rows.flatMap((r, ri) => r.units.map((u) => `${tag(u, ri)} ${u.requestedWidth}`)).join(' / ');
  const doors = rows
    .flatMap((r, ri) => r.units.map((u) => ({ u, ri })))
    .filter((x) => x.u.doors)
    .map((x) => `${tag(x.u, x.ri)} ${x.u.doors!.count} 扇`)
    .join('、');
  const count = multi ? `${rows.length} 行 ${us.length} 个分区` : `${us.length} 个分区`;
  return `${count}：${names}　门：${doors || '无门板'}`;
}

/**
 * 规格 + 风格预设 → N 份候选方案。纯函数，无副作用。
 *
 * 规则集里没配 `stylePresets` 时返回**空数组** ——
 * 界面必须如实说"这个工厂没配风格"，不许悄悄编一套出来。
 */
export function buildVariants(spec: VariantSpec, rules: RuleSet): VariantDraft[] {
  const presets = rules.stylePresets ?? [];
  const out: VariantDraft[] = [];

  for (const preset of presets) {
    const units = unitsFromPreset(preset, mm(spec.width), rules) ?? undefined;
    const cabinet = createCabinet({
      // 明显的占位 id：候选不进项目，采用时会换成真正的 `cab_00N`
      id: `variant__${preset.id}`,
      name: `${spec.name}·${preset.nameZh}`,
      roomId: spec.roomId,
      x: mm(spec.x ?? 0),
      y: mm(spec.y ?? 0),
      rules,
      params: {
        width: mm(spec.width),
        height: mm(spec.height),
        depth: mm(spec.depth),
        ...(spec.bodyLift !== undefined ? { bodyLift: mm(spec.bodyLift) } : {}),
      },
      units,
    });

    const draft: VariantDraft = {
      id: `var_${preset.id}`,
      presetId: preset.id,
      nameZh: preset.nameZh,
      note: preset.note,
      cabinet,
      front: [],
      frontBox: null,
      issues: [],
      stats: { panelKinds: 0, pieces: 0, boardAreaM2: 0, estWeightKg: 0 },
      summary: summarize(cabinet),
    };

    // ① 板件与校验（这一步失败 = 这份方案本身不成立，必须报出来）
    try {
      const geom = generateCabinet(cabinet, rules);
      draft.issues = mergeIssues(geom.issues, validateCabinet(cabinet, geom, rules));
      draft.stats = {
        panelKinds: geom.stats.panelKinds,
        pieces: geom.stats.totalPieces,
        boardAreaM2: geom.stats.boardAreaM2,
        estWeightKg: geom.stats.estWeightKg,
      };
    } catch (e) {
      draft.error = `板件派生失败：${e instanceof Error ? e.message : String(e)}`;
    }

    // ② 正视图（只取 front，不取 hinge / labels —— 衔接线是"视图之间"的连线，
    //    单视图下没有意义；整幅标注同理。这不是另画一遍，是取同一次派生的产物。）
    try {
      const vs = buildCabinetViews(cabinet, rules);
      draft.front = vs.prims.front;
      draft.frontBox = vs.meta.front.bbox;
    } catch (e) {
      draft.error = draft.error
        ? `${draft.error}；正视图派生失败：${e instanceof Error ? e.message : String(e)}`
        : `正视图派生失败：${e instanceof Error ? e.message : String(e)}`;
    }

    out.push(draft);
  }

  return out;
}

/**
 * 采用一份候选：换掉所有占位 id，返回一份可以直接交给 `CMD.createCabinet` 的柜体。
 *
 * 为什么必须换 id：候选里的 `variant__xxx` / `unit_001` 是**对比会话内部**的编号，
 * 项目里可能已经存在同名的 `unit_001`（defaultUnits 就是从 unit_001 开始编的）。
 * 直接落进去会撞 id，而这种撞法不报错 —— 它会静默地让两个分区共用一条记录。
 */
export function adoptVariant(draft: VariantDraft, project: Project): Cabinet {
  const taken = new Set<string>();
  for (const c of project.cabinets) taken.add(c.id);
  for (const r of project.rooms) for (const w of r.walls) taken.add(w.id);
  for (const r of project.rooms) taken.add(r.id);
  for (const c of project.cabinets) for (const u of allUnits(c.layout)) taken.add(u.id);

  const cabId = nextId('cab', taken);
  taken.add(cabId);

  const units = canonicalUnits(draft.cabinet.layout).map((u) => {
    const uid = nextId('unit', taken);
    taken.add(uid);
    return { ...u, id: uid };
  });

  return { ...draft.cabinet, id: cabId, layout: { ...draft.cabinet.layout, units } };
}

/**
 * 落点必须避开的判据：**撞墙 / 撞柜**。
 *
 * 为什么只列这两条，而不是"有 ERROR 就不放"：
 * 方案本身可能带 ERROR（比如 3600 宽下单扇门超宽），那是**这一份方案**的问题，
 * 界面上已经列出来、用户是看着它决定采用的；它跟"放在哪儿"没关系。
 * 拿它去否决落点，结果就是所有落点都被否掉、采用永远失败 ——
 * 而"因为门太宽所以放不下"这种提示对用户是完全误导的。
 */
export const PLACEMENT_BLOCKING_CODES = new Set(['RULE-CABINET-IN-WALL', 'RULE-CABINET-OVERLAP']);

export interface PlacedVariant {
  cabinet: Cabinet;
  /** 贴到了哪面墙（空串 = 房间没有墙，按候选自带位置放） */
  wallName: string;
}

/**
 * 给候选柜体挑一个放得下的落点。
 *
 * **判断"放不放得下"不在这里做** —— probe 由调用方用 CommandBus 的 dryRun 实现。
 * 原因：干涉与撞墙的判据只有一份（校验器 + 记忆门），
 * 在这里再写一遍 AABB 就是第二份真相源，两边迟早算出不一样的答案。
 *
 * 返回 null = 一串落点全试过都不行，调用方必须如实告诉用户"放不下"，
 * 不许退化成"按 (0,0) 放进去再说" —— 那正是这次缺陷的来源。
 */
export function placeVariant(
  cab: Cabinet,
  project: Project,
  probe: (trial: Cabinet) => boolean
): PlacedVariant | null {
  for (const s of candidateSpots(project, cab.roomId, cab.params.width)) {
    const trial: Cabinet = {
      ...cab,
      placement: { ...cab.placement, x: s.x, y: s.y, rotation: s.rotation },
    };
    if (probe(trial)) return { cabinet: trial, wallName: s.wallName };
  }
  // 房间没有墙（极少数情况）：退回候选自带位置，但**仍要过 probe**
  return probe(cab) ? { cabinet: cab, wallName: '' } : null;
}

/** 这份方案里最该被看见的问题（ERROR 优先，其次 WARNING），没有则返回 null */
export function topIssue(draft: VariantDraft): Issue | null {
  const err = draft.issues.find((i) => i.severity === 'ERROR');
  if (err) return err;
  return draft.issues.find((i) => i.severity === 'WARNING') ?? null;
}

/** 没有配风格时给界面用的一句话 —— 不许在界面上硬编码这个理由 */
export function noPresetReason(rules: RuleSet): string {
  return `规则集「${rules.name}」里没有配置 stylePresets，所以没有可对比的风格。换工厂 = 换规则集文件。`;
}

/** 供"默认分区"对照：不用任何预设造出来的柜体长什么样（用于验收对照） */
export function defaultVariant(spec: VariantSpec, rules: RuleSet): Cabinet {
  return createCabinet({
    id: 'variant__default',
    name: `${spec.name}·默认`,
    roomId: spec.roomId,
    x: mm(spec.x ?? 0),
    y: mm(spec.y ?? 0),
    rules,
    params: { width: mm(spec.width), height: mm(spec.height), depth: mm(spec.depth) },
    units: defaultUnits(mm(spec.width), rules, mm(spec.depth)),
  });
}
