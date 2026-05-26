/**
 * @file core/prompt-assembler.ts
 * @description System Prompt 模組化組裝器
 *
 * 將 system prompt 拆成可組合的模組（identity / tools-usage / coding-rules /
 * git-rules / output-format / memory-rules），按 mode + 角色動態組裝。
 *
 * 使用方式：
 *   const prompt = assembleSystemPrompt({ role, mode, projectId, ... });
 *   // 結果為完整 system prompt 字串，可直接傳給 agent-loop
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "../logger.js";
import type { Role } from "../accounts/registry.js";
import type { ModePreset } from "./config.js";
import { config, resolveWorkspaceDir } from "./config.js";
import type { FrozenPromptMaterials } from "./session-snapshot.js";

// ── Prompt Module 介面 ──────────────────────────────────────────────────────

export interface PromptModule {
  /** 模組識別名（用於 log 和 debug） */
  name: string;
  /** 優先序（越小越前面，預設 50） */
  priority: number;
  /** 內容產生函式（回傳空字串 = 不注入此模組） */
  build: (ctx: PromptContext) => string;
}

export interface PromptContext {
  /** 使用者角色 */
  role: Role;
  /** 模式 preset */
  mode: ModePreset;
  /** 模式名稱（normal / precision） */
  modeName: string;
  /** 專案 ID（可選） */
  projectId?: string;
  /** Bound project 解析後的 CLAUDE.md 內容（會注入 system prompt 的 catclaw-md module） */
  projectClaudeMd?: string;
  /** Bound project cwd（給 @import 解析當 base dir） */
  projectCwd?: string;
  /** 是否為群組頻道 */
  isGroupChannel?: boolean;
  /** 說話者顯示名稱 */
  speakerDisplay?: string;
  /** CatClaw accountId */
  accountId?: string;
  /** 說話者角色字串（群組場景） */
  speakerRole?: string;
  /** 工作目錄 */
  workspaceDir?: string;
  /** 當前 session 已啟用的 MCP server 名稱 */
  activeMcpServers?: string[];
  /** 對話場景標籤（比照 OpenClaw ConversationLabel）
   *  例："Guild名 #頻道名 channel id:頻道ID" */
  conversationLabel?: string;
  /** Session 開場凍結的 prompt 材料。各 module build() 偵測到此欄位即直接讀凍結值，
   *  不再執行 readFileSync / new Date / 全域變數讀取等變動操作（保 prompt cache 命中）。 */
  frozenMaterials?: FrozenPromptMaterials;
}

// ── Context-aware Intent Detection ──────────────────────────────────────────

export type PromptIntent = "coding" | "research" | "conversation";

const CODING_KEYWORDS_EN = /\b(git|commit|push|pull|merge|branch|rebase|diff|code|bug|fix|refactor|test|build|compile|deploy|npm|tsc|lint|pr|issue|file|function|class|module|import|error|exception|stack|debug|log|trace)\b/i;
// 中文沒有 \b 字邊界，用 alternation 直接列。動詞（執行類）+ 高頻技術名詞
const CODING_KEYWORDS_ZH = /執行|下載|跑一下|跑個|跑起|修(?:bug|復|正)|改成|寫個|寫一|新增|建立|刪除|移除|刪掉|編譯|提交|推上|拉一|安裝|裝起|重啟|啟動|關閉|關掉|抓一|檢查|確認|測試|更新|備份|還原|建置|部署|trace|錯誤|失敗|報錯|跳錯/;
const RESEARCH_KEYWORDS_EN = /\b(search|find|look up|investigate|research|explain|what is|how does|why|compare|analyze|review|check|inspect|describe|list|show|status)\b/i;
const RESEARCH_KEYWORDS_ZH = /查(?:一下|看|找)?|找(?:一下|看|找)?|看一下|看看|列(?:出|一下)?|有沒有|顯示|分析|比較|為什麼|怎麼(?:會|辦|做|樣)?|是什麼|哪個|哪些|是否/;

export function detectIntent(userMessage: string): PromptIntent {
  const codingScore =
    (userMessage.match(CODING_KEYWORDS_EN) || []).length +
    (userMessage.match(CODING_KEYWORDS_ZH) || []).length;
  const researchScore =
    (userMessage.match(RESEARCH_KEYWORDS_EN) || []).length +
    (userMessage.match(RESEARCH_KEYWORDS_ZH) || []).length;

  if (codingScore >= 2) return "coding";
  if (researchScore >= 2 && codingScore === 0) return "research";
  if (codingScore >= 1) return "coding";
  return "conversation";
}

