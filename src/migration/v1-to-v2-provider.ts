/**
 * @file migration/v1-to-v2-provider.ts
 * @description 對話 LLM 設定遷移到 models-config.json
 *
 * 偵測兩種 legacy source：
 * - V1：catclaw.json 內 `provider` + `providers.{id}.{type,host,model,...}` + `providerRouting`
 * - V2-deprecated：catclaw.json 內 `agentDefaults` 區塊（Phase 4 廢棄；B 方案下 source-of-truth 改為 models-config.json）
 *
 * 寫出目標（B 方案）：
 * - `models-config.json`：`primary` + `aliases` + `providers.{name}.{baseUrl,api,models[]}`（merge，不覆蓋既有）
 * - `catclaw.json`：拔 `provider` / `providers` / `providerRouting` / `agentDefaults` 四項
 *
 * 冪等：偵測到 catclaw.json 已無 legacy 結構 → 回 already_v2
 *
 * 觸發點：
 * 1. platform.ts 啟動時偵測 → 自動跑（migrate 完用 reloadConfigNow）
 * 2. 手動：`./catclaw migrate-v2 [--dry-run]`
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

interface V2DeprecatedAgentDefaults {
  model?: { primary?: string; fallbacks?: string[] };
  models?: Record<string, { alias?: string }>;
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
  modelsConfigBackupPath?: string;
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

  // 1. 偵測 legacy source
  const v1Provider = raw["provider"] as string | undefined;
  const v1Providers = (raw["providers"] as Record<string, V1ProviderEntry> | undefined) ?? {};
  const v2DepAgentDefaults = raw["agentDefaults"] as V2DeprecatedAgentDefaults | undefined;
  const hasV1 = !!v1Provider && Object.keys(v1Providers).length > 0;
  const hasV2Dep = !!v2DepAgentDefaults?.model?.primary;
  const hasProviderRouting = !!raw["providerRouting"];

  if (!hasV1 && !hasV2Dep && !hasProviderRouting) {
    result.status = "already_v2";
    result.changes.push("catclaw.json 已無 legacy 結構（provider / providers / providerRouting / agentDefaults）");
    return result;
  }

  // 2. 載入 models-config.json（或初始化空殼）
  // 真實位置：CATCLAW_CONFIG_DIR/models-config.json（跟 catclaw.json 同目錄；參考 config.ts:loadModelsConfigFile）
  // 注意 workspaceDir 跟 configDir 不一樣，bug 修正：用 dirname(configPath) 與 loadModelsConfigFile 同源
  void workspaceDir; // 保留參數簽名 — 未來若改寫 auth-profile 之類會用到
  const modelsConfigPath = join(dirname(configPath), "models-config.json");
  type McJson = {
    mode?: string;
    primary?: string;
    fallbacks?: string[];
    aliases?: Record<string, string>;
    providers?: Record<string, unknown>;
  };
  let mcJson: McJson = {};
  if (existsSync(modelsConfigPath)) {
    try {
      mcJson = JSON.parse(readFileSync(modelsConfigPath, "utf-8")) as McJson;
    } catch {
      result.changes.push(`models-config.json 解析失敗，將另建`);
    }
  }
  mcJson.mode = mcJson.mode ?? "merge";
  mcJson.providers = mcJson.providers ?? {};
  mcJson.aliases = mcJson.aliases ?? {};

  const reviewNotes: string[] = [];

  // 3. 推導 primary（優先 V2-deprecated agentDefaults.model.primary，否則 V1 推導）
  let derivedPrimary: string | undefined;
  if (hasV2Dep) {
    derivedPrimary = v2DepAgentDefaults!.model!.primary;
    result.changes.push(`primary 來自 catclaw.json agentDefaults（${derivedPrimary}）`);
    // 順帶搬 alias 表
    for (const [ref, entry] of Object.entries(v2DepAgentDefaults!.models ?? {})) {
      if (entry?.alias) {
        mcJson.aliases[entry.alias] = ref;
        result.changes.push(`alias "${entry.alias}" → "${ref}" 寫入 models-config.json`);
      }
    }
  } else if (hasV1) {
    const primaryEntry = v1Providers[v1Provider!];
    if (!primaryEntry) {
      result.status = "error";
      result.changes.push(`provider="${v1Provider}" 但 providers.${v1Provider} 不存在`);
      return result;
    }
    const t = primaryEntry.type || "ollama";
    const m = primaryEntry.model || V1_TYPE_DEFAULT_MODEL[t] || "unknown";
    derivedPrimary = `${v1Provider}/${m}`;
    result.changes.push(`推導 primary = ${derivedPrimary}（從 V1 provider type=${t}）`);
  }

  // 4. 從 V1 providers 補 models-config.json providers entry（merge，不覆蓋）
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

    if (entry.token || entry.password) {
      reviewNotes.push(`provider "${providerId}" 帶有 token/password — 請手動移到 auth-profile.json（V2 憑證管理）`);
    }

    mcJson.providers[providerId] = providerDef;
    result.changes.push(`models-config.json 加 providers.${providerId}（baseUrl=${baseUrl}, api=${api ?? "(無)"}, model=${m}）`);
  }

  // 5. 寫 primary 到 models-config.json（覆蓋；這是真相源）
  if (derivedPrimary) {
    if (mcJson.primary && mcJson.primary !== derivedPrimary) {
      result.changes.push(`models-config.json primary "${mcJson.primary}" 覆寫為 "${derivedPrimary}"`);
    } else if (!mcJson.primary) {
      result.changes.push(`models-config.json primary 設為 "${derivedPrimary}"`);
    } else {
      result.changes.push(`models-config.json primary "${mcJson.primary}" 已對齊，不動`);
    }
    mcJson.primary = derivedPrimary;
  }

  // 6. V1 providerRouting roles 引用 V1 ID 提示
  const oldRouting = raw["providerRouting"] as V1ProviderRouting | undefined;
  if (oldRouting?.roles) {
    const v1RolesUsed = Object.values(oldRouting.roles).filter(v => v1Providers[v]);
    if (v1RolesUsed.length > 0) {
      reviewNotes.push(`providerRouting.roles 引用了 V1 provider ID（${v1RolesUsed.join(", ")}）— 已刪除整個 providerRouting；如需 channel/role routing 請在 models-config.json 加 routing 或 dashboard 設定`);
    }
  }

  // 7. 備份 catclaw.json + models-config.json
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backupPath = `${configPath}.bak.${ts}`;
  result.backupPath = backupPath;
  if (existsSync(modelsConfigPath)) {
    result.modelsConfigBackupPath = `${modelsConfigPath}.bak.${ts}`;
  }
  if (!dryRun) {
    writeFileSync(backupPath, readFileSync(configPath, "utf-8"), "utf-8");
    if (result.modelsConfigBackupPath) {
      writeFileSync(result.modelsConfigBackupPath, readFileSync(modelsConfigPath, "utf-8"), "utf-8");
    }
  }
  result.changes.push(`${dryRun ? "[dryRun] " : ""}備份 catclaw.json → ${backupPath}`);
  if (result.modelsConfigBackupPath) {
    result.changes.push(`${dryRun ? "[dryRun] " : ""}備份 models-config.json → ${result.modelsConfigBackupPath}`);
  }

  // 8. 清掉 catclaw.json 內 legacy 區塊
  const removed: string[] = [];
  for (const key of ["provider", "providers", "providerRouting", "agentDefaults"]) {
    if (key in raw) { delete raw[key]; removed.push(key); }
  }
  if (removed.length > 0) result.changes.push(`catclaw.json 移除：${removed.join(", ")}`);

  // 9. 寫檔
  if (!dryRun) {
    writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");
    writeFileSync(modelsConfigPath, JSON.stringify(mcJson, null, 2), "utf-8");
  }

  result.status = "migrated";
  if (reviewNotes.length > 0) result.requiresManualReview = reviewNotes;
  log.info(`[migrate:v1-to-v2-provider] ${dryRun ? "[dryRun] " : ""}完成，${result.changes.length} 項變動`);
  return result;
}
