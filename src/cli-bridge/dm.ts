/**
 * @file cli-bridge/dm.ts
 * @description 私訊（DM）bridge：每位授權使用者的 DM = 一條獨立 bridge / CLI session。
 *
 * 設定檔：~/.catclaw/cli-bridge-dm.json（獨立於 cli-bridges.json；格式見 DmBridgeConfig）
 *
 * 流程：bridge bot 收到 DM → 白名單判定 → 找／建該 DM channel 的 bridge → 走既有 reply 流程
 *  - owner（本人）：workingDir = ownerWorkingDir，權限按鈕在自己 DM，與一般 bridge 相同
 *  - team（同事）：workingDir = <teamWorkspaceRoot>/<slug>（首次建立 + 寫 CLAUDE.md），
 *    CLI 以隔離模式啟動（不載 ~/.claude、拒讀 denyPaths），權限按鈕改發 owner 的 DM
 *
 * DM 內沒有 slash command，改用文字指令：!help / !status / !session new / !cd <path>（owner 限定）；
 * 「開新對話」等口令（index.ts isNewSessionCommand）同樣有效
 *
 * Discord 的 DM channel id 對「bot × 使用者」固定，所以 auto-spawn 的 bridge 持久化到
 * cli-bridges.json 後，重啟會照常由 initBridgesFromConfig 重建。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";
import type { Message } from "discord.js";
import { log } from "../logger.js";
import { config, resolveCatclawDir } from "../core/config.js";
import type { CliBridge } from "./bridge.js";
import type { IndependentBotSender } from "./discord-sender.js";
import type { CliBridgeChannelConfig, CliBridgeConfig, CliBridgeDmBinding, CliIsolation } from "./types.js";
import {
  consumeBridgeInboundHistory,
  getCliBridge,
  getCliBridgeByLabel,
  isNewSessionCommand,
  loadCliBridgeConfigs,
  rebuildBridgeForChannel,
  registerBridge,
  startNewSession,
} from "./index.js";

// ── 設定 ────────────────────────────────────────────────────────────────────

export interface DmUserConfig {
  /** 顯示名（名冊暱稱）；也是 bridge label 與工作目錄的 slug 來源 */
  name: string;
  /** 預設 true；false = 名單保留但暫停 */
  enabled?: boolean;
  /** 覆寫工作目錄（預設 <teamWorkspaceRoot>/<slug>） */
  workingDir?: string;
}

export interface DmBridgeConfig {
  enabled: boolean;
  /** 收 DM 的 bot token；省略 = cli-bridges.json 第一條的 botToken */
  botToken?: string;
  /** owner 的 Discord user id；省略 = catclaw.json admin.allowedUserIds[0] */
  ownerId?: string;
  /** owner DM bridge 的工作目錄 */
  ownerWorkingDir: string;
  /** 同事工作目錄的根（建議放在本機操作者家目錄之外，否則會被 denyPaths 擋住） */
  teamWorkspaceRoot: string;
  /** 同事名單：userId → 設定。不在名單 = 不理會 */
  users: Record<string, DmUserConfig>;
  team: {
    /** 同事 session 不可讀寫的路徑前綴 */
    denyPaths: string[];
    /** 同事 session 直接禁用的工具 */
    disallowedTools: string[];
    /** 同事工作目錄 CLAUDE.md 範本路徑（省略 = 內建範本） */
    claudeMdTemplatePath?: string;
  };
}

const CONFIG_FILENAME = "cli-bridge-dm.json";

function getDmConfigPath(): string {
  return join(resolveCatclawDir(), CONFIG_FILENAME);
}

