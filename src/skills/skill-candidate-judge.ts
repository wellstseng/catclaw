/**
 * @file skills/skill-candidate-judge.ts
 * @description 對話脈絡 LLM 判官 — hermes 自動學習 (a) 的核心。
 *
 * 平行於 self-reflect.ts：
 *   self-reflect = skill 跑完後問「值不值得改進這個 skill」
 *   skill-candidate-judge = 每 N turn / idle 跑「最近的 user→tools→reply 序列裡，有沒有值得抽成新 skill 的 workflow」
 *
 * Fire-and-forget — caller 不 await，失敗只 debug log。
 *
 * 早退條件：
 *   - env CATCLAW_SKILL_CANDIDATE=false
 *   - config.safety.skillCandidate.enabled === false
 *   - cron: / api: channel（非 user-triggered）
 *   - recentTurns.length < minTurnsForJudge（預設 3）
 *   - slug 撞既有 skill 名稱
 *   - cooldown 內（store 內部會擋）
 */

import { log } from "../logger.js";
import { config } from "../core/config.js";
import {
  proposeSkillCandidate,
  isInCooldown,
  type SkillCandidateTrigger,
} from "../memory/skill-candidate-store.js";

export interface RecentTurnSummary {
  /** Turn 序號，純資訊用 */
  turnIndex: number;
  userPrompt: string;
  /** Assistant 最終文字回應（不含 tool blocks） */
  assistantResponse: string;
  /** 本 turn 跑過的 tool 名稱序列（不含 args 細節，避免 prompt 爆炸） */
  toolNames: string[];
  /** 本 turn 是否有失敗的 tool */
  hadError: boolean;
}

export interface JudgeOpts {
  channelId: string;
  agentId: string;
  sessionKey: string;
  triggeredBy: SkillCandidateTrigger;
  recentTurns: RecentTurnSummary[];
  existingSkillNames: string[];
}

interface JudgeResult {
  needPropose: boolean;
  slug: string;
  description: string;
  whenToUse: string;
  sampleWorkflow: string;
  reason: string;
  /** 推薦執行程度（LLM judge 評分） */
  priority?: "low" | "med" | "high";
  /** 緊急性 1-10（LLM judge 評分） */
  urgencyScore?: number;
}

