#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  OpenAI 兼容端点的替身（只实现 /chat/completions）
 *
 *  为什么要有它：AI 通路要验的是**整条链真的能跑通**
 *  （说一句话 → 计划 → 干跑预览 → 应用 → 模型真的变了）。
 *  接真服务商只能验到失败路径（假 key 必然被拒），而成功路径
 *  才是这条功能存在的全部理由。
 *
 *  为什么抽成独立文件：验收链（run-ui-verify.mjs）和出图脚本
 *  （shot-ai-generate.cjs）都要用它。两份各写一遍的话，
 *  出图那张"AI 生成了什么"迟早会和验收断言里的不是同一个东西 ——
 *  于是截图成了一种比断言更难察觉的假证据。
 *
 *  直接运行：node verify/mock-openai.mjs   （端口用 MOCK_PORT 指定）
 * ══════════════════════════════════════════════════════════════════════
 */
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * mock 的**规划**回答。
 *
 * 计划从**请求里带的快照**推出来（读 cabinets[0] 现在的值），
 * 所以它不依赖种子的具体数值 —— 模型被前面的用例改过也照样对得上。
 */
export function mockPlan(ask, snap) {
  const cab = snap?.cabinets?.[0];
  if (!cab) return { reply: '快照里没有柜体，我不知道该改谁。', actions: [] };
  const name = cab.name;
  if (ask.includes('越界')) {
    // 负例：第二条动作故意多带一个契约里没有的参数 volume
    return {
      reply: '两条动作：把踢脚改成 140，再改个名。第二条我故意多写了一个参数。',
      actions: [
        { action: 'cabinet.setBodyLift', target: { cabinetName: name }, params: { mm: 140 }, reason: '用户要求踢脚 140' },
        { action: 'cabinet.rename', target: { cabinetName: name }, params: { name: `${name}·越界`, volume: 3 }, reason: '顺手改名（多带一个参数）' },
      ],
    };
  }
  /**
   * 「洗衣机柜」—— B38 验的是**复杂柜型**经 AI 全链落地：
   * kind:'appliance'（洞口三尺寸 + topDrawers）必须是契约内说得出的话，
   * 而不是"AI 说不出来、只能建完手动改"。
   *
   * ⚠️ 必须排在「生成一个」分支**前面**：B38 的用户原话是
   * "帮我生成一个洗衣机柜…"，两个关键词同时命中，
   * 分支顺序写反了就会被上面的普通建柜分支截胡（第一版就踩了）。
   */
  if (ask.includes('洗衣机')) {
    return {
      reply: '洗衣机柜搭好了：左侧留 650×850 的洗衣机洞口（上面三只抽屉），右侧一组对开门层板柜。',
      actions: [
        {
          action: 'cabinet.create',
          target: { roomName: snap?.rooms?.[0]?.name ?? '主卧' },
          params: {
            name: 'AI洗衣机柜',
            width: 1400,
            height: 2100,
            depth: 620,
            units: [
              {
                kind: 'appliance',
                width: 700,
                applianceName: '洗衣机',
                openingWidth: 650,
                openingHeight: 850,
                openingDepth: 600,
                topDrawers: 3,
                nickname: '洗衣机位',
              },
              { kind: 'shelves', width: 700, count: 4, doorCount: 2, nickname: '侧柜' },
            ],
          },
          reason: '用户要洗衣机柜：洞口 + 上下分体 + 侧柜',
        },
      ],
    };
  }
  /**
   * 「按描述生成柜体」—— 用户一句话说出内部结构，模型应当**一次**搭出来。
   *
   * 为什么 mock 要专门回这一条：B37 验的是"AI 能不能照描述建柜"这条**成功路径**。
   * 它必须真的给出 cabinet.create + units，而不是让前端自己去凑 ——
   * 否则验到的只是"前端能不能建柜"，AI 通路仍然没被证明。
   */
  if (ask.includes('生成一个') || ask.includes('餐边柜')) {
    return {
      reply: '照你说的搭：左边三只抽屉，中间两块层板带一组对开门，右边留一个开放格。',
      actions: [
        {
          action: 'cabinet.create',
          target: { roomName: snap?.rooms?.[0]?.name ?? '主卧' },
          params: {
            name: 'AI生成柜',
            width: 1200,
            height: 900,
            depth: 400,
            units: [
              { kind: 'drawerBank', width: 400, count: 3, nickname: '左抽' },
              { kind: 'shelves', width: 500, count: 2, doorCount: 2, nickname: '中门格' },
              { kind: 'open', width: 300, nickname: '右开放' },
            ],
          },
          reason: '用户描述了内部结构，一次搭出三个分区',
        },
      ],
    };
  }
  const lift = Math.round(cab.params.bodyLift);
  const to = lift === 120 ? 100 : 120;
  return {
    reply: `把「${name}」的踢脚从 ${lift} 改成 ${to}，并把它改名为「${name}·AI」。`,
    actions: [
      { action: 'cabinet.setBodyLift', target: { cabinetName: name }, params: { mm: to }, reason: `用户要求踢脚 ${to}` },
      { action: 'cabinet.rename', target: { cabinetName: name }, params: { name: `${name}·AI` }, reason: '用户要求改个名字' },
    ],
  };
}

