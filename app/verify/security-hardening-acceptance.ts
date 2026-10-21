/**
 * ══════════════════════════════════════════════════════════════════════
 *  安全加固验收（2026-10-20 审计整改）—— 路径穿越 / 多项目 / SSRF /
 *  CSV 公式注入 / 登录锁定按来源
 *
 *  ── 为什么要有一份"跨模块"的验收 ──
 *    这一轮审计挖出的 4 个多项目 bug 之所以全部活着，根因是 `verify/` 里
 *    **没有任何 projects 相关脚本** —— 修好了也没有东西守着，下次重构照样复发。
 *    另外两条已经修好的安全问题（SSRF、CSV 公式注入）同样没有验收。
 *    本文件把这三类合成一份可执行的回归，接进 `npm run verify:all`。
 *
 *  ── 口径 ──
 *    全部在临时目录里跑，**不碰仓库内的任何数据**；不起服务、不发网络请求
 *    （SSRF 用例全部走 IP 字面量 / 明显内网域名，不需要 DNS）。
 *    每条断言都必须能"从红变绿"：改坏被测实现时它必须变 ✗（见交付说明里的
 *    变异验证矩阵），恒真的断言等于没写。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: unknown, detail = ''): void {
  if (cond === true) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n【${t}】`);
}
/** 同步断言：抛异常 = 没满足（不要让它变成"崩溃"，崩溃看起来也像判红，但分不清） */
function attempt(name: string, fn: () => boolean, detail = ''): void {
  try {
    ok(name, fn(), detail);
  } catch (e) {
    ok(name, false, `${detail ? `${detail}；` : ''}抛异常：${(e as Error)?.message ?? e}`);
  }
}
/** 异步断言：同上 */
async function attemptAsync(name: string, fn: () => Promise<boolean>, detail = ''): Promise<void> {
  try {
    ok(name, await fn(), detail);
  } catch (e) {
    ok(name, false, `${detail ? `${detail}；` : ''}抛异常：${(e as Error)?.message ?? e}`);
  }
}

const TMP = mkdtempSync(join(tmpdir(), 'furnicad-sec-hardening-'));
const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s ?? '').slice(0, 200);
};

