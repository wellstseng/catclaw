/**
 * @file skills/builtin/aidocs.ts
 * @description /aidocs-status, /aidocs-audit, /aidocs-update skills
 *
 * 知識庫管理：顯示狀態、審計覆蓋率、更新指定模組文件
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import type { Skill } from "../types.js";
import { resolveWorkspaceDir } from "../../core/config.js";
import { log } from "../../logger.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAiDocsDir(): string {
  return join(resolveWorkspaceDir(), "_AIDocs");
}

function getModulesDir(): string {
  return join(getAiDocsDir(), "modules");
}

function getSrcDir(): string {
  return join(resolveWorkspaceDir(), "src");
}

/** 讀取 _CHANGELOG.md 最近 N 筆 */
function recentChangelog(n: number): string[] {
  const p = join(getAiDocsDir(), "_CHANGELOG.md");
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf-8").split("\n");
  const entries: string[] = [];
  for (const line of lines) {
    if (line.startsWith("- ") || line.startsWith("* ")) {
      entries.push(line);
      if (entries.length >= n) break;
    }
  }
  return entries;
}

/** 遞迴收集 .ts 檔案（相對路徑） */
function collectTsFiles(dir: string, base?: string): string[] {
  const result: string[] = [];
  const root = base ?? dir;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return result; }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        result.push(...collectTsFiles(full, root));
      } else if (entry.endsWith(".ts")) {
        result.push(relative(root, full));
      }
    } catch { /* skip */ }
  }
  return result;
}

/** 從 modules/*.md 解析對應的原始碼路徑 */
function parseModuleCoverage(): Map<string, string[]> {
  const dir = getModulesDir();
  const map = new Map<string, string[]>(); // moduleName → covered src paths
  if (!existsSync(dir)) return map;

  for (const file of readdirSync(dir).filter(f => f.endsWith(".md"))) {
    const content = readFileSync(join(dir, file), "utf-8");
    const name = file.replace(".md", "");
    const paths: string[] = [];

    // 從 "對應原始碼" 行或表格中提取 src/ 路徑
    const srcMatches = content.matchAll(/`(src\/[^`]+\.ts)`/g);
    for (const m of srcMatches) {
      paths.push(m[1]!);
    }
    // 也匹配目錄級別 `src/xxx/`
    const dirMatches = content.matchAll(/`(src\/[^`]+\/)`/g);
    for (const m of dirMatches) {
      paths.push(m[1]!);
    }

    map.set(name, [...new Set(paths)]);
  }
  return map;
}

// ── /aidocs-status ──────────────────────────────────────────────────────────

const aidocsStatusSkill: Skill = {
  name: "aidocs-status",
  description: "顯示 _AIDocs 知識庫狀態（文件數、覆蓋率、最近變更）",
  tier: "standard",
  trigger: ["/aidocs-status", "/aidocs status"],

  async execute() {
    const aiDocsDir = getAiDocsDir();
    if (!existsSync(aiDocsDir)) {
      return { text: "❌ 此工作目錄沒有 `_AIDocs/`" };
    }

    const modulesDir = getModulesDir();
    const moduleFiles = existsSync(modulesDir)
      ? readdirSync(modulesDir).filter(f => f.endsWith(".md"))
      : [];

    // 最近更新日期
    let latestDate = "N/A";
    for (const f of moduleFiles) {
      try {
        const mtime = statSync(join(modulesDir, f)).mtime;
        const d = mtime.toISOString().slice(0, 10);
        if (d > latestDate || latestDate === "N/A") latestDate = d;
      } catch { /* skip */ }
    }

    // 覆蓋率
    const coverage = parseModuleCoverage();
    const coveredSrcPaths = new Set<string>();
    for (const paths of coverage.values()) {
      for (const p of paths) coveredSrcPaths.add(p);
    }
    const allTs = collectTsFiles(getSrcDir());
    const uncovered = allTs.filter(f => {
      const full = `src/${f}`;
      // 檢查是否被任何 doc 的路徑覆蓋（完全匹配或目錄前綴匹配）
      for (const cp of coveredSrcPaths) {
        if (cp.endsWith("/") && full.startsWith(cp)) return false;
        if (full === cp) return false;
      }
      return true;
    });
    const covRate = allTs.length > 0
      ? Math.round(((allTs.length - uncovered.length) / allTs.length) * 100)
      : 0;

    // 最近 changelog
    const changelog = recentChangelog(3);

    const lines = [
      "📚 **_AIDocs 知識庫狀態**\n",
      `**modules/ 文件數**：${moduleFiles.length}`,
      `**最近更新**：${latestDate}`,
      `**src/ 總 .ts 檔**：${allTs.length}`,
      `**覆蓋率**：${covRate}%（${allTs.length - uncovered.length}/${allTs.length}）`,
    ];

    if (uncovered.length > 0 && uncovered.length <= 10) {
      lines.push(`\n**未覆蓋檔案**：`);
      for (const f of uncovered) lines.push(`  • \`src/${f}\``);
    } else if (uncovered.length > 10) {
      lines.push(`\n**未覆蓋檔案**：${uncovered.length} 個（執行 \`/aidocs-audit\` 查看完整清單）`);
    }

    if (changelog.length > 0) {
      lines.push(`\n**最近變更**：`);
      for (const c of changelog) lines.push(`  ${c}`);
    }

    return { text: lines.join("\n") };
  },
};