export async function judgeSkillCandidate(opts: JudgeOpts): Promise<void> {
  if (process.env["CATCLAW_SKILL_CANDIDATE"] === "false") return;
  if (config.safety?.skillCandidate?.enabled === false) return;
  if (opts.channelId.startsWith("cron:") || opts.channelId.startsWith("api:")) return;

  const minTurns = config.safety?.skillCandidate?.minTurnsForJudge ?? 3;
  if (opts.recentTurns.length < minTurns) return;

  let provider;
  try {
    const { getProviderRegistry } = await import("../providers/registry.js");
    provider = getProviderRegistry().resolve({ channelId: opts.channelId });
  } catch {
    return;
  }

  const turnsBlock = opts.recentTurns
    .map(t => {
      const u = t.userPrompt.slice(0, 150).replace(/\n/g, " ");
      const r = t.assistantResponse.slice(0, 150).replace(/\n/g, " ");
      const tools = t.toolNames.length > 0 ? t.toolNames.slice(0, 12).join("→") : "(none)";
      const err = t.hadError ? " [hadError]" : "";
      return `T${t.turnIndex}${err}: user="${u}" | tools=${tools} | reply="${r}"`;
    })
    .join("\n");

  const existingBlock = opts.existingSkillNames.length > 0
    ? opts.existingSkillNames.slice(0, 80).join(", ")
    : "(無)";

  const judgePrompt =
    `分析以下最近 ${opts.recentTurns.length} 個 turn，判斷有沒有「值得抽成新 skill 的 workflow」。\n\n` +
    `近期對話：\n${turnsBlock}\n\n` +
    `既有 skill（不要重複提案）：${existingBlock}\n\n` +
    `判斷標準（都要符合才 yes）：\n` +
    `1. 跨 2+ turn 重複類似 tool 序列（不是單次的 ad-hoc 操作）\n` +
    `2. workflow 有明確結構（輸入 → 處理 → 輸出可複現）\n` +
    `3. slug 不與既有 skill 撞名 / 高度重疊\n` +
    `4. workflow 通用，下次類似情境可直接 invoke 而非重新組合\n\n` +
    `寧可 false，避免噪音。一般對話 / 探索 / 一次性任務 → false。\n\n` +
    `**priority / urgency_score 評分標準**（needPropose=true 時必填）：\n` +
    `- high: 對話脈絡反覆出現缺一個現有 skill 解不開的問題（urgency 8-10）\n` +
    `- med: 偶發但有複用空間，user 後續可能再用（urgency 4-7）\n` +
    `- low: 一次性 / 邊角情境，存著可能用不到（urgency 1-3）\n\n` +
    `回覆嚴格 JSON：\n` +
    `{"needPropose": <true|false>, "slug": "kebab-case-name", "description": "一句話描述 skill 做什麼", "whenToUse": "何時該觸發這個 skill", "sampleWorkflow": "簡述 tool 序列", "reason": "為什麼值得 / 不值得", "priority": "low|med|high", "urgencyScore": <1-10>}`;

  try {
    const stream = await provider.stream(
      [{ role: "user", content: judgePrompt }],
      {
        systemPrompt:
          "你是 workflow 抽象化判斷者。嚴格 yes/no，回 JSON 不加任何前後文。判斷要嚴苛 — 寧可 false，避免噪音。slug 必須 kebab-case 且簡潔（≤40 字元）。",
      },
    );
    let text = "";
    for await (const evt of stream.events as AsyncIterable<{ type: string; text?: string }>) {
      if (evt.type === "text_delta" && evt.text) text += evt.text;
    }

    const parsed = parseJudgeJson(text);
    if (!parsed) {
      log.debug(`[skill-candidate] judge JSON parse 失敗，skip（trigger=${opts.triggeredBy}）`);
      return;
    }
    if (!parsed.needPropose) {
      log.debug(`[skill-candidate] judge: 不需提案（${parsed.reason.slice(0, 60)}）`);
      return;
    }

    const slugLower = parsed.slug.toLowerCase().trim();
    if (opts.existingSkillNames.some(n => n.toLowerCase() === slugLower)) {
      log.debug(`[skill-candidate] slug 撞名 ${slugLower}，skip`);
      return;
    }

    const cooldownHours = config.safety?.skillCandidate?.cooldownHours ?? 24;
    if (isInCooldown(parsed.slug, cooldownHours)) {
      log.debug(`[skill-candidate] ${parsed.slug} 冷卻中（${cooldownHours}h），skip`);
      return;
    }

    proposeSkillCandidate({
      slug: parsed.slug,
      description: parsed.description,
      whenToUse: parsed.whenToUse,
      sampleWorkflow: parsed.sampleWorkflow,
      reason: parsed.reason,
      triggeredBy: opts.triggeredBy,
      channelId: opts.channelId,
      agentId: opts.agentId,
      sessionKey: opts.sessionKey,
      cooldownHours,
      priority: parsed.priority,
      urgencyScore: parsed.urgencyScore,
    });
    log.info(`[skill-candidate] propose ${parsed.slug}（trigger=${opts.triggeredBy}）`);
  } catch (err) {
    log.debug(`[skill-candidate] judge 失敗（靜默）：${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseJudgeJson(text: string): JudgeResult | null {
  const m = text.match(/\{[\s\S]*"needPropose"[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as Partial<JudgeResult>;
    if (typeof parsed.needPropose !== "boolean") return null;
    if (!parsed.needPropose) {
      return {
        needPropose: false,
        slug: "",
        description: "",
        whenToUse: "",
        sampleWorkflow: "",
        reason: typeof parsed.reason === "string" ? parsed.reason : "",
      };
    }
    if (typeof parsed.slug !== "string" || !parsed.slug.trim()) return null;
    if (typeof parsed.description !== "string" || !parsed.description.trim()) return null;
    const priority = parsed.priority === "low" || parsed.priority === "med" || parsed.priority === "high"
      ? parsed.priority
      : undefined;
    const urgencyScore = typeof parsed.urgencyScore === "number" && parsed.urgencyScore >= 1 && parsed.urgencyScore <= 10
      ? Math.round(parsed.urgencyScore)
      : undefined;
    return {
      needPropose: true,
      slug: parsed.slug.trim(),
      description: parsed.description.trim(),
      whenToUse: typeof parsed.whenToUse === "string" ? parsed.whenToUse.trim() : "",
      sampleWorkflow: typeof parsed.sampleWorkflow === "string" ? parsed.sampleWorkflow.trim() : "",
      reason: typeof parsed.reason === "string" ? parsed.reason.trim() : "",
      priority,
      urgencyScore,
    };
  } catch {
    return null;
  }
}
