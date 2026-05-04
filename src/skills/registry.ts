/**
 * @file skills/registry.ts
 * @description Skill 註冊表 — 目錄掃描自動載入、trigger 前綴匹配
 *
 * 兩種 skill 類型：
 *   Command-type：TypeScript 直接執行（builtin/*.ts）
 *   Prompt-type ：SKILL.md 格式注入 system prompt（builtin-prompt/**／SKILL.md）
 *
 * 使用方式：
 *   await loadBuiltinSkills()          // 啟動時載入 builtin/
 *   await loadPromptSkills()           // 啟動時載入 builtin-prompt/
 *   const match = matchSkill(text)     // debounce callback 中攔截
 *   const prompt = buildSkillsPrompt() // acp.ts 注入 system prompt
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Skill, SkillContext, SkillResult } from "./types.js";
import { log } from "../logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 內部 Map ─────────────────────────────────────────────────────────────────

const skills = new Map<string, Skill>();

// ── 公開 API ─────────────────────────────────────────────────────────────────

/** 列出所有已載入的 skill */
export function listSkills(): Skill[] {
  return Array.from(skills.values());
}

/** 手動註冊一個 skill */
export function registerSkill(skill: Skill): void {
  skills.set(skill.name, skill);
  log.info(`[skills] 已載入：${skill.name}  triggers=[${skill.trigger.join(", ")}]`);
}

/**
 * 從外部目錄載入 command-type skills（.js 檔）。
 * 適合使用者自訂 skill 目錄（如 ~/.catclaw/skills/）。
 */
export async function loadExternalSkills(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    log.debug(`[skills] 外部 skill 目錄不存在，跳過：${dir}`);
    return;
  }
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    log.warn(`[skills] 外部 skill 目錄無法讀取：${dir}`);
    return;
  }
  let count = 0;
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { skill?: Skill; skills?: Skill[] };
      if (mod.skill) { registerSkill(mod.skill); count++; }
      if (mod.skills) { mod.skills.forEach(s => { registerSkill(s); count++; }); }
    } catch (err) {
      log.warn(`[skills] 外部 skill 載入失敗：${file} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (count > 0) log.info(`[skills] 外部 skill 目錄 ${dir}：載入 ${count} 個`);
}

/**
 * 從外部目錄載入 prompt-type skills（SKILL.md）。
 * 適合使用者自訂 skill 目錄（如 ~/.catclaw/skills/）。
 */
export function loadExternalPromptSkills(dir: string): void {
  if (!existsSync(dir)) {
    log.debug(`[skills] 外部 prompt skill 目錄不存在，跳過：${dir}`);
    return;
  }
  const found = scanSkillMd(dir);
  for (const { name, filePath, content } of found) {
    promptSkills.push({ name, description: extractDescription(content), filePath });
    log.info(`[skills] 外部 Prompt-type 載入：${name}`);
  }
  if (found.length > 0) log.info(`[skills] 外部 prompt skill 目錄 ${dir}：載入 ${found.length} 個`);
}

/**
 * Skill 執行 wrapper（項目 10 Week 1）：包裝 skill.execute 加自動提案產生 hook。
 * 真錯誤（isError && !validation）或拋例外時自動寫提案到 _staging/skill-improvements/。
 * 包裝 transparent — 例外仍會 re-throw，caller 端 try/catch 行為不變。
 *
 * 3 個 caller 改用此 wrapper：discord.ts / slash.ts / tools/builtin/skill.ts。
 */
export async function runSkill(skill: Skill, ctx: SkillContext): Promise<SkillResult> {
  const startMs = Date.now();
  // 項目 10 完整補洞 Phase B：記最近 skill 給干預偵測用
  void (async () => {
    try {
      const { recordSkillStart } = await import("./recent-skill-tracker.js");
      recordSkillStart(ctx.channelId, skill.name, {
        args: ctx.args,
        channelId: ctx.channelId,
        authorId: ctx.authorId,
      });
    } catch { /* 靜默 */ }
  })();
  try {
    const result = await skill.execute(ctx);
    const durationMs = Date.now() - startMs;
    if (result.isError === true && result.validation !== true) {
      _proposeImprovement(skill, ctx, "isError", result.text, durationMs);
    } else {
      // 成功 case → fire-and-forget LLM 自省（項目 10 完整版，hermes self-improving 核心）
      // env CATCLAW_SKILL_SELF_REFLECT=false 可整段關閉
      void (async () => {
        try {
          const { selfReflectSkill } = await import("./self-reflect.js");
          await selfReflectSkill(skill, ctx, result, durationMs);
        } catch (err) {
          log.debug(
            `[skills:${skill.name}] self-reflect 失敗（靜默）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    }
    return result;
  } catch (err) {
    _proposeImprovement(
      skill,
      ctx,
      "exception",
      err instanceof Error ? err.message : String(err),
      Date.now() - startMs,
    );
    throw err;
  }
}