// ═══════════ 1. P0-1 路径穿越（projectId 唯一出口 parseProjectId）═══════════
section('1. P0-1 路径穿越：projectId 只能由 parseProjectId() 产出');
{
  const projects = await import('../server/projects.mjs');
  const { parseProjectId, deleteProject, createProject } = projects;

  const dataDir = join(TMP, 'domain-1');
  mkdirSync(dataDir, { recursive: true });

  /**
   * ── 1a–1c 断的是「落点」，不是「ok 字段」 ──
   * 只断言 `ok === false` 会漏掉一种真实退化：白名单（第一道闸）被放开，
   * 而解析后兜底断言（第二道闸）仍然把穿越挡住 —— 此时 ok 依然是 false，
   * 断言全绿，但"三道闸缺一不可"的纪律已经破了。实测过：把白名单注释掉，
   * 只断言 ok 的写法一条都不红。
   * 所以改成看**解析出的 id 落到哪**：任何含分隔符 / `..` / 反斜杠 / 空字节的
   * 输入，要么被拒，要么被抓成不含分隔符的普通名字 —— 绝不允许解码后仍是
   * 一个能拼出目录外路径的串。
   */
  const TRAVERSALS: Array<[string, string]> = [
    ['1a', '..%2F..%2F..%2Faccounts'],
    ['1b', '../../../accounts'],
    ['1c', 'a/b'],
    ['1c2', '..%5C..%5Caccounts'],
    ['1c3', 'a\\b'],
    ['1c4', 'a\u0000b'],
  ];
  for (const [tag, raw] of TRAVERSALS) {
    const r = parseProjectId(dataDir, raw);
    const resolvedId = r.ok === true ? String(r.id) : '';
    const escaped = /[\\/]|\.\.|\u0000/.test(resolvedId);
    // 标签里把不可见字符转义出来，否则 `a\u0000b` 在日志里显示成 "a b"，看不出测的是什么。
    const shown = raw.replace(/\u0000/g, '\\u0000');
    ok(
      `${tag}. parseProjectId 让穿越输入（${shown}）落不到目录外：落点不含分隔符/..`,
      r.ok === false || !escaped,
      `实得：${short(r)}`
    );
  }

  /**
   * 1d 是"别只测返回值、要测真实后果"的那一条：
   * 历史事故里 DELETE /api/projects/..%2f..%2faccounts 真的把账号库删了，
   * 重启后 auth 降级成 local-open（免鉴权）。所以这里造一个"目录外的受害者文件"，
   * 断言它**在处理完之后仍然存在**。
   */
  /**
   * ── 受害者文件的相对深度必须算准，否则这条断言是瞎的 ──
   * `deleteProject` 删的是 join(dataDir, 'projects', '<解码后的 id>.json')。
   * 以 dataDir=${TMP}/domain-1 为例：
   *   '../VICTIM'        → ${TMP}/domain-1/VICTIM.json   ← 命中下面第一个受害者
   *   '../../OUTSIDE'    → ${TMP}/OUTSIDE.json           ← 命中第二个（projects/ 之外）
   * 实测过：随手写 '../../../VICTIM' 会跑到盘符根 D:\VICTIM.json 去 ——
   * 那时就算 parseProjectId 被整个绕过，也只会得到"项目不存在"，
   * 断言照样绿。那不是验收，那是自欺。所以每个用例的受害者都按真实深度摆。
   */
  const victimInside = join(dataDir, 'VICTIM.json');
  const victimOutside = join(TMP, 'OUTSIDE.json');
  writeFileSync(victimInside, JSON.stringify({ keep: true }));
  writeFileSync(victimOutside, JSON.stringify({ keep: true }));
  const DELETES: Array<[string, string, string]> = [
    ['../VICTIM', '../VICTIM', victimInside],
    ['..%2FVICTIM', '..%2FVICTIM', victimInside],
    ['../../OUTSIDE', '../../OUTSIDE', victimOutside],
    ['..%2F..%2FOUTSIDE', '..%2F..%2FOUTSIDE', victimOutside],
  ];
  for (const [tag, raw, victim] of DELETES) {
    let threw = false;
    let message = '';
    try {
      await deleteProject(dataDir, raw);
    } catch (e) {
      threw = true;
      message = String((e as Error)?.message ?? e);
    }
    ok(
      `1d.${tag}. deleteProject 拒绝穿越，且 projects 目录外的受害者文件仍存在`,
      threw === true && existsSync(victim),
      `threw=${threw}（${short(message)}）victimExists=${existsSync(victim)}`
    );
    // 拒绝的理由必须是"ID 非法"这条闸 —— 若报的是"项目不存在"，
    // 说明挡住穿越的是 existsSync 而不是 parseProjectId，闸门已经名存实亡。
    ok(
      `1d.${tag}b. 拒绝来自 projectId 校验（不是"项目不存在"这种偶然挡枪）`,
      threw === true && /项目 ID/.test(message),
      `拒绝信息=${short(message)}`
    );
  }
  void createProject;

  const good = parseProjectId(dataDir, 'proj_abc-123');
  ok(
    '1e. 合法 projectId 仍被接受（proj_abc-123 → ok:true 且 id 原样）',
    good.ok === true && good.id === 'proj_abc-123',
    `实得：${short(good)}`
  );
}