/**
 * mock 的**对话**回答。
 *
 * ── 为什么必须把两条通道分开 ──
 *   `/api/ai/plan` 的 user 消息里带 `【用户这一句要求】` 标记 + 一个 ```json 快照块；
 *   `/api/ai/chat` 的 user 消息**就是用户原话**（快照在 system 消息里）。
 *
 *   早先这个 mock 只认规划请求：对话请求进来后 `ask` 是空串、`snap` 是 null，
 *   于是它老老实实回了一句"快照里没有柜体，我不知道该改谁" —— 而那其实是一次提问。
 *   **通道没分开，mock 就会给出"看起来有回答、其实答错了题"的东西**，
 *   而这类"假成功"比直接报错更难发现。
 *
 * 顺带回一个 `reasoning_content`：推理模型的思考过程是要在界面上折叠显示的，
 * 没有这个字段那条路就永远验不到。
 */
export function mockChat(userText) {
  return {
    content: `（mock 回答）你问的是「${String(userText).slice(-40)}」。这条通道只回答问题，不会修改模型。`,
    reasoning: '先把用户这句话归一下类：它走的是对话通道而不是规划通道，所以按提问处理；答复里要明确说清"不改模型"。',
  };
}

/**
 * 故意慢一点再回。
 *
 * 为什么需要这个延迟：要验证的是"等待期间界面有没有如实告诉用户它在等"。
 * mock 秒回的话，那个状态在探针能读到之前就已经结束了 ——
 * 于是这条断言只能写成"存在即可"（恒真），等于没验。
 * 800ms 足够探针在下一次读取时抓到"AI 正在思考… 1s"这个中间态。
 */
export const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS || 800);

/**
 * mock 的**设计方案**回答（P3）。
 *
 * 房间名从请求里的快照取 —— 与 mockPlan 同一条纪律：
 * 不依赖种子数值，项目被前面的用例改过也照样对得上。
 *
 * 故意给出一个"带问号"的方案吗？不 —— 这条通道验的是**成功路径**
 * （说一句话 → 拿到方案 → 预览 → 确认 → 模型真的多了柜子）。
 * 待确认问题的路径由 verify/proposal-acceptance.ts 的 F 组直接验编译器，
 * 那条不需要 mock。
 */