function _proposeImprovement(
  skill: Skill,
  ctx: SkillContext,
  triggeredBy: "isError" | "exception",
  detail: string,
  durationMs: number,
): void {
  void (async () => {
    try {
      const { proposeSkillImprovement } = await import("../memory/skill-improvement-store.js");
      proposeSkillImprovement({
        skillName: skill.name,
        triggeredBy,
        ctx: { args: ctx.args, channelId: ctx.channelId, authorId: ctx.authorId },
        durationMs,
        situationText:
          triggeredBy === "exception"
            ? `skill \`${skill.name}\` 拋出例外：${detail}`
            : `skill \`${skill.name}\` 回傳 isError：${detail.slice(0, 200)}`,
      });
    } catch (err) {
      log.warn(
        `[skills:${skill.name}] 提案產生失敗：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
}

/**
 * 比對輸入文字，回傳匹配的 skill + 剩餘 args
 * 無匹配回傳 null
 */
export function matchSkill(text: string): { skill: Skill; args: string } | null {
  const lower = text.toLowerCase().trim();
  for (const skill of skills.values()) {
    for (const t of skill.trigger) {
      const tl = t.toLowerCase();
      if (
        lower === tl ||
        lower.startsWith(tl + " ") ||
        lower.startsWith(tl + "\n")
      ) {
        const args = text.slice(t.length).trim();
        return { skill, args };
      }
    }
  }
  return null;
}

/** 掃描 builtin/ 目錄，自動載入所有 export skill 的 .js 檔 */
export async function loadBuiltinSkills(): Promise<void> {
  const dir = join(__dirname, "builtin");
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  } catch {
    log.warn("[skills] builtin 目錄不存在或無法讀取，跳過");
    return;
  }

  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(join(dir, file)).href)) as { skill?: Skill; skills?: Skill[] };
      if (mod.skill) registerSkill(mod.skill);
      if (mod.skills) mod.skills.forEach(s => registerSkill(s));
    } catch (err) {
      log.warn(`[skills] 載入失敗：${file} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  log.info(`[skills] 載入完成，共 ${skills.size} 個 skill`);
}

// ── Prompt-type Skill ────────────────────────────────────────────────────────

interface PromptSkill {
  name: string;
  description: string;
  filePath: string; // SKILL.md 絕對路徑（供 Claude Read tool 使用）
}

const promptSkills: PromptSkill[] = [];

/**
 * 遞迴掃描 builtin-prompt/ 目錄，載入所有 SKILL.md
 * 目錄結構：builtin-prompt/{category}/SKILL.md 或 builtin-prompt/{category}/{sub}/SKILL.md
 */
export function loadPromptSkills(): void {
  const baseDir = join(__dirname, "builtin-prompt");
  if (!existsSync(baseDir)) {
    log.warn("[skills] builtin-prompt 目錄不存在，跳過");
    return;
  }

  const found = scanSkillMd(baseDir);
  for (const { name, filePath, content } of found) {
    promptSkills.push({ name, description: extractDescription(content), filePath });
    log.info(`[skills] Prompt-type 載入：${name}`);
  }
  log.info(`[skills] Prompt-type 載入完成，共 ${promptSkills.length} 個`);
}

/** 遞迴掃描目錄，回傳所有 SKILL.md 的 {name, filePath, content} */
function scanSkillMd(dir: string): Array<{ name: string; filePath: string; content: string }> {
  const result: Array<{ name: string; filePath: string; content: string }> = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === "SKILL.md") {
      try {
        const content = readFileSync(fullPath, "utf-8");
        // name 取自上層目錄名稱
        const name = dir.split(/[\\/]/).pop() ?? "unknown";
        result.push({ name, filePath: fullPath, content });
      } catch (err) {
        log.warn(`[skills] 讀取失敗：${fullPath} — ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // 嘗試作為子目錄遞迴
      try {
        const sub = scanSkillMd(fullPath);
        result.push(...sub);
      } catch {
        // 非目錄，忽略
      }
    }
  }
  return result;
}

/** 從 SKILL.md 內容提取 description 欄位（YAML frontmatter） */
function extractDescription(content: string): string {
  const m = content.match(/^description:\s*(.+)$/m);
  return m?.[1]?.trim() ?? "";
}

/**
 * 產生 Prompt-type skill 的 system prompt 注入字串
 *
 * 仿 OpenClaw 兩段式：只注入清單（name + description + path）
 * Claude 需要時自己用 Read tool 讀取 SKILL.md 完整內容
 *
 * 項目 10 Week 3 整合（commit pending）：每個 skill 若有 promoted improvement-atoms，
 * 在 <skill> block 內附加 <improvements> 子標籤列出該 skill 的經驗補充摘要 +
 * 完整路徑（讓 LLM 需要時用 Read tool 讀取詳細內容）。
 * Promote 流程：dashboard 「提案」 tab → Accept → 從 _staging 搬到
 * ~/.catclaw/workspace/skills/{skillName}/improvement-atoms/ → 下次載 skills prompt 時自動帶。
 */
export function buildSkillsPrompt(): string {
  if (promptSkills.length === 0) return "";

  const items = promptSkills.map((s) => {
    let atomsBlock = "";
    try {
      // sync require — 避免 buildSkillsPrompt() 變成 async
      const mod = require("../memory/skill-improvement-store.js") as {
        listImprovementAtoms?: (skillName: string) => Array<{ fileName: string; filePath: string; rawText: string }>;
      };
      const atoms = mod.listImprovementAtoms?.(s.name) ?? [];
      if (atoms.length > 0) {
        const previews = atoms.map(a => {
          // 抽 description 欄位作為 preview
          const m = a.rawText.match(/^description:\s*(.+)$/m);
          return m ? m[1]!.trim().slice(0, 100) : a.fileName;
        }).slice(0, 5);
        atomsBlock =
          `\n    <improvements count="${atoms.length}" dir="${atoms[0]!.filePath.replace(/\/[^/]+$/, "")}">\n` +
          previews.map(p => `      <atom>${p}</atom>`).join("\n") +
          `\n    </improvements>`;
      }
    } catch { /* 模組未就緒 / 讀取失敗 → 略 */ }

    return `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>${atomsBlock}\n  </skill>`;
  }).join("\n");

  return `\n\n## Skills
Scan <available_skills> before replying.
- If a skill clearly applies: use Read tool to load the SKILL.md at <location>, then follow it.
- If <improvements> is non-empty: also Read the atoms in that dir for accumulated experience.
- If none apply: do not load any SKILL.md.

<available_skills>
${items}
</available_skills>`;
}