// ═══════════ 2. P0-2 多项目三连：空目录 / 项目文件格式 / 迁移认领 ═══════════
section('2. P0-2 多项目：空目录不递归、新建项目可载入、迁移有认领标记');
{
  const projects = await import('../server/projects.mjs');
  const { listProjects, readActiveProjectId, createProject, migrateIfNeeded } = projects;
  const { openWorkspace } = await import('../server/workspaceHost.mjs');

  // 2a 历史事故：getActiveProjectId 无 active 文件时回调 listProjects，互为递归 →
  //    新账号第一次 GET /api/projects 直接 RangeError（栈溢出）。空目录必测。
  const emptyDir = join(TMP, 'domain-2-empty');
  mkdirSync(emptyDir, { recursive: true });
  /**
   * 2a 是递归事故的正面用例：listProjects → (问激活项目) → readActiveProjectId
   * → (找不到 active-project.json) → 兜底，**单向**读目录即止。
   * 历史上兜底回调了 getActiveProjectId，两个函数互递归 ⇒ 新账号第一次
   * GET /api/projects 直接 RangeError（栈溢出）。
   */
  attempt(
    '2a. 空目录 listProjects 返回 []，不因与 readActiveProjectId 互递归抛 RangeError',
    () => {
      const list = listProjects(emptyDir);
      return Array.isArray(list) && list.length === 0;
    },
    '期望 []'
  );

  /**
   * 2a2 让"兜底分支"真的被执行一次 —— 只有目录里有项目、但没有
   * active-project.json 时它才会跑。否则 2a 可能只是"根本没走到那段代码"，
   * 把兜底改回递归也照样绿（恒真）。顺带钉住"取排序后第一个"，而不是随机一个。
   */
  const fallbackDir = join(TMP, 'domain-2-fallback');
  mkdirSync(fallbackDir, { recursive: true });
  const fallbackProj = await createProject(fallbackDir, '兜底项目');
  attempt(
    '2a2. 无 active-project.json 时 readActiveProjectId 走兜底分支并返回目录内项目 id（单向读目录，不回调 listProjects）',
    () => readActiveProjectId(fallbackDir) === fallbackProj.id,
    `期望 ${fallbackProj.id}，实得 ${short(readActiveProjectId(fallbackDir))}`
  );

  attempt(
    '2b. 空目录 readActiveProjectId 返回 null（不是 undefined/空串）',
    () => readActiveProjectId(emptyDir) === null,
    `实得：${short(readActiveProjectId(emptyDir))}`
  );

  const projDir = join(TMP, 'domain-2-projects');
  mkdirSync(projDir, { recursive: true });
  const created = await createProject(projDir, '客户A');
  const projectFile = join(projDir, 'projects', `${created.id}.json`);
  const envelope = JSON.parse(readFileSync(projectFile, 'utf8')) as Record<string, any>;

  // 2c 历史事故：手搓 {project, version:1} 信封缺 format ⇒ WorkspaceStore.load 一律拒收
  //    ⇒ "新建的项目永远无法激活"。format/formatVersion 是这个信封的唯一身份证。
  ok(
    '2c. createProject 产出带 format/formatVersion 的合法项目信封',
    envelope.format === 'furniture-cad-project' && typeof envelope.formatVersion === 'number' && envelope.formatVersion >= 1 && typeof envelope.project === 'object',
    `信封 keys=${Object.keys(envelope).join(',')} format=${short(envelope.format)} formatVersion=${short(envelope.formatVersion)}`
  );

  const opened = (await openWorkspace({ filePath: projectFile, owner: 'acceptance', account: 'acceptance' })) as {
    ok: boolean;
    error?: string;
  };
  ok('2d. createProject 产出的文件能被 openWorkspace() 正常载入', opened.ok === true, `openWorkspace 失败：${opened.error ?? ''}`);

  // 2e 迁移只换文件名、不改文件内 project.id ⇒ 激活时 PROJECT_ID_MISMATCH 必 409。
  ok(
    '2e. 项目文件内的 project.id 与文件名（去扩展名）一致',
    envelope.project?.id === created.id,
    `project.id=${short(envelope.project?.id)} 文件名 id=${short(created.id)}`
  );

  // 2f 迁移：既要"能迁移"，也要"只被认领一次"（跨租户重复导入 = 数据泄露）。
  const migDir = join(TMP, 'domain-2-migrate');
  mkdirSync(migDir, { recursive: true });
  const legacyPath = join(migDir, 'workspace.json');
  writeFileSync(legacyPath, JSON.stringify({ workspaceId: 'ws_legacy', project: { name: '旧项目', rooms: [], cabinets: [] } }));
  const migrated = (await migrateIfNeeded(migDir, legacyPath)) as { id?: string; error?: string } | null;
  const migFiles = existsSync(join(migDir, 'projects')) ? readdirSync(join(migDir, 'projects')).filter((f) => f.endsWith('.json')) : [];
  let migratedIdMatches = false;
  if (migFiles.length === 1) {
    const migEnvelope = JSON.parse(readFileSync(join(migDir, 'projects', migFiles[0]), 'utf8')) as Record<string, any>;
    migratedIdMatches = migEnvelope.project?.id === migFiles[0].replace(/\.json$/, '');
  }
  ok(
    '2f. 迁移：旧 workspace.json 被改名为 .migrated（认领标记），且新文件 project.id 与文件名一致',
    Boolean(migrated && !migrated.error) && !existsSync(legacyPath) && existsSync(`${legacyPath}.migrated`) && migFiles.length === 1 && migratedIdMatches,
    `migrated=${short(migrated)} oldGone=${!existsSync(legacyPath)} mark=${existsSync(`${legacyPath}.migrated`)} files=${migFiles.join(',')} idMatch=${migratedIdMatches}`
  );

  /**
   * 2g. 迁移产物必须**真的能被载入**。
   *
   *   这一条是 fix-tests 在变异验证里发现的真实缺陷（原实现漏了 schemaVersion）：
   *   只断言"文件生成 + id 一致"会假绿 —— 文件在那儿，但一载入就报
   *   `project.schemaVersion 缺失`，项目激活照样失败。
   *   判据必须是"目标真干成那件事"：openWorkspace() 返回 ok。
   */
  if (migFiles.length === 1) {
    const migOpen = await (await import('../server/workspaceHost.mjs')).openWorkspace({
      filePath: join(migDir, 'projects', migFiles[0]), owner: 'verify', account: 'verify',
    });
    ok('2g. 迁移产物能被 openWorkspace() 真正载入（不是只生成了文件）', migOpen.ok === true, `openWorkspace 失败：${migOpen.error ?? ''}`);
  } else {
    ok('2g. 迁移产物能被 openWorkspace() 真正载入（不是只生成了文件）', false, `迁移未产出唯一文件：${migFiles.join(',')}`);
  }

  /**
   * 2h. 带 format 但**缺 schemaVersion** 的旧文件也必须能迁移并被载入。
   *     这正是上面 2g 暴露出来的那一类输入 —— 旧 workspace 若是从本系统导出的信封，
   *     它本来就带 format，旧代码只补 project 不补 schemaVersion。
   */
  const migDir2 = join(TMP, 'domain-2-migrate-with-format');
  mkdirSync(migDir2, { recursive: true });
  const legacyPath2 = join(migDir2, 'workspace.json');
  writeFileSync(legacyPath2, JSON.stringify({
    format: 'furniture-cad-project', formatVersion: 1, savedAt: new Date().toISOString(),
    workspaceId: 'ws_legacy2', project: { name: '带信封但缺 schemaVersion', rooms: [], cabinets: [] },
  }));
  const migrated2 = (await migrateIfNeeded(migDir2, legacyPath2)) as { id?: string; error?: string } | null;
  const migFiles2 = existsSync(join(migDir2, 'projects')) ? readdirSync(join(migDir2, 'projects')).filter((f) => f.endsWith('.json')) : [];
  const migOpen2 = migFiles2.length === 1
    ? await (await import('../server/workspaceHost.mjs')).openWorkspace({ filePath: join(migDir2, 'projects', migFiles2[0]), owner: 'verify', account: 'verify' })
    : { ok: false, error: '未产出文件' };
  ok('2h. 带 format 但缺 schemaVersion 的旧文件也能迁移并被载入', Boolean(migrated2 && !migrated2.error) && migOpen2.ok === true, `migrated=${short(migrated2)} open=${(migOpen2 as any).error ?? 'ok'}`);
}