// ── /aidocs-audit ───────────────────────────────────────────────────────────

const aidocsAuditSkill: Skill = {
  name: "aidocs-audit",
  description: "審計 _AIDocs 覆蓋率：列出缺失或未覆蓋的模組",
  tier: "elevated",
  trigger: ["/aidocs-audit", "/aidocs audit"],

  async execute() {
    const aiDocsDir = getAiDocsDir();
    if (!existsSync(aiDocsDir)) {
      return { text: "❌ 此工作目錄沒有 `_AIDocs/`" };
    }

    const coverage = parseModuleCoverage();
    const allTs = collectTsFiles(getSrcDir());
    const coveredSrcPaths = new Set<string>();
    for (const paths of coverage.values()) {
      for (const p of paths) coveredSrcPaths.add(p);
    }

    // 分類：已覆蓋 vs 未覆蓋
    const uncovered: string[] = [];
    const covered: string[] = [];
    for (const f of allTs) {
      const full = `src/${f}`;
      let isCovered = false;
      for (const cp of coveredSrcPaths) {
        if (cp.endsWith("/") && full.startsWith(cp)) { isCovered = true; break; }
        if (full === cp) { isCovered = true; break; }
      }
      if (isCovered) covered.push(full);
      else uncovered.push(full);
    }

    // 檢查 docs 是否引用了不存在的檔案
    const stale: Array<{ doc: string; missingPath: string }> = [];
    const srcDir = getSrcDir();
    for (const [docName, paths] of coverage) {
      for (const p of paths) {
        if (p.endsWith("/")) {
          // 目錄級別
          const dirPath = join(resolveWorkspaceDir(), p);
          if (!existsSync(dirPath)) stale.push({ doc: docName, missingPath: p });
        } else {
          const filePath = join(resolveWorkspaceDir(), p);
          if (!existsSync(filePath)) stale.push({ doc: docName, missingPath: p });
        }
      }
    }

    const total = allTs.length;
    const covRate = total > 0 ? Math.round((covered.length / total) * 100) : 0;

    const lines = [
      "🔍 **_AIDocs 審計報告**\n",
      `**總 .ts 檔**：${total}`,
      `**已覆蓋**：${covered.length}  **未覆蓋**：${uncovered.length}  **覆蓋率**：${covRate}%`,
      `**modules/ 文件數**：${coverage.size}`,
    ];

    if (stale.length > 0) {
      lines.push(`\n⚠️ **過時引用**（文件引用了不存在的路徑）：`);
      for (const s of stale) {
        lines.push(`  • \`${s.doc}.md\` → \`${s.missingPath}\``);
      }
    }

    if (uncovered.length > 0) {
      lines.push(`\n📋 **未覆蓋檔案**：`);
      // 按目錄分組
      const byDir = new Map<string, string[]>();
      for (const f of uncovered) {
        const dir = f.split("/").slice(0, -1).join("/");
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir)!.push(f);
      }
      for (const [dir, files] of byDir) {
        lines.push(`  **${dir}/**`);
        for (const f of files) {
          lines.push(`    • \`${basename(f)}\``);
        }
      }
    } else {
      lines.push(`\n✅ 所有 src/ 檔案均已覆蓋`);
    }

    lines.push(`\n> 此報告僅供參考，不自動修改任何文件。`);
    return { text: lines.join("\n") };
  },
};

// ── /aidocs-update ──────────────────────────────────────────────────────────

