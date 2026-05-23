/**
 * @file migration/v1-to-v2-provider.ts
 * @description V1 → V2 Provider 設定遷移
 *
 * V1：catclaw.json 內含 `provider` + `providers.{id}.{type,host,model,...}` + `providerRouting`
 * V2：catclaw.json 內 `agentDefaults.model.primary` + `agentDefaults.models.{ref}`
 *     models-config.json 內 `providers.{name}.{baseUrl,api,models[]}`
 *
 * 冪等：偵測到 `agentDefaults.model.primary` 已存在 → 回 already_v2，不動任何檔案
 *
 * 觸發點：
 * 1. platform.ts 啟動時偵測 V1 自動跑（見 platform.ts:initPlatform）
 * 2. 手動：`./catclaw migrate-v2 [--dry-run]`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../logger.js";

// V1 type → V2 api 對應（apiToProviderType 反推；providers/registry.ts:129-144）
const V1_TYPE_TO_V2_API: Record<string, string> = {
  "claude":         "anthropic-messages",
  "claude-oauth":   "anthropic-messages",
  "openai":         "openai-completions",
  "openai-compat":  "openai-completions",
  "codex-oauth":    "openai-codex-responses",
  "ollama":         "ollama",
  // cli-* 系列 V2 直接用 provider name 識別，無對應 api 字串
};

// V1 type → 預設 model（若 V1 沒填 model 時 fallback）
const V1_TYPE_DEFAULT_MODEL: Record<string, string> = {
  "claude":         "claude-sonnet-4-6",
  "claude-oauth":   "claude-sonnet-4-6",
  "openai":         "gpt-4o",
  "openai-compat":  "gpt-4o",
  "codex-oauth":    "gpt-5",
  "ollama":         "qwen3:8b",
  "cli-claude":     "claude",
  "cli-gemini":     "gemini",
  "cli-codex":      "codex",
};

interface V1ProviderEntry {
  type?: string;
  host?: string;
  model?: string;
  baseUrl?: string;
  token?: string;
  username?: string;
  password?: string;
}

interface V1ProviderRouting {
  channels?: Record<string, string>;
  roles?: Record<string, string>;
  projects?: Record<string, string>;
}

export interface MigrateV1ToV2Options {
  configPath: string;
  workspaceDir: string;
  dryRun?: boolean;
}

export interface MigrateV1ToV2Result {
  status: "already_v2" | "migrated" | "skipped" | "error";
  changes: string[];
  backupPath?: string;
  requiresManualReview?: string[];
}

export async function migrateV1ToV2(opts: MigrateV1ToV2Options): Promise<MigrateV1ToV2Result> {
  const { configPath, workspaceDir, dryRun = false } = opts;
  const result: MigrateV1ToV2Result = { status: "skipped", changes: [] };

  if (!existsSync(configPath)) {
    result.status = "error";
    result.changes.push(`catclaw.json 不存在：${configPath}`);
    return result;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    result.status = "error";
    result.changes.push(`catclaw.json JSON.parse 失敗：${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // 1. 冪等檢查：已是 V2 → 直接回
  const agentDefaults = raw["agentDefaults"] as { model?: { primary?: string } } | undefined;
  if (agentDefaults?.model?.primary) {
    result.status = "already_v2";
    result.changes.push(`agentDefaults.model.primary 已存在（${agentDefaults.model.primary}）`);
    return result;
  }

  // 2. 確認 V1 結構存在
  const v1Provider = raw["provider"] as string | undefined;
  const v1Providers = raw["providers"] as Record<string, V1ProviderEntry> | undefined;
  if (!v1Provider || !v1Providers || Object.keys(v1Providers).length === 0) {
    result.status = "skipped";
    result.changes.push("既無 V2 也無 V1 結構，無事可做");
    return result;
  }

  const primaryEntry = v1Providers[v1Provider];
  if (!primaryEntry) {
    result.status = "error";
    result.changes.push(`provider="${v1Provider}" 但 providers.${v1Provider} 不存在`);
    return result;
  }

  // 3. 推導 primary model ref
  const primaryType = primaryEntry.type || "ollama";
  const primaryModel = primaryEntry.model || V1_TYPE_DEFAULT_MODEL[primaryType] || "unknown";
  const primaryRef = `${v1Provider}/${primaryModel}`;
  result.changes.push(`推導 primary model = ${primaryRef}（V1 type=${primaryType}）`);

  // 4. 備份 catclaw.json
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = `${configPath}.bak.${ts}`;
  if (!dryRun) {
    writeFileSync(backupPath, readFileSync(configPath, "utf-8"), "utf-8");
  }
  result.backupPath = backupPath;
  result.changes.push(`${dryRun ? "[dryRun] " : ""}備份 catclaw.json → ${backupPath}`);

  // 5. 建構 V2 agentDefaults
  const newModels: Record<string, { alias?: string }> = {};
  for (const [providerId, entry] of Object.entries(v1Providers)) {
    const t = entry.type || "ollama";
    const m = entry.model || V1_TYPE_DEFAULT_MODEL[t] || "unknown";
    const ref = `${providerId}/${m}`;
    newModels[ref] = {}; // alias 留空給使用者手動命名
  }
  const newAgentDefaults: Record<string, unknown> = {
    model: { primary: primaryRef },
    models: newModels,
  };

  // 6. 同步 models-config.json
  const modelsConfigPath = join(workspaceDir, "models-config.json");
  const reviewNotes: string[] = [];
  let mcJson: { providers?: Record<string, unknown>; mode?: string; aliases?: Record<string, string> } = {};
  if (existsSync(modelsConfigPath)) {
    try {
      mcJson = JSON.parse(readFileSync(modelsConfigPath, "utf-8")) as typeof mcJson;
    } catch {
      result.changes.push(`models-config.json 解析失敗，將另建`);
    }
  }
  mcJson.mode = mcJson.mode ?? "merge";
  mcJson.providers = mcJson.providers ?? {};

  for (const [providerId, entry] of Object.entries(v1Providers)) {
    const t = entry.type || "ollama";
    const api = V1_TYPE_TO_V2_API[t]; // 可能 undefined（cli-* 系列）
    const m = entry.model || V1_TYPE_DEFAULT_MODEL[t] || "unknown";

    if (mcJson.providers[providerId]) {
      result.changes.push(`models-config.json providers.${providerId} 已存在，跳過`);
      continue;
    }

    let baseUrl = entry.baseUrl;
    if (!baseUrl) {
      if (t === "ollama") baseUrl = entry.host || "http://localhost:11434";
      else if (t === "openai" || t === "openai-compat") baseUrl = "https://api.openai.com/v1";
      else if (t === "claude" || t === "claude-oauth") baseUrl = "https://api.anthropic.com/v1";
      else if (t === "codex-oauth") baseUrl = "https://chatgpt.com/backend-api";
      else baseUrl = "";
    }

    const providerDef: Record<string, unknown> = {
      baseUrl,
      models: [
        {
          id: m,
          name: `${providerId} ${m}`,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32768,
          maxTokens: 4096,
        },
      ],
    };
    if (api) providerDef["api"] = api;

    // 認證憑據警示（不複製 token 進 models-config — 走 auth-profile 另外處理）
    if (entry.token || entry.password) {
      reviewNotes.push(`provider "${providerId}" 帶有 token/password — 請手動移到 auth-profile.json（V2 憑證管理）`);
    }

    mcJson.providers[providerId] = providerDef;
    result.changes.push(`models-config.json 加 providers.${providerId}（baseUrl=${baseUrl}, api=${api ?? "(無)"}, model=${m}）`);
  }

  // 7. 寫檔
  raw["agentDefaults"] = newAgentDefaults;
  delete raw["provider"];
  delete raw["providers"];
  // providerRouting：保留 channels/projects（V2 也用），但 roles 內若引用 V1 id 則記為 review
  const oldRouting = raw["providerRouting"] as V1ProviderRouting | undefined;
  if (oldRouting?.roles) {
    const v1RolesUsed = Object.values(oldRouting.roles).filter(v => v1Providers[v]);
    if (v1RolesUsed.length > 0) {
      reviewNotes.push(`providerRouting.roles 引用了 V1 provider ID（${v1RolesUsed.join(", ")}）— 請改寫成 V2 model ref（如 "${primaryRef}"）或刪除`);
    }
  }
  // V1 殘留全砍（feedback-no-legacy-by-default）
  delete raw["providerRouting"];
  result.changes.push("移除 V1 殘留：provider, providers, providerRouting");

  if (!dryRun) {
    writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
    writeFileSync(modelsConfigPath, JSON.stringify(mcJson, null, 2), "utf-8");
  }

  result.status = "migrated";
  if (reviewNotes.length > 0) result.requiresManualReview = reviewNotes;
  log.info(`[migrate:v1-to-v2-provider] ${dryRun ? "[dryRun] " : ""}完成，${result.changes.length} 項變動`);
  return result;
}