// ═══════════ 3. P1-1 SSRF：内网地址判定与 URL 闸 ═══════════
section('3. P1-1 SSRF：内网地址一律拒绝（含 IPv6 / 元数据 / 末尾点绕过）');
{
  const { isPrivateAddress, assertPublicUrl } = await import('../server/ssrfGuard.mjs');

  // 历史洞①：`::1` 分支永远匹配不上 —— URL.hostname 对 IPv6 返回带方括号的 [::1]
  ok('3a. isPrivateAddress 拦住 IPv6 回环 ::1', isPrivateAddress('::1') === true, `实得：${short(isPrivateAddress('::1'))}`);
  ok(
    '3b. isPrivateAddress 拦住 IPv4-mapped ::ffff:127.0.0.1',
    isPrivateAddress('::ffff:127.0.0.1') === true,
    `实得：${short(isPrivateAddress('::ffff:127.0.0.1'))}`
  );
  ok(
    '3c. isPrivateAddress 拦住 link-local 云元数据 169.254.169.254',
    isPrivateAddress('169.254.169.254') === true,
    `实得：${short(isPrivateAddress('169.254.169.254'))}`
  );
  ok(
    '3d. isPrivateAddress 拦住 CGNAT 元数据 100.100.100.200',
    isPrivateAddress('100.100.100.200') === true,
    `实得：${short(isPrivateAddress('100.100.100.200'))}`
  );
  ok('3e. isPrivateAddress 拦住 ULA fd00::1', isPrivateAddress('fd00::1') === true, `实得：${short(isPrivateAddress('fd00::1'))}`);
  // 反向：不能"一律拦" —— 那样图片抓取功能直接全废，也是一次事故。
  ok('3f. isPrivateAddress 放行公网 IPv4 8.8.8.8', isPrivateAddress('8.8.8.8') === false, `实得：${short(isPrivateAddress('8.8.8.8'))}`);
  ok(
    '3g. isPrivateAddress 放行公网 IPv6 2606:4700:4700::1111',
    isPrivateAddress('2606:4700:4700::1111') === false,
    `实得：${short(isPrivateAddress('2606:4700:4700::1111'))}`
  );

  // 以下三条全部走 IP 字面量 / 明显内网域名，**不需要 DNS**（verify:all 不该依赖网络）。
  const v6url = await assertPublicUrl('http://[::1]:8080/x.png');
  ok('3h. assertPublicUrl 拒绝 http://[::1]:8080/x.png', v6url.ok === false, `实得：${short(v6url)}`);

  // 历史洞②：localhost. 带末尾点，域名后缀白名单曾绕过去
  const dot = await assertPublicUrl('http://localhost./x.png');
  ok('3i. assertPublicUrl 拒绝 http://localhost./x.png（末尾点绕过）', dot.ok === false, `实得：${short(dot)}`);

  /**
   * 3j/3k 断的是"**死在哪道闸上**"，不是"有没有死"。
   * file:///etc/passwd 的主机名是空串，即使把协议闸整个删掉，它也会被
   * "缺少主机名"这另一道闸拦住 —— 只断言 ok===false 的话，协议闸坏了照样绿
   * （实测过）。所以要求 reason 明确指向 http/https。
   */
  const fileUrl = await assertPublicUrl('file:///etc/passwd');
  ok(
    '3j. assertPublicUrl 因"非 http/https"拒绝 file:///etc/passwd（不是被空主机名顺手拦住）',
    fileUrl.ok === false && /http|https/i.test(String(fileUrl.reason ?? '')),
    `实得：${short(fileUrl)}`
  );

  // 3k 反向钉住：主机是**公网域名**的 file: URL，除协议闸外没有任何别的闸能拦它。
  const fileHost = await assertPublicUrl('file://example.com/etc/passwd');
  ok(
    '3k. assertPublicUrl 只放行 http/https（file://example.com 同样因协议被拒）',
    fileHost.ok === false && /http|https/i.test(String(fileHost.reason ?? '')),
    `实得：${short(fileHost)}`
  );

  /**
   * 正例（3l/3m）不能省：只有"全拒"的验收是假绿 —— 一旦 SSRF 闸退化成
   * "什么都拦"，图片抓取功能整体报废，而上面的负例一条都不会红。
   *  · 3l 走 IP 字面量分支（8.8.8.8），**不需要 DNS**，verify:all 才能在离线机器上跑；
   *  · 3m 走域名白名单分支，skipDns 跳过解析，同样不依赖网络。
   */
  const pubIp = await assertPublicUrl('http://8.8.8.8/x.png');
  ok('3l. assertPublicUrl 放行公网 IP 字面量（http://8.8.8.8，不是一律拒绝）', pubIp.ok === true, `实得：${short(pubIp)}`);

  const pubHost = await assertPublicUrl('https://example.com/x.png', { skipDns: true });
  ok('3m. assertPublicUrl 放行公网域名（https://example.com，不是一律拒绝）', pubHost.ok === true, `实得：${short(pubHost)}`);
}