const aidocsUpdateSkill: Skill = {
  name: "aidocs-update",
  description: "檢查並顯示指定模組文件與原始碼的差異摘要",
  tier: "elevated",
  trigger: ["/aidocs-update", "/aidocs update"],

  async execute({ args }) {
    const moduleName = args.trim();
    if (!moduleName) {
      return { text: "用法：`/aidocs-update <模組名稱>`\n例：`/aidocs-update agent-loop`" };
    }

    const modulePath = join(getModulesDir(), `${moduleName}.md`);
    if (!existsSync(modulePath)) {
      // 列出可用模組
      const available = existsSync(getModulesDir())
        ? readdirSync(getModulesDir()).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""))
        : [];
      return {
        text: `❌ 找不到模組文件：\`${moduleName}.md\`\n\n可用模組（${available.length}）：\n${available.map(a => `• \`${a}\``).join("\n")}`,
        isError: true,
      };
    }

    // 讀取文件內容
    const docContent = readFileSync(modulePath, "utf-8");
    const docLines = docContent.split("\n").length;
    const docDate = docContent.match(/更新日期：(\d{4}-\d{2}-\d{2})/)?.[1] ?? "未知";

    // 提取文件引用的 src 路徑
    const srcPaths: string[] = [];
    for (const m of docContent.matchAll(/`(src\/[^`]+)`/g)) {
      srcPaths.push(m[1]!);
    }
    const uniqueSrcPaths = [...new Set(srcPaths)];

    // 檢查原始碼是否存在 + 最近修改時間
    const srcInfo: Array<{ path: string; exists: boolean; mtime?: string; lines?: number }> = [];
    for (const p of uniqueSrcPaths) {
      const fullPath = join(resolveWorkspaceDir(), p);
      if (existsSync(fullPath)) {
        try {
          const st = statSync(fullPath);
          const content = readFileSync(fullPath, "utf-8");
          srcInfo.push({
            path: p,
            exists: true,
            mtime: st.mtime.toISOString().slice(0, 10),
            lines: content.split("\n").length,
          });
        } catch {
          srcInfo.push({ path: p, exists: true });
        }
      } else {
        srcInfo.push({ path: p, exists: false });
      }
    }

    // 提取文件中列出的函式/class 名稱
    const docFunctions = new Set<string>();
    for (const m of docContent.matchAll(/`(\w+)\(`/g)) {
      docFunctions.add(m[1]!);
    }
    for (const m of docContent.matchAll(/`(class \w+)`/g)) {
      docFunctions.add(m[1]!.replace("class ", ""));
    }

    // 掃描原始碼中的 export 函式/class，比對文件是否漏列
    const missing: string[] = [];
    for (const info of srcInfo) {
      if (!info.exists) continue;
      const fullPath = join(resolveWorkspaceDir(), info.path);
      if (info.path.endsWith("/")) continue;
      try {
        const src = readFileSync(fullPath, "utf-8");
        const exports = src.matchAll(/export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/g);
        for (const m of exports) {
          const name = m[1]!;
          if (!docFunctions.has(name) && !name.startsWith("_")) {
            missing.push(`${info.path}: ${name}`);
          }
        }
      } catch { /* skip */ }
    }

    // 產出報告
    const lines = [
      `📝 **模組文件檢查：${moduleName}**\n`,
      `**文件**：\`_AIDocs/modules/${moduleName}.md\`（${docLines} 行，更新 ${docDate}）`,
      `**引用原始碼**：${uniqueSrcPaths.length} 個路徑`,
    ];

    const missingFiles = srcInfo.filter(s => !s.exists);
    const newerFiles = srcInfo.filter(s => s.exists && s.mtime && s.mtime > docDate);

    if (missingFiles.length > 0) {
      lines.push(`\n⚠️ **不存在的路徑**：`);
      for (const f of missingFiles) lines.push(`  • \`${f.path}\``);
    }

    if (newerFiles.length > 0) {
      lines.push(`\n🔄 **原始碼比文件更新**：`);
      for (const f of newerFiles) lines.push(`  • \`${f.path}\`（修改 ${f.mtime}）`);
    }

    if (missing.length > 0) {
      lines.push(`\n📋 **文件未列出的 export**（${missing.length} 個）：`);
      for (const m of missing.slice(0, 15)) lines.push(`  • \`${m}\``);
      if (missing.length > 15) lines.push(`  …還有 ${missing.length - 15} 個`);
    }

    if (missingFiles.length === 0 && newerFiles.length === 0 && missing.length === 0) {
      lines.push(`\n✅ 文件與原始碼一致，無需更新`);
    } else {
      lines.push(`\n> 使用 agent loop 指示 AI 更新此文件，或手動編輯 \`_AIDocs/modules/${moduleName}.md\`。`);
    }

    return { text: lines.join("\n") };
  },
};

// ── exports ──────────────────────────────────────────────────────────────────

export const skill = aidocsStatusSkill;
export const skills = [aidocsAuditSkill, aidocsUpdateSkill];
