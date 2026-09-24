/**
 * ══════════════════════════════════════════════════════════════════════
 *  本地草稿 —— localStorage 自动保存层（Task #23）
 *
 *  ── 解决的问题 ──
 *    此前刷新页面 = 项目全丢。"设计到一半去吃个饭"都要先导出文件，
 *    这不是一个能日常使用的工具该有的样子。
 *
 *  ── 存什么 ──
 *    存的是 parseProjectFile 的完整信封（format + formatVersion + savedAt + project）。
 *    直接复用项目文件的序列化/解析 —— 草稿和正式存档是**同一种文件**，
 *    "自动保存"与"手动导出"在格式上没有第二条路，不存在"草稿能读、
 *    文件打不开"或反过来的分叉。
 *
 *  ── 为什么是 localStorage 而不是后端 ──
 *    本地优先（主方案原则 #8）：纯前端、零依赖、断网可用、随浏览器走。
 *    项目只存 authored 字段，通常几十 KB，远够 localStorage 的配额。
 *    后端账号化的多设备同步属于 Task #27 的范围，不在这里混做。
 *
 *  ── 失败策略 ──
 *    localStorage 可能被禁用（隐私模式）或超配额。此时静默降级：
 *    返回空串，界面上的"已保存时间"不更新 —— 界面永远只说真话，
 *    存不进去就说没保存，不假装存了。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Project } from '../core/types.ts';
import { parseProjectFile, serializeProjectFile } from '../core/projectFile.ts';

const KEY = 'furnicad.draft.v1';

/** 保存草稿，返回保存时间（ISO）；失败返回 ''（调用方据此不更新界面的"已保存"） */
export function saveDraft(project: Project): string {
  const savedAt = new Date().toISOString();
  try {
    localStorage.setItem(KEY, serializeProjectFile(project, savedAt));
    return savedAt;
  } catch {
    return '';
  }
}

export interface DraftRecord {
  project: Project;
  savedAt: string;
}

/** 读草稿。不存在 / 内容非法 → null（顺手清掉坏草稿，下次别再被它绊倒） */
export function loadDraft(): DraftRecord | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const r = parseProjectFile(raw);
  if (!r.ok) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* 清不掉就算了，loadDraft 下次照样返回 null */
    }
    return null;
  }
  return { project: r.project, savedAt: r.savedAt };
}

/** 手动丢弃草稿（用于「新建项目」：不清的话一刷新又回来了） */
export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上，静默 */
  }
}

/** HH:MM —— 界面上的"已自动保存"只精确到分钟，秒会让人盯着它焦虑 */
export function fmtSavedAt(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
