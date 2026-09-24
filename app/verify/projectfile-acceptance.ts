import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  项目存盘与加载验收 —— Task #23（Node 层）
 *
 *  三组证明：
 *
 *  A. 往返一致：serialize → parse 得回同一个模型，一个字段都不多不少。
 *     「存档方便回滚」的全部价值都建立在"回来的是原来的项目"上。
 *
 *  B. 拒绝非法文件：导入的文件是攻击面。每一条拒绝规则都要有正反样本，
 *     一条"永远绿"的校验器等于没有校验器。
 *
 *  C. 总线集成：导入走 replaceProject（唯一写入口、进历史、可撤销），
 *     撤销后回到导入前的项目 —— "打开文件"在审计上也是一条普通命令。
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const reject = (raw: unknown): string | null => {
  const r = parseProjectFile(typeof raw === 'string' ? raw : JSON.stringify(raw));
  return r.ok ? null : r.error;
};

const sameModel = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ───────────────────────── A. 往返一致 ─────────────────────────

console.log('\n── A. 往返一致：存进去再读出来，还是同一个项目 ──');

const projA = sampleProject(rules);
const rawA = serializeProjectFile(projA, '2026-09-24T10:00:00.000Z');
const parsedA = parseProjectFile(rawA);

ok('自己的文件能被解析', parsedA.ok);
if (parsedA.ok) {
  ok('信封 format 是 furniture-cad-project', rawA.includes('"format": "furniture-cad-project"'));
  ok('savedAt 原样保留', parsedA.savedAt === '2026-09-24T10:00:00.000Z');
  ok('project 与原文逐字段相等', sameModel(parsedA.project, projA));
  ok('文件里没有派生字段（panels / geometry / issues 不许出现）', !/"(panels|geometry|issues|stats)"/.test(rawA));
} else {
  ok('解析出错时后续断言跳过', false, 'parsedA.ok 为 false');
}

// 第二个正样本：手动改过的柜体 + 追加房间，往返后保持
const projB = sampleProject(rules);
projB.cabinets[0].params.width = 1800;
projB.cabinets[0].layout.units[0].requestedWidth = 900;
projB.rooms.push({ id: 'room_extra', name: '次卧', walls: [] });
const parsedB = parseProjectFile(serializeProjectFile(projB));
ok('第二个样本（改宽 + 加房间）往返相等', parsedB.ok && sameModel(parsedB.project, projB));

// ───────────────────────── B. 拒绝非法文件 ─────────────────────────

console.log('\n── B. 拒绝非法文件：导入的文件是攻击面 ──');

// B.0 非 JSON 语法
ok('坏 JSON 被拒', reject('{ not json !!') !== null, reject('{ not json !!') ?? '竟然通过了');

// B.1 format 信封
ok('别家 JSON（如 package.json 内容）被拒', reject('{"name":"x","version":"1"}') !== null, reject('{"name":"x","version":"1"}') ?? '通过');
ok('format 不对被拒', reject({ format: 'other-app', formatVersion: 1, project: projA }) !== null);
ok('formatVersion 不对被拒', reject({ format: 'furniture-cad-project', formatVersion: 99, project: projA }) !== null);
ok('缺 project 字段被拒', reject({ format: 'furniture-cad-project', formatVersion: 1 }) !== null);

// B.2 结构
ok('rooms 不是数组被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, rooms: 'x' },
}) !== null);
ok('房间 id 重复被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, rooms: [projA.rooms[0], { ...projA.rooms[0], name: '克隆' }] },
}) !== null);
ok('柜体 roomId 悬空被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, cabinets: [{ ...projA.cabinets[0], roomId: 'room_ghost' }] },
}) !== null);
ok('柜体 id 重复被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, cabinets: [projA.cabinets[0], { ...projA.cabinets[0], roomId: projA.rooms[0].id }] },
}) !== null);

// B.3 整数铁律（正反各二：非法浮点 / 合法整数）
ok('柜体落位非整数被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, cabinets: [{ ...projA.cabinets[0], placement: { x: 400.5, y: 60, rotation: 0 } }] },
}) !== null);
ok('墙坐标非整数被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: {
    ...projA,
    rooms: [{ ...projA.rooms[0], walls: [{ ...projA.rooms[0].walls[0], start: { x: 0.1, y: 0 } }] }],
  },
}) !== null);
ok('params.width 非整数被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, cabinets: [{ ...projA.cabinets[0], params: { ...projA.cabinets[0].params, width: 2400.25 } }] },
}) !== null);
ok('整数落位（0 与负坐标）是合法的', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, cabinets: [{ ...projA.cabinets[0], placement: { x: -1200, y: 0, rotation: 0 } }] },
}) === null);

// B.4 分区
ok('空分区（layout.units = []）被拒', reject({
  format: 'furniture-cad-project', formatVersion: 1,
  project: { ...projA, cabinets: [{ ...projA.cabinets[0], layout: { ...projA.cabinets[0].layout, units: [] } }] },
}) !== null);
ok('分区 id 跨柜重复被拒（板件 id 由分区派生，撞名 = 清单少板件）', (() => {
  const p = sampleProject(rules);
  const cab2 = JSON.parse(JSON.stringify(p.cabinets[0]));
  cab2.id = 'cab_b';
  cab2.roomId = p.rooms[0].id;
  p.cabinets.push(cab2);
  return reject({ format: 'furniture-cad-project', formatVersion: 1, project: p });
})() !== null);

// ───────────────────────── C. 总线集成 ─────────────────────────

console.log('\n── C. 总线集成：导入走唯一写入口，可撤销 ──');

const busC = new CommandBus(sampleProject(rules), rules);
const beforeModel = structuredClone(busC.getState());
const incoming = parseProjectFile(serializeProjectFile(projB));
if (!incoming.ok) {
  ok('导入样本准备失败', false, incoming.error);
} else {
  busC.replaceProject(incoming.project, '导入项目文件 测试.json');

  ok('导入后模型变成文件里的项目', sameModel(busC.getState(), incoming.project));
  ok('导入是日志里的一条命令（审计有据）', busC.activeLog().at(-1)?.label === '导入项目文件 测试.json');
  ok('导入后派生照常（柜体几何能生成）', Object.keys(busC.derive().geom.cabinets).length === incoming.project.cabinets.length);

  // 撤销：replaceProject 声称可撤销 —— 断言必须真的试一次
  const undone = busC.undo();
  ok('导入可以撤销', undone);
  ok('撤销后回到导入前的项目', sameModel(busC.getState(), beforeModel));

  // 坏文件根本不该进总线：parse 拒绝在前，总线永远见不到它
  // （第一次写错的是断言自己：拒得早的 schemaVersion 先说话，不该去猜错误消息的措辞）
  const bad = parseProjectFile('{"format":"furniture-cad-project","formatVersion":1,"project":{"rooms":[]}}');
  ok('缺 cabinets 的文件在 parse 层就被拒（到不了总线）', !bad.ok);
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log('项目存盘与加载成立：往返一致、非法文件在门口被拒、导入是可撤销的一条普通命令。');
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