// ═══════════ 4. P1-2 CSV 公式注入（CWE-1236）═══════════
section('4. P1-2 CSV 公式注入：= + - @ 开头的值必须被中和');
{
  const { csvCell } = await import('../server/csvCell.mjs');

  const amp = String(csvCell('=cmd|calc'));
  ok('4a. csvCell 中和 "=" 开头（=cmd|calc 前置单引号）', amp.startsWith("'") && amp.includes('=cmd|calc'), `实得：${short(amp)}`);

  const plus = String(csvCell('+1'));
  ok('4b. csvCell 中和 "+" 开头', plus.startsWith("'") && plus === "'+1", `实得：${short(plus)}`);

  const minus = String(csvCell('-1'));
  ok('4c. csvCell 中和 "-" 开头', minus.startsWith("'") && minus === "'-1", `实得：${short(minus)}`);

  // 注意：`@SUM(1,1)` 里带逗号，所以中和之后还会再套一层 RFC4180 引号，
  // 正确输出是 `"'@SUM(1,1)"` —— 断言要认这个真实形状，不能只认裸串。
  const at = String(csvCell('@SUM(1,1)'));
  ok('4d. csvCell 中和 "@" 开头（@SUM(1,1) → "' + '@SUM(1,1) 且保留 RFC4180 引号）', at === `"'@SUM(1,1)"`, `实得：${short(at)}`);

  // 反向：普通文本**不能**被加前缀，否则导出的板件名全变成 '柜体' 这种脏数据。
  const normal = String(csvCell('normal'));
  ok('4e. csvCell 不给普通文本加前缀（normal 原样返回）', normal === 'normal' && !normal.includes("'"), `实得：${short(normal)}`);

  // 回归：公式中和不能把原有的 RFC4180 引号转义弄丢。
  const quoted = String(csvCell('a,b'));
  ok('4f. csvCell 原有 RFC4180 转义仍生效（a,b → "a,b"）', quoted === '"a,b"', `实得：${short(quoted)}`);
}

