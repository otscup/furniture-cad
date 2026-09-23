import type { Project, RuleSet } from '../core/types.ts';
import type { Command } from '../core/commandBus.ts';
import * as CMD from '../core/commands.ts';
import { createCabinet } from '../core/docFactory.ts';
import type { Correction } from './memory.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  预置记忆 —— 每条都必须是"能在命令上跑起来"的，不许只写漂亮话
 *
 *  分两类：
 *   · 普通记忆  —— 能构造出"该拦的场景"，验收脚本会跑 **双向测试**：
 *                  该拦的必须拦住、不该拦的必须放行（防误伤）
 *   · 哨兵记忆  —— 对应的缺陷已被更底层的断言吃掉（例如生成器恒等式），
 *                  现实中造不出触发场景。这类条目**不做触发测试**，
 *                  但验收会检查它引用的 issue code 在上游真实存在 ——
 *                  否则记忆会指向一个被重命名掉的死 code，变成永久哑弹。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface MemoryCase {
  correctionId: string;
  /** 哨兵型：无法构造触发场景，只测"不误伤" + code 存在性 */
  defensive?: boolean;
  /** 该记忆引用的 issue code（哨兵型必填，验收会去上游源码里找它） */
  referencedIssueCode?: string;
  /** 应当被拦下的命令。哨兵型可以不提供 */
  blocking?: (base: Project, rules: RuleSet) => Command;
  /** 应当放行的命令 —— 证明这道门不是"一律拒绝" */
  passing: (base: Project, rules: RuleSet) => Command;
}

const firstCab = (p: Project) => p.cabinets[0];

export function seedCorrections(now = Date.now()): Correction[] {
  return [
    {
      id: 'mem_001_backsplit_grid',
      at: now,
      scope: 'rule',
      origin: 'self',
      nl: '背板超过板材幅面时必须两个方向都拆，不能只拆一个方向',
      evidence: [
        'Phase 0 实测：2400×2400×600 衣柜生成 2327×2442 背板，只按短边拆块后单块仍放不进 2440×1220',
        '修复后改为 nW×nH 网格拆块（两种摆放取向取块数更少者），并加面积守恒断言',
      ],
      status: 'active',
      tags: ['几何生成器', '背板', '拆块'],
      checkSpec: {
        kind: 'noNewIssue',
        issueCode: 'IDENTITY-BACKSPLIT-BAD',
        message: '背板拆块后仍有单块放不进板材幅面 —— 说明拆块算法退化成只拆一个方向了',
        fixHint: '回到 nW×nH 网格拆块：两种摆放取向都算块数，取更少的一种',
      },
    },
    {
      id: 'mem_002_no_cabinet_in_wall',
      at: now,
      scope: 'cabinet',
      origin: 'self',
      nl: '柜体不许跟墙体发生干涉（背靠墙相切是可以的，扎进墙里不行）',
      evidence: ['detectCollisions 对"相切"用严格小于判定，因此贴墙放置不会误报'],
      status: 'active',
      tags: ['布置', '碰撞'],
      checkSpec: {
        kind: 'noNewIssue',
        issueCode: 'RULE-CABINET-IN-WALL',
        message: '这次操作把柜体扎进了墙体里（背靠墙相切不算，重叠才算）',
        fixHint: '把柜体沿墙面法线方向挪出来，让它与墙面相切',
      },
    },
    {
      id: 'mem_003_no_cabinet_overlap',
      at: now,
      scope: 'cabinet',
      origin: 'self',
      nl: '两个柜体不许重叠放置',
      evidence: ['Phase 1 验收里 RULE-CABINET-OVERLAP 是 ERROR 级，但默认 strict=false 只警告不阻断'],
      status: 'active',
      tags: ['布置', '碰撞'],
      checkSpec: {
        kind: 'noNewIssue',
        issueCode: 'RULE-CABINET-OVERLAP',
        message: '这次操作让两个柜体在平面上重叠了',
        fixHint: '横向挪开其中一个，或缩短柜体宽度',
      },
    },
    {
      id: 'mem_004_max_height_2400',
      at: now,
      scope: 'global',
      origin: 'user',
      nl: '柜体总高不超过 2400mm（行业默认单柜上限）',
      evidence: [
        '示例记忆：用来演示"用户说一句 → 下次自动拦住"的完整链路',
        '规则集里 maxSingleCabinetHeight = 2400，但那是 WARNING，不会阻断；这条记忆把它升级为硬门',
      ],
      status: 'active',
      tags: ['示例', '尺寸上限'],
      checkSpec: {
        kind: 'maxValue',
        path: 'params.height',
        value: 2400,
        unit: 'mm',
        message: '柜体总高被改到超过 2400mm',
        fixHint: '上下分柜（拆成两组），或确认工厂确实能接受超高单柜后再改这条记忆',
      },
    },
    {
      id: 'mem_005_no_schema_write',
      at: now,
      scope: 'global',
      origin: 'self',
      nl: 'schemaVersion / 派生字段永远不许被写（AI 与人都一样）',
      evidence: ['CommandBus 的 WRITABLE 白名单 + DENY 前缀已在代码层拦截，这条记忆是第二道锁'],
      status: 'active',
      tags: ['安全', '哨兵'],
      checkSpec: {
        kind: 'pathForbidden',
        path: 'schemaVersion',
        message: '试图写入 schemaVersion —— 这是系统字段，任何来源都不许改',
        fixHint: 'schemaVersion 只能由迁移工具修改；请撤销这次操作',
      },
    },
    {
      id: 'mem_006_dimlfac_must_be_1',
      at: now,
      scope: 'export',
      origin: 'self',
      nl: 'DXF 标注的 dimlfac 必须是 1.0，ezdxf 的 EZDXF dimstyle 默认自带 100',
      evidence: [
        'Phase 0 实测：setup=True 复制出来的 EZDXF dimstyle 里 dimlfac=100，导致标注文字放大 100 倍',
        '修复：ds.dxf.dimlfac = 1.0',
      ],
      status: 'pending',
      pendingReason:
        'DXF 导出通道尚未接进 app（目前只有 Phase 0 的 Python 脚本），命令总线上没有可以判定的时机 → 检不出来，因此不进 active。',
      tags: ['DXF', '出图'],
    },
    {
      id: 'mem_007_hermes_tool_whitelist',
      at: now,
      scope: 'ui',
      origin: 'user',
      nl: 'MCP 工具白名单里不许出现 SQL、任意文件路径、shell、规则集修改',
      evidence: ['主方案 §H 的红线；属于部署期配置，不是模型上的可判定条件'],
      status: 'pending',
      pendingReason: '这是 MCP 服务端的工具暴露配置，不落在项目模型上，命令总线无法判定 → 只能作为部署检查项保留。',
      tags: ['MCP', '安全'],
    },
  ];
}

