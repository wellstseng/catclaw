/**
 * @file memory/atom-locations.ts
 * @description Atom scope → (dir, namespace) 解析單一來源
 *
 * 抽出自 atom-write.ts / atom-delete.ts 原本各自重複的 4-branch 邏輯。
 *
 * 對應規則（與原始實作 byte-identical）：
 *   - scope="agent" + ctx.agentId    → resolveAgentDataDir(agentId)/memory, ns="agent/{id}"
 *   - scope="project" + ctx.projectId → globalDir/projects/{id},           ns="project/{id}"
 *   - scope="account"                 → globalDir/accounts/{accountId},    ns="account/{id}"
 *                                       （原邏輯不檢查 accountId 是否 undefined，保留以維持等價）
 *   - 其他                            → globalDir,                          ns="global"
 *
 * 對 catclaw upstream V5 對齊（commit 89ccb2d）的本地對應做法：
 * 上游用 `lib/atom_locations.py` 抽 feedback-* + Failures layer 路由；catclaw
 * 沒有 Failures 概念，這裡只抽 scope→dir 的 4-branch（純內部重複消除，無行為變化）。
 */

import { join } from "node:path";
import type { AtomScope } from "./atom.js";

export interface ResolveScopeDirCtx {
  /** memory engine 的 globalDir（從 getMemoryEngine().getStatus()） */
  globalDir: string;
  /** ctx.accountId 在 ToolContext 是 required `string`，保持同等型別契約 */
  accountId: string;
  agentId?: string;
  projectId?: string;
}

export interface ResolveScopeDirResult {
  /** 寫入/讀取目標目錄 */
  dir: string;
  /** 向量 namespace（與 recall.layerToNs 對齊） */
  namespace: string;
}

/**
 * 把 (scope, ctx) 解析為 (dir, namespace)。
 *
 * 用 dynamic import `agent-loader.js` 避免 circular（agent-loader → memory）。
 */
export async function resolveScopeDir(
  scope: AtomScope,
  ctx: ResolveScopeDirCtx,
): Promise<ResolveScopeDirResult> {
  if (scope === "agent" && ctx.agentId) {
    const { resolveAgentDataDir } = await import("../core/agent-loader.js");
    return {
      dir: join(resolveAgentDataDir(ctx.agentId), "memory"),
      namespace: `agent/${ctx.agentId}`,
    };
  }
  if (scope === "project" && ctx.projectId) {
    return {
      dir: join(ctx.globalDir, "projects", ctx.projectId),
      namespace: `project/${ctx.projectId}`,
    };
  }
  if (scope === "account") {
    return {
      dir: join(ctx.globalDir, "accounts", ctx.accountId),
      namespace: `account/${ctx.accountId}`,
    };
  }
  return {
    dir: ctx.globalDir,
    namespace: "global",
  };
}
