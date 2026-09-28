/**
 * 额度视图的 TS 类型 —— 与 shared/quota.mjs 的 `quotaView()` 输出同构。
 *
 * 为什么单独一个文件：shared/quota.mjs 是纯 JS（要被 Node 服务端直接 import），
 * 而前端是 TS 严格模式。把类型写在这里，`src/ai/*`（客户端）与 `src/ui/*`（面板）
 * 都能引用，不必让 aiClient 去 import 一个 .tsx —— 那会把"取数据"和"画界面"缠在一起。
 */

export interface QuotaDim {
  period: 'day' | 'month';
  periodText: string;
  /** null = 不限 */
  limit: number | null;
  limitText: string;
  used: number;
  usedText: string;
  remain: number | null;
  remainText: string;
  pct: number;
  unlimited: boolean;
  exhausted: boolean;
}

export interface QuotaView {
  planId: string;
  planLabel: string;
  models: string[];
  tokens: QuotaDim;
  generations: QuotaDim;
  calls: { day: number; total: number; totalTokens: number; totalGenerations: number };
  /** 是哪一条把这次调用拦下的（null = 没被拦） */
  blockedBy: 'tokens' | 'generations' | null;
  blockReason: string;
  used?: Record<string, number | string>;
}

/** 服务端 /api/account/accounts 下发的档位定义（界面据此生成档位说明，不手写第二份） */
export interface PlanOption {
  id: string;
  label: string;
  tokens?: { limit: number | null; period?: 'day' | 'month' };
  generations?: { limit: number | null; period?: 'day' | 'month' };
  models?: string[];
}