/** 根據 intent 決定要啟用哪些模組 */
export function getModulesForIntent(intent: PromptIntent): string[] | undefined {
  switch (intent) {
    case "coding":
      // 全部模組
      return undefined;
    case "research":
      // 省略 coding-rules、git-rules，但保留工具/技能清單
      return ["date-time", "identity", "context-integrity", "catclaw-md", "tools-usage", "tool-summary", "skill-summary", "output-format", "discord-reply", "memory-rules"];
    case "conversation":
      // 最小 prompt — tools-usage / tool-summary / skill-summary 一律保留，否則 LLM 看不到工具會幻覺執行
      return ["date-time", "identity", "context-integrity", "catclaw-md", "tools-usage", "tool-summary", "skill-summary", "output-format", "discord-reply", "memory-rules"];
  }
}

// ── 內建模組 ─────────────────────────────────────────────────────────────────

const dateTimeModule: PromptModule = {
  name: "date-time",
  priority: 5,
  build: (ctx) => {
    if (ctx.frozenMaterials) return ctx.frozenMaterials.dateTimeText;
    const now = new Date();
    const dateStr = now.toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei", year: "numeric", month: "long", day: "numeric", weekday: "long" });
    const timeStr = now.toLocaleTimeString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
    // session 凍結時刻；user message 前綴每 turn 帶當下 ts，LLM 仍能拿到精確時間
    return `[系統時鐘] 今天是 ${dateStr}，session 開始時間 ${timeStr}（Asia/Taipei）。使用者每則訊息會在 [meta] 前綴帶當下 ts；說「今天」「昨天」「這週」時以該 ts 為基準。`;
  },
};

const identityModule: PromptModule = {
  name: "identity",
  priority: 10,
  build: (ctx) => {
    const parts: string[] = [];
    // 身份由 agent CATCLAW.md 定義，此處只描述平台環境
    parts.push("你正在 CatClaw 平台上運行，以 Discord 為前端介面，提供開發能力與對話服務。");
    parts.push("你的身份、行為規則由下方 CATCLAW.md 定義。");
    if (ctx.conversationLabel) {
      parts.push(`\n[Conversation] ${ctx.conversationLabel}`);
    }
    if (ctx.isGroupChannel) {
      parts.push("[多人頻道] 此頻道有多名使用者；每則 user 訊息會在 [meta] 前綴帶當下說話者，請按該前綴區分。");
    }
    // 注：speakerDisplay / accountId 不在此處注入（per-turn 變動會炸 prompt cache）。
    // 改由 agent-loop.ts 在每則 user message 前綴加 [meta] ts=... speaker=...
    return parts.join("\n");
  },
};

const contextIntegrityModule: PromptModule = {
  name: "context-integrity",
  priority: 15,
  build: () => [
    "## 記憶完整性規則（Anti-Hallucination）",
    "",
    "CatClaw 為了省 token 會把歷史訊息壓縮為標記，**這些標記不是內容**，只是索引：",
    "- `[工具索引 turn N]` / `[工具記錄]`（舊格式） — tool 呼叫紀錄；**連 args 都沒有**，完整內容在索引標示的絕對路徑",
    "- `[對話摘要]` / `[對話摘要｜多輪壓縮...]` — 多輪對話的 LLM 摘要，**非原文**，可能遺漏細節",
    "- `[📄 外部化]` — 原文已存外部檔案（stub 含完整路徑）",
    "- `[已壓縮 ... 內容不可恢復]` / `[user stub]` / `[assistant stub]`（舊格式） — 原文已徹底刪除，無法還原",
    "- `[⚠️ CE 已截斷：原文 N chars，僅保留前 M chars...]` — 訊息被 Decay 截斷，**後半部已丟失**，看到的只是片段",
    "",
    "### 鐵則（違反即違反 CatClaw 精準記憶精神）",
    "1. **不得**憑標記（tool 名稱、摘要片段）推論原文內容、args 或結果；看到截斷標記的訊息**不得**假設內容完整",
    "2. 回答問題前，若 context 中與問題相關的訊息帶有截斷/stub/外部化標記且附有檔案路徑 → **先 read_file 取回完整內容再回答**，不要只靠截斷片段回答",
    "3. 若不確定某段被壓的內容是否與當前問題相關 → **寧可多讀一個檔也不要猜**",
    "4. 檔案不可讀 → 誠實回「此段已不可恢復，請告訴我具體是什麼」",
    "5. 引用任何標記內容必須來自實際讀檔後的原文，不得憑印象或推測",
    "",
    "### Retry Escalation 防線（避免「說謊」失敗模式）",
    "若使用者指出你回答有誤：",
    "- **第一反應**：檢查被質疑的內容是否為 stub/摘要/標記（非原文）",
    "- **是** → 立即承認「我沒有原文，之前是從標記推測」，請使用者提供正確版本或 read_file 路徑",
    "- **不得** 改編敘事去 fit 使用者的糾正——那會讓錯誤升級成「說謊」，嚴重違反 CatClaw 設計目標",
  ].join("\n"),
};