// ═══════════ 5. P1-4 登录锁定按来源（不能变成"踢人下线"工具）═══════════
section('5. P1-4 登录锁定：按 (账号,来源) 维度，不连坐会话');
{
  const { AuthStore } = await import('../server/auth.mjs');
  const authDir = join(TMP, 'domain-5-auth');
  mkdirSync(authDir, { recursive: true });
  const store = new AuthStore({ accountsPath: join(authDir, 'accounts.json'), auditPath: join(authDir, 'audit.jsonl') });

  const PW = 'Sup3r-Secret-Pass!';
  const created = store.create({ username: 'owner01', password: PW, displayName: '验收用业主' });
  ok('5z. 前置：账号建立成功（否则后面全是假绿）', created.ok === true, `create 失败：${short(created)}`);

  const IP_A = '203.0.113.9';
  const IP_B = '198.51.100.7';
  // 锁定**之前**签发的会话 —— 后面的爆破不能把它作废
  const pre = store.login('owner01', PW, { ip: IP_A });
  const preToken = pre.ok ? String(pre.token) : '';

  // 5a 同一来源连续 5 次错口令 → 被锁定
  let lastCode = '';
  for (let i = 0; i < 5; i++) {
    const r = store.login('owner01', `wrong-password-${i}`, { ip: IP_A });
    lastCode = String(r.code ?? '');
  }
  const afterLock = store.login('owner01', 'wrong-password-final', { ip: IP_A });
  ok(
    '5a. 同一来源连续 5 次口令错误后被锁定（LOCKED）',
    lastCode === 'LOCKED' && afterLock.code === 'LOCKED',
    `第5次 code=${short(lastCode)}，锁后 code=${short(afterLock.code)}`
  );

  // 5b/5c 另一个来源不受影响 —— 历史缺陷是"账号级锁定"，
  //    任何人知道用户名就能把 owner 锁 15 分钟。
  const otherWrong = store.login('owner01', 'wrong-password-from-b', { ip: IP_B });
  ok(
    '5b. 其它来源被锁后仍返回 BAD_CREDENTIALS（不是 LOCKED，锁定不连坐）',
    otherWrong.code === 'BAD_CREDENTIALS',
    `实得 code=${short(otherWrong.code)}`
  );

  const otherOk = store.login('owner01', PW, { ip: IP_B });
  ok('5c. 其它来源用正确口令仍能登录（未被连带锁定）', otherOk.ok === true, `实得：${short({ ok: otherOk.ok, code: otherOk.code })}`);

  // 5d 真正的危害面：`authenticate()` 曾把 lockedUntil 当否决条件 ⇒
  //    攻击者连发 5 次错口令就能让在线用户 401（防爆破反成强制下线工具）。
  const stillIn = store.authenticate(preToken);
  ok(
    '5d. 锁定前签发的 token 仍能通过 authenticate()（爆破不能把在线用户踢下线）',
    Boolean(stillIn) && stillIn?.username === 'owner01',
    `authenticate 返回：${stillIn ? short(stillIn.username) : 'null（被踢下线）'}`
  );
}

// ═══════════ 汇总 ═══════════
rmSync(TMP, { recursive: true, force: true });
console.log('\n══════════════════════════════════════════════════════');
console.log(`  安全加固验收：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：路径穿越拦截、多项目文件契约与迁移认领、SSRF 内网判定、CSV 公式中和、登录锁定按来源均满足。');
