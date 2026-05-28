/**
 * @file core/agent-skill-loader.ts
 * @description Agent Persona Skills — 掃描 agents/{id}/skills/，解析 frontmatter 並組裝 prompt
 *
 * 支援兩種 skill 佈署格式：
 *
 * (A) CatClaw 平鋪格式（舊）：`skills/{name}.md`
 * ```markdown
 * ---
 * name: stock-analysis
 * description: 專業股票技術分析
 * userInvocable: true
 * ---
 *
 * # Skill body...
 * ```
 *
 * (B) Claude Code 資料夾格式（新，可 bundle 腳本／資產）：`skills/{name}/SKILL.md`
 * ```
 * skills/
 *   my-skill/
 *     SKILL.md          ← frontmatter + 主說明
 *     scripts/foo.py    ← 配套腳本
 *     assets/...        ← 其他資產
 * ```
 * SKILL.md 內可用相對路徑引用 bundle 內檔案，body 注入 prompt 時會附上 skillDir。
 * 支援 frontmatter：`name` / `description` / `allowed-tools`（陣列）/ `license` / `userInvocable`（CatClaw 擴充）
 *
 * 載入策略：
 *   1. 掃描目錄：`.md` → 平鋪 skill；子資料夾含 `SKILL.md` → 資料夾 skill
 *   2. 若 config.json 有 skills 欄位 → 只載入指定的 skill
 *   3. 若 skills 欄位為空/未設 → 載入全部
 */

import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { log } from "../logger.js";
import { resolveAgentDataDir } from "./agent-loader.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface AgentSkill {
  name: string;
  description?: string;
  /** CatClaw 擴充：是否允許使用者直接以 `/name` 觸發 */
  userInvocable?: boolean;
  /** Claude Code 規格：限制 skill 可呼叫的 tool 名單（目前僅記錄，尚未強制） */
  allowedTools?: string[];
  /** Claude Code 規格：license 標記 */
  license?: string;
  /** frontmatter 以外的 body（prompt 內容） */
  body: string;
  /** 來源檔案路徑（平鋪：.md 檔本身；資料夾：SKILL.md） */
  filePath: string;
  /** 資料夾 skill 才有：bundle 根目錄，agent 用相對路徑讀腳本／資產時的 base */
  skillDir?: string;
}

// ── Frontmatter 解析 ────────────────────────────────────────────────────────

/** 解析單一 value：支援 true/false / 陣列 [a, b] / quoted "x" / 純字串 */
function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  // 內聯陣列
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }
  // Quoted string
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta: Record<string, unknown> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    meta[key] = parseValue(line.slice(idx + 1));
  }
  return { meta, body: match[2].trim() };
}

/** 從 meta 抽 allowedTools：陣列直接用；字串用逗號切；其他回 undefined */
function extractAllowedTools(meta: Record<string, unknown>): string[] | undefined {
  const raw = meta["allowed-tools"] ?? meta["allowedTools"];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw === "string" && raw.length > 0) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }
  return undefined;
}

/** 從讀檔內容 + 預設 name 組出 AgentSkill */
function buildSkill(opts: {
  raw: string;
  filePath: string;
  defaultName: string;
  skillDir?: string;
}): AgentSkill {
  const { meta, body } = parseFrontmatter(opts.raw);
  return {
    name: String(meta.name ?? opts.defaultName),
    description: meta.description ? String(meta.description) : undefined,
    userInvocable: meta.userInvocable === true,
    allowedTools: extractAllowedTools(meta),
    license: typeof meta.license === "string" ? meta.license : undefined,
    body,
    filePath: opts.filePath,
    skillDir: opts.skillDir,
  };
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * 載入指定 agent 的 skills。
 * @param agentId Agent ID
 * @param filter 只載入這些 skill name（來自 config.json skills 欄位）；null/undefined = 全部
 */
export function loadAgentSkills(agentId: string, filter?: string[] | null): AgentSkill[] {
  const skillsDir = join(resolveAgentDataDir(agentId), "skills");
  if (!existsSync(skillsDir)) return [];

  const filterSet = filter?.length ? new Set(filter) : null;
  const skills: AgentSkill[] = [];

  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = join(skillsDir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }

    try {
      // (A) 平鋪 `.md`：CatClaw 舊格式
      if (stat.isFile() && entry.endsWith(".md")) {
        const raw = readFileSync(fullPath, "utf-8");
        const skill = buildSkill({
          raw,
          filePath: fullPath,
          defaultName: entry.replace(/\.md$/, ""),
        });
        if (filterSet && !filterSet.has(skill.name)) continue;
        skills.push(skill);
        continue;
      }

      // (B) 子資料夾 + SKILL.md：Claude Code 格式
      if (stat.isDirectory()) {
        const skillMdPath = join(fullPath, "SKILL.md");
        if (!existsSync(skillMdPath)) continue;
        const raw = readFileSync(skillMdPath, "utf-8");
        const skill = buildSkill({
          raw,
          filePath: skillMdPath,
          defaultName: entry,
          skillDir: fullPath,
        });
        if (filterSet && !filterSet.has(skill.name)) continue;
        skills.push(skill);
      }
    } catch (err) {
      log.warn(`[agent-skill-loader] 讀取失敗：${fullPath} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  log.debug(`[agent-skill-loader] agent=${agentId} loaded ${skills.length} skill(s)`);
  return skills;
}

/**
 * 將 skills 組裝為 system prompt 區塊。
 */
export function buildSkillsPrompt(skills: AgentSkill[]): string {
  if (skills.length === 0) return "";

  const sections = skills.map(s => {
    const header = s.description ? `### ${s.name} — ${s.description}` : `### ${s.name}`;
    const bundleHint = s.skillDir
      ? `\n\n_（此 skill 含 bundle 資產，根目錄：\`${s.skillDir}\`，body 內相對路徑都從這裡解析；用 read_file 讀取配套檔案）_`
      : "";
    const toolsHint = s.allowedTools?.length
      ? `\n\n_（依規範本 skill 應僅使用 tool：${s.allowedTools.join(", ")}）_`
      : "";
    return `${header}${bundleHint}${toolsHint}\n\n${s.body}`;
  });

  return `\n\n# Agent Skills\n\n以下是你的專屬 skills，遇到相關情境時請依照指示執行。\n\n${sections.join("\n\n---\n\n")}`;
}

/**
 * 產生 skill 自建提示（注入 system prompt，告知 agent 如何建立新 skill）。
 */
export function buildSkillCreationHint(agentId: string): string {
  const skillsDir = join(resolveAgentDataDir(agentId), "skills");
  return [
    `\n\n# Skill 自建能力\n`,
    `你可以用 write_file 在 \`${skillsDir}/\` 底下建立新 skill，下次被召喚時自動載入。支援兩種格式：\n`,
    `**(A) 平鋪 .md（簡單 skill）**：寫成 \`${skillsDir}/my-skill.md\``,
    "```markdown",
    "---",
    "name: my-skill",
    "description: 簡短說明",
    "userInvocable: true",
    "---",
    "",
    "# Skill 內容...",
    "```\n",
    `**(B) 資料夾 + SKILL.md（可 bundle 腳本／資產，相容 Claude Code 規格）**：寫成 \`${skillsDir}/my-skill/SKILL.md\` + 任意配套檔`,
    "```markdown",
    "---",
    "name: my-skill",
    "description: 簡短說明",
    "allowed-tools: [read_file, write_file, run_command]",
    "userInvocable: true",
    "---",
    "",
    "# Skill 內容...",
    "",
    "腳本見 `scripts/foo.py`（相對 skill 資料夾）",
    "```",
  ].join("\n");
}