const toolsUsageModule: PromptModule = {
  name: "tools-usage",
  priority: 20,
  build: () => {
    return [
      "## 工具使用規則",
      "- 讀檔用 read_file，不用 cat/head/tail/sed",
      "- 改檔用 edit_file 精確修改，不用 sed/awk",
      "- 建檔用 write_file，不用 echo redirection",
      "- 搜檔用 glob / grep，不用 find",
      "- 修改檔案前必須先 read_file（Read-before-Write 規則，程式碼層面強制）",
      "- 能用專用工具就不用 run_command",
      "- run_command 用於需要 shell 執行的系統指令",
    ].join("\n");
  },
};

const codingRulesModule: PromptModule = {
  name: "coding-rules",
  priority: 30,
  build: (ctx) => {
    if (ctx.frozenMaterials) return ctx.frozenMaterials.codingRulesText;
    // 精密模式從 workspace/prompts/coding-discipline.md 載入
    if (ctx.modeName === "precision" && ctx.workspaceDir) {
      const p = join(ctx.workspaceDir, "prompts", "coding-discipline.md");
      if (existsSync(p)) {
        try { return readFileSync(p, "utf-8"); } catch { /* fall through */ }
      }
    }
    // 一般模式：基本行為約束
    return [
      "## 行為約束",
      "- 程式碼修改保持最小範圍，不主動重構周圍程式碼",
      "- 不加不需要的 docstring、type annotation、無意義註解",
      "- 不為假想的未來需求設計",
      "- 先理解現有程式碼再修改",
    ].join("\n");
  },
};

const gitRulesModule: PromptModule = {
  name: "git-rules",
  priority: 40,
  build: () => {
    return [
      "## Git 安全協定",
      "- 優先建新 commit，不 amend（除非使用者明確要求）",
      "- 禁止 force push 到 main/master",
      "- 禁止 --no-verify",
      "- Destructive operations（reset --hard, checkout ., clean -f）→ 先確認",
      "- git add 指定檔案名，避免 -A 意外提交敏感檔案",
    ].join("\n");
  },
};

const outputFormatModule: PromptModule = {
  name: "output-format",
  priority: 50,
  build: () => {
    return [
      "## 輸出規則",
      "- 直球、精準、無廢話：跳過客套，直接給結論",
      "- 一句話能說的不用三句",
      "- 不在回應結尾總結剛才做的事",
      "- 回應語言：繁體中文（技術術語可英文）",
    ].join("\n");
  },
};

const discordReplyModule: PromptModule = {
  name: "discord-reply",
  priority: 55,
  build: (ctx) => {
    const hasDiscordMcp = ctx.activeMcpServers?.some(s => s.toLowerCase().includes("discord"));
    if (!hasDiscordMcp) return "";
    return [
      "## Discord 回覆規則",
      "你正在 CatClaw 的 Discord agent-loop 內；一般最終回覆請直接輸出文字，平台 reply-handler 會負責送回 Discord。",
      "只有在使用者明確要求 Discord 操作時才使用 Discord MCP/discord tool，例如建立討論串、跨頻道傳訊、讀取/編輯訊息、上傳附件或管理頻道。",
      "不要為了回答當前訊息而自行呼叫 Discord send/reply；這會繞過 reply-handler 與 session history。",
    ].join("\n");
  },
};

