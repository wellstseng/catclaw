#!/usr/bin/env node
/**
 * OpenClaw → CatClaw atom 格式轉換腳本
 *
 * 讀取 ~/.openclaw/workspace/memory/atoms/{fixed,observed,temp}/
 * 轉換為 CatClaw V2.18 格式，輸出到 ~/.catclaw/workspace/memory/
 *
 * 用法：node scripts/convert-openclaw-atoms.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const DRY_RUN = process.argv.includes("--dry-run");

const OPENCLAW_ATOMS = join(homedir(), ".openclaw/workspace/memory/atoms");
const CATCLAW_MEMORY = join(homedir(), ".catclaw/workspace/memory");

// ── 跳過規則 ──────────────────────────────────────────────────────────────────

/** 檔名包含這些片段的 atom 跳過（OpenClaw 自身架構知識） */
/** 已過期/已結案的臨時原子 */
const SKIP_TEMP = new Set([
  "T005-sgi-transfer-20260316.md",    // 3/16 已過
  "T010-memory-upgrade-plan.md",      // 完成 2026-03-07
  "T012-qq-離職-轉調人員到位-20260316.md", // 有效期 3/30 已過
  "T016-migration-discord-tools.md",  // ✅ 結案 2026-03-23
  "T025-15f-claude-usage-check.md",   // 有效期 3/31 已過
]);

const SKIP_PATTERNS = [
  /^F05[6-9]-openclaw/,       // F056-openclaw* ~ F059-openclaw*
  /^F057-openclaw-/,          // F057-openclaw-* 系列（routing, agents, gateway 等）
  /^F057-INDEX/,              // 索引檔
  /^F058-MASTER-INDEX/,       // 主索引
  /^F058-v3\.2/,              // v3.2 升級
  /^F059-openclaw/,           // openclaw final
  /^F059-memory-store/,       // openclaw memory store schema
  /^F060-openclaw/,           // openclaw remaining
  /openclaw-agent-loop/,      // F024
  /openclaw-memory-config/,   // F025
  /openclaw-hooks-impl/,      // F026
  /openclaw-cron$/,           // F027（注意不要誤殺 catclaw 的 cron）
  /openclaw-gateway-config/,  // F028
  /openclaw-plugin-system/,   // F029
  /openclaw-docker-deploy/,   // F030
  /openclaw-session-system/,  // F031
  /openclaw-security$/,       // F032
  /openclaw-providers/,       // F033
  /openclaw-cli-reference/,   // F034
  /openclaw-debug/,           // F035
  /openclaw-tool-result/,     // F036
  /openclaw-multi-agent/,     // F037
  /openclaw-skills/,          // F038
  /openclaw-discord-channel-config/, // F039
  /openclaw-subagents/,       // F040
  /openclaw-workspace-bootstrap/,    // F041
  /openclaw-compaction/,      // F042
  /openclaw-experimental/,    // F043
  /openclaw-webhook-gmail/,   // F044
  /openclaw-prompt-caching/,  // F045
  /openclaw-message-system/,  // F046
  /openclaw-tts/,             // F047
  /openclaw-nodes/,           // F048
  /openclaw-templates/,       // F049
  /openclaw-logging/,         // F050
  /openclaw-v2026/,           // F052 升級知識
  /openclaw-acp/,             // F057-openclaw-acp*
  /openclaw-auto-reply/,      // F057-openclaw-auto-reply*
  /openclaw-channels/,        // F057-openclaw-channels*
  /openclaw-config/,          // F057-openclaw-config
  /openclaw-context-engine/,  // F057-openclaw-context-engine*
  /openclaw-discord/,         // F057-openclaw-discord*
  /openclaw-extensions/,      // F057-openclaw-extensions*
  /openclaw-hooks/,           // F057-openclaw-hooks*
  /openclaw-infra/,           // F057-openclaw-infra
  /openclaw-memory$/,         // F057-openclaw-memory
  /openclaw-plugins/,         // F057-openclaw-plugins
  /openclaw-providers-v3/,    // F057-openclaw-providers-v3
  /openclaw-routing/,         // F057-openclaw-routing*
  /openclaw-sessions-v3/,     // F057-openclaw-sessions-v3
  /openclaw-agents/,          // F057-openclaw-agents*
  /flash-system-fixes/,       // F056 flash system（OpenClaw 專用）
  /memory-system-v2\.5/,      // F051 溫蒂記憶 v2.5（OpenClaw 專用）
  /^F055-catclaw$/,           // 已有 _AIDocs，不需重複搬
  /^F056b-openclaw-code$/,    // OpenClaw 程式碼知識
];