export function mockDesign(ask, snap) {
  const roomName = snap?.rooms?.[0]?.name;
  return {
    title: `按你说的：「${String(ask || '').slice(0, 20)}」`,
    summary: '玄关放一个鞋柜（下三层鞋抽 + 右侧开放格），再拐个弯接一组挂衣区，两柜成 L 型。',
    ...(roomName ? { room: roomName } : {}),
    cabinets: [
      {
        ref: 'shoe',
        name: '玄关鞋柜',
        width: 1200,
        height: 1000,
        depth: 350,
        units: [
          { kind: 'drawerBank', width: 800, count: 3, nickname: '鞋抽' },
          { kind: 'open', width: 400, nickname: '钥匙格' },
        ],
      },
      {
        ref: 'hang',
        name: '转角挂衣区',
        width: 900,
        height: 2400,
        depth: 600,
        rotation: 90,
        rows: [
          { height: 1400, units: [{ kind: 'hanging', width: 900, rodHeight: 1300 }] },
          { height: 'fill', units: [{ kind: 'drawerBank', width: 900, count: 2 }] },
        ],
      },
    ],
    assemblies: [{ ref: 'g1', name: '玄关 L 型', members: ['shoe', 'hang'], connections: [{ a: 'shoe', b: 'hang', kind: 'corner' }] }],
    assumptions: ['鞋柜深度按常见的 350'],
    questions: [],
  };
}

export function createMockServer() {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = (req.url || '').split('?')[0];
      if (!url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock 只实现了 /chat/completions，收到的是 ${url}` } }));
        return;
      }
      let envelope = {};
      try {
        envelope = JSON.parse(raw || '{}');
      } catch {
        /* 元数据读不出来也照样回，验的是计划而不是解析 */
      }
      const msgs = envelope.messages || [];
      const user = msgs.find((m) => m.role === 'user')?.content || '';
      /** 通道判定：只有规划通道的 user 消息带这个标记 */
      const isPlan = /【用户这一句要求】/.test(user);

      let message;
      let usage;
      /**
       * 通道判定：design 与 plan 的 user 消息用的是同一个模板（buildUserMessage），
       * 只能靠 **system 提示**区分 —— design 的 system 里写着"设计方案"。
       */
      const systemText = msgs.find((m) => m.role === 'system')?.content || '';
      const isDesign = /设计方案/.test(systemText);
      if (isDesign) {
        const snapM = /```json\s*([\s\S]*?)```/.exec(user);
        let snap = null;
        try {
          snap = snapM ? JSON.parse(snapM[1]) : null;
        } catch {
          /* 快照读不出来就按"没有房间"回，前端的语义校验会给一句人话 */
        }
        const ask = (user.split('【用户这一句要求】')[1] || '').trim();
        message = { role: 'assistant', content: JSON.stringify(mockDesign(ask, snap)) };
        usage = { prompt_tokens: 1450, completion_tokens: 220, total_tokens: 1670 };
      } else if (isPlan) {
        const snapM = /```json\s*([\s\S]*?)```/.exec(user);
        let snap = null;
        try {
          snap = snapM ? JSON.parse(snapM[1]) : null;
        } catch {
          /* 快照读不出来 → mockPlan 会如实说"我不知道该改谁" */
        }
        const ask = (user.split('【用户这一句要求】')[1] || '').trim();
        message = { role: 'assistant', content: JSON.stringify(mockPlan(ask, snap)) };
        usage = { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 };
      } else {
        const { content, reasoning } = mockChat(user);
        message = { role: 'assistant', content, reasoning_content: reasoning };
        usage = { prompt_tokens: 92, completion_tokens: 44, total_tokens: 136, reasoning_tokens: 19 };
      }

      const payload = {
        id: `chatcmpl-mock-${isPlan ? 'plan' : 'chat'}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'mock-model-1',
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage,
      };
      const text = JSON.stringify(payload);
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
      }, MOCK_DELAY_MS);
    });
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.join(here, 'mock-openai.mjs');
if (isMain) {
  const port = Number(process.env.MOCK_PORT || 8792);
  const s = createMockServer();
  s.listen(port, '127.0.0.1', () => console.log(`mock OpenAI 端点已就绪：http://127.0.0.1:${port}/v1`));
}