/** 工具摘要（由 platform.ts 初始化後注入） */
let _toolSummaryText = "";

/** 供 platform.ts 呼叫：注入工具摘要 */
export function setToolSummary(tools: Array<{ name: string; description: string }>): void {
  if (tools.length === 0) { _toolSummaryText = ""; return; }
  const lines = tools.map(t => `- ${t.name}：${t.description.split("\n")[0]}`);
  _toolSummaryText = [
    "## 可用工具摘要",
    "以下是當前 session 已註冊的所有工具（含 MCP 工具）：",
    ...lines,
  ].join("\n");
}

const toolSummaryModule: PromptModule = {
  name: "tool-summary",
  priority: 56,
  build: (ctx) => {
    if (ctx.frozenMaterials) return ctx.frozenMaterials.toolSummaryText;
    return _toolSummaryText;
  },
};

/** Skill 摘要（由 platform.ts 初始化後注入） */
let _skillSummaryText = "";

/** 供 platform.ts 呼叫：注入 skill 摘要 */
export function setSkillSummary(skills: Array<{ name: string; description: string; trigger: string[] }>): void {
  if (skills.length === 0) { _skillSummaryText = ""; return; }
  const lines = skills.map(s => `- \`${s.trigger[0]}\`（${s.name}）：${s.description}`);
  _skillSummaryText = [
    "## 可用 Skill 指令",
    "使用者可直接在 Discord 輸入以下指令（不經過 AI，由系統直接執行）：",
    ...lines,
    "",
    "當使用者的需求對應到某個 skill 時，引導他們直接輸入對應指令。",
  ].join("\n");
}

const skillSummaryModule: PromptModule = {
  name: "skill-summary",
  priority: 57,
  build: (ctx) => {
    if (ctx.frozenMaterials) return ctx.frozenMaterials.skillSummaryText;
    return _skillSummaryText;
  },
};

const memoryRulesModule: PromptModule = {
  name: "memory-rules",
  priority: 60,
  build: () => {
    return [
      "## 記憶系統",
      "- 使用 memory_recall 工具搜尋相關記憶（向量+關鍵字混合搜尋）",
      "- 已記錄事實直接引用，不重新分析原始碼",
      "- 已載入但不相關的記憶：靜默忽略",
    ].join("\n");
  },
};

/**
 * CATCLAW.md 層級繼承（對標 Claude Code 的 3 層 CLAUDE.md 機制）
 *
 * 從 workspaceDir 開始往上搜尋 CATCLAW.md，直到根目錄。
 * 越接近 workspace 的優先序越高（後載入覆寫先載入）。
 * 返回合併的內容字串。
 */
function loadCatclawMdHierarchy(workspaceDir: string): string {
  const parts: string[] = [];
  let dir = workspaceDir;
  const seen = new Set<string>();

  while (dir && !seen.has(dir)) {
    seen.add(dir);
    const candidate = join(dir, "CATCLAW.md");
    if (existsSync(candidate)) {
      try {
        const content = readFileSync(candidate, "utf-8").trim();
        if (content) {
          // 展開 @import 語法（對齊 Claude Code），讓 CLAUDE.md / CATCLAW.md 內的 @path 自動 inline
          const expanded = expandClaudeMdImports(content, dirname(candidate));
          parts.push(`<!-- CATCLAW.md: ${candidate} -->\n${expanded}`);
        }
      } catch { /* ignore read errors */ }
    }
    const parent = join(dir, "..");
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  if (parts.length === 0) return "";
  // Reverse: root-level first, project-level last (project overrides root)
  parts.reverse();
  return parts.join("\n\n");
}

/**
 * 展開 CLAUDE.md / CATCLAW.md 內的 @import 語法（對齊 Claude Code 行為）。
 *
 * 偵測整行只有 `@<path>` 的 line（前可有空白），把 path 解析為相對 baseDir 的檔案，
 * 讀進來 inline 取代該行。支援巢狀 @import（遞迴展開，seen set 防無限循環）。
 *
 * 範例：
 *   @IDENTITY.md           → 讀 baseDir/IDENTITY.md 內容 inline
 *   @memory/MEMORY.md      → 讀 baseDir/memory/MEMORY.md 內容 inline
 *   @.claude/skills/x.md   → 讀 baseDir/.claude/skills/x.md
 *
 * 失敗（檔不存在 / 讀檔錯誤）保留原行（不替換）— 對使用者明顯可見。
 */
export function expandClaudeMdImports(content: string, baseDir: string, seen = new Set<string>()): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*@(\S+)\s*$/);
    if (!m) { out.push(line); continue; }
    const importPath = m[1]!;
    const fullPath = join(baseDir, importPath);
    if (seen.has(fullPath)) {
      out.push(`<!-- @import ${importPath} skipped: circular reference -->`);
      continue;
    }
    if (!existsSync(fullPath)) {
      out.push(`<!-- @import ${importPath} skipped: file not found at ${fullPath} -->`);
      continue;
    }
    try {
      const imported = readFileSync(fullPath, "utf-8");
      const nextSeen = new Set(seen);
      nextSeen.add(fullPath);
      const expanded = expandClaudeMdImports(imported, dirname(fullPath), nextSeen);
      out.push(`<!-- @import ${importPath} (from ${fullPath}) -->`);
      out.push(expanded);
      out.push(`<!-- /@import ${importPath} -->`);
    } catch (err) {
      out.push(`<!-- @import ${importPath} read failed: ${err instanceof Error ? err.message : String(err)} -->`);
    }
  }
  return out.join("\n");
}