/** 每次都讀檔（DM 頻率低，省掉 watch）；壞檔視為停用並 warn */
export function loadDmConfig(): DmBridgeConfig | null {
  const p = getDmConfigPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<DmBridgeConfig>;
    if (!raw.ownerWorkingDir || !raw.teamWorkspaceRoot) {
      log.warn(`[cli-bridge:dm] ${p} 缺 ownerWorkingDir / teamWorkspaceRoot，停用 DM bridge`);
      return null;
    }
    return {
      enabled: raw.enabled !== false,
      botToken: raw.botToken,
      ownerId: raw.ownerId,
      ownerWorkingDir: expandHome(raw.ownerWorkingDir),
      teamWorkspaceRoot: expandHome(raw.teamWorkspaceRoot),
      users: raw.users ?? {},
      team: {
        denyPaths: raw.team?.denyPaths ?? [homedir()],
        disallowedTools: raw.team?.disallowedTools ?? [],
        claudeMdTemplatePath: raw.team?.claudeMdTemplatePath,
      },
    };
  } catch (err) {
    log.warn(`[cli-bridge:dm] 讀取 ${p} 失敗：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── 本機開關（/dm skill 用）────────────────────────────────────────────────────

/** 同事工作目錄根的平台預設：刻意放在操作者家目錄外，否則會被 denyPaths 擋住 */
function defaultTeamWorkspaceRoot(): string {
  if (process.platform === "win32") return "C:/catclaw-dm";
  if (process.platform === "darwin") return "/Users/Shared/catclaw-dm";
  return "/srv/catclaw-dm";
}

export interface DmToggleResult {
  /** 設定檔絕對路徑 */
  path: string;
  /** 本次是否新建設定檔（首次在此機開啟） */
  created: boolean;
  enabled: boolean;
  ownerWorkingDir: string;
  teamWorkspaceRoot: string;
  /** users 名單人數（不含 owner 自動允許） */
  userCount: number;
}

/**
 * 切換本機 DM bridge 開關。檔案不存在且要開 → 以平台預設新建（名單只有 owner，同事待補）；
 * 其餘只改 enabled、保留檔內所有欄位。寫完 loadDmConfig() 下一則 DM 就生效（每次讀檔）。
 */
export function setDmBridgeEnabled(enabled: boolean, owner: { userId: string; name: string }): DmToggleResult {
  const p = getDmConfigPath();
  const exists = existsSync(p);
  const raw: Partial<DmBridgeConfig> = exists
    ? (JSON.parse(readFileSync(p, "utf-8")) as Partial<DmBridgeConfig>)
    : {
        ownerId: owner.userId,
        ownerWorkingDir: "~/.claude",
        teamWorkspaceRoot: defaultTeamWorkspaceRoot(),
        users: { [owner.userId]: { name: owner.name } },
        team: { denyPaths: [homedir()], disallowedTools: [] },
      };
  const next = { ...raw, enabled };
  if (enabled) mkdirSync(expandHome(next.teamWorkspaceRoot ?? defaultTeamWorkspaceRoot()), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
  log.info(`[cli-bridge:dm] 本機 DM bridge ${enabled ? "開啟" : "關閉"}（${exists ? "更新" : "新建"} ${p}）`);
  const users = next.users ?? {};
  return {
    path: p,
    created: !exists,
    enabled,
    ownerWorkingDir: expandHome(next.ownerWorkingDir ?? ""),
    teamWorkspaceRoot: expandHome(next.teamWorkspaceRoot ?? ""),
    userCount: Object.keys(users).filter(id => id !== (next.ownerId ?? owner.userId)).length,
  };
}

/** 本機 DM bridge 現況（status 用）；檔案不存在 = 關閉 */
export function getDmBridgeStatus(): DmToggleResult | null {
  const cfg = loadDmConfig();
  if (!cfg) return null;
  const ownerId = resolveOwnerId(cfg);
  return {
    path: getDmConfigPath(),
    created: false,
    enabled: cfg.enabled,
    ownerWorkingDir: cfg.ownerWorkingDir,
    teamWorkspaceRoot: cfg.teamWorkspaceRoot,
    userCount: Object.keys(cfg.users).filter(id => id !== ownerId).length,
  };
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function resolveOwnerId(dmCfg: DmBridgeConfig): string | null {
  if (dmCfg.ownerId) return dmCfg.ownerId;
  return config.admin?.allowedUserIds?.[0] ?? null;
}

function resolveDmBotToken(dmCfg: DmBridgeConfig): string | null {
  if (dmCfg.botToken) return dmCfg.botToken;
  return loadCliBridgeConfigs().find(c => c.botToken)?.botToken ?? null;
}

interface DmUser {
  userId: string;
  name: string;
  kind: "owner" | "team";
  workingDir: string;
}

/** 白名單判定：owner 永遠允許；其餘看 users 名單 */
function resolveDmUser(dmCfg: DmBridgeConfig, userId: string, displayName: string): DmUser | null {
  const ownerId = resolveOwnerId(dmCfg);
  if (ownerId && userId === ownerId) {
    return { userId, name: dmCfg.users[userId]?.name ?? displayName, kind: "owner", workingDir: dmCfg.ownerWorkingDir };
  }
  const u = dmCfg.users[userId];
  if (!u || u.enabled === false) return null;
  const workingDir = u.workingDir ? expandHome(u.workingDir) : join(dmCfg.teamWorkspaceRoot, slugify(u.name, userId));
  return { userId, name: u.name, kind: "team", workingDir };
}

/** 檔名／label 安全的 slug：保留中英數字，其餘換 -；全部被濾掉就退回 user id 尾 6 碼 */
function slugify(name: string, userId: string): string {
  const s = name.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return s || `user-${userId.slice(-6)}`;
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/** 同一 DM channel 併發訊息共用同一個 spawn Promise */
const _spawning = new Map<string, Promise<CliBridge | null>>();

/**
 * 獨立 bot 收到 DM 的唯一入口（index.ts handleIndependentBotMessage 轉來，同一則訊息只進來一次）。
 * @param viaBridge 分派這則訊息的任一 bridge——只拿它的 botToken / Discord client，不代表路由目標
 */
export async function handleDmMessage(msg: Message, viaBridge: CliBridge): Promise<void> {
  if (msg.author.bot) return;
  const dmCfg = loadDmConfig();
  if (!dmCfg?.enabled) return;

  const token = viaBridge.getBridgeConfig().botToken;
  if (!token || token !== resolveDmBotToken(dmCfg)) return; // 不是指定收 DM 的 bot

  // 名單外一律靜默：同一個 bot 可能由多台機器同時接，各機名單分流，不是本機的人不能回話
  const who = resolveDmUser(dmCfg, msg.author.id, msg.author.displayName || msg.author.username);
  if (!who) {
    log.info(`[cli-bridge:dm] 不在本機名單，忽略 ${msg.author.tag} (${msg.author.id})`);
    return;
  }

  if (msg.channel.partial) await msg.channel.fetch();

  if (await handleDmCommand(msg, who)) return;

  let bridge = getCliBridge(msg.channelId);
  if (!bridge) {
    let p = _spawning.get(msg.channelId);
    if (!p) {
      p = spawnDmBridge(msg, who, dmCfg, viaBridge).finally(() => _spawning.delete(msg.channelId));
      _spawning.set(msg.channelId, p);
    }
    bridge = (await p) ?? undefined;
  }
  if (!bridge) return;
  await routeDmToBridge(bridge, msg);
}

// ── 建 bridge ───────────────────────────────────────────────────────────────

async function spawnDmBridge(msg: Message, who: DmUser, dmCfg: DmBridgeConfig, viaBridge: CliBridge): Promise<CliBridge | null> {
  const template = viaBridge.getBridgeConfig();
  const baseLabel = `dm-${slugify(who.name, who.userId)}`;
  const label = getCliBridgeByLabel(baseLabel) ? `${baseLabel}-${msg.channelId.slice(-6)}` : baseLabel;

  const binding: CliBridgeDmBinding = { userId: who.userId, userName: who.name, kind: who.kind };
  if (who.kind === "team") {
    const ownerId = resolveOwnerId(dmCfg);
    if (!ownerId) {
      log.error(`[cli-bridge:dm] 無法決定 owner（cli-bridge-dm.json ownerId / catclaw.json admin.allowedUserIds 都沒有），拒建 team bridge`);
      await msg.reply("⚠️ 系統未設定管理者，暫時無法服務。").catch(() => {});
      return null;
    }
    ensureTeamWorkspace(who, dmCfg, ownerId);
    try {
      binding.approvalChannelId = await ownerDmChannelId(viaBridge, ownerId);
    } catch (err) {
      log.error(`[cli-bridge:dm] 取得 owner DM channel 失敗，拒建 team bridge：${err instanceof Error ? err.message : String(err)}`);
      await msg.reply("⚠️ 無法連到管理者的私訊，暫時無法服務。").catch(() => {});
      return null;
    }
    binding.approverId = ownerId;
    binding.isolation = teamIsolation(dmCfg);
  }

  const channelConfig: CliBridgeChannelConfig = {
    label,
    requireMention: false,
    dangerouslySkipPermissions: false,
    dm: binding,
  };
  const cfg: CliBridgeConfig = {
    ...template,
    enabled: true,
    label,
    provider: "claude", // 隔離旗標只有 claude provider 實作
    workingDir: who.workingDir,
    channels: { [msg.channelId]: channelConfig },
  };

  try {
    const bridge = await registerBridge(msg.channelId, cfg, channelConfig);
    log.info(`[cli-bridge:dm] 建立 ${who.kind} DM bridge：${label} user=${who.name}(${who.userId}) cwd=${who.workingDir}${binding.approvalChannelId ? ` approval→${binding.approvalChannelId}` : ""}`);
    return bridge;
  } catch (err) {
    log.error(`[cli-bridge:dm] 建立 DM bridge 失敗：${err instanceof Error ? err.message : String(err)}`);
    await msg.reply("⚠️ 建立工作階段失敗，請稍後再試。").catch(() => {});
    return null;
  }
}

function teamIsolation(dmCfg: DmBridgeConfig): CliIsolation {
  return {
    denyPaths: dmCfg.team.denyPaths.map(p => resolvePath(expandHome(p))),
    disallowedTools: [...dmCfg.team.disallowedTools],
  };
}

/** owner 與這顆 bot 的 DM channel（不存在會建立） */
async function ownerDmChannelId(viaBridge: CliBridge, ownerId: string): Promise<string> {
  const sender = viaBridge.getSender();
  if (sender.mode !== "independent-bot") throw new Error("DM bridge 需要獨立 bot（有 botToken）");
  const client = (sender as IndependentBotSender).getClient();
  const user = await client.users.fetch(ownerId);
  const dm = await user.createDM();
  return dm.id;
}

const DEFAULT_TEAM_CLAUDE_MD = `# 工作區說明

你是透過 Discord 私訊服務團隊成員 **{name}** 的 CLI 助理，跑在管理者（Discord id {owner}）的機器上。

## 邊界
- 你的工作目錄是 \`{workingDir}\`，只在這裡讀寫檔案。管理者家目錄下的檔案已由權限規則擋住，不要嘗試繞過。
- 需要執行指令、寫檔等動作時，權限請求會送給管理者審批，不是 {name} 本人；等待時用一句話告知對方「已送管理者審批」。
- 不要代為處理與工作無關的個人事務，不要外洩這台機器上的任何設定或憑證。

## 對話
- 使用者是 {name}（Discord id {userId}），以繁體中文回覆。
`;

/** 同事工作目錄：mkdir + 首次寫入 CLAUDE.md（已存在不覆寫） */
function ensureTeamWorkspace(who: DmUser, dmCfg: DmBridgeConfig, ownerId: string): void {
  mkdirSync(who.workingDir, { recursive: true });
  const claudeMd = join(who.workingDir, "CLAUDE.md");
  if (existsSync(claudeMd)) return;
  let template = DEFAULT_TEAM_CLAUDE_MD;
  const tplPath = dmCfg.team.claudeMdTemplatePath;
  if (tplPath) {
    try { template = readFileSync(expandHome(tplPath), "utf-8"); }
    catch (err) { log.warn(`[cli-bridge:dm] 讀取 CLAUDE.md 範本 ${tplPath} 失敗，改用內建：${err instanceof Error ? err.message : String(err)}`); }
  }
  const body = template
    .replaceAll("{name}", who.name)
    .replaceAll("{userId}", who.userId)
    .replaceAll("{owner}", ownerId)
    .replaceAll("{workingDir}", who.workingDir);
  writeFileSync(claudeMd, body, "utf-8");
  log.info(`[cli-bridge:dm] 已建立工作區 ${who.workingDir}（含 CLAUDE.md）`);
}

// ── 路由到 bridge（與 index.ts home-channel 路徑同步）────────────────────────

async function routeDmToBridge(bridge: CliBridge, msg: Message): Promise<void> {
  try {
    await bridge.ensureAlive({ drainInboundHistory: false });
    const { handleCliBridgeReply, extractAttachments } = await import("./reply.js");
    const { text: attachmentText, imageBlocks } = await extractAttachments(msg);
    let fullText = msg.content + attachmentText;
    const inboundCtx = await consumeBridgeInboundHistory(bridge);
    if (inboundCtx) fullText = inboundCtx + "\n---\n" + fullText;
    log.info(`[cli-bridge:dm] 路由：${bridge.label} channel=${msg.channelId}`);
    void handleCliBridgeReply(bridge, fullText.trim(), msg, {
      showToolCalls: "none",
    } as Parameters<typeof handleCliBridgeReply>[3], bridge.getBridgeConfig(), imageBlocks);
  } catch (err) {
    log.error(`[cli-bridge:dm] 路由失敗：${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 文字指令 ────────────────────────────────────────────────────────────────

const HELP_TEXT = [
  "**DM 指令**",
  "`!status` — 目前工作階段狀態",
  "`!session new` — 開新對話（清掉 CLI session）",
  "`!cd <path>` — 切換工作目錄（僅管理者）",
  "其餘文字直接送進 CLI。",
].join("\n");

/** 回 true = 已當指令處理完，不再送進 CLI */
async function handleDmCommand(msg: Message, who: DmUser): Promise<boolean> {
  const text = msg.content.trim();
  if (isNewSessionCommand(text)) return newSession(msg);
  if (!text.startsWith("!")) return false;
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  const bridge = getCliBridge(msg.channelId);

  switch ((cmd ?? "").toLowerCase()) {
    case "help":
      await msg.reply(HELP_TEXT);
      return true;

    case "status": {
      if (!bridge) { await msg.reply("尚未建立工作階段，直接傳訊息即可開始。"); return true; }
      await msg.reply(
        `• Bridge：${bridge.label}（${who.kind}）\n` +
        `• 狀態：${bridge.status}\n` +
        `• 工作目錄：\`${bridge.workingDir}\`\n` +
        `• Session：\`${bridge.currentSessionId ?? "(新)"}\``,
      );
      return true;
    }

    case "session":
      if (arg.toLowerCase() !== "new") { await msg.reply("用法：`!session new`"); return true; }
      return newSession(msg);

    case "cd": {
      if (who.kind !== "owner") { await msg.reply("此指令僅管理者可用。"); return true; }
      if (!arg) { await msg.reply("用法：`!cd <path>`"); return true; }
      const abs = resolvePath(expandHome(arg));
      if (!existsSync(abs)) { await msg.reply(`❌ 目錄不存在：\`${abs}\``); return true; }
      if (!bridge) { await msg.reply("尚未建立工作階段，先傳一則訊息再切目錄。"); return true; }
      try {
        const nb = await rebuildBridgeForChannel(msg.channelId, (cfg) => { cfg.workingDir = abs; });
        await msg.reply(`✅ 工作目錄已切換為 \`${abs}\`（${nb?.status ?? "unknown"}）`);
      } catch (err) {
        await msg.reply(`❌ 切換失敗：${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }

    default:
      await msg.reply(`未知指令 \`!${cmd}\`\n${HELP_TEXT}`);
      return true;
  }
}

/** = slash /session new（index.ts startNewSession）。rebuild 會換 sender，先用原 msg 回 ⏳ */
async function newSession(msg: Message): Promise<boolean> {
  if (!getCliBridge(msg.channelId)) { await msg.reply("尚未建立工作階段，沒有可重置的 session。"); return true; }
  try {
    await msg.reply("⏳ 開新對話中…");
    const nb = await startNewSession(msg.channelId);
    await nb?.getSender().send("✅ 已開新對話（舊 session 已清除，下次對話建立新 session）");
  } catch (err) {
    await msg.reply(`❌ 重置失敗：${err instanceof Error ? err.message : String(err)}`).catch(() => {});
  }
  return true;
}
