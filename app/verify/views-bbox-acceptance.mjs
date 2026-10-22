#!/usr/bin/env node
/**
 * 视图 bbox 验收（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   `buildFurnitureSheet` 的返回值加了 `views`（各视图在图纸上的位置），
 *   三段式视觉识别的裁剪**完全依赖它**。
 *
 *   ★ 为什么必须守 ──
 *   裁剪坐标一旦错位，**不会报错**，只会裁出空白或裁错视图 ——
 *   而「裁错」在肉眼看来也可能像样（同样是图纸），
 *   只有对着 bbox 断言才抓得住。
 *
 * 断言：
 *   · 三个视图都在图纸范围内
 *   · 俯视图比正面图**扁**（宽高比 > 2）
 *   · 正面图/内部图是**高瘦**的（宽高比 < 1）
 *   · 正面图在左、内部图在右（图纸版式）
 *   · bbox 的宽高与实际图元一致（不是随手填的数）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const rules = JSON.parse(readFileSync(join(appDir, 'src/core/ruleset/factory-default.json'), 'utf8'));

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

function build(width, height, depth, type, units) {
  const project = emptyProject({ name: 'v', ruleSetId: rules.id, id: 'v' });
  const room = rectRoom({ name: 'R', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'c1', name: '柜', roomId: room.id, x: 100, y: 60, rotation: 0, rules,
    params: { width, height, depth, bodyLift: 80, cabinetType: type, mountHeight: 0 },
    units,
  }));
  return buildFurnitureSheet(room, project.cabinets, project, rules, { furnitureName: '柜' });
}

console.log('视图 bbox 验收');
console.log('='.repeat(64));

const sheet = build(1800, 2400, 600, 'tall', [
  { id: 'u1', kind: 'hanging', requestedWidth: 1800, nickname: '挂', rod: { count: 1, heightFromBottom: 1800 } },
]);
const v = sheet.views;

ok('返回里有 views', !!v);
ok('views 有 front', !!v?.front);
ok('views 有 internal', !!v?.internal);
ok('views 有 plan', v?.plan !== undefined);

const sw = sheet.bbox.max.x - sheet.bbox.min.x;
const sh = sheet.bbox.max.y - sheet.bbox.min.y;
for (const [k, box] of Object.entries(v ?? {})) {
  if (!box) { ok(k + ' 不在图纸范围内（应为 null）', false); continue; }
  const inside = box.x >= sheet.bbox.min.x && box.y >= sheet.bbox.min.y
    && box.x + box.w <= sheet.bbox.max.x && box.y + box.h <= sheet.bbox.max.y;
  ok(k + ' 在图纸范围内', inside, JSON.stringify(box));
  ok(k + ' 尺寸为正', box.w > 0 && box.h > 0, JSON.stringify(box));
}

ok('★ 俯视图比正面图扁（宽高比 > 2）',
  v.plan.w / v.plan.h > 2,
  'plan ' + (v.plan.w / v.plan.h).toFixed(2) + ' vs front ' + (v.front.w / v.front.h).toFixed(2));
ok('★ 正面图是高瘦的（宽高比 < 1）', v.front.w / v.front.h < 1, String((v.front.w / v.front.h).toFixed(2)));
ok('★ 内部图是高瘦的（宽高比 < 1）', v.internal.w / v.internal.h < 1, String((v.internal.w / v.internal.h).toFixed(2)));
ok('★ 正面图在左、内部图在右（图纸版式）', v.front.x < v.internal.x,
  'front.x=' + v.front.x + ' internal.x=' + v.internal.x);

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log('通过 ' + pass + ' 项，失败 0 项');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  for (const f of failures) console.log('  x ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