const claudeMdModule: PromptModule = {
  name: "catclaw-md",
  priority: 15, // after identity (10), before tools-usage (20)
  build: (ctx) => {
    if (ctx.frozenMaterials) return ctx.frozenMaterials.catclawMdText;
    const wsDir = ctx.workspaceDir ?? (() => { try { return resolveWorkspaceDir(); } catch { return ""; } })();
    if (!wsDir) return "";

    // 1. Workspace 層級 CATCLAW.md（全域共用規則）
    let content = loadCatclawMdHierarchy(wsDir);
    if (!content) {
      // Auto-create: 優先從 templates/CATCLAW.md 複製，否則用內建預設
      const p = join(wsDir, "CATCLAW.md");
      let defaultContent: string | undefined;
      try {
        const templatePath = join(__dirname, "..", "..", "templates", "CATCLAW.md");
        if (existsSync(templatePath)) {
          defaultContent = readFileSync(templatePath, "utf-8");
        }
      } catch { /* ignore */ }
      if (!defaultContent) {
        defaultContent = `# CATCLAW.md — CatClaw Bot 行為規則\n\n你是 CatClaw，一個專案知識代理人。\n\n## 工作目錄\n\n工作目錄由 bound project（若該頻道有設）或 run_command 實際解析決定。**不要憑記憶回答**，請用 run_command pwd 驗證實際路徑。`;
      }
      try { writeFileSync(p, defaultContent, "utf-8"); log.info(`[prompt-assembler] 已產生預設 CATCLAW.md：${p}`); } catch { /* ignore */ }
      content = defaultContent;
    }

    // 2. Agent 層級 CATCLAW.md（agent 專屬規則，所有 agent 統一機制）
    try {
      const { getBootAgentId, resolveAgentDataDir } = require("./agent-loader.js") as typeof import("./agent-loader.js");
      const agentId = getBootAgentId();
      if (agentId) {
        const agentMdPath = join(resolveAgentDataDir(agentId), "CATCLAW.md");
        if (existsSync(agentMdPath)) {
          const agentContent = readFileSync(agentMdPath, "utf-8").trim();
          if (agentContent) {
            // 同樣展開 @import（agent CATCLAW.md 也可能引用 @memory/xxx.md）
            const expanded = expandClaudeMdImports(agentContent, dirname(agentMdPath));
            content += `\n\n<!-- Agent CATCLAW.md: ${agentMdPath} -->\n${expanded}`;
          }
        }
      }
    } catch { /* agent-loader not ready yet */ }

    // 3. Project 層級 CLAUDE.md（bound project 解析後注入）
    // @import base dir 用 projectCwd（從 ProjectBinding 來），讓 @.claude/memory/xxx 正確解析
    if (ctx.projectClaudeMd) {
      const baseDir = ctx.projectCwd ?? wsDir; // 沒帶 projectCwd 退到 wsDir（不該發生但兜底）
      const expanded = expandClaudeMdImports(ctx.projectClaudeMd, baseDir);
      content += `\n\n<!-- Project CLAUDE.md -->\n${expanded}`;
    }

    return `## Project Instructions (CATCLAW.md)\n\n${content}`;
  },
};

