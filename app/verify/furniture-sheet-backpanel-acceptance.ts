import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sampleProject } from '../src/core/docFactory.ts';
import type { Cabinet, Prim, RuleSet } from '../src/core/types.ts';
import { backPanelThicknessNote, buildFurnitureSheet } from '../src/export/furnitureSheet.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
const project = sampleProject(rules);
const cabinet = project.cabinets[0]!;
const room = project.rooms.find((candidate) => candidate.id === cabinet.roomId)!;
let pass = 0;
let fail = 0;

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function sheetText(prims: Prim[]): string[] {
  return prims.filter((prim): prim is Extract<Prim, { k: 'text' }> => prim.k === 'text').map((prim) => prim.text);
}

const defaultSheet = buildFurnitureSheet(room, [cabinet], project, rules, { furnitureName: cabinet.name });
const defaultText = sheetText(defaultSheet.prims);
ok('默认背板材料为 9mm 时，图纸准确标注 9mm 而非 18mm',
  cabinet.params.backPanel.material === 'M_BACK_9' && defaultText.includes('9mm背板') && !defaultText.includes('18mm背板'),
  defaultText.filter((text) => text.includes('背板')).join(' / '));
const defaultBackNote = defaultSheet.prims.filter((prim): prim is Extract<Prim, { k: 'text' }> => prim.k === 'text' && prim.text === '9mm背板');
ok('9mm 注记仅出现一次，作为红字位于右侧信息栏而非内部视图',
  defaultBackNote.length === 1 && defaultBackNote[0]?.layer === 'F-ANNOT-RED'
    && defaultBackNote[0]!.p.x >= 14000 - 2400 + 650 && defaultBackNote[0]!.p.x < 14000 - 100,
  defaultBackNote.map((note) => `x=${note.p.x}, layer=${note.layer}`).join(' / ') || 'label missing');

const cabinet18: Cabinet = structuredClone(cabinet);
cabinet18.name = `${cabinet.name}-18mm反例`;
cabinet18.params.backPanel.material = 'M_BOARD_18_WOOD';
const sheet18 = buildFurnitureSheet(room, [cabinet18], project, rules, { furnitureName: cabinet18.name });
const text18 = sheetText(sheet18.prims);
ok('背板材料规则为 18mm 时，图纸标注 18mm 且不残留 9mm 标签',
  text18.includes('18mm背板') && !text18.includes('9mm背板'),
  text18.filter((text) => text.includes('背板')).join(' / '));
const note18 = sheet18.prims.filter((prim): prim is Extract<Prim, { k: 'text' }> => prim.k === 'text' && prim.text === '18mm背板');
ok('18mm 注记同样位于右侧信息栏，不回到内部图框',
  note18.length === 1 && note18[0]?.layer === 'F-ANNOT-RED'
    && note18[0]!.p.x >= 14000 - 2400 + 650 && note18[0]!.p.x < 14000 - 100,
  note18.map((note) => `x=${note.p.x}, layer=${note.layer}`).join(' / ') || 'label missing');

const unknownRules: RuleSet = structuredClone(rules);
unknownRules.materials.M_BACK_9 = { ...unknownRules.materials.M_BACK_9!, thickness: Number.NaN };
ok('背板厚度未知时不生成猜测标注', backPanelThicknessNote(cabinet, unknownRules) === null);

const doubleCabinet: Cabinet = structuredClone(cabinet);
doubleCabinet.layout = { ...doubleCabinet.layout, type: 'double', backUnits: structuredClone(doubleCabinet.layout.units) };
ok('有效双面柜没有实体背板，不输出背板厚度注记', backPanelThicknessNote(doubleCabinet, rules) === null);

console.log(`\n背板注记回归：${pass} 通过，${fail} 失败。`);
if (fail > 0) process.exitCode = 1;
