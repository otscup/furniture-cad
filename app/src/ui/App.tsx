import { useCallback, useEffect, useRef, useState } from 'react';
import type { Vec2 } from '../core/types.ts';
import type { Command, ExecResult } from '../core/commandBus.ts';
import * as CMD from '../core/commands.ts';
import { bus, useBusVersion, RULESET } from '../state/store.ts';
import { createCabinet as makeCabinet, createWall as makeWall, DEFAULT_WALL_THICKNESS, DEFAULT_WALL_HEIGHT, rectRoom, sampleProject } from '../core/docFactory.ts';
import { placeAgainstNearestWall } from '../core/snapPlace.ts';
import { DEFAULT_SNAP } from '../viewport/snapping.ts';
import type { SnapSettings } from '../viewport/snapping.ts';
import { defaultHiddenLayers } from '../viewport/layers.ts';
import type { Camera } from '../viewport/camera.ts';
import { Viewport } from './Viewport.tsx';
import { Toolbar } from './Toolbar.tsx';
import type { RightTab } from './Toolbar.tsx';
import { ContextMenu } from './ContextMenu.tsx';
import type { CtxItem } from './ContextMenu.tsx';
import { StatusBar } from './StatusBar.tsx';
import { CommandLine } from './CommandLine.tsx';
import { ObjectTree } from './panels/ObjectTree.tsx';
import { LayersPanel } from './panels/LayersPanel.tsx';
import { PropertiesPanel } from './panels/PropertiesPanel.tsx';
import { IssuesPanel } from './panels/IssuesPanel.tsx';
import { HistoryPanel } from './panels/HistoryPanel.tsx';
import { ViewsPanel } from './panels/ViewsPanel.tsx';
import { MemoryPanel } from './panels/MemoryPanel.tsx';
import { AdminPanel } from './panels/AdminPanel.tsx';
import { AIPanel } from './panels/AIPanel.tsx';
import { AccountPanel } from './panels/AccountPanel.tsx';
import { VariantPanel } from './panels/VariantPanel.tsx';
import { ExportPanel } from './panels/ExportPanel.tsx';
import { loadToken, saveToken } from '../ai/aiClient.ts';
import { loadDraft, saveDraft, clearDraft, fmtSavedAt } from '../state/draftStore.ts';
import type { PickLine } from '../core/geometry/pickLines.ts';
import { noteHit, useCorrections } from '../state/memoryStore.ts';
import { nextToastId } from './types.ts';
import type { Toast, ToastKind, Tool } from './types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  App —— 编排层
 *
 *  职责边界（很重要，防止架构在这层腐蚀）：
 *   · App 只持有【视图状态】（相机、选择、工具、面板开关、图层可见性）
 *   · 模型状态 100% 归 CommandBus，App 只是订阅者
 *   · App 想改模型时，唯一的动作是构造 Command 并 execute —— 和 AI 走同一条路
 * ══════════════════════════════════════════════════════════════════════
 */