// ── Failure Recall Module ────────────────────────────────────────────────────

/**
 * 快取的 failure summary（由 refreshFailureRecallCache() 非同步更新）。
 * prompt module 同步讀取此快取。
 */
let _failureRecallCache = "";

/** 重新載入 failure recall 快取。應在 session 開始時呼叫。 */
export async function refreshFailureRecallCache(): Promise<void> {
  try {
    const { getRecentFailureSummary } = await import("../workflow/failure-detector.js");
    _failureRecallCache = await getRecentFailureSummary();
    if (_failureRecallCache) {
      log.info(`[prompt-assembler] failure recall 載入 ${_failureRecallCache.split("\n").length - 1} 條陷阱`);
    }
  } catch (err) {
    log.debug(`[prompt-assembler] failure recall 載入失敗：${err instanceof Error ? err.message : String(err)}`);
    _failureRecallCache = "";
  }
}

const failureRecallModule: PromptModule = {
  name: "failure-recall",
  priority: 55, // after coding-rules (40), before memory-rules (60)
  build: (ctx) => {
    if (ctx.frozenMaterials) return ctx.frozenMaterials.failureRecallText;
    return _failureRecallCache;
  },
};

// ── _AIDocs Index Module ────────────────────────────────────────────────────
// Bound project 內 _AIDocs/_INDEX.md 自動注入 system prompt — 讓 agent 知道專案知識庫存在
// 哪些檔，按需用 read_file 取詳細內容（對齊 ~/.claude 那邊 SessionStart 注入 _AIDocs 機制）
// 只注入索引（_INDEX.md），不全部把 _AIDocs/*.md 塞進來（避免爆 token budget）
const aidocsIndexModule: PromptModule = {
  name: "aidocs-index",
  priority: 13, // after identity (10) + catclaw-md (15)，在 tools-usage (20) 之前
  build: (ctx) => {
    // 沒 projectCwd（無 bound project）→ 不注入
    const projectCwd = ctx.projectCwd;
    if (!projectCwd) return "";
    const indexPath = join(projectCwd, "_AIDocs", "_INDEX.md");
    if (!existsSync(indexPath)) return "";
    try {
      const content = readFileSync(indexPath, "utf-8").trim();
      if (!content) return "";
      // 4000 chars 兜底；_INDEX.md 通常 < 1000 chars 但保險
      const truncated = content.length > 4000
        ? content.slice(0, 4000) + "\n\n... [_INDEX.md 已截斷至 4000 chars，完整版用 read_file 取]"
        : content;
      return `## 專案知識庫索引 (_AIDocs/_INDEX.md)\n\n${truncated}\n\n> agent 可依此索引用 read_file 取詳細文件。`;
    } catch (err) {
      log.debug(`[aidocs-index] 讀取失敗：${err instanceof Error ? err.message : String(err)}`);
      return "";
    }
  },
};

// ── Module Registry ──────────────────────────────────────────────────────────

const builtinModules: PromptModule[] = [
  dateTimeModule,
  identityModule,
  contextIntegrityModule,
  claudeMdModule,
  aidocsIndexModule,
  toolsUsageModule,
  codingRulesModule,
  gitRulesModule,
  outputFormatModule,
  discordReplyModule,
  toolSummaryModule,
  skillSummaryModule,
  memoryRulesModule,
  failureRecallModule,
];

const customModules: PromptModule[] = [];

/** 註冊自訂 prompt 模組（供外部擴充） */
export function registerPromptModule(mod: PromptModule): void {
  customModules.push(mod);
}

// ── 組裝器 ───────────────────────────────────────────────────────────────────

/** 組裝段落（name + 原始文字，用於計算 offset） */
export interface AssembleSegment {
  name: string;
  content: string;
}

/** assembleSystemPrompt 的 trace 輸出 */
export interface AssembleTraceOutput {
  modulesActive: string[];
  modulesSkipped: string[];
  /** 按組裝順序的各段落 name + content */
  segments: AssembleSegment[];
}

