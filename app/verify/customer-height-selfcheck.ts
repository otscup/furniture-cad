
import { readFileSync } from 'node:fs';
import { sampleProject } from '../src/core/docFactory.ts';
import { compileAction } from '../src/ai/compile.ts';

const rules = JSON.parse(readFileSync('src/core/ruleset/factory-default.json', 'utf8'));
const project = sampleProject(rules);
let pass = 0, fail = 0;
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('OK  ' + name); } else { fail++; console.log('FAIL ' + name + ' :: ' + (detail ?? '')); } };

const cases = [
  { height: 1700, want: 1700, label: '1700 直接给' },
  { height: 1.7, want: 1700, label: '1.7 按米换算' },
  { height: 0, want: null, label: '0 = 清除' },
];
for (const c of cases) {
  const r = compileAction({ action: 'project.setCustomerHeight', params: { height: c.height }, reason: 'test' }, project, rules);
  ok('编译成功: ' + c.label, r.ok === true, JSON.stringify(r).slice(0, 200));
  if (r.ok && r.command) {
    const ch = r.command.changes?.[0];
    ok('载荷正确: ' + c.label, ch && ch.path === 'customerHeight' && ch.value === c.want, JSON.stringify(ch));
  }
}
const bad = compileAction({ action: 'project.setCustomerHeight', params: { height: 9999 }, reason: 'test' }, project, rules);
ok('负样本: 9999mm 被拒', bad.ok === false, JSON.stringify(bad).slice(0, 150));
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