export function App() {
  const version = useBusVersion();
  /**
   * 记忆列表要订阅：tab 上那个"待编译"角标必须在新增记忆后立刻更新。
   * 记忆变化极低频，订阅它的代价可以忽略。
   */
  const corrections = useCorrections();
  const memoryPending = corrections.filter((c) => c.status === 'pending').length;

  const [cam, setCam] = useState<Camera>({ cx: 900, cy: 1000, scale: 0.26 });
  const [mode, setModeRaw] = useState<'plan' | 'sheet'>('plan');
  /**
   * 分解图开关。**默认关闭** —— 用户的说法是"4 视图调整好后**可以选择**生成
   * 分解图用于生产，也可以选择关闭"。所以默认状态必须是"关"，
   * 而不是"开着但你可以关"。打开时自动切到图幅模式：分解图是图幅的一部分，
   * 在平面图里打开它什么也看不见，那会让人以为开关坏了。
   */
  const [explode, setExplodeRaw] = useState(false);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<string[]>([]);
  const [snap, setSnap] = useState<SnapSettings>(DEFAULT_SNAP);
  const [showGrid, setShowGrid] = useState(true);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(() => defaultHiddenLayers());
  const [pendingMove, setPendingMove] = useState<{ base: Vec2 | null } | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('props');
  const [leftTab, setLeftTab] = useState<'tree' | 'layers'>('tree');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fitSignal, setFitSignal] = useState(0);
  const [cancelSignal, setCancelSignal] = useState(0);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [lastMsg, setLastMsg] = useState('');
  /**
   * 登录 token 放在 sessionStorage（不是 localStorage）：关掉标签页即失效，
   * 也不跨标签页共享。代价是每次开新标签要重新登录 —— 换来的是
   * "共用这台电脑的另一个人打开浏览器拿不到你的会话"。
   */
  const [token, setTokenRaw] = useState<string | null>(() => loadToken());
  const setToken = useCallback((t: string | null) => {
    setTokenRaw(t);
    saveToken(t);
  }, []);

  // ── 本地草稿 ──
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /**
   * 启动时恢复草稿。
   *
   * 放在自动保存 effect **之前**声明不是随意的：mount 时两个 effect 按声明序执行，
   * 恢复先把旧项目装回总线，随后自动保存才会以恢复后的项目为准 ——
   * 否则第一次自动保存会把默认示例项目写回去，把真草稿冲掉。
   *
   * 恢复采用「直接回来 + 气泡告知」而不是弹窗询问：用户上一句话是
   * "现在刷新就丢，等于没法真正用" —— 恢复是默认期望，丢弃才需要用户主动做
   * （命令行 NEW）。弹窗在自动化验收与日常使用里都是噪音。
   */
  useEffect(() => {
    const d = loadDraft();
    if (!d) return;
    bus.replaceProject(d.project, `恢复本地草稿（${fmtSavedAt(d.savedAt)}）`);
    setSavedAt(d.savedAt);
    toast(
      'info',
      `已恢复上次草稿「${d.project.name}」：${d.project.rooms.length} 房间 / ${d.project.cabinets.length} 柜体（保存于 ${fmtSavedAt(d.savedAt)}）。想要全新项目，按 \` 打开命令行输入 NEW`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 模型一变就排一次自动保存（去抖 800ms：连拖几个夹点只写一次）
  useEffect(() => {
    const t = window.setTimeout(() => {
      const at = saveDraft(bus.getState());
      if (at) setSavedAt(at);
      // 存不进去（隐私模式 / 超配额）就不更新时间 —— 界面不说"已保存"的谎
    }, 800);
    return () => window.clearTimeout(t);
  }, [version]);

  // 关标签页前把没来得及去抖的那份冲进 localStorage
  useEffect(() => {
    const flush = () => {
      saveDraft(bus.getState());
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  // ── 右键上下文菜单（Task #24）──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const onViewportContextMenu = useCallback(
    (p: { x: number; y: number }) => {
      // 有命令进行中（画墙画到一半 / 移动等第二点 / 其它工具）时，右键 = 取消，不弹菜单 —— 与 Esc 同义
      if (tool !== 'select' || pendingMove) {
        setTool('select');
        setPendingMove(null);
        setCancelSignal((v) => v + 1);
        setCtxMenu(null);
        return;
      }
      setCtxMenu(p);
    },
    [tool, pendingMove]
  );

  // ── 提示气泡 ──
  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = nextToastId();
    setToasts((t) => [...t, { id, kind, text }].slice(-4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);

  // ── 唯一的"改模型"入口 ──
  /**
   * 命令执行之后的**统一**收尾：记忆拦截记录 / ERROR 提示 / 钳制提示 / 行内消息。
   *
   * 抽出来的原因（一次真实缺陷）：
   * 命令行的 Command JSON 通道（AI / MCP 走这条）原先自己写了一遍失败处理，
   * 直接调 bus.execute —— 于是**记忆拦下 AI 命令时不记 lastHit**，
   * 「最近一次拦截」在记忆面板上永远是空的。
   * 而"AI 下次不要再犯同样的错误"正是这条记忆最该留下痕迹的场景。
   *
   * 现在四条路（鼠标 / 命令行字母 / Command JSON / MCP）都收敛到这一个函数，
   * 失败处理只有一份实现，"某条路少做了一步"这类缺陷在结构上不再可能。
   */
  const afterExec = useCallback(
    (cmd: Command, r: ExecResult): boolean => {
      if (!r.ok) {
        if (r.memoryHits.length > 0) {
          const h = r.memoryHits[0];
          noteHit(h.correctionId, cmd.label ?? cmd.op, h.message);
          toast('error', r.error ?? '被记忆拦住');
        } else {
          toast('error', r.error ?? '操作被拒绝');
        }
        setLastMsg(r.error ?? '操作被拒绝');
        return false;
      }
      const errs = r.newIssues.filter((i) => i.severity === 'ERROR');
      if (errs.length > 0) {
        toast('warn', `已应用，但新增 ${errs.length} 条 ERROR：${errs[0].message}`);
      }
      if (r.clamped.length > 0) toast('info', r.clamped[0]);
      setLastMsg(cmd.label ?? cmd.op);
      return true;
    },
    [toast]
  );

  const run = useCallback(
    (cmd: Command): boolean => afterExec(cmd, bus.execute(cmd, { commitLabel: cmd.label })),
    [afterExec]
  );

  // ── 撤销 / 重做 ──
  const doUndo = useCallback(() => {
    if (!bus.undo()) toast('info', '没有可撤销的操作');
    setPendingMove(null);
  }, [toast]);
  const doRedo = useCallback(() => {
    if (!bus.redo()) toast('info', '没有可重做的操作');
  }, [toast]);

  // ── 视图模式：切换时收掉一切编辑态，避免"图幅上还留着夹点/草稿墙/选择框" ──
  const setMode = useCallback((m: 'plan' | 'sheet') => {
    setModeRaw(m);
  }, []);

  /** 分解图开关。打开时顺带切到图幅 —— 分解图只在图幅里有意义 */
  const setExplode = useCallback((v: boolean) => {
    setExplodeRaw(v);
    if (v) setModeRaw('sheet');
  }, []);

  /**
   * 切模式时"该选中谁"由下面这个 ref 决定，而不是一律清空。
   *
   * 为什么需要它（一次真实缺陷）：采用方案后要 `setSelection([新柜体id])` + `setMode('sheet')`，
   * 两条 setState 在同一批里提交，随后这个 effect 因为 mode 变了而跑起来，
   * 把刚设上去的选中又清成空 —— 于是"采用后新柜体是选中的"这件事静默失效。
   * 这类缺陷在只比对文本的断言里看不见：界面上什么都没报错，只是选中没了。
   */
  const selectionOnModeChange = useRef<string[] | null>(null);

  useEffect(() => {
    setTool('select');
    setPendingMove(null);
    setSelection(selectionOnModeChange.current ?? []);
    selectionOnModeChange.current = null; // 只在切换这一次生效
    // 复用 Esc 的取消通道，让视口自己把 draft / drag / preview / grip / readout 一起清掉。
    // 不这么做的话，从「画墙画到一半」切到四视图，草稿墙会跟着画到图幅上。
    setCancelSignal((v) => v + 1);
  }, [mode]);

  // ── 选择集随模型收敛（撤销后可能指向已不存在的对象）──
  useEffect(() => {
    const p = bus.getState();
    setSelection((prev) => {
      const next = prev.filter(
        (id) => p.cabinets.some((c) => c.id === id) || p.rooms.some((r) => r.walls.some((w) => w.id === id))
      );
      return next.length === prev.length ? prev : next;
    });
  }, [version]);

  // ── 工具动作 ──
  const onPlaceCabinet = useCallback(
    (p: Vec2) => {
      const project = bus.getState();
      if (project.rooms.length === 0) {
        toast('info', '还没有房间，先在工具栏点「+ 房间」，或直接用「画墙」工具画一面墙（会自动建房间）');
        return;
      }
      const width = 900;
      const placed = placeAgainstNearestWall(project, p, width);
      // 柜体必须归属"吸附到的那面墙所在的房间"，否则会出现跨房间归属混乱
      const ownerRoom =
        project.rooms.find((r) => placed.wallId && r.walls.some((w) => w.id === placed.wallId)) ?? project.rooms[0];
      const cab = makeCabinet({
        name: `柜体 ${project.cabinets.length + 1}`,
        roomId: ownerRoom.id,
        x: placed.x,
        y: placed.y,
        rotation: placed.rotation,
        rules: bus.getRules(),
        params: { width },
        takenIds: project.cabinets.map((c) => c.id),
      });
      if (run(CMD.createCabinet(cab))) {
        setSelection([cab.id]);
        setTool('select');
        setRightTab('props');
        setLastMsg(
          placed.wallId
            ? `已贴「${placed.wallName}」放置（距离 ${placed.distance}mm，旋转 ${placed.rotation}°）`
            : '已放置（未找到附近墙体，按原始点放置）'
        );
      }
    },
    [run, toast]
  );

  const onCreateWall = useCallback(
    (a: Vec2, b: Vec2) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1) {
        toast('warn', '墙长为 0，已忽略');
        return;
      }
      const project = bus.getState();
      const used = project.rooms.flatMap((r) => r.walls.map((w) => w.id));
      const wall = makeWall({
        name: `墙 ${used.length + 1}`,
        start: a,
        end: b,
        thickness: DEFAULT_WALL_THICKNESS,
        height: DEFAULT_WALL_HEIGHT,
        takenIds: used,
      });
      if (run(CMD.drawWall(wall))) {
        setLastMsg(`已画墙 ${Math.round(len)}mm（厚 ${DEFAULT_WALL_THICKNESS}mm）`);
      }
    },
    [run, toast]
  );

  const onNewRoom = useCallback(() => {
    const project = bus.getState();
    const n = project.rooms.length;
    /**
     * 房间 id 与墙 id 都必须避开**全项目**已用的，不能只按"第几个房间"编。
     * 少了这一行，第二个房间拿到的还是 `room_001`（已存在）→
     * planStructural 直接返回 null → 界面上只剩一句"结构性命令失败：room.create"，
     * 用户点「+ 房间」永远建不出第二个房间。
     */
    const takenIds = new Set<string>();
    for (const r of project.rooms) {
      takenIds.add(r.id);
      for (const w of r.walls) takenIds.add(w.id);
    }
    const room = rectRoom({
      name: `房间${n + 1}`,
      x: n * 3600,
      y: 0,
      w: 3200,
      h: 2600,
      takenIds,
    });
    if (run(CMD.createRoomCommand(room))) {
      setTool('select');
      setFitSignal((v) => v + 1);
    }
  }, [run]);

  // ── 选中对象操作 ──
  const selectedCabs = useCallback(() => bus.getState().cabinets.filter((c) => selection.includes(c.id)), [selection]);
  const selectedWalls = useCallback(
    () => bus.getState().rooms.flatMap((r) => r.walls.filter((w) => selection.includes(w.id))),
    [selection]
  );

  const onDelete = useCallback(() => {
    const cabs = selectedCabs();
    const walls = selectedWalls();
    if (cabs.length === 0 && walls.length === 0) {
      toast('info', '没有选中任何可删除的对象');
      return;
    }
    let count = 0;
    for (const c of cabs) if (run(CMD.deleteCabinet(c))) count++;
    for (const w of walls) if (run(CMD.deleteWall(w.id, w.name))) count++;
    if (count > 0) {
      setSelection([]);
      toast('ok', `已删除 ${count} 个对象（可撤销）`);
    }
  }, [run, selectedCabs, selectedWalls, toast]);

  const onDuplicate = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体');
      return;
    }
    const created: string[] = [];
    for (const c of cabs) {
      const before = bus.getState();
      if (run(CMD.duplicateCabinet(c, 700 + before.cabinets.length * 20))) {
        const after = bus.getState();
        const nid = after.cabinets[after.cabinets.length - 1]?.id;
        if (nid && nid !== c.id) created.push(nid);
      }
    }
    if (created.length > 0) setSelection(created);
  }, [run, selectedCabs, toast]);

  const onRotate90 = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体');
      return;
    }
    for (const c of cabs) {
      let next = (c.placement.rotation + 90) % 360;
      if (next > 180) next -= 360;
      run(CMD.rotateCabinet(c, next));
    }
  }, [run, selectedCabs, toast]);

  /** MI 镜像：语义化 = 分区左右反序。单分区被总线拒绝时 afterExec 统一报原因 */
  const onMirror = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体');
      return;
    }
    for (const c of cabs) run(CMD.mirrorCabinet(c));
  }, [run, selectedCabs, toast]);

  const onMovePick = useCallback(
    (p: Vec2) => {
      if (!pendingMove) return;
      if (!pendingMove.base) {
        setPendingMove({ base: p });
        setLastMsg(`基点已定 (${p.x}, ${p.y})，请指定第二点`);
        return;
      }
      const dx = p.x - pendingMove.base.x;
      const dy = p.y - pendingMove.base.y;
      setPendingMove(null);
      const cabs = selectedCabs();
      if (cabs.length === 0) {
        toast('warn', '选中的对象已不存在，移动取消');
        return;
      }
      if (dx === 0 && dy === 0) {
        setLastMsg('位移为 0，未产生变更');
        return;
      }
      run(CMD.moveCabinetBatch(cabs, bus.getState().cabinets, dx, dy));
    },
    [pendingMove, run, selectedCabs, toast]
  );

  const startMove = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体，再执行移动');
      return;
    }
    setTool('select');
    setPendingMove({ base: null });
    setLastMsg('指定基点');
  }, [selectedCabs, toast]);

  // ── 四视图点选部件（Task #25 A 组）──
  const onPickPart = useCallback(
    (pl: PickLine) => {
      const cab = bus.getState().cabinets.find((c) => c.id === pl.cabinetId);
      setSelection([pl.cabinetId]);
      setLastMsg(`点选部件：${cab?.name ?? pl.cabinetId} · ${pl.labelZh} · ${pl.paramPath}`);
      toast('info', `这是「${cab?.name ?? pl.cabinetId}」的${pl.labelZh} —— 由参数 ${pl.paramPath} 决定。改参数请到属性面板，或让 AI 改（会先干跑预览）`);
    },
    [toast]
  );

  // ── 命令行解释器 ──
  const runText = useCallback(
    (raw: string): string | null => {
      const text = raw.trim();
      if (!text) return null;

      // ① AI / 外部通道：直接吃 Command JSON
      if (text.startsWith('{')) {
        try {
          const obj = JSON.parse(text) as Partial<Command>;
          if (!obj.op) throw new Error('缺少 op 字段');
          const cmd: Command = {
            id: obj.id ?? `cmd_ext_${Date.now().toString(36)}`,
            op: String(obj.op),
            source: obj.source ?? 'mcp',
            target: obj.target,
            changes: obj.changes ?? [],
            payload: obj.payload,
            label: obj.label ?? `外部指令 ${obj.op}`,
            intent: obj.intent,
          };
          // 走同一条收尾（含记忆拦截记录）—— AI 通道不许有自己的一套失败处理
          const r = bus.execute(cmd, { commitLabel: cmd.label });
          const ok = afterExec(cmd, r);
          if (ok) {
            setRightTab('history');
            toast('ok', `已执行 ${cmd.op}，${r.diff.length} 处变更（与鼠标操作走同一条路径）`);
            return null;
          }
          return r.error ?? '命令被拒绝';
        } catch (e) {
          const m = (e as Error).message;
          toast('error', `JSON 解析失败：${m}`);
          return m;
        }
      }

      const parts = text.split(/\s+/);
      const head = parts[0].toUpperCase();
      const arg = parts[1] ?? '';
      const num = Number(arg);
      const cabs = selectedCabs();

      const needCab = (): boolean => {
        if (cabs.length === 0) {
          toast('info', `${head} 需要先选中柜体`);
          return false;
        }
        return true;
      };

      switch (head) {
        case 'HELP':
        case '?':
        case '帮助':
          return '见下方命令列表';
        case 'L':
        case 'WALL':
          setTool('wall');
          setLastMsg('画墙：点起点，再点终点');
          return null;
        case 'CAB':
        case 'C':
          setTool('cabinet');
          setLastMsg('放柜体：在墙上点一下会自动贴墙');
          return null;
        case 'S':
        case 'SELECT':
          setTool('select');
          return null;
        case 'M':
        case 'MOVE':
          startMove();
          return null;
        case 'CO':
        case 'COPY':
          onDuplicate();
          return null;
        case 'RO':
        case 'ROTATE':
          onRotate90();
          return null;
        case 'MI':
        case 'MIRROR':
          onMirror();
          return null;
        // ── O / TR / EX：AutoCAD 习惯键位，但语义模型里没有线条可操作 ──
        // 诚实拒绝 + 指路，不做"假装支持"：偏移一条不存在的线是违背
        // "严禁改线条"铁律的空壳功能。用户敲了别名至少要知道去哪。
        case 'O':
        case 'OFFSET':
          toast('info', '语义模型没有线条可偏移 —— 改柜宽用属性面板或 WIDTH；离墙距离用移动（M）');
          return null;
        case 'TR':
        case 'TRIM':
          toast('info', '语义模型没有线条可修剪 —— 改分区宽在属性面板拖分区夹点，或让 AI 改 requestedWidth');
          return null;
        case 'EX':
        case 'EXTEND':
          toast('info', '语义模型没有线条可延伸 —— 柜高顶到墙用属性面板改 height，加分区用 addUnit');
          return null;
        case 'E':
        case 'DEL':
        case 'ERASE':
          onDelete();
          return null;
        case 'U':
        case 'UNDO':
          doUndo();
          return null;
        case 'REDO':
          doRedo();
          return null;
        case 'ZE':
        case 'Z':
          setFitSignal((v) => v + 1);
          return '已缩放到图幅';
        case 'VIEWS':
        case 'VV':
        case '4V': {
          setMode('sheet');
          setRightTab('views');
          const g = bus.derive().geom;
          return `已切到四视图图幅：${g.views.prims.length} 个图元 / ${bus.getState().cabinets.length} 个柜体 / ${g.views.assumptions.length} 条派生假设（均为同一份模型投影派生）`;
        }
        case 'AI':
          setRightTab('ai');
          return arg ? '请在上方「AI 规划」输入框里说这句话（那里才有干跑预览与逐条应用）' : '已打开 AI 面板';
        case 'ACCT':
        case 'ACCOUNT':
          setRightTab('account');
          return '已打开「账号与安全」';
        case 'EXPLODE':
        case 'EXP': {
          if (arg.toUpperCase() === 'OFF' || arg === '0') {
            setExplode(false);
            return '分解图已关闭（四视图仍可看）';
          }
          setExplode(true);
          const e = bus.deriveExplode(true);
          const warn = e.check.ok ? '' : `　⚠ ${e.check.unplaced.length} 类板件摆不出来`;
          return `已生成分解图：${e.check.cabinets} 个柜体 / 清单 ${e.check.panelKinds} 种 ${e.check.pieces} 件 / 图上 ${e.check.instances} 件 / ${e.check.drawnNos} 个件号${warn}`;
        }
        case 'PLAN':
        case 'PL':
          setMode('plan');
          return '已切回平面图（唯一可编辑视图）';
        case 'GRID':
          setShowGrid((v) => !v);
          return null;
        case 'SNAP':
          setSnap((s) => ({ ...s, enabled: !s.enabled }));
          return null;
        case 'ORTHO':
          setSnap((s) => ({ ...s, ortho: !s.ortho, polar: s.ortho ? s.polar : false }));
          return null;
        case 'ROOM':
          onNewRoom();
          return null;
        case 'W':
        case 'WIDTH': {
          if (!needCab()) return '需要先选中柜体';
          const delta = /^[+-]/.test(arg);
          const v = Number(arg.replace(/[+-]/, ''));
          if (!Number.isFinite(v)) return '用法：W 2400 或 W+100 / W-100';
          for (const c of cabs) run(CMD.resizeCabinet(c, { width: delta ? c.params.width + v * (arg.startsWith('-') ? -1 : 1) : v }));
          return null;
        }
        case 'H':
        case 'HEIGHT': {
          if (!needCab()) return '需要先选中柜体';
          if (!Number.isFinite(num)) return '用法：H 2200';
          for (const c of cabs) run(CMD.resizeCabinet(c, { height: num }));
          return null;
        }
        case 'D':
        case 'DEPTH': {
          if (!needCab()) return '需要先选中柜体';
          if (!Number.isFinite(num)) return '用法：D 600';
          for (const c of cabs) run(CMD.resizeCabinet(c, { depth: num }));
          return null;
        }
        case 'N':
        case 'NUDGE': {
          if (!needCab()) return '需要先选中柜体';
          const d = Number(arg);
          if (!Number.isFinite(d)) return '用法：N 100（沿 +X 平移）';
          for (const c of cabs) run(CMD.nudgeCabinet(c, d, 0));
          return null;
        }
        case 'DUMP': {
          const json = JSON.stringify(bus.getState(), null, 2);
          // eslint-disable-next-line no-console
          console.log('[model.json]', json);
          toast('info', `已把模型 JSON 打印到控制台（${json.length} 字符）—— 这就是唯一的真相源`);
          return '已输出到控制台';
        }
        case 'SAVE':
        case 'QSAVE':
          setRightTab('export');
          return savedAt
            ? `草稿已自动保存于 ${fmtSavedAt(savedAt)}。要拿走文件，「导出」页签 → 项目存档 → 存为 .json`
            : '草稿还没存过 —— 已打开「导出」页签，从项目存档导出 .json';
        case 'NEW': {
          bus.replaceProject(sampleProject(RULESET), '新建项目');
          clearDraft();
          setSelection([]);
          setFitSignal((v) => v + 1);
          toast('ok', '已新建项目（草稿已清空，之前的模型可在历史里找回）');
          return '已新建项目';
        }
        default:
          toast('warn', `未知命令：${head}（输入 HELP 查看）`);
          return `未知命令：${head}`;
      }
    },
    [afterExec, doRedo, doUndo, onDelete, onDuplicate, onMirror, onNewRoom, onRotate90, run, savedAt, selectedCabs, setExplode, setMode, startMove, toast]
  );

  // ── 键盘 ──
  useEffect(() => {
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
        return;
      }
      if (mod && e.key === '1') {
        e.preventDefault();
        setRightTab('props');
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        onDuplicate();
        return;
      }

      // 下面这些键在输入框里不应该生效
      if (isTyping(e.target)) return;
      if (mod || e.altKey) return;

      switch (e.key) {
        case 'Escape':
          setPendingMove(null);
          setCancelSignal((v) => v + 1);
          setSelection([]);
          setTool('select');
          break;
        case 'Delete':
        case 'e':
        case 'E':
          e.preventDefault();
          onDelete();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          startMove();
          break;
        case 'l':
        case 'L':
          setTool('wall');
          break;
        case 'c':
        case 'C':
          setTool('cabinet');
          break;
        case 's':
        case 'S':
          setTool('select');
          break;
        case 'F3':
          e.preventDefault();
          setSnap((s) => ({ ...s, enabled: !s.enabled }));
          break;
        case 'F7':
          e.preventDefault();
          setShowGrid((v) => !v);
          break;
        case 'F8':
          e.preventDefault();
          setSnap((s) => ({ ...s, ortho: !s.ortho, polar: s.ortho ? s.polar : false }));
          break;
        case 'F9':
          e.preventDefault();
          setSnap((s) => ({ ...s, gridSnap: !s.gridSnap }));
          break;
        case 'F4':
          e.preventDefault();
          setMode(mode === 'plan' ? 'sheet' : 'plan');
          break;
        case 'Home':
          e.preventDefault();
          setFitSignal((v) => v + 1);
          break;
        case '`':
          e.preventDefault();
          setCmdOpen((v) => !v);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doRedo, doUndo, onDelete, onDuplicate, setMode, startMove, mode]);

  const issues = bus.issues();
  const errCount = issues.filter((i) => i.severity === 'ERROR').length;

  // ── 右键菜单项：按「当前选中了什么」算 —— 选中态不同，菜单就不同 ──
  const buildCtxItems = (): CtxItem[] => {
    const cabs = selectedCabs();
    const walls = selectedWalls();
    const items: CtxItem[] = [];
    if (cabs.length > 0) {
      items.push(
        { key: 'props', label: '属性', hint: 'Ctrl+1', onSelect: () => setRightTab('props') },
        { key: 'dup', label: cabs.length > 1 ? `复制 ${cabs.length} 个柜体` : '复制', hint: 'Ctrl+D', onSelect: onDuplicate },
        { key: 'rot', label: '旋转 90°', hint: '逆时针', onSelect: onRotate90 },
        { key: 'mir', label: '镜像（分区反序）', hint: 'MI', onSelect: onMirror },
      );
    } else if (walls.length > 0) {
      items.push({ key: 'props', label: '属性', hint: 'Ctrl+1', onSelect: () => setRightTab('props') });
    }
    if (selection.length > 0) {
      items.push({ key: 'del', label: `删除（${selection.length} 项）`, hint: 'Delete', danger: true, onSelect: onDelete });
      items.push({ key: 'sep1', label: '' });
    }
    items.push(
      {
        key: 'selall',
        label: '全选',
        hint: '柜体 + 墙',
        onSelect: () => {
          const p = bus.getState();
          setSelection([...p.cabinets.map((c) => c.id), ...p.rooms.flatMap((r) => r.walls.map((w) => w.id))]);
        },
      },
      { key: 'room', label: '新建房间', onSelect: onNewRoom },
      { key: 'zoom', label: '适应窗口', hint: 'Home', onSelect: () => setFitSignal((v) => v + 1) },
      { key: 'cmd', label: '命令行…', hint: '`', onSelect: () => setCmdOpen(true) },
    );
    return items;
  };

  const toggleLayer = useCallback((name: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  return (
    <div className="app">
      <Toolbar
        tool={tool}
        setTool={setTool}
        mode={mode}
        setMode={setMode}
        explode={explode}
        setExplode={setExplode}
        canUndo={bus.canUndo()}
        canRedo={bus.canRedo()}
        onUndo={doUndo}
        onRedo={doRedo}
        onZoomExtents={() => setFitSignal((v) => v + 1)}
        showGrid={showGrid}
        setShowGrid={setShowGrid}
        snap={snap}
        setSnap={setSnap}
        onNewRoom={onNewRoom}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        hasSelection={selection.length > 0}
        canDuplicate={selectedCabs().length > 0}
        canDelete={selection.length > 0}
      />

      <div className="body">
        <aside className="side-left">
          <div className="tabs">
            <button type="button" className={leftTab === 'tree' ? 'on' : ''} onClick={() => setLeftTab('tree')}>
              对象树
            </button>
            <button type="button" className={leftTab === 'layers' ? 'on' : ''} onClick={() => setLeftTab('layers')}>
              图层
            </button>
          </div>
          {leftTab === 'tree' ? (
            <ObjectTree bus={bus} version={version} selection={selection} setSelection={setSelection} />
          ) : (
            <LayersPanel
              hiddenLayers={hiddenLayers}
              toggle={toggleLayer}
              setAll={(hidden) => setHiddenLayers(hidden ? new Set(defaultHiddenLayers()) : new Set())}
            />
          )}
        </aside>

        <main className="stage">
          <Viewport
            bus={bus}
            version={version}
            cam={cam}
            setCam={setCam}
            fitSignal={fitSignal}
            cancelSignal={cancelSignal}
            mode={mode}
            explode={explode}
            tool={tool}
            selection={selection}
            setSelection={setSelection}
            snapSettings={snap}
            showGrid={showGrid}
            hiddenLayers={hiddenLayers}
            pendingMove={pendingMove}
            onMovePick={onMovePick}
            onPlaceCabinet={onPlaceCabinet}
            onCreateWall={onCreateWall}
            onContextMenu={onViewportContextMenu}
            onPickPart={onPickPart}
            onToast={toast}
            cursorStyle={tool === 'select' ? 'default' : 'crosshair'}
          />
          {cmdOpen ? <CommandLine onCommand={runText} onClose={() => setCmdOpen(false)} lastMessage={lastMsg} /> : null}
        </main>

        <aside className="side-right">
          <div className="tabs">
            <button type="button" className={rightTab === 'props' ? 'on' : ''} onClick={() => setRightTab('props')}>
              属性
            </button>
            <button type="button" className={rightTab === 'issues' ? 'on' : ''} onClick={() => setRightTab('issues')}>
              问题{errCount > 0 ? <span className="tab-badge">{errCount}</span> : null}
            </button>
            <button type="button" className={rightTab === 'history' ? 'on' : ''} onClick={() => setRightTab('history')}>
              历史
            </button>
            <button type="button" className={rightTab === 'layers' ? 'on' : ''} onClick={() => setRightTab('layers')}>
              图层
            </button>
            <button type="button" className={rightTab === 'views' ? 'on' : ''} onClick={() => setRightTab('views')}>
              视图
            </button>
            <button type="button" className={rightTab === 'variant' ? 'on' : ''} onClick={() => setRightTab('variant')}>
              方案
            </button>
            <button type="button" className={rightTab === 'export' ? 'on' : ''} onClick={() => setRightTab('export')}>
              导出
            </button>
            <button type="button" className={rightTab === 'ai' ? 'on' : ''} onClick={() => setRightTab('ai')}>
              AI
            </button>
            <button type="button" className={rightTab === 'memory' ? 'on' : ''} onClick={() => setRightTab('memory')}>
              记忆
              {memoryPending > 0 ? <span className="tab-badge tab-badge-warn">{memoryPending}</span> : null}
            </button>
            <button type="button" className={rightTab === 'admin' ? 'on' : ''} onClick={() => setRightTab('admin')}>
              后台
            </button>
            <button type="button" className={rightTab === 'account' ? 'on' : ''} onClick={() => setRightTab('account')}>
              账号
            </button>
          </div>
          {rightTab === 'props' ? (
            <PropertiesPanel bus={bus} version={version} selection={selection} setSelection={setSelection} onToast={toast} />
          ) : null}
          {rightTab === 'issues' ? <IssuesPanel bus={bus} version={version} setSelection={setSelection} /> : null}
          {rightTab === 'history' ? <HistoryPanel bus={bus} version={version} /> : null}
          {rightTab === 'layers' ? (
            <LayersPanel
              hiddenLayers={hiddenLayers}
              toggle={toggleLayer}
              setAll={(hidden) => setHiddenLayers(hidden ? new Set(defaultHiddenLayers()) : new Set())}
            />
          ) : null}
          {rightTab === 'views' ? (
            <ViewsPanel bus={bus} version={version} mode={mode} setMode={setMode} explode={explode} setExplode={setExplode} />
          ) : null}
          {rightTab === 'variant' ? (
            <VariantPanel
              bus={bus}
              version={version}
              run={run}
              onToast={toast}
              onAdopted={(id) => {
                // 两处都写：切模式会触发上面的 effect（它会按 ref 重设选中）；
                // 若模式本来就是图幅、effect 不触发，这里的直接赋值才是生效的那一次。
                setSelection([id]);
                selectionOnModeChange.current = [id];
                // 采用之后直接切到四视图 —— 这正是"选完再出四视图"的那一步
                setMode('sheet');
                setRightTab('views');
              }}
            />
          ) : null}
          {rightTab === 'export' ? <ExportPanel bus={bus} version={version} token={token} savedAt={savedAt} onToast={toast} /> : null}
          {rightTab === 'memory' ? <MemoryPanel /> : null}
          {rightTab === 'admin' ? <AdminPanel token={token} /> : null}
          {rightTab === 'ai' ? <AIPanel bus={bus} version={version} token={token} selection={selection} onToast={toast} /> : null}
          {rightTab === 'account' ? <AccountPanel token={token} setToken={setToken} onToast={toast} /> : null}
        </aside>
      </div>

      {/* 命令行打开时不再重复这条提示 */}
      {cmdOpen ? null : (
        <div className="cmd-hint">
          按 <kbd>`</kbd> 打开命令行 · 输入 <b>HELP</b> 查看全部命令 · 以 <b>{'{'}</b> 开头可粘贴一段 Command JSON 直接执行
        </div>
      )}

      <StatusBar bus={bus} version={version} cam={cam} snap={snap} tool={tool} selectionCount={selection.length} savedAt={savedAt} />

      {ctxMenu ? <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={buildCtxItems()} onClose={() => setCtxMenu(null)} /> : null}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