export const MEMORY_CASES: MemoryCase[] = [
  {
    correctionId: 'mem_001_backsplit_grid',
    defensive: true,
    referencedIssueCode: 'IDENTITY-BACKSPLIT-BAD',
    passing: (_p, _r) => CMD.resizeCabinet(firstCab(_p), { width: 2400 }),
  },
  {
    correctionId: 'mem_002_no_cabinet_in_wall',
    blocking: (p) => CMD.moveCabinet(firstCab(p), 400, -200),
    passing: (p) => CMD.moveCabinet(firstCab(p), 400, 300),
  },
  {
    correctionId: 'mem_003_no_cabinet_overlap',
    blocking: (p, r) =>
      CMD.createCabinet(
        createCabinet({
          id: 'cab_probe_overlap',
          name: '探针柜（故意重叠）',
          roomId: p.rooms[0].id,
          x: 500,
          y: 60,
          rules: r,
          params: { width: 900 },
        })
      ),
    passing: (p, r) =>
      CMD.createCabinet(
        createCabinet({
          id: 'cab_probe_free',
          name: '探针柜（互不重叠）',
          roomId: p.rooms[0].id,
          x: 3400,
          y: 60,
          rules: r,
          params: { width: 900 },
        })
      ),
  },
  {
    correctionId: 'mem_004_max_height_2400',
    blocking: (p) => CMD.resizeCabinet(firstCab(p), { height: 2600 }),
    passing: (p) => CMD.resizeCabinet(firstCab(p), { height: 2200 }),
  },
  {
    correctionId: 'mem_005_no_schema_write',
    defensive: true,
    passing: (p) => CMD.moveCabinet(firstCab(p), 400, 300),
  },
];
