/**
 * @file skills/self-reflect.ts
 * @description Skill 執行後 LLM 自省（項目 10 Week 1 完整版，hermes self-improving 核心）
 *
 * 對應 plan §「改進提案的觸發條件」3 條：
 *   1. 遇到意外（error / retry / 干預 — error 已由 runSkill 直接觸發）
 *   2. 學到非顯而易見的技巧
 *   3. 發現 skill description 缺漏
 *
 * 實作：成功 skill 執行後 fire-and-forget 跑一次 LLM judge。
 *   - 用 platform 預設 provider
 *   - 短 prompt 問 yes/no + 一句原因
 *   - yes → proposeSkillImprovement(triggeredBy="self-reflection")
 *
 * 短路：
 *   - env CATCLAW_SKILL_SELF_REFLECT=false → 整段關閉
 *   - args + result 合計 < 100 chars → 簡單 skill 跳過（avoid 噪音）
 *   - cron: / api: channel → 不是使用者觸發，跳過
 *   - platform 未就緒（getProviderRegistry throw）→ 跳過
 *
 * Mitigation（plan §「Mitigation」）：低品質 LLM 回應 → parse 失敗 / needPropose=false → 不寫提案。
 */

import { log } from "../logger.js";
import { config } from "../core/config.js";
import type { Skill, SkillContext, SkillResult } from "./types.js";

const DEFAULT_MIN_CHARS = 30;

interface SelfReflectionResult {
  needPropose: boolean;
  reason: string;
}

export async function selfReflectSkill(
  skill: Skill,
  ctx: SkillContext,
  result: SkillResult,
  durationMs: number,
): Promise<void> {
  if (process.env["CATCLAW_SKILL_SELF_REFLECT"] === "false") return;
  if (config.safety?.skillSelfReflectEnabled === false) return;
  if (ctx.channelId.startsWith("cron:") || ctx.channelId.startsWith("api:")) return;
  // 短路：超短輸入+輸出（如 /status / /think on）不值得 judge；門檻設低讓多數 skill 都能進判官
  const minChars = config.safety?.skillSelfReflectMinChars ?? DEFAULT_MIN_CHARS;
  const combined = (ctx.args?.length ?? 0) + (result.text?.length ?? 0);
  if (combined < minChars) return;

  let provider;
  try {
    const { getProviderRegistry } = await import("../providers/registry.js");
    provider = getProviderRegistry().resolve({ channelId: ctx.channelId });
  } catch {
    return;
  }

  const argsPreview = (ctx.args ?? "").slice(0, 200);
  const resultPreview = (result.text ?? "").slice(0, 500);

  const judgePrompt =
    `判斷以下 skill 執行是否值得記錄改進提案。\n\n` +
    `Skill: ${skill.name}\n` +
    `Description: ${skill.description}\n` +
    `Args: ${argsPreview || "(空)"}\n` +
    `Duration: ${durationMs}ms\n` +
    `Result preview: ${resultPreview}\n\n` +
    `判斷標準（任一 yes 就 propose）：\n` +
    `1. 遇到非顯然的意外（不是普通的 OK 結果）\n` +
    `2. 學到非顯而易見的技巧（特定參數組合 / 順序 / 邊界）\n` +
    `3. 發現 skill description 缺漏（result 暗示 description 沒寫清楚）\n\n` +
    `普通成功的 skill（如查詢狀態 / 顯示說明）一律 false。\n\n` +
    `回覆嚴格 JSON：{"needPropose": <true|false>, "reason": "<一句話原因>"}`;

  try {
    const stream = await provider.stream(
      [{ role: "user", content: judgePrompt }],
      {
        systemPrompt:
          "你是 skill 自省判斷者。嚴格 yes/no，回 JSON 不加任何前後文。判斷要嚴苛 — 寧可 false，避免噪音。",
      },
    );
    let text = "";
    for await (const evt of stream.events as AsyncIterable<{ type: string; text?: string }>) {
      if (evt.type === "text_delta" && evt.text) text += evt.text;
    }

    const parsed = parseSelfReflectionJson(text);
    if (!parsed || !parsed.needPropose) return;

    const { proposeSkillImprovement } = await import("../memory/skill-improvement-store.js");
    proposeSkillImprovement({
      skillName: skill.name,
      triggeredBy: "self-reflection",
      ctx: { args: ctx.args, channelId: ctx.channelId, authorId: ctx.authorId },
      durationMs,
      situationText: `LLM 自省觸發：${parsed.reason}`,
      observationText: parsed.reason,
    });
    log.debug(`[self-reflect] ${skill.name} → propose（${parsed.reason.slice(0, 40)}）`);
  } catch (err) {
    log.debug(`[self-reflect] ${skill.name} judge 失敗（靜默）：${err instanceof Error ? err.message : String(err)}`);
  }
}

function parseSelfReflectionJson(text: string): SelfReflectionResult | null {
  // 容忍前後雜訊：抓含 needPropose 的最近 JSON object
  const m = text.match(/\{[^{}]*"needPropose"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as { needPropose?: boolean; reason?: string };
    if (typeof parsed.needPropose !== "boolean") return null;
    return {
      needPropose: parsed.needPropose,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch {
    return null;
  }
}
