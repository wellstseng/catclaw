/**
 * @file tools/builtin/hook-remove.ts
 * @description hook_remove — 刪除或停用 hook 腳本
 */

import { unlink, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import type { Tool } from "../types.js";

export const tool: Tool = {
  name: "hook_remove",
  description:
    "刪除或停用已註冊的 hook。mode=delete 實體刪除；mode=disable 重新命名為 *.disabled.ext（scanner 會跳過）。" +
    "需提供 event+name 或完整 scriptPath（二擇一）。",
  tier: "elevated",
  resultTokenCap: 300,
  parameters: {
    type: "object",
    properties: {
      event:      { type: "string", description: "HookEvent（與 name 搭配）" },
      name:       { type: "string", description: "hook 名稱（與 event 搭配）" },
      scriptPath: { type: "string", description: "hook 腳本完整路徑（可替代 event+name）" },
      scope:      { type: "string", description: "global / agent（預設 global，僅用於 event+name 路徑定位）" },
      mode:       { type: "string", description: "delete / disable（預設 disable）" },
    },
  },
  async execute(params, ctx) {
    const event = String(params["event"] ?? "").trim();
    const name = String(params["name"] ?? "").trim();
    const providedPath = String(params["scriptPath"] ?? "").trim();
    const scope = String(params["scope"] ?? "global").trim() as "global" | "agent";
    const mode = String(params["mode"] ?? "disable").trim() as "delete" | "disable";

    try {
      let filePath = providedPath;

      if (!filePath) {
        if (!event || !name) return { error: "需提供 event+name 或 scriptPath" };
        const { getHookRegistry } = await import("../../hooks/hook-registry.js");
        const reg = getHookRegistry();
        if (!reg) return { error: "HookRegistry 未初始化" };

        const all = reg.listAll();
        const pool = scope === "agent" && ctx.agentId
          ? (all.byAgent[ctx.agentId] ?? [])
          : all.global;
        const found = pool.find(h => h.event === event && h.name === name);
        if (!found || !found.scriptPath) {
          return { error: `找不到 hook event=${event} name=${name}（scope=${scope}）` };
        }
        filePath = found.scriptPath;
      }

      if (!existsSync(filePath)) return { error: `hook 檔案不存在：${filePath}` };

      if (mode === "delete") {
        await unlink(filePath);
        return { result: { removed: true, mode: "delete", path: filePath } };
      }

      // disable：重新命名為 *.disabled.ext
      const ext = extname(filePath);
      const base = basename(filePath, ext);
      const target = join(dirname(filePath), `${base}.disabled${ext}`);
      await rename(filePath, target);
      return { result: { removed: true, mode: "disable", from: filePath, to: target } };
    } catch (err) {
      return { error: `移除失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
