/**
 * @file skills/recent-skill-tracker.ts
 * @description 追蹤 channel 最近的 skill 呼叫（項目 10 完整補洞 Phase B 用）
 *
 * 用途：agent-loop 偵測到 user 在 turn 進行中插話時，若該 channel 最近 30s 內有
 *       skill 執行 → 視為「skill 干預」→ emit `skill:interrupted` event。
 *
 * 設計：in-memory Map，process restart 自動清空（可接受）。30s TTL。
 */

const TTL_MS = 30_000;

interface RecentSkill {
  skillName: string;
  startedAtMs: number;
  ctx: { args: string; channelId: string; authorId: string };
}

const _recent = new Map<string, RecentSkill>();

export function recordSkillStart(
  channelId: string,
  skillName: string,
  ctx: { args: string; channelId: string; authorId: string },
): void {
  if (!channelId) return;
  _recent.set(channelId, { skillName, startedAtMs: Date.now(), ctx });
}

/** 取得最近 skill（< TTL）。過期則回 null 並順便清除。 */
export function getRecentSkill(channelId: string): RecentSkill | null {
  const r = _recent.get(channelId);
  if (!r) return null;
  if (Date.now() - r.startedAtMs > TTL_MS) {
    _recent.delete(channelId);
    return null;
  }
  return r;
}

export function clearRecentSkill(channelId: string): void {
  _recent.delete(channelId);
}
