/**
 * @file tools/builtin/atom-write.ts
 * @description atom_write — 寫入/更新記憶 atom（standard tier）
 *
 * 寫入後自動更新 MEMORY.md index 和向量資料庫。
 */

import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "atom_write",
  description:
    "寫入或更新一筆記憶 atom。自動更新 MEMORY.md 索引和向量資料庫。" +
    "scope 決定寫入位置：global（全域共用）、agent（當前 agent 專屬）、project、account。" +
    "判斷規則：跨 agent 共用的知識/規則/使用者偏好 → global；agent 專屬的行為校正/工作記錄 → agent。",
  tier: "standard",
  deferred: false,
  resultTokenCap: 500,
  concurrencySafe: false,
  parameters: {
    type: "object",
    properties: {
      name:        { type: "string",  description: "atom 名稱（英文 kebab-case，例如 team-roster）" },
      content:     { type: "string",  description: "atom 內容（知識本體）" },
      description: { type: "string",  description: "一行描述（用於索引和向量搜尋）" },
      confidence:  { type: "string",  description: "信心等級：[固] / [觀] / [臨]（預設 [臨]）" },
      scope:       { type: "string",  description: "範圍：global（全域共用）/ agent（當前 agent 專屬）/ project / account。預設 global" },
      triggers:    { type: "string",  description: "觸發關鍵字，逗號分隔（例如：團隊名單, 成員查詢）" },
      related:     { type: "string",  description: "相關 atom 名稱，逗號分隔" },
    },
    required: ["name", "content"],
  },
  async execute(params, ctx) {
    const name = String(params["name"] ?? "").trim();
    const content = String(params["content"] ?? "").trim();
    const description = String(params["description"] ?? content.slice(0, 60)).trim();
    const confidence = String(params["confidence"] ?? "[臨]").trim() as "[固]" | "[觀]" | "[臨]";
    const scope = String(params["scope"] ?? "global").trim() as "global" | "agent" | "project" | "account";
    const triggersRaw = String(params["triggers"] ?? "").trim();
    const relatedRaw = String(params["related"] ?? "").trim();

    if (!name) return { error: "name 不能為空" };
    if (!content) return { error: "content 不能為空" };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { error: "name 必須是英文 kebab-case（例如 my-atom-name）" };

    const triggers = triggersRaw ? triggersRaw.split(",").map(s => s.trim()).filter(Boolean) : [];
    const related = relatedRaw ? relatedRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    // 決定寫入目錄
    let namespace: string;
    try {
      const { getMemoryEngine } = await import("../../memory/engine.js");
      const engine = getMemoryEngine();
      const { globalDir } = engine.getStatus();
      const { join } = await import("node:path");

      let dir: string;
      let effectiveScope = scope;

      // Global 寫入權限檢查
      if (scope === "global" && ctx.agentId) {
        try {
          const { loadAgentConfig } = await import("../../core/agent-loader.js");
          const agentConfig = loadAgentConfig(ctx.agentId);
          if (agentConfig && !agentConfig.globalMemoryWrite && !agentConfig.admin) {
            // 沒有全域寫入權限 → 降級為 agent scope 並提示
            effectiveScope = "agent";
            return {
              result: {
                written: false,
                reason: `此 agent（${ctx.agentId}）沒有全域記憶寫入權限（globalMemoryWrite=false）。` +
                  `請改用 scope="agent" 寫入 agent 專屬記憶，或請管理者授權。`,
                suggestedScope: "agent",
              },
            };
          }
        } catch { /* agent-loader 未就緒，允許寫入 */ }
      }

      if (effectiveScope === "agent" && ctx.agentId) {
        const { resolveAgentDataDir } = await import("../../core/agent-loader.js");
        dir = join(resolveAgentDataDir(ctx.agentId), "memory");
        namespace = `agent/${ctx.agentId}`;
      } else if (effectiveScope === "project" && ctx.projectId) {
        dir = join(globalDir, "projects", ctx.projectId);
        namespace = `project/${ctx.projectId}`;
      } else if (effectiveScope === "account") {
        dir = join(globalDir, "accounts", ctx.accountId);
        namespace = `account/${ctx.accountId}`;
      } else {
        dir = globalDir;
        namespace = "global";
      }

      // write-gate 去重檢查
      const gate = await engine.checkWrite(content, namespace);
      if (!gate.allowed) {
        return { result: { written: false, reason: `write-gate 阻擋：${gate.reason}` } };
      }

      // PreAtomWrite hook（可 block / 改 content）
      let hookContent = content;
      try {
        const { getHookRegistry } = await import("../../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("PreAtomWrite", ctx.agentId) > 0) {
          const pre = await hookReg.runPreAtomWrite({
            event: "PreAtomWrite",
            atomPath: join(dir, `${name}.md`),
            scope: effectiveScope === "agent" ? "agent" : "global",
            content,
            agentId: ctx.agentId,
            accountId: ctx.accountId,
          });
          if (pre.blocked) return { result: { written: false, reason: `PreAtomWrite hook 阻擋：${pre.reason ?? ""}` } };
          hookContent = pre.content;
        }
      } catch { /* hook 系統不可用，靜默通過 */ }

      const { writeAtom } = await import("../../memory/atom.js");
      const filePath = writeAtom(dir, name, {
        description,
        confidence,
        scope: effectiveScope,
        triggers,
        related,
        content: hookContent,
        namespace,
      });

      // PostAtomWrite hook（observer）
      try {
        const { getHookRegistry } = await import("../../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("PostAtomWrite", ctx.agentId) > 0) {
          await hookReg.runPostAtomWrite({
            event: "PostAtomWrite",
            atomPath: filePath,
            scope: effectiveScope === "agent" ? "agent" : "global",
            bytesWritten: Buffer.byteLength(hookContent),
            agentId: ctx.agentId,
            accountId: ctx.accountId,
          });
        }
      } catch { /* ignore */ }

      return { result: { written: true, path: filePath, namespace } };
    } catch (err) {
      return { error: `寫入失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