function shouldSkip(filename) {
  const name = basename(filename, ".md");
  if (SKIP_TEMP.has(filename)) return true;
  return SKIP_PATTERNS.some(p => p.test(name));
}

// ── 信心等級映射 ──────────────────────────────────────────────────────────────

function mapConfidence(typeStr, tier) {
  if (tier === "fixed" || /固定/.test(typeStr)) return "[固]";
  if (tier === "observed" || /觀察/.test(typeStr)) return "[觀]";
  return "[臨]";
}

// ── 日期 → Unix ms ──────────────────────────────────────────────────────────

function dateToUnixMs(dateStr) {
  if (!dateStr) return Date.now();
  const d = new Date(dateStr.trim());
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

// ── 產生 atom name（去除編號前綴）──────────────────────────────────────────

function toAtomName(filename) {
  const name = basename(filename, ".md");
  // F001-wells-profile → wells-profile
  // F001a-wells-basic → wells-basic
  // O001-wells-decision-style → wells-decision-style
  // T002-titan-rd → titan-rd
  return name.replace(/^[FOT]\d+[a-z]?-/, "");
}

// ── 解析 OpenClaw atom ──────────────────────────────────────────────────────

function parseOpenClawAtom(raw) {
  const lines = raw.split("\n");
  const meta = {
    title: "",
    type: "",
    tags: [],
    created: "",
    updated: "",
    trigger: [],
    confirmations: 0,
    lastUsed: "",
    source: "",
  };

  // 標題
  const titleLine = lines.find(l => l.startsWith("# "));
  if (titleLine) {
    meta.title = titleLine.replace(/^#\s+/, "").replace(/^\[.+?\]\s*/, "").replace(/^[FOT]\d+[a-z]?\s*[-–—]\s*/, "").trim();
  }

  // metadata 區（到第一個 `---` 或 `## `）
  let contentStart = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // 粗體 key：- **類型**：固定
    const boldMatch = line.match(/^-\s+\*\*(.+?)\*\*[：:]\s*(.+)$/);
    if (boldMatch) {
      const [, key, val] = boldMatch;
      switch (key) {
        case "類型": meta.type = val.trim(); break;
        case "標籤": meta.tags = val.split(/[,，]/).map(s => s.trim()).filter(Boolean); break;
        case "建立": meta.created = val.trim(); break;
        case "更新": meta.updated = val.trim(); break;
        case "來源": meta.source = val.trim(); break;
        case "Trigger": meta.trigger = val.split(/[,，]/).map(s => s.trim()).filter(Boolean); break;
      }
      continue;
    }

    // 純文字 key：- Trigger: xxx
    const plainMatch = line.match(/^-\s+(\w[\w-]*):\s+(.+)$/);
    if (plainMatch) {
      const [, key, val] = plainMatch;
      switch (key.toLowerCase()) {
        case "trigger":
          meta.trigger = val.split(/[,，]/).map(s => s.trim()).filter(Boolean); break;
        case "confirmations":
          meta.confirmations = parseInt(val.trim(), 10) || 0; break;
        case "last-used":
          meta.lastUsed = val.trim(); break;
      }
      continue;
    }

    // 找內容起點（第一個 ## 或 --- 後的 ##）
    if (line.startsWith("## ") && contentStart === -1) {
      contentStart = i;
    }
  }

  // 如果觸發詞為空，用標籤當觸發詞
  if (meta.trigger.length === 0 && meta.tags.length > 0) {
    meta.trigger = [...meta.tags];
  }

  // 內容（從第一個 ## 開始到結尾）
  let content = "";
  if (contentStart >= 0) {
    content = lines.slice(contentStart).join("\n").trim();
    // 移除開頭的 --- 分隔線（如果緊接在 metadata 後）
    content = content.replace(/^---\n+/, "");
  }

  return { meta, content };
}

// ── 轉換單個 atom ──────────────────────────────────────────────────────────

function convertAtom(filename, raw, tier) {
  const atomName = toAtomName(filename);
  const { meta, content } = parseOpenClawAtom(raw);
  const confidence = mapConfidence(meta.type, tier);

  const outputLines = [
    `# ${atomName}`,
    "",
    `- Scope: global`,
    `- Confidence: ${confidence}`,
  ];

  if (meta.trigger.length > 0) {
    outputLines.push(`- Trigger: ${meta.trigger.join(", ")}`);
  }

  outputLines.push(`- Created-at: ${dateToUnixMs(meta.created)}`);
  outputLines.push(`- Last-used: ${meta.lastUsed || new Date().toISOString().slice(0, 10)}`);
  outputLines.push(`- Confirmations: ${meta.confirmations}`);

  outputLines.push("");

  // 把 ## 開頭的內容放進來（保持原有 section 結構，CatClaw parser 會全部納入 content）
  if (content) {
    outputLines.push(content);
  } else {
    outputLines.push("## 知識\n");
  }

  outputLines.push("");

  return {
    name: atomName,
    output: outputLines.join("\n"),
    confidence,
    triggers: meta.trigger,
    title: meta.title,
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
  const tiers = ["fixed", "observed", "temp"];
  const results = { converted: [], skipped: [], errors: [] };

  for (const tier of tiers) {
    const dir = join(OPENCLAW_ATOMS, tier);
    if (!existsSync(dir)) {
      console.log(`[skip] ${dir} 不存在`);
      continue;
    }

    const files = readdirSync(dir).filter(f => f.endsWith(".md"));
    console.log(`\n[scan] ${tier}/：${files.length} 個 atom`);

    for (const file of files) {
      if (shouldSkip(file)) {
        results.skipped.push({ file, reason: "openclaw-specific" });
        continue;
      }

      try {
        const raw = readFileSync(join(dir, file), "utf-8");
        const converted = convertAtom(file, raw, tier);

        if (DRY_RUN) {
          console.log(`  [dry] ${file} → ${converted.name}.md (${converted.confidence})`);
        } else {
          mkdirSync(CATCLAW_MEMORY, { recursive: true });
          const outPath = join(CATCLAW_MEMORY, `${converted.name}.md`);
          writeFileSync(outPath, converted.output, "utf-8");
          console.log(`  [ok] ${file} → ${converted.name}.md`);
        }

        results.converted.push({
          source: file,
          name: converted.name,
          confidence: converted.confidence,
          triggers: converted.triggers,
          title: converted.title,
        });
      } catch (err) {
        results.errors.push({ file, error: err.message });
        console.error(`  [err] ${file}：${err.message}`);
      }
    }
  }

  // ── 產生 MEMORY.md 索引 ─────────────────────────────────────────────────────

  if (!DRY_RUN && results.converted.length > 0) {
    const indexLines = [
      "# Atom Index — CatClaw",
      "",
      "> 從 OpenClaw 遷移，格式已轉為 CatClaw V2.18",
      "",
      "| Atom | Path | Trigger |",
      "|------|------|---------|",
    ];

    for (const item of results.converted) {
      const triggers = item.triggers.join(", ");
      indexLines.push(`| ${item.name} | ${item.name}.md | ${triggers} |`);
    }

    const indexPath = join(CATCLAW_MEMORY, "MEMORY.md");
    writeFileSync(indexPath, indexLines.join("\n") + "\n", "utf-8");
    console.log(`\n[ok] MEMORY.md 索引已產生（${results.converted.length} 筆）`);
  }

  // ── 摘要 ────────────────────────────────────────────────────────────────────

  console.log(`\n=== 摘要 ===`);
  console.log(`轉換：${results.converted.length}`);
  console.log(`跳過：${results.skipped.length}（OpenClaw 專屬）`);
  console.log(`錯誤：${results.errors.length}`);

  if (DRY_RUN) {
    console.log(`\n[dry-run] 未寫入任何檔案。移除 --dry-run 執行實際轉換。`);
  }
}

main();
