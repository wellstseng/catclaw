/**
 * @file tools/builtin/atom-delete.ts
 * @description atom_delete — 刪除記憶 atom（standard tier）
 *
 * 刪除檔案 + 移除 MEMORY.md index + 移除向量資料庫條目。
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "atom_delete",
  description: "刪除一筆記憶 atom。同時移除 MEMORY.md 索引和向量資料庫條目。",
  tier: "standard",
  deferred: false,
  resultTokenCap: 300,
  concurrencySafe: false,
  parameters: {
    type: "object",
    properties: {
      name:  { type: "string", description: "atom 名稱（英文 kebab-case，例如 team-roster）" },
      scope: { type: "string", description: "範圍：global / agent / project / account（預設 global）" },
    },
    required: ["name"],
  },
  async execute(params, ctx) {
    const name = String(params["name"] ?? "").trim();
    const scope = String(params["scope"] ?? "global").trim() as "global" | "agent" | "project" | "account";

    if (!name) return { error: "name 不能為空" };

    try {
      const { getMemoryEngine } = await import("../../memory/engine.js");
      const engine = getMemoryEngine();
      const { globalDir } = engine.getStatus();

      let dir: string;
      let namespace: string;
      if (scope === "agent" && ctx.agentId) {
        const { resolveAgentDataDir } = await import("../../core/agent-loader.js");
        dir = join(resolveAgentDataDir(ctx.agentId), "memory");
        namespace = `agent/${ctx.agentId}`;
      } else if (scope === "project" && ctx.projectId) {
        dir = join(globalDir, "projects", ctx.projectId);
        namespace = `project/${ctx.projectId}`;
      } else if (scope === "account") {
        dir = join(globalDir, "accounts", ctx.accountId);
        namespace = `account/${ctx.accountId}`;
      } else {
        dir = globalDir;
        namespace = "global";
      }

      const filePath = join(dir, `${name}.md`);
      if (!existsSync(filePath)) {
        return { result: { deleted: false, reason: `atom "${name}" 不存在（${filePath}）` } };
      }

      // PreAtomDelete hook（可 block）
      try {
        const { getHookRegistry } = await import("../../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("PreAtomDelete", ctx.agentId) > 0) {
          const pre = await hookReg.runPreAtomDelete({
            event: "PreAtomDelete",
            atomPath: filePath,
            scope: scope === "agent" ? "agent" : "global",
            agentId: ctx.agentId,
            accountId: ctx.accountId,
          });
          if (pre.blocked) return { result: { deleted: false, reason: `PreAtomDelete hook 阻擋：${pre.reason ?? ""}` } };
        }
      } catch { /* ignore */ }

      // 1. 刪除檔案
      unlinkSync(filePath);

      // PostAtomDelete hook（observer）
      try {
        const { getHookRegistry } = await import("../../hooks/hook-registry.js");
        const hookReg = getHookRegistry();
        if (hookReg && hookReg.count("PostAtomDelete", ctx.agentId) > 0) {
          await hookReg.runPostAtomDelete({
            event: "PostAtomDelete",
            atomPath: filePath,
            scope: scope === "agent" ? "agent" : "global",
            agentId: ctx.agentId,
            accountId: ctx.accountId,
          });
        }
      } catch { /* ignore */ }

      // 2. 移除 MEMORY.md index
      try {
        const { removeIndex } = await import("../../memory/index-manager.js");
        const memoryMdPath = join(dir, "MEMORY.md");
        removeIndex(memoryMdPath, name);
      } catch { /* index 不存在或更新失敗，不阻擋 */ }

      // 3. 移除向量資料庫條目
      import("../../vector/lancedb.js").then(({ getVectorService }) => {
        try {
          const vs = getVectorService();
          if (vs.isAvailable()) {
            vs.delete(name, namespace).catch(() => {});
          }
        } catch { /* vector service 未初始化 */ }
      }).catch(() => {});

      return { result: { deleted: true, path: filePath, namespace } };
    } catch (err) {
      return { error: `刪除失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