export interface AssembleOpts extends PromptContext {
  /** 額外的 system prompt 片段（CATCLAW.md 內容、記憶 context 等） */
  extraBlocks?: string[];
  /** extraBlocks 的對應名稱（用於 trace segment 標記），與 extraBlocks 同序 */
  extraBlockNames?: string[];
  /** 覆寫使用的模組（null = 使用全部） */
  moduleFilter?: string[];
  /** 傳入此物件時，組裝完成後寫入模組追蹤資訊 */
  traceOutput?: AssembleTraceOutput;
}

/**
 * 組裝完整 system prompt。
 * 按 priority 排序，依序呼叫每個模組的 build()，串接為一個字串。
 */
export function assembleSystemPrompt(opts: AssembleOpts): string {
  const disabledModules = config.promptAssembler?.disabledModules ?? [];
  const allModules = [...builtinModules, ...customModules]
    .filter(m => !disabledModules.includes(m.name))
    .sort((a, b) => a.priority - b.priority);

  const activeModules = opts.moduleFilter
    ? allModules.filter(m => opts.moduleFilter!.includes(m.name))
    : allModules;

  const skippedModules = opts.moduleFilter
    ? allModules.filter(m => !opts.moduleFilter!.includes(m.name))
    : [];

  const parts: string[] = [];
  const segments: AssembleSegment[] = [];

  // 額外區塊（記憶 / channel override / mode extras）優先注入
  if (opts.extraBlocks?.length) {
    const extraNames = opts.extraBlockNames ?? [];
    for (let i = 0; i < opts.extraBlocks.length; i++) {
      const blk = opts.extraBlocks[i];
      if (!blk) continue;
      parts.push(blk);
      segments.push({ name: extraNames[i] ?? `extra-${i}`, content: blk });
    }
  }

  for (const mod of activeModules) {
    try {
      const content = mod.build(opts);
      if (content) {
        parts.push(content);
        segments.push({ name: mod.name, content });
      }
    } catch (err) {
      log.warn(`[prompt-assembler] 模組 ${mod.name} 組裝失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 寫入 trace 輸出
  if (opts.traceOutput) {
    opts.traceOutput.modulesActive = activeModules.map(m => m.name);
    opts.traceOutput.modulesSkipped = skippedModules.map(m => m.name);
    opts.traceOutput.segments = segments;
  }

  log.debug(`[prompt-assembler] 組裝完成：${activeModules.length} 個模組, ${parts.length} 個區段`);
  return parts.join("\n\n");
}

/** 列出所有已註冊的 prompt 模組（供 debug/dashboard 使用） */
export function listPromptModules(): Array<{ name: string; priority: number }> {
  return [...builtinModules, ...customModules]
    .sort((a, b) => a.priority - b.priority)
    .map(m => ({ name: m.name, priority: m.priority }));
}

/**
 * Session 開場時凍結各 module 的「session 內穩定」輸出，供後續 turn 讀同一份。
 * 由 session-snapshot.ts 的 prepareSessionSnapshot() 呼叫。
 *
 * 凍結的 6 個 module 對應 cache killer 來源：
 * - dateTime（new Date 每 turn 變）
 * - catclaw-md（readFileSync）
 * - coding-rules（readFileSync）
 * - tool-summary / skill-summary（讀全域 mutable cache）
 * - failure-recall（讀全域 mutable cache，本函式呼叫前需先 await refreshFailureRecallCache()）
 *
 * 注意：呼叫時 ctx.frozenMaterials 必須為 undefined，否則會導致 build() 短路成空字串。
 */
export function prepareFrozenMaterials(opts: {
  modeName: string;
  workspaceDir?: string;
}): {
  dateTimeText: string;
  catclawMdText: string;
  codingRulesText: string;
  toolSummaryText: string;
  skillSummaryText: string;
  failureRecallText: string;
} {
  const ctx: PromptContext = {
    role: "admin" as Role,        // 凍結的 6 個 module 都不讀 role
    mode: {} as ModePreset,       // 同上不讀 mode
    modeName: opts.modeName,
    workspaceDir: opts.workspaceDir,
  };
  return {
    dateTimeText: dateTimeModule.build(ctx),
    catclawMdText: claudeMdModule.build(ctx),
    codingRulesText: codingRulesModule.build(ctx),
    toolSummaryText: toolSummaryModule.build(ctx),
    skillSummaryText: skillSummaryModule.build(ctx),
    failureRecallText: failureRecallModule.build(ctx),
  };
}
