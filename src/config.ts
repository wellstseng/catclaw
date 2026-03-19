/**
 * @file config.ts
 * @description 從 config.json 載入設定，提供 per-channel 存取 helper
 *
 * 結構參考 OpenClaw 的 channel 設定模式：
 * - guilds.{guildId}.channels.{channelId} 控制 allow / requireMention
 * - dm.enabled 控制 DM 是否啟用
 * - guilds 為空物件 → 所有頻道皆允許（開發方便）
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { LogLevel } from "./logger.js";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** 單一頻道設定 */
export interface ChannelConfig {
  /** 是否允許回應此頻道 */
  allow: boolean;
  /** 是否需要 @mention bot 才觸發，預設 true */
  requireMention?: boolean;
}

/** 單一 Guild（伺服器）設定 */
export interface GuildConfig {
  channels: Record<string, ChannelConfig>;
}

/** DM 設定 */
export interface DmConfig {
  /** 是否啟用 DM 回應，預設 true */
  enabled: boolean;
}

/** 全域設定物件型別 */
export interface BridgeConfig {
  /** Discord Bot Token */
  token: string;
  /** 是否顯示「🔧 使用工具：xxx」訊息 */
  showToolCalls: boolean;
  /** DM 設定 */
  dm: DmConfig;
  /** per-guild、per-channel 設定 */
  guilds: Record<string, GuildConfig>;
  /** Claude session 工作目錄（spawn cwd），預設 $HOME */
  claudeCwd: string;
  /** claude CLI binary 路徑，預設 "claude" */
  claudeCommand: string;
  /** Debounce 毫秒數，預設 500 */
  debounceMs: number;
  /** Claude 回應超時毫秒數，預設 300000（5 分鐘） */
  turnTimeoutMs: number;
  /** 回覆超過此字數時上傳為 .md 檔案，0 = 停用，預設 4000 */
  fileUploadThreshold: number;
  /** Log 層級，預設 "info" */
  logLevel: LogLevel;
}

// ── JSON 載入 ────────────────────────────────────────────────────────────────

/** config.json 的原始 JSON 型別（所有欄位皆可選） */
interface RawConfig {
  token?: string;
  showToolCalls?: boolean;
  dm?: { enabled?: boolean };
  guilds?: Record<string, { channels?: Record<string, ChannelConfig> }>;
  claudeCwd?: string;
  claudeCommand?: string;
  debounceMs?: number;
  turnTimeoutMs?: number;
  fileUploadThreshold?: number;
  logLevel?: string;
}

/**
 * 從 config.json 載入設定
 * @returns 完整的 BridgeConfig 物件
 * @throws 若 config.json 不存在或 token 未設定
 */
function loadConfig(): BridgeConfig {
  const configPath = resolve(process.cwd(), "config.json");

  let raw: RawConfig;
  try {
    const text = readFileSync(configPath, "utf-8");
    raw = JSON.parse(text) as RawConfig;
  } catch (err) {
    throw new Error(
      `無法讀取 config.json（${configPath}）：${err instanceof Error ? err.message : String(err)}\n` +
      "請複製 config.example.json 為 config.json 並填入設定"
    );
  }

  if (!raw.token) {
    throw new Error("config.json 中 token 欄位必填");
  }

  // 正規化 guilds：確保每個 guild 都有 channels
  const guilds: Record<string, GuildConfig> = {};
  if (raw.guilds) {
    for (const [guildId, guild] of Object.entries(raw.guilds)) {
      guilds[guildId] = { channels: guild.channels ?? {} };
    }
  }

  // 驗證 logLevel
  const validLevels = ["debug", "info", "warn", "error", "silent"];
  const logLevel = (
    validLevels.includes(raw.logLevel ?? "") ? raw.logLevel : "info"
  ) as LogLevel;

  return {
    token: raw.token,
    showToolCalls: raw.showToolCalls ?? true,
    dm: { enabled: raw.dm?.enabled ?? true },
    guilds,
    claudeCwd: raw.claudeCwd || process.env.HOME || "/",
    claudeCommand: raw.claudeCommand || "claude",
    debounceMs: raw.debounceMs ?? 500,
    turnTimeoutMs: raw.turnTimeoutMs ?? 300_000,
    fileUploadThreshold: raw.fileUploadThreshold ?? 4000,
    logLevel,
  };
}

// ── Per-channel 存取 helper ─────────────────────────────────────────────────

/** getChannelAccess 的回傳值 */
export interface ChannelAccess {
  /** 是否允許回應 */
  allowed: boolean;
  /** 是否需要 @mention bot */
  requireMention: boolean;
}

/**
 * 查詢指定頻道的存取設定
 *
 * 規則：
 * - DM（guildId = null）→ 看 dm.enabled，不需 mention
 * - guilds 為空物件 → 所有頻道允許，requireMention 預設 true
 * - guilds 有設定 → 只允許明確 allow: true 的頻道
 *
 * @param guildId Guild ID（DM 時為 null）
 * @param channelId Channel ID
 */
export function getChannelAccess(
  guildId: string | null,
  channelId: string
): ChannelAccess {
  // DM：不需 mention
  if (!guildId) {
    return { allowed: config.dm.enabled, requireMention: false };
  }

  // 沒有任何 guild 設定 → 全開，預設需 mention
  if (Object.keys(config.guilds).length === 0) {
    return { allowed: true, requireMention: true };
  }

  // 查 guild
  const guild = config.guilds[guildId];
  if (!guild) return { allowed: false, requireMention: true };

  // 查 channel
  const channel = guild.channels[channelId];
  if (!channel) return { allowed: false, requireMention: true };

  return {
    allowed: channel.allow,
    requireMention: channel.requireMention ?? true,
  };
}

// ── Export ────────────────────────────────────────────────────────────────────

/** 全域設定單例，啟動時載入一次 */
export const config: BridgeConfig = loadConfig();
