/**
 * @file web/webchat.ts
 * @description 網頁版聊天（/chat）：帳號登入、對話列表、串流回覆、工具卡片、停止、插話、附件。
 *
 * 掛在 dashboard 同一個 HTTP server 上（dashboard.ts 在 token 檢查前把 /chat、/api/webchat/* 轉進來），
 * 有自己的登入（cookie），不吃 dashboard token。
 *
 * 資料都在 {CATCLAW_CONFIG_DIR}/webchat/：
 *   users.json           帳號名 → { accountId, salt, hash }（密碼 scrypt）
 *   logins.json          登入 token 的 sha256 → { username, expiresAt }
 *   conversations.json   對話列表 { id, owner, title, createdAt, updatedAt }
 *   transcripts/<id>.jsonl  畫面要顯示的紀錄（不受 CE 壓縮影響）
 *   uploads/<id>/        使用者上傳的附件
 *   setup-code.txt       還沒有任何帳號時的一次性設定碼
 *
 * 一則訊息的流程跟 discord.ts 同一套：skill 攔截 → 角色／專案 → rate limit → provider 路由
 *   → runMessagePipeline → agentLoop；session key 是 web:ch:<對話 id>。
 * 回合在背景跑，事件推給訂閱該對話的所有分頁（SSE），重新整理或另開分頁都接得回進行中的回覆。
 *
 * 每個對話可以各自選模型與思考等級（存在 conversations.json），回合時優先於預設路由；
 * /use、/think 的頻道覆寫（記憶體內）比對話設定更優先，在選單改設定時會清掉對應的覆寫，所以「後設定的贏」。
 * 執行核准（safety.execApproval）在對話中推核准卡，只有對話擁有者能按核准／拒絕。
 * 子 agent 與背景工作在對話中顯示進度卡（執行中 → 完成／失敗），回合結束後才完成的也會更新回原卡片。
 *
 * 對話有兩種：一般對話走上面的 agent loop；CLI 對話是這個對話專屬的一條 Claude Code CLI session
 * （重用 cli-bridge 的 CliBridge），文字原樣送給 CLI，CLI 的權限／提問（control_request）在網頁作答。
 * 能不能開 CLI 對話看每個帳號的 cliAccess（none／isolated／full，管理員在帳號管理設定）；
 * isolated 的工具權限請求送管理員審批。細節見下方「CLI 對話」一節。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync, chmodSync, realpathSync, statSync } from "node:fs";
import { join, dirname, extname, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import { log } from "../logger.js";
import { config, resolveCatclawDir, resolveProvider } from "../core/config.js";
import type { Role } from "../accounts/registry.js";
import type { Skill } from "../skills/types.js";
import type { AgentLoopEvent } from "../core/agent-loop.js";
import type { CliBridge } from "../cli-bridge/bridge.js";
import type { CliBridgeConfig, CliBridgeChannelConfig, CliBridgeEvent, CliEffortLevel, StdinImageBlock, TurnHandle } from "../cli-bridge/types.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

/**
 * 網頁帳號。密碼登入有 salt／hash；GitLab 登入的帳號可以沒有密碼（只認 gitlab.sub）。
 * disabled：GitLab 帳號不能真的刪（下次登入會被自動建回來），管理員改成停用。
 */
interface WebUser {
  accountId: string;
  createdAt: string;
  salt?: string;
  hash?: string;
  gitlab?: { sub: string; username: string };
  disabled?: boolean;
  /** CLI 對話權限；沒設定依角色（platform-owner／admin → full，其他 → none） */
  cliAccess?: CliAccess;
  /** isolated 除了個人工作區之外，管理員另外指定可用的工作目錄（真實路徑） */
  cliDirs?: string[];
}

/**
 * CLI 對話權限。
 * none = 不能開；isolated = 只能用個人工作區或指定目錄、隔離模式啟動、工具權限送管理員審批；
 * full = 任選工作目錄、載入完整 ~/.claude、可跳過權限確認。
 */
type CliAccess = "none" | "isolated" | "full";
const CLI_ACCESS_VALUES: CliAccess[] = ["none", "isolated", "full"];

/** GitLab 登入設定（管理員在頁面填，存 webchat/gitlab.json） */
interface GitlabConfig { url: string; clientId: string; clientSecret: string; redirectUri: string }
interface LoginRecord { username: string; expiresAt: number }
const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];
/** 對話的思考設定："off" 是強制關閉；沒設定就跟預設（模式／dashboard） */
type ThinkingChoice = "off" | ThinkingLevel;

/** CLI 對話的設定：工作目錄、權限模式、模型、effort，以及接回用的 CLI sessionId */
interface CliConvSettings {
  /** 開對話當下的權限模式；之後擁有者的 cliAccess 被調低時，full 對話就不能再用 */
  mode: "full" | "isolated";
  workingDir: string;
  /** true = 跳過權限確認（--dangerously-skip-permissions）；提問與計畫核准仍會問 */
  skipPermissions: boolean;
  /** claude CLI 的 --model；沒設定就用 CLI 預設 */
  model?: string;
  /** claude CLI 的 --effort；沒設定就用 CLI 預設 */
  effort?: CliEffortLevel;
  sessionId?: string;
  /** CLI 回報的斜線指令（不含 /），斜線清單用 */
  commands?: string[];
}

interface Conversation {
  id: string; owner: string; title: string; createdAt: string; updatedAt: string;
  /** 對話選的模型（provider id）；沒設定就走預設路由（一般對話用） */
  model?: string;
  thinking?: ThinkingChoice;
  /** 沒寫 = 一般對話（agent loop） */
  kind?: "agent" | "cli";
  cli?: CliConvSettings;
}

/** 對話目前生效的模型與思考等級，以及各自來自哪裡（畫面上的選單用） */
interface ConvSettings {
  model: string;
  modelSource: "use" | "conversation" | "default";
  /** 一般對話是思考等級；CLI 對話是 effort */
  thinking: string;
  thinkingSource: "think" | "conversation" | "default";
  defaultModel: string;
  /** 只有 CLI 對話有 */
  cli?: { mode: "full" | "isolated"; workingDir: string; skipPermissions: boolean; sessionId: string | null; commands: string[] };
}

interface FileRef { id: string; name: string; mime: string; size: number; isImage: boolean }

/** 畫面上的一筆紀錄 */
type Entry =
  | { kind: "user"; id: string; at: string; author: string; text: string; files: FileRef[] }
  | { kind: "assistant"; id: string; at: string; blocks: Block[]; error?: string }
  | { kind: "notice"; id: string; at: string; text: string };

type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
type JobStatus = "running" | "completed" | "failed";

/** 執行核准卡：id 是 exec-approval 的 approvalId */
interface ApprovalBlock { type: "approval"; id: string; command: string; expiresAt: string; status: ApprovalStatus }
/** 子 agent／背景工作卡：id 是 runId 或 jobId */
interface JobBlock { type: "job"; kind: "subagent" | "background"; id: string; label: string; status: JobStatus; startedAt: string; summary?: string }

/** 工具卡：參數與結果都是截斷過的預覽文字 */
interface ToolBlock { type: "tool"; id: string; name: string; params: string; result?: string; error?: string; blocked?: string }

/** CLI 提問的一題（AskUserQuestion 的 input.questions） */
interface ControlQuestion { question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }
type ControlStatus = "pending" | "allowed" | "denied" | "expired";
/**
 * CLI 的權限／提問卡（control_request），id 是 request_id。
 * question = AskUserQuestion、plan = ExitPlanMode、permission = 其他工具要權限。
 */
interface ControlBlock {
  type: "control"; id: string; kind: "question" | "plan" | "permission"; tool: string;
  questions?: ControlQuestion[];
  plan?: string;
  /** permission：工具參數預覽 */
  input?: string;
  expiresAt: string; status: ControlStatus;
  /** 作答結果的一行說明（選了什麼、退回意見…） */
  answer?: string;
  /** true = 隔離模式的請求，送管理員審批，發話者只看結果 */
  review?: boolean;
}

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | ToolBlock
  | ApprovalBlock
  | JobBlock
  | ControlBlock;

const isSlashTrigger = (trigger: string): boolean => trigger.startsWith("/");

/** 推給瀏覽器的事件 */
type WebEvent =
  | { type: "sync"; entries: Entry[]; live: WebEvent[] }
  | { type: "entry"; entry: Entry }
  | { type: "turn_start" }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string; params: string }
  | { type: "tool_result"; id: string; result: string; error?: string }
  | { type: "tool_blocked"; name: string; reason: string }
  | { type: "status"; text: string }
  | { type: "turn_end"; entry: Entry }
  | { type: "approval"; block: ApprovalBlock }     // 新卡或狀態更新，畫面依 id 取代
  | { type: "job"; block: JobBlock }               // 同上；卡片可能在進行中的回覆或較早的紀錄裡
  | { type: "control"; block: ControlBlock }       // CLI 權限／提問卡，同上
  | { type: "settings"; settings: ConvSettings }
  | { type: "conversations" }
  | { type: "reviews" };                            // 待審批清單變了（只送給審批者）

// ── 常數 ─────────────────────────────────────────────────────────────────────

const COOKIE_NAME = "catclaw_web";
const LOGIN_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BODY_BYTES = 40 * 1024 * 1024;        // JSON 內含 base64 附件
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const PREVIEW_CHARS = 4000;                      // 工具參數／結果在畫面上保留的長度
const SYNC_ENTRIES = 300;                        // 打開對話時送最近幾筆
const ROLES: Role[] = ["platform-owner", "admin", "developer", "member", "guest"];
const ADMIN_ROLES = new Set<Role>(["platform-owner", "admin"]);
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/;
const JOB_SUMMARY_CHARS = 1500;                  // 子 agent／背景工作卡片的結果摘要長度
// CLI 對話
const CLI_CONTROL_TIMEOUT_MS = Number(process.env.CATCLAW_PERMISSION_TIMEOUT_MS ?? 600_000);   // 跟 Discord 的 control-request 同一個設定
const CLI_IDLE_SUSPEND_MS = Number(process.env.CATCLAW_WEB_CLI_IDLE_MS ?? 600_000);           // 閒置多久關掉 CLI process（下次訊息 --resume 接回）
const CLI_IMAGE_MAX_BYTES = 5 * 1024 * 1024;     // 超過就不 inline，改附路徑（Anthropic 單張上限）
const CLI_MODEL_ALIASES = ["opus", "sonnet", "haiku", "fable"];
const CLI_EFFORT_LEVELS: CliEffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const CLI_DEFAULT_COMMANDS = ["compact", "context", "cost"];   // CLI 還沒回報指令清單前先列這幾個

// ── 檔案存取 ─────────────────────────────────────────────────────────────────

function dataDir(): string {
  const dir = join(resolveCatclawDir(), "webchat");
  mkdirSync(join(dir, "transcripts"), { recursive: true });
  mkdirSync(join(dir, "uploads"), { recursive: true });
  return dir;
}

function readJson<T>(name: string, fallback: T): T {
  const p = join(dataDir(), name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; }
  catch (err) { log.warn(`[webchat] 讀 ${name} 失敗：${err instanceof Error ? err.message : String(err)}`); return fallback; }
}

/** 先寫暫存檔再 rename，避免寫到一半斷電留下壞檔 */
function writeJson(name: string, data: unknown): void {
  const p = join(dataDir(), name);
  writeFileSync(p + ".tmp", JSON.stringify(data, null, 2), "utf-8");
  renameSync(p + ".tmp", p);
}

const loadUsers = () => readJson<Record<string, WebUser>>("users.json", {});
const saveUsers = (u: Record<string, WebUser>) => writeJson("users.json", u);
const loadLogins = () => readJson<Record<string, LoginRecord>>("logins.json", {});
const saveLogins = (l: Record<string, LoginRecord>) => writeJson("logins.json", l);
const loadConversations = () => readJson<Conversation[]>("conversations.json", []);
const saveConversations = (c: Conversation[]) => writeJson("conversations.json", c);

function transcriptPath(convId: string): string { return join(dataDir(), "transcripts", `${convId}.jsonl`); }

function appendEntry(convId: string, entry: Entry): void {
  appendFileSync(transcriptPath(convId), JSON.stringify(entry) + "\n", "utf-8");
}

/** 改寫紀錄裡某張子 agent／背景工作卡片；找到並改了就回傳改後的卡片 */
function updateJobInTranscript(convId: string, jobId: string, patch: Partial<JobBlock>): JobBlock | null {
  const entries = readTranscript(convId);
  for (const entry of entries) {
    if (entry.kind !== "assistant") continue;
    const block = entry.blocks.find((b): b is JobBlock => b.type === "job" && b.id === jobId);
    if (!block) continue;
    Object.assign(block, patch);
    const p = transcriptPath(convId);
    writeFileSync(p + ".tmp", entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf-8");
    renameSync(p + ".tmp", p);
    return block;
  }
  return null;
}

function readTranscript(convId: string): Entry[] {
  const p = transcriptPath(convId);
  if (!existsSync(p)) return [];
  const entries: Entry[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line) as Entry); } catch { /* 壞行跳過 */ }
  }
  return entries;
}

// ── 密碼與登入 ───────────────────────────────────────────────────────────────

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function passwordMatches(user: WebUser, password: string): boolean {
  if (!user.hash || !user.salt) return false;   // 只用 GitLab 登入、沒設密碼的帳號
  const expected = Buffer.from(user.hash, "hex");
  const actual = Buffer.from(hashPassword(password, user.salt), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function makeUser(accountId: string, password: string): WebUser {
  const salt = randomBytes(16).toString("hex");
  return { accountId, salt, hash: hashPassword(password, salt), createdAt: new Date().toISOString() };
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function issueLogin(res: ServerResponse, username: string): void {
  const token = randomBytes(32).toString("hex");
  const logins = loadLogins();
  const now = Date.now();
  for (const [k, v] of Object.entries(logins)) if (v.expiresAt < now) delete logins[k];
  logins[sha256(token)] = { username, expiresAt: now + LOGIN_TTL_MS };
  saveLogins(logins);
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LOGIN_TTL_MS / 1000}`);
}

function readCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE_NAME) return v.join("=");
  }
  return null;
}

interface Viewer { username: string; accountId: string; displayName: string; role: Role; gitlab: string | null; cliAccess: CliAccess }

async function currentViewer(req: IncomingMessage): Promise<Viewer | null> {
  const token = readCookieToken(req);
  if (!token) return null;
  const rec = loadLogins()[sha256(token)];
  if (!rec || rec.expiresAt < Date.now()) return null;
  const user = loadUsers()[rec.username];
  if (!user || user.disabled) return null;
  const { getAccountRegistry } = await import("../core/platform.js");
  accountLookup = getAccountRegistry();
  const acct = accountLookup.get(user.accountId);
  if (!acct || acct.disabled) return null;
  return {
    username: rec.username, accountId: user.accountId, displayName: acct.displayName, role: acct.role,
    gitlab: user.gitlab?.username ?? null, cliAccess: effectiveCliAccess(user, acct.role),
  };
}

/** catclaw 帳號名冊（第一次查登入時從 platform 取得；審批者判斷要同步查角色與顯示名） */
let accountLookup: { get(accountId: string): { displayName: string; role: Role; disabled?: boolean } | null } | null = null;

/** 帳號實際的 CLI 權限：有設定用設定，沒有依角色 */
function effectiveCliAccess(user: WebUser, role: Role): CliAccess {
  return user.cliAccess ?? (ADMIN_ROLES.has(role) ? "full" : "none");
}

/** 能審批隔離 CLI 對話的人：完整 CLI 權限的 platform-owner／admin */
const canReviewCli = (viewer: Viewer) => ADMIN_ROLES.has(viewer.role) && viewer.cliAccess === "full";

/** 登入失敗次數（每個 IP，10 分鐘內 10 次就擋） */
const loginFailures = new Map<string, { count: number; since: number }>();
function loginBlocked(ip: string): boolean {
  const rec = loginFailures.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.since > 10 * 60_000) { loginFailures.delete(ip); return false; }
  return rec.count >= 10;
}
function noteLoginFailure(ip: string): void {
  const rec = loginFailures.get(ip);
  if (!rec || Date.now() - rec.since > 10 * 60_000) loginFailures.set(ip, { count: 1, since: Date.now() });
  else rec.count++;
}

/** 沒有任何帳號時產生一次性設定碼（寫檔＋log），用來建立第一個管理員 */
function ensureSetupCode(): string | null {
  if (Object.keys(loadUsers()).length > 0) return null;
  const p = join(dataDir(), "setup-code.txt");
  if (existsSync(p)) return readFileSync(p, "utf-8").trim();
  const code = randomBytes(6).toString("hex");
  writeFileSync(p, code, "utf-8");
  log.info(`[webchat] 尚無網頁帳號，首次設定碼：${code}（也寫在 ${p}）`);
  return code;
}

// ── 帳號建立（設定與管理員共用） ─────────────────────────────────────────────

async function createWebUser(opts: { username: string; password: string; displayName: string; role: Role; linkAccountId?: string }): Promise<string | null> {
  if (!USERNAME_RE.test(opts.username)) return "帳號名只能用小寫英數與 _ . -，2～32 字";
  if (opts.password.length < 8) return "密碼至少 8 個字";
  if (!ROLES.includes(opts.role)) return "角色不正確";
  const users = loadUsers();
  if (users[opts.username]) return "帳號名已存在";

  const { getAccountRegistry } = await import("../core/platform.js");
  const registry = getAccountRegistry();
  let accountId = opts.linkAccountId?.trim() || "";
  if (accountId) {
    if (!registry.get(accountId)) return `找不到要綁定的帳號 ${accountId}`;
  } else {
    accountId = `web-${opts.username}`;
    if (registry.get(accountId)) return `帳號 ${accountId} 已存在，請改用綁定`;
    registry.create({ accountId, displayName: opts.displayName || opts.username, role: opts.role });
  }
  registry.linkIdentity(accountId, "web", opts.username);
  users[opts.username] = makeUser(accountId, opts.password);
  saveUsers(users);
  log.info(`[webchat] 建立網頁帳號 ${opts.username} → ${accountId}`);
  return null;
}

// ── GitLab 登入（OAuth＋PKCE） ──────────────────────────────────────────────
//
// 流程：/oauth/gitlab/start 產生一次性 state 與 PKCE → 轉到 GitLab 授權頁 → GitLab 帶 code 轉回
// /oauth/gitlab/callback → 換 token、讀 userinfo → 找 gitlab.sub 對應的帳號登入，沒有就建一般成員。
// 綁定模式：已登入的人按「綁定 GitLab」，start 當下就把帳號名記進 state；回呼時 cookie 是 SameSite=Strict、
// 從 GitLab 轉回來的請求不會帶，所以不能在回呼時才看是誰。

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const GITLAB_DEFAULT_ROLE: Role = "member";

interface OAuthState { verifier: string; mode: "login" | "link"; username?: string; expiresAt: number }
const oauthStates = new Map<string, OAuthState>();

function loadGitlabConfig(): GitlabConfig | null {
  const cfg = readJson<Partial<GitlabConfig>>("gitlab.json", {});
  if (!cfg.url || !cfg.clientId || !cfg.clientSecret || !cfg.redirectUri) return null;
  return { url: cfg.url.replace(/\/+$/, ""), clientId: cfg.clientId, clientSecret: cfg.clientSecret, redirectUri: cfg.redirectUri };
}

const base64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** 回到聊天頁並在網址 # 帶訊息（登入頁會顯示） */
function redirectToChat(res: ServerResponse, message?: { error?: string; notice?: string }): void {
  const hash = message?.error ? `#login-error=${encodeURIComponent(message.error)}`
    : message?.notice ? `#notice=${encodeURIComponent(message.notice)}` : "";
  res.writeHead(302, { Location: `/chat${hash}` });
  res.end();
}

function startGitlabLogin(res: ServerResponse, cfg: GitlabConfig, mode: "login" | "link", username?: string): void {
  const now = Date.now();
  for (const [k, v] of oauthStates) if (v.expiresAt < now) oauthStates.delete(k);
  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(32));
  oauthStates.set(state, { verifier, mode, username, expiresAt: now + OAUTH_STATE_TTL_MS });
  const query = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: "openid profile email",
    state,
    code_challenge: base64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
  });
  res.writeHead(302, { Location: `${cfg.url}/oauth/authorize?${query}` });
  res.end();
}

interface GitlabProfile { sub: string; username: string; name: string }

/** 用 code 換 token，再讀 userinfo */
async function fetchGitlabProfile(cfg: GitlabConfig, code: string, verifier: string): Promise<GitlabProfile> {
  const tokenRes = await fetch(`${cfg.url}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
      grant_type: "authorization_code", redirect_uri: cfg.redirectUri, code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = await tokenRes.json().catch(() => ({})) as { access_token?: string; error?: string; error_description?: string };
  if (!tokenRes.ok || !token.access_token) throw new Error(`GitLab 換 token 失敗（${tokenRes.status} ${token.error_description ?? token.error ?? ""}）`);

  const infoRes = await fetch(`${cfg.url}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const info = await infoRes.json().catch(() => ({})) as { sub?: string | number; nickname?: string; preferred_username?: string; name?: string };
  const username = info.nickname ?? info.preferred_username ?? "";
  if (!infoRes.ok || info.sub == null || !username) throw new Error(`GitLab 讀使用者資料失敗（${infoRes.status}）`);
  return { sub: String(info.sub), username, name: info.name || username };
}

/** GitLab 帳號名 → 可用的網頁帳號名（小寫、換掉不合法字元、撞名加 -gitlab／數字） */
function pickUsername(gitlabUsername: string, users: Record<string, WebUser>, accountTaken: (id: string) => boolean): string {
  let base = gitlabUsername.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 24);
  if (base.length < 2) base = `gl-${base || "user"}`;
  const free = (name: string) => !users[name] && !accountTaken(`web-${name}`);
  if (free(base)) return base;
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? `${base}-gitlab` : `${base}-gitlab${i + 1}`;
    if (free(candidate)) return candidate;
  }
  throw new Error(`找不到可用的帳號名（${gitlabUsername}）`);
}

/** 回呼：換 token、找或建帳號、設好登入 cookie；回傳要在聊天頁顯示的錯誤或提示 */
async function finishGitlabLogin(res: ServerResponse, cfg: GitlabConfig, code: string, stateKey: string): Promise<{ error?: string; notice?: string }> {
  const state = oauthStates.get(stateKey);
  oauthStates.delete(stateKey);   // 一次性
  if (!state || state.expiresAt < Date.now()) return { error: "登入逾時或連結已用過，請重新按「用 GitLab 登入」" };

  const profile = await fetchGitlabProfile(cfg, code, state.verifier);
  const users = loadUsers();
  const owner = Object.entries(users).find(([, u]) => u.gitlab?.sub === profile.sub);

  if (state.mode === "link") {
    const target = state.username ? users[state.username] : undefined;
    if (!target) return { error: "要綁定的帳號不存在" };
    if (owner && owner[0] !== state.username) return { error: `這個 GitLab 帳號已綁定到 ${owner[0]}` };
    target.gitlab = { sub: profile.sub, username: profile.username };
    saveUsers(users);
    log.info(`[webchat] ${state.username} 綁定 GitLab ${profile.username}`);
    return { notice: `已綁定 GitLab：${profile.username}` };
  }

  if (owner) {
    const [username, user] = owner;
    if (user.disabled) return { error: "這個帳號已被管理員停用" };
    issueLogin(res, username);
    return {};
  }

  // 第一次用 GitLab 登入：建一般成員
  const { getAccountRegistry } = await import("../core/platform.js");
  const registry = getAccountRegistry();
  const username = pickUsername(profile.username, users, id => registry.get(id) !== null);
  const accountId = `web-${username}`;
  registry.create({ accountId, displayName: profile.name, role: GITLAB_DEFAULT_ROLE });
  registry.linkIdentity(accountId, "web", username);
  users[username] = { accountId, createdAt: nowIso(), gitlab: { sub: profile.sub, username: profile.username } };
  saveUsers(users);
  log.info(`[webchat] GitLab ${profile.username} 首次登入，建立 ${username}（${GITLAB_DEFAULT_ROLE}）`);
  issueLogin(res, username);
  return {};
}

// ── 即時事件：每個對話的訂閱者與進行中回合 ───────────────────────────────────

const subscribers = new Map<string, Set<ServerResponse>>();   // convId → SSE 連線
const liveTurns = new Map<string, WebEvent[]>();             // convId → 進行中回合已發生的事件
const userStreams = new Map<string, Set<ServerResponse>>();   // username → 對話列表變動通知

function sendEvent(res: ServerResponse, event: WebEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function broadcast(convId: string, event: WebEvent): void {
  const live = liveTurns.get(convId);
  if (live && event.type !== "entry") live.push(event);
  for (const res of subscribers.get(convId) ?? []) sendEvent(res, event);
}

function notifyConversationsChanged(username: string): void {
  for (const res of userStreams.get(username) ?? []) sendEvent(res, { type: "conversations" });
}

function openSse(req: IncomingMessage, res: ServerResponse, set: Set<ServerResponse>): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  set.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
  req.on("close", () => { clearInterval(ping); set.delete(res); });
}

// ── 附件 ─────────────────────────────────────────────────────────────────────

interface UploadIn { name: string; mime: string; data: string }

function saveUploads(convId: string, uploads: UploadIn[]): { refs: FileRef[]; paths: string[]; images: Array<{ data: string; mimeType: string; name: string }> } {
  const dir = join(dataDir(), "uploads", convId);
  mkdirSync(dir, { recursive: true });
  const refs: FileRef[] = [];
  const paths: string[] = [];
  const images: Array<{ data: string; mimeType: string; name: string }> = [];
  for (const up of uploads) {
    const buf = Buffer.from(up.data, "base64");
    if (buf.length > MAX_FILE_BYTES) throw new Error(`附件 ${up.name} 超過 20MB`);
    const id = randomUUID().slice(0, 12);
    const safeName = (up.name || "file").replace(/[^\w.\-一-鿿]/g, "_").slice(0, 120);
    const path = join(dir, `${id}__${safeName}`);
    writeFileSync(path, buf);
    const isImage = IMAGE_MIMES.has(up.mime);
    refs.push({ id, name: up.name || safeName, mime: up.mime || "application/octet-stream", size: buf.length, isImage });
    if (isImage) images.push({ data: up.data, mimeType: up.mime, name: safeName });
    else paths.push(path);
  }
  return { refs, paths, images };
}

function findUpload(convId: string, fileId: string): string | null {
  if (!/^[a-f0-9-]{1,40}$/.test(fileId)) return null;
  const dir = join(dataDir(), "uploads", convId);
  if (!existsSync(dir)) return null;
  const name = readdirSync(dir).find(n => n.startsWith(`${fileId}__`));
  return name ? join(dir, name) : null;
}

// ── 回合執行 ─────────────────────────────────────────────────────────────────

const sessionKeyOf = (convId: string) => `web:ch:${convId}`;

function preview(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : (() => { try { return JSON.stringify(value, null, 2); } catch { return String(value); } })();
  return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + `\n…（共 ${s.length} 字，已截斷）` : s;
}

function nowIso(): string { return new Date().toISOString(); }

/** 文字與思考合併到最後一個同類 block，工具等其他 block 會把它們隔開 */
function appendTextBlock(blocks: Block[], type: "text" | "thinking", chunk: string): void {
  const last = blocks[blocks.length - 1];
  if (last && last.type === type) last.text += chunk;
  else blocks.push({ type, text: chunk });
}

function pushNotice(convId: string, text: string): void {
  const entry: Entry = { kind: "notice", id: randomUUID(), at: nowIso(), text };
  appendEntry(convId, entry);
  broadcast(convId, { type: "entry", entry });
}

// ── 執行核准 ─────────────────────────────────────────────────────────────────

/** 等待中的核准：approvalId → 所屬對話；denied 用來分辨「按了拒絕」與「逾時」 */
const pendingApprovals = new Map<string, { convId: string; denied: boolean }>();

/** 擁有者按核准／拒絕；核准不屬於這個對話或已結束就回 false */
async function decideApproval(convId: string, approvalId: string, approved: boolean): Promise<boolean> {
  const rec = pendingApprovals.get(approvalId);
  if (!rec || rec.convId !== convId) return false;
  if (!approved) rec.denied = true;
  const { resolveApproval } = await import("../core/exec-approval.js");
  return resolveApproval(approvalId, approved);
}

/**
 * 停止回合時把這個對話還在等的核准當成拒絕：agent-loop 等核准時不看中止訊號，
 * 不先拒絕的話要等到逾時回合才會停。
 */
async function rejectApprovalsOf(convId: string): Promise<void> {
  for (const [approvalId, rec] of pendingApprovals) {
    if (rec.convId === convId) await decideApproval(convId, approvalId, false);
  }
}

// ── 子 agent／背景工作卡片 ───────────────────────────────────────────────────

/** 工具回傳「已在背景啟動」時建立的卡片；不是這兩個工具或沒啟動成功就回 null */
function jobBlockFromToolResult(name: string, params: unknown, result: unknown): JobBlock | null {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== "object" || r.status !== "spawned") return null;
  const p = (params ?? {}) as Record<string, unknown>;
  const startedAt = nowIso();
  if (name === "spawn_subagent" && typeof r.runId === "string") {
    const label = String(p.label ?? p.task ?? "子 agent").slice(0, 80);
    return { type: "job", kind: "subagent", id: r.runId, label, status: "running", startedAt };
  }
  if (name === "run_background_command" && typeof r.jobId === "string") {
    const label = String(p.label ?? p.command ?? "背景工作").slice(0, 80);
    return { type: "job", kind: "background", id: r.jobId, label, status: "running", startedAt };
  }
  return null;
}

function backgroundSummary(exitCode: number | null, stdoutPath?: string, reason?: string): string {
  const lines = reason ? [`原因：${reason}`] : [`exitCode=${exitCode ?? "null"}`];
  if (stdoutPath) lines.push(`stdout：${stdoutPath}`);
  return lines.join("\n");
}

/**
 * 子 agent／背景工作結束：更新卡片。順序是進行中回覆裡的卡 → 紀錄裡較早的卡 → 都沒有就新增。
 * blocks 是進行中回合的 assistant blocks；回合外（回合結束後才完成）傳 null，找不到舊卡時另開一筆紀錄。
 */
function finishJob(convId: string, blocks: Block[] | null, job: JobBlock): void {
  const patch = { status: job.status, summary: job.summary };
  const inTurn = blocks?.find((b): b is JobBlock => b.type === "job" && b.id === job.id);
  if (inTurn) {
    Object.assign(inTurn, patch);
    broadcast(convId, { type: "job", block: { ...inTurn } });
    return;
  }
  const earlier = updateJobInTranscript(convId, job.id, patch);
  if (earlier) {
    broadcast(convId, { type: "job", block: earlier });
    return;
  }
  if (blocks) {
    blocks.push(job);
    broadcast(convId, { type: "job", block: { ...job } });
    return;
  }
  const entry: Entry = { kind: "assistant", id: randomUUID(), at: nowIso(), blocks: [job] };
  appendEntry(convId, entry);
  broadcast(convId, { type: "entry", entry });
}

/** 進行中回合的 assistant blocks（convId → blocks），讓 eventBus 收到的完成通知能更新這一輪的卡片 */
const liveBlocks = new Map<string, Block[]>();

/**
 * 子 agent／背景工作完成時接 eventBus 更新卡片。
 * 回合進行中也要接：agent-loop 只在下一輪 LLM 呼叫前送 relay，回合若剛好沒有下一輪就收不到；
 * finishJob 可重複套用，relay 之後再到也不會出錯。
 */
let jobListenersReady = false;
async function ensureJobListeners(): Promise<void> {
  if (jobListenersReady) return;
  jobListenersReady = true;
  const { eventBus } = await import("../core/event-bus.js");
  const convOf = (sessionKey: string): string | null => {
    if (!sessionKey.startsWith("web:ch:")) return null;
    const convId = sessionKey.slice("web:ch:".length);
    return loadConversations().some(c => c.id === convId) ? convId : null;
  };
  const handle = (sessionKey: string, job: Omit<JobBlock, "type" | "startedAt">): void => {
    const convId = convOf(sessionKey);
    if (!convId) return;
    try { finishJob(convId, liveBlocks.get(convId) ?? null, { type: "job", startedAt: nowIso(), ...job }); }
    catch (err) { log.warn(`[webchat] 更新背景工作卡片失敗 conv=${convId}：${err instanceof Error ? err.message : String(err)}`); }
  };
  eventBus.on("subagent:completed", (key, runId, label, result) =>
    handle(key, { kind: "subagent", id: runId, label, status: "completed", summary: result.slice(0, JOB_SUMMARY_CHARS) }));
  eventBus.on("subagent:failed", (key, runId, label, error) =>
    handle(key, { kind: "subagent", id: runId, label, status: "failed", summary: error.slice(0, JOB_SUMMARY_CHARS) }));
  eventBus.on("background-job:completed", (key, jobId, label, exitCode, stdoutPath) =>
    handle(key, { kind: "background", id: jobId, label, status: "completed", summary: backgroundSummary(exitCode, stdoutPath) }));
  eventBus.on("background-job:failed", (key, jobId, label, reason) =>
    handle(key, { kind: "background", id: jobId, label, status: "failed", summary: backgroundSummary(null, undefined, reason) }));
}

// ── 模型與思考等級 ───────────────────────────────────────────────────────────

/** 角色與專案（provider 路由與 pipeline 都要） */
async function roleAndProject(accountId: string): Promise<{ role: Role; projectId?: string }> {
  const platform = await import("../core/platform.js");
  const { getBootAgentId, loadAgentConfig } = await import("../core/agent-loader.js");
  const acct = platform.getAccountRegistry().get(accountId);
  let agentBoundProject: string | undefined;
  try { const aid = getBootAgentId(); if (aid) agentBoundProject = loadAgentConfig(aid)?.boundProject; } catch { /* agent-loader 未就緒 */ }
  return { role: acct?.role ?? "guest", projectId: agentBoundProject ?? acct?.projects?.[0] };
}

async function settingsOf(viewer: Viewer, conv: Conversation): Promise<ConvSettings> {
  if (conv.kind === "cli" && conv.cli) return cliSettingsOf(conv.cli);
  const { getChannelProviderOverride } = await import("../skills/builtin/use.js");
  const { getChannelThinking } = await import("../skills/builtin/think.js");
  const { role, projectId } = await roleAndProject(viewer.accountId);
  const defaultModel = resolveProvider({ channelId: conv.id, role, projectId });
  const useOverride = getChannelProviderOverride(conv.id);
  const thinkOverride = getChannelThinking(conv.id);
  return {
    model: useOverride ?? conv.model ?? "",
    modelSource: useOverride ? "use" : conv.model ? "conversation" : "default",
    thinking: thinkOverride ?? conv.thinking ?? "",
    thinkingSource: thinkOverride ? "think" : conv.thinking ? "conversation" : "default",
    defaultModel,
  };
}

async function broadcastSettings(viewer: Viewer, convId: string): Promise<void> {
  const conv = loadConversations().find(c => c.id === convId);
  if (conv) broadcast(convId, { type: "settings", settings: await settingsOf(viewer, conv) });
}

/** 換模型沿用 /use 的權限 tier */
async function canChangeModel(viewer: Viewer): Promise<boolean> {
  const platform = await import("../core/platform.js");
  const { listSkills } = await import("../skills/registry.js");
  const tier = listSkills().find(sk => sk.name === "use")?.tier ?? "admin";
  return platform.getPlatformPermissionGate().checkTier(viewer.accountId, tier).allowed;
}

/**
 * 收到使用者訊息：記錄、廣播，然後在背景跑回合（呼叫端不等）。
 * 回傳錯誤字串代表沒收下。
 */
async function acceptMessage(viewer: Viewer, conv: Conversation, text: string, uploads: UploadIn[]): Promise<string | null> {
  if (conv.kind === "cli") return acceptCliMessage(viewer, conv, text, uploads);
  const platform = await import("../core/platform.js");
  if (!platform.isPlatformReady()) return "catclaw 平台尚未就緒";
  if (!text.trim() && uploads.length === 0) return "訊息是空的";

  // Skill 先攔（跟 Discord 同順序）：回覆進行中打 /stop 這類指令要直接執行，不能變成插話
  const { matchSkill } = await import("../skills/registry.js");
  const skillMatch = uploads.length === 0 ? matchSkill(text) : null;
  if (skillMatch) {
    const entry: Entry = { kind: "user", id: randomUUID(), at: nowIso(), author: viewer.displayName, text, files: [] };
    appendEntry(conv.id, entry);
    broadcast(conv.id, { type: "entry", entry });
    touchConversation(conv, text);
    if (skillMatch.skill.name === "stop") void rejectApprovalsOf(conv.id);
    void runSkillCommand(viewer, conv, skillMatch).catch(err => {
      log.error(`[webchat] skill 失敗 conv=${conv.id}：${err instanceof Error ? err.message : String(err)}`);
      pushNotice(conv.id, `❌ ${skillMatch.skill.name} 執行失敗`);
    });
    return null;
  }

  const sessionKey = sessionKeyOf(conv.id);
  const { pushInterruptMessage } = await import("../core/agent-loop.js");
  const turnRunning = liveTurns.has(conv.id);

  // 進行中回合：插話（附件不能插話，請等回合結束）
  if (turnRunning) {
    if (uploads.length > 0) return "回覆進行中，附件請等這輪結束再送";
    if (!pushInterruptMessage(sessionKey, text)) return "上一則還在準備中，請稍候再送";
    const entry: Entry = { kind: "user", id: randomUUID(), at: nowIso(), author: viewer.displayName, text, files: [] };
    appendEntry(conv.id, entry);
    broadcast(conv.id, { type: "entry", entry });
    broadcast(conv.id, { type: "status", text: "已插話，AI 會在下一步看到" });
    return null;
  }

  let saved: ReturnType<typeof saveUploads>;
  try { saved = saveUploads(conv.id, uploads); }
  catch (err) { return err instanceof Error ? err.message : String(err); }

  const userEntry: Entry = { kind: "user", id: randomUUID(), at: nowIso(), author: viewer.displayName, text, files: saved.refs };
  appendEntry(conv.id, userEntry);
  broadcast(conv.id, { type: "entry", entry: userEntry });
  touchConversation(conv, text);

  liveTurns.set(conv.id, []);
  broadcast(conv.id, { type: "turn_start" });
  void runTurn(viewer, conv, text, saved).catch(err => {
    log.error(`[webchat] 回合失敗 conv=${conv.id}：${err instanceof Error ? err.message : String(err)}`);
    finishTurn(conv.id, { kind: "assistant", id: randomUUID(), at: nowIso(), blocks: [], error: String(err instanceof Error ? err.message : err) });
  });
  return null;
}

function finishTurn(convId: string, entry: Entry): void {
  const hasContent = entry.kind !== "assistant" || entry.blocks.length > 0 || entry.error;
  if (hasContent) appendEntry(convId, entry);
  broadcast(convId, { type: "turn_end", entry });
  liveTurns.delete(convId);
  liveBlocks.delete(convId);
  // 讓側欄的「回覆中」圓點消失
  const owner = loadConversations().find(c => c.id === convId)?.owner;
  if (owner) notifyConversationsChanged(owner);
}

/** 斜線指令：跟 Discord 同一套 skill，結果用系統訊息顯示 */
async function runSkillCommand(viewer: Viewer, conv: Conversation, match: { skill: Skill; args: string }): Promise<void> {
  const platform = await import("../core/platform.js");
  const { runSkill } = await import("../skills/registry.js");
  const { getBootAgentId } = await import("../core/agent-loader.js");
  const { MessageTrace, getTraceStore } = await import("../core/message-trace.js");
  const { skill, args } = match;
  const trace = MessageTrace.create(randomUUID(), conv.id, viewer.accountId, "api");
  trace.recordInbound({ messageId: trace.traceId, text: `/${skill.name} ${args}`.trim(), attachments: 0 });
  try {
    const tierCheck = platform.getPlatformPermissionGate().checkTier(viewer.accountId, skill.tier);
    if (!tierCheck.allowed) { pushNotice(conv.id, `❌ 權限不足：${tierCheck.reason ?? "tier 限制"}`); return; }
    const ctx = { args, channelId: conv.id, authorId: viewer.accountId, accountId: viewer.accountId, agentId: getBootAgentId(), config, platform: "web" };
    if (skill.preflight) {
      const check = await skill.preflight(ctx);
      if (!check.ok) { pushNotice(conv.id, `❌ ${skill.name} 無法執行：${check.reason ?? "前置檢查失敗"}`); return; }
    }
    const result = await runSkill(skill, ctx);
    pushNotice(conv.id, result.text);
    // /use、/think 會改這個對話的模型／思考覆寫，選單要跟著變
    await broadcastSettings(viewer, conv.id);
  } catch (err) {
    trace.recordError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    getTraceStore()?.append(trace.finalize());
  }
}

/** 更新對話時間；標題還是預設值時拿第一句當標題 */
function touchConversation(conv: Conversation, text: string): void {
  const all = loadConversations();
  const target = all.find(c => c.id === conv.id);
  if (!target) return;
  target.updatedAt = nowIso();
  if (target.title === "新對話" && text.trim()) target.title = text.trim().replace(/\s+/g, " ").slice(0, 40);
  saveConversations(all);
  notifyConversationsChanged(conv.owner);
}

async function runTurn(viewer: Viewer, conv: Conversation, rawText: string, saved: ReturnType<typeof saveUploads>): Promise<void> {
  const platform = await import("../core/platform.js");
  const { agentLoop } = await import("../core/agent-loop.js");
  const { eventBus } = await import("../core/event-bus.js");
  const { getProviderRegistry } = await import("../providers/registry.js");
  const { runMessagePipeline } = await import("../core/message-pipeline.js");
  const { MessageTrace } = await import("../core/message-trace.js");
  const { getBootAgentId, getBootIsAdmin } = await import("../core/agent-loader.js");
  const { getChannelThinking } = await import("../skills/builtin/think.js");
  const { getChannelMode, getChannelModePreset, getModeThinking, getDashboardDefaultThinking } = await import("../core/mode.js");
  const { getChannelProviderOverride } = await import("../skills/builtin/use.js");
  const { getChannelSystemOverride } = await import("../skills/builtin/system.js");
  const { recordUserMessage } = await import("../history.js");

  const channelId = conv.id;
  const accountId = viewer.accountId;
  const turnId = randomUUID();
  const assistant: Extract<Entry, { kind: "assistant" }> = { kind: "assistant", id: randomUUID(), at: nowIso(), blocks: [] };
  liveBlocks.set(conv.id, assistant.blocks);

  let text = rawText;
  if (saved.paths.length > 0) text += `\n\n[使用者附件，請用 read_file 工具讀取]\n${saved.paths.map(p => `- ${p}`).join("\n")}`;
  if (saved.images.length > 0) text += `${text ? "\n\n" : ""}[使用者上傳圖片：${saved.images.map(i => i.name).join(", ")}]`;

  const trace = MessageTrace.create(turnId, channelId, accountId, "api");
  trace.recordInbound({ messageId: turnId, text, attachments: saved.refs.length });
  recordUserMessage({
    turnId, messageId: turnId, authorId: accountId, authorName: viewer.displayName, isBot: false,
    channelId, guildId: null, content: text, attachments: saved.refs.map(r => r.name),
  });

  // ── 角色、專案、rate limit、provider ──
  const { role, projectId } = await roleAndProject(accountId);
  // 選單可能在送出後才改，取最新的對話設定
  const settings = loadConversations().find(c => c.id === conv.id) ?? conv;

  const rateLimiter = platform.getPlatformRateLimiter();
  if (rateLimiter) {
    const rl = rateLimiter.check(accountId, role);
    if (!rl.allowed) {
      pushNotice(conv.id, `⏳ 請求過於頻繁，請 ${Math.ceil(rl.retryAfterMs / 1000)} 秒後再試（角色 ${role} 每分鐘上限已達）`);
      finishTurn(conv.id, assistant);
      return;
    }
    rateLimiter.record(accountId);
  }

  // 優先序：/use 覆寫 > 對話選的模型 > 預設路由
  const providerId = getChannelProviderOverride(channelId) ?? settings.model ?? resolveProvider({ channelId, role, projectId });
  const registry = getProviderRegistry();
  const provider = (await registry.ensure(providerId)) ?? registry.resolve({ role, projectId });
  if (!provider) { finishTurn(conv.id, { ...assistant, error: "沒有可用的模型 provider" }); return; }

  const modePreset = getChannelModePreset(channelId);
  const modeName = getChannelMode(channelId);
  const pipeline = await runMessagePipeline({
    prompt: text, platform: "api", trace, channelId, accountId, provider, projectId, role,
    isGroupChannel: false, speakerDisplay: viewer.displayName, modeName, modePreset,
    memoryRecall: true, inboundHistory: false, sessionMemory: true, modeExtras: true,
    channelOverride: getChannelSystemOverride(channelId),
    conversationLabel: `網頁對話「${conv.title}」 user:${viewer.displayName} channel id:${channelId}`,
  });

  // 優先序：/think 覆寫 > 對話設定（"off" 強制關閉）> 模式 > dashboard 預設
  const thinking = getChannelThinking(channelId)
    ?? (settings.thinking === "off" ? undefined : settings.thinking ?? getModeThinking(modePreset) ?? getDashboardDefaultThinking());
  const approvalCfg = config.safety?.execApproval;

  // 執行核准：在對話中推核准卡，擁有者按按鈕 → /approve API → resolveApproval
  const requestApproval = async (req: { approvalId: string; command: string; timeoutMs: number; decision: Promise<boolean> }): Promise<void> => {
    const block: ApprovalBlock = {
      type: "approval", id: req.approvalId, command: preview(req.command),
      expiresAt: new Date(Date.now() + req.timeoutMs).toISOString(), status: "pending",
    };
    assistant.blocks.push(block);
    pendingApprovals.set(req.approvalId, { convId: conv.id, denied: false });
    broadcast(conv.id, { type: "approval", block: { ...block } });
    void req.decision.then(approved => {
      const denied = pendingApprovals.get(req.approvalId)?.denied ?? false;
      pendingApprovals.delete(req.approvalId);
      block.status = approved ? "approved" : denied ? "denied" : "expired";
      broadcast(conv.id, { type: "approval", block: { ...block } });
    });
  };

  const gen = agentLoop(text, {
    platform: "web",
    channelId,
    accountId,
    projectId,
    agentId: getBootAgentId(),
    isAdmin: getBootIsAdmin(),
    isGroupChannel: false,
    speakerDisplay: viewer.displayName,
    speakerRole: role,
    provider,
    systemPrompt: pipeline.systemPrompt || undefined,
    ...(pipeline.memoryContext ? { memoryInjectedByCaller: { atoms: pipeline.memoryAtoms } } : {}),
    turnTimeoutMs: config.turnTimeoutMs,
    turnTimeoutToolCallMs: config.turnTimeoutToolCallMs,
    showToolCalls: "all",   // 網頁一律顯示工具卡片，不跟 Discord 的 showToolCalls 設定
    ...(pipeline.sessionMemoryOpts ? { sessionMemory: pipeline.sessionMemoryOpts } : {}),
    ...(approvalCfg?.enabled ? {
      execApproval: {
        enabled: true,
        dmUserId: approvalCfg.dmUserId,
        timeoutMs: approvalCfg.timeoutMs,
        allowedPatterns: approvalCfg.allowedPatterns ?? [],
        requestApproval,
        // 有 requestApproval 時 agent-loop 不會走 DM；萬一走到就報錯（agent-loop 會拒絕該工具）
        sendDm: async () => { throw new Error("網頁對話用核准卡，不送 DM"); },
      },
    } : {}),
    ...(saved.images.length > 0 ? { imageAttachments: saved.images } : {}),
    ...(thinking ? { thinking } : {}),
    modePreset,
    modeName,
    _sessionKeyOverride: sessionKeyOf(channelId),
    allowSpawn: true,
    trace: pipeline.trace,
    promptBreakdownHints: pipeline.promptBreakdownHints,
  }, {
    sessionManager: platform.getPlatformSessionManager(),
    permissionGate: platform.getPlatformPermissionGate(),
    toolRegistry: platform.getPlatformToolRegistry(),
    safetyGuard: platform.getPlatformSafetyGuard(),
    eventBus,
  });

  const appendTo = (type: "text" | "thinking", chunk: string) => appendTextBlock(assistant.blocks, type, chunk);
  function toolBlock(id: string): ToolBlock | undefined {
    for (const b of assistant.blocks) if (b.type === "tool" && b.id === id) return b;
    return undefined;
  }
  const toolParams = new Map<string, unknown>();   // 工具 id → 原始參數（建子 agent／背景工作卡片要 label）

  for await (const evt of gen) handleLoopEvent(evt);

  try { platform.getAccountRegistry().touch(accountId); } catch { /* 非必要 */ }
  finishTurn(conv.id, assistant);

  function handleLoopEvent(evt: AgentLoopEvent): void {
    switch (evt.type) {
      case "text_delta":
        appendTo("text", evt.text);
        broadcast(conv.id, { type: "text", text: evt.text });
        break;
      case "thinking":
        appendTo("thinking", evt.thinking);
        broadcast(conv.id, { type: "thinking", text: evt.thinking });
        break;
      case "tool_start": {
        const params = preview(evt.params);
        toolParams.set(evt.id, evt.params);
        assistant.blocks.push({ type: "tool", id: evt.id, name: evt.name, params });
        broadcast(conv.id, { type: "tool_start", id: evt.id, name: evt.name, params });
        break;
      }
      case "tool_result": {
        const result = preview(evt.result);
        const block = toolBlock(evt.id);
        if (block) { block.result = result; if (evt.error) block.error = evt.error; }
        else assistant.blocks.push({ type: "tool", id: evt.id, name: evt.name, params: "", result, ...(evt.error ? { error: evt.error } : {}) });
        broadcast(conv.id, { type: "tool_result", id: evt.id, result, ...(evt.error ? { error: evt.error } : {}) });
        const job = evt.error ? null : jobBlockFromToolResult(evt.name, toolParams.get(evt.id), evt.result);
        if (job) {
          assistant.blocks.push(job);
          broadcast(conv.id, { type: "job", block: { ...job } });
        }
        break;
      }
      case "tool_blocked":
        assistant.blocks.push({ type: "tool", id: randomUUID(), name: evt.name, params: "", blocked: evt.reason });
        broadcast(conv.id, { type: "tool_blocked", name: evt.name, reason: evt.reason });
        break;
      case "subagent_relay":
        finishJob(conv.id, assistant.blocks, {
          type: "job", kind: "subagent", id: evt.runId, label: evt.label, status: evt.status,
          startedAt: nowIso(), summary: evt.content.slice(0, JOB_SUMMARY_CHARS),
        });
        break;
      case "background_job_relay":
        finishJob(conv.id, assistant.blocks, {
          type: "job", kind: "background", id: evt.jobId, label: evt.label, status: evt.status,
          startedAt: nowIso(), summary: backgroundSummary(evt.exitCode, evt.stdoutPath, evt.reason),
        });
        break;
      case "context_warning":
        broadcast(conv.id, { type: "status", text: `對話脈絡已用 ${Math.round(evt.utilization * 100)}%` });
        break;
      case "error":
        assistant.error = evt.message;
        break;
      case "done":
        // 沒有串流文字但有最終文字（某些 provider 不送 delta）→ 補上
        if (!assistant.blocks.some(b => b.type === "text") && evt.text) appendTo("text", evt.text);
        break;
    }
  }
}

// ── CLI 對話 ─────────────────────────────────────────────────────────────────
//
// 每個 CLI 對話有自己的一條 claude CLI session：convId → CliSession（裡面是一個 CliBridge，provider 固定 claude）。
// 不寫 cli-bridges.json（那個檔有 hot-reload，寫它會重建 Discord bridge）：sessionId 存在 conversations.json，
// 閒置 CLI_IDLE_SUSPEND_MS 就關掉 process，下一則訊息（或 catclaw 重啟後）用 --resume 接回。
//
// 一則訊息：原文（不經 catclaw skill）→ bridge.send(source "web") → 這個回合的事件依序轉成網頁事件。
// 回合進行中再送訊息照 Discord bridge 的做法直接 send（CLI 自己排隊／插話），舊回合在畫面上收尾、新回合接著顯示。
// CLI 自己開的背景回合（source background）也當成一則回覆顯示。
// control_request（提問、計畫核准、工具權限）變成對話中的卡片，擁有者作答後回 control_response；
// 逾時、按停止、改送新訊息都回 deny，CLI 不會卡住。
//
// 權限（帳號的 cliAccess）：
//   full     任選工作目錄、載入完整 ~/.claude、可跳過權限確認，卡片由擁有者自己作答。
//   isolated 工作目錄只能是個人工作區 <teamWorkspaceRoot>/<帳號名> 或管理員指定的目錄；CLI 以隔離模式啟動
//            （照 DM team：--setting-sources project,local、deny cli-bridge-dm.json 的 team.denyPaths、禁 team.disallowedTools）；
//            不能跳過權限確認；AskUserQuestion 仍由擁有者回答，其他請求（含 ExitPlanMode）送管理員審批，
//            沒有任何管理員可審就直接 deny，不退回擁有者自審。
//   none     不能開、不能用。每次送訊息、作答都重新檢查，管理員改了立即生效。

interface CliSession {
  convId: string;
  owner: string;
  bridge: CliBridge;
  /** 回合依序消費：上一個回合在畫面上收尾後才開始下一個 */
  chain: Promise<void>;
  /** 使用者按了停止：這輪的錯誤訊息改顯示「已停止」 */
  stopRequested: boolean;
  /** CLI 最近寫的計畫檔（~/.claude/plans/*.md）；ExitPlanMode 的 input 沒帶計畫時從這裡讀 */
  planFile?: string;
}

/** 一個進行中的 CLI 回合 */
interface CliRun { session: CliSession; assistant: Extract<Entry, { kind: "assistant" }> }

interface PendingControl {
  convId: string; bridge: CliBridge; block: ControlBlock; input: Record<string, unknown>; timer: ReturnType<typeof setTimeout>;
  /** 送管理員審批的請求：誰、哪個對話（審批清單只給看這張請求，不給看整個對話） */
  review?: { requester: string; requesterName: string; convTitle: string; createdAt: string };
}

const cliSessions = new Map<string, CliSession>();
const pendingControls = new Map<string, PendingControl>();   // request_id → 等作答的卡片

/** 讀 {CATCLAW_CONFIG_DIR} 底下的 cli-bridge 設定檔（只讀，不寫） */
function readCatclawFile<T>(name: string, fallback: T): T {
  const p = join(resolveCatclawDir(), name);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; }
  catch (err) { log.warn(`[webchat] 讀 ${name} 失敗：${err instanceof Error ? err.message : String(err)}`); return fallback; }
}

const loadBridgeConfigs = () => {
  const list = readCatclawFile<CliBridgeConfig[]>("cli-bridges.json", []);
  return Array.isArray(list) ? list : [];
};

/** 模型選單：CLI 的別名＋cli-bridges.json 裡設過的模型 */
function cliModelChoices(): string[] {
  const models = new Set(CLI_MODEL_ALIASES);
  for (const b of loadBridgeConfigs()) {
    if (b.model) models.add(b.model);
    for (const ch of Object.values(b.channels ?? {})) if (ch.model) models.add(ch.model);
  }
  return [...models];
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? join(homedir(), p.slice(1)) : p;
}

/** 工作目錄 → 存在的資料夾的真實路徑；不是絕對路徑、不存在或不是資料夾回 null */
function resolveWorkingDir(raw: string): string | null {
  const p = expandHome(raw.trim());
  if (!p || !isAbsolute(p)) return null;
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch { return null; }
}

/** 新 CLI 對話的工作目錄候選：各 bridge 的 workingDir 與私訊 owner 的工作目錄（去重、只留存在的） */
function cliWorkingDirChoices(): string[] {
  const raw = loadBridgeConfigs().map(b => b.workingDir);
  raw.push(readCatclawFile<{ ownerWorkingDir?: string }>("cli-bridge-dm.json", {}).ownerWorkingDir ?? "");
  const dirs = new Set<string>();
  for (const d of raw) {
    const real = d ? resolveWorkingDir(d) : null;
    if (real) dirs.add(real);
  }
  return [...dirs];
}

/** claude 執行檔：沿用 cli-bridges.json 設的路徑，沒有就靠 PATH */
function claudeBin(): string {
  return loadBridgeConfigs().find(b => b.claudeBin)?.claudeBin ?? "claude";
}

// ── 隔離模式（isolated）的設定與工作目錄 ──

interface IsolationSettings { workspaceRoot: string; denyPaths: string[]; disallowedTools: string[]; claudeMdTemplatePath?: string }

/** 隔離設定沿用私訊 team 的 cli-bridge-dm.json；沒有就用 ~/catclaw-web 當工作區根、擋本機家目錄 */
function isolationSettings(): IsolationSettings {
  const dm = readCatclawFile<{ teamWorkspaceRoot?: string; team?: { denyPaths?: string[]; disallowedTools?: string[]; claudeMdTemplatePath?: string } }>("cli-bridge-dm.json", {});
  return {
    workspaceRoot: expandHome(dm.teamWorkspaceRoot || "~/catclaw-web"),
    denyPaths: (dm.team?.denyPaths ?? [homedir()]).map(p => expandHome(p)),
    disallowedTools: dm.team?.disallowedTools ?? [],
    claudeMdTemplatePath: dm.team?.claudeMdTemplatePath,
  };
}

const WEB_WORKSPACE_CLAUDE_MD = `# 工作區說明

你是透過 CatClaw 網頁版服務 **{name}**（網頁帳號 {userId}）的 CLI 助理，跑在管理者的機器上。

## 邊界
- 你的工作目錄是 \`{workingDir}\`，只在這裡讀寫檔案。其他路徑已由權限規則擋住，不要嘗試繞過。
- 需要執行指令、寫檔等動作時，權限請求會送給管理員審批，不是 {name} 本人；等待時用一句話告知「已送管理員審批」。
- 不要外洩這台機器上的任何設定或憑證。

## 對話
- 以繁體中文回覆。
`;

/** 個人工作區 <工作區根>/<帳號名>：第一次建立並寫 CLAUDE.md（已存在不覆寫） */
function ensurePersonalWorkspace(username: string, displayName: string): string {
  const iso = isolationSettings();
  const dir = join(iso.workspaceRoot, username);
  mkdirSync(dir, { recursive: true });
  const claudeMd = join(dir, "CLAUDE.md");
  if (!existsSync(claudeMd)) {
    let template = WEB_WORKSPACE_CLAUDE_MD;
    if (iso.claudeMdTemplatePath) {
      try { template = readFileSync(expandHome(iso.claudeMdTemplatePath), "utf-8"); }
      catch (err) { log.warn(`[webchat] 讀 CLAUDE.md 範本 ${iso.claudeMdTemplatePath} 失敗，改用內建：${err instanceof Error ? err.message : String(err)}`); }
    }
    const body = template.replaceAll("{name}", displayName).replaceAll("{userId}", username)
      .replaceAll("{owner}", "管理員").replaceAll("{workingDir}", dir);
    writeFileSync(claudeMd, body, "utf-8");
    log.info(`[webchat] 建立個人工作區 ${dir}`);
  }
  return realpathSync(dir);
}

/** isolated 可用的工作目錄：個人工作區＋管理員指定的（只留還存在的） */
function isolatedDirs(username: string, displayName: string): string[] {
  const dirs = [ensurePersonalWorkspace(username, displayName)];
  for (const d of loadUsers()[username]?.cliDirs ?? []) {
    const real = resolveWorkingDir(d);
    if (real && !dirs.includes(real)) dirs.push(real);
  }
  return dirs;
}

/** 工作目錄在 denyPaths 底下時，隔離模式的 CLI 連自己的目錄都讀不到 */
function deniedByIsolation(dir: string): string | null {
  return isolationSettings().denyPaths.find(p => dir === p || dir.startsWith(p.replace(/\/+$/, "") + "/")) ?? null;
}

/** 這個人現在還能不能用這個 CLI 對話；不能回原因 */
function cliConvBlockedReason(viewer: Viewer, conv: Conversation): string | null {
  if (!conv.cli) return "對話缺 CLI 設定";
  if (viewer.cliAccess === "none") return "你沒有 CLI 對話權限";
  if (conv.cli.mode === "full" && viewer.cliAccess !== "full") return "你的 CLI 權限已改為隔離模式，這個完整權限的對話不能再用，請開新的 CLI 對話";
  if (conv.cli.mode === "isolated" && !isolatedDirs(viewer.username, viewer.displayName).includes(conv.cli.workingDir)) return "這個工作目錄已不在你可用的清單裡";
  return null;
}

function cliSettingsOf(cli: CliConvSettings): ConvSettings {
  return {
    model: cli.model ?? "",
    modelSource: cli.model ? "conversation" : "default",
    thinking: cli.effort ?? "",
    thinkingSource: cli.effort ? "conversation" : "default",
    defaultModel: "CLI 預設",
    cli: { mode: cli.mode, workingDir: cli.workingDir, skipPermissions: cli.skipPermissions, sessionId: cli.sessionId ?? null, commands: cli.commands ?? CLI_DEFAULT_COMMANDS },
  };
}

/** 改 conversations.json 裡某個 CLI 對話的設定；改了回傳新設定 */
function updateCliConv(convId: string, patch: (cli: CliConvSettings) => void): CliConvSettings | null {
  const all = loadConversations();
  const target = all.find(c => c.id === convId);
  if (!target?.cli) return null;
  patch(target.cli);
  saveConversations(all);
  return target.cli;
}

/** 取得（或建立）這個對話的 CLI session；只建物件，process 等第一則訊息才 spawn */
async function getCliSession(conv: Conversation): Promise<CliSession> {
  const existing = cliSessions.get(conv.id);
  if (existing && existing.bridge.status !== "dead") return existing;
  const cli = conv.cli!;
  const { CliBridge } = await import("../cli-bridge/bridge.js");
  const label = `web-${conv.id}`;
  const isolated = cli.mode === "isolated";
  const iso = isolated ? isolationSettings() : null;
  const channelConfig: CliBridgeChannelConfig = {
    label, sessionId: cli.sessionId ?? null,
    dangerouslySkipPermissions: !isolated && cli.skipPermissions,
    // 「每次詢問權限」：明確 --permission-mode default，不被 ~/.claude settings 的 defaultMode（例如 bypassPermissions）蓋掉
    permissionMode: "default",
    ...(iso ? { isolation: { denyPaths: iso.denyPaths, disallowedTools: iso.disallowedTools } } : {}),
  };
  const bridgeConfig: CliBridgeConfig = {
    enabled: true, label, provider: "claude", claudeBin: claudeBin(), workingDir: cli.workingDir,
    channels: { [conv.id]: channelConfig },
    logDir: join(dataDir(), "cli-logs"),
    turnTimeoutMs: 0,              // 不用 Discord 的「等太久要不要中斷」按鈕；畫面有停止鍵
    shutdownDrainTimeoutMs: 3000,
    ...(cli.model ? { model: cli.model } : {}),
    ...(cli.effort ? { effort: cli.effort } : {}),
  };
  const bridge = new CliBridge(label, conv.id, bridgeConfig, channelConfig);
  const session: CliSession = { convId: conv.id, owner: conv.owner, bridge, chain: Promise.resolve(), stopRequested: false };
  bridge.setAnswerableSources(["web", "background"]);
  bridge.setSessionIdStore(sid => { updateCliConv(conv.id, c => { if (sid) c.sessionId = sid; else delete c.sessionId; }); });
  bridge.setUnsolicitedTurnHandler(handle => queueCliRun(session, handle));
  cliSessions.set(conv.id, session);
  ensureCliIdleScanner();
  return session;
}

/** 關掉這個對話的 CLI process 並移除 session（刪對話、換模型、catclaw 關閉） */
async function closeCliSession(convId: string): Promise<void> {
  const session = cliSessions.get(convId);
  if (!session) return;
  cliSessions.delete(convId);
  denyControlsOf(convId, "CLI session 關閉中", "CLI session 已關閉");
  await session.bridge.shutdown();
  // 等最後一個回合在畫面上收尾（寫進紀錄），最多 3 秒
  await Promise.race([session.chain, new Promise(r => setTimeout(r, 3000))]);
}

let cliIdleTimer: ReturnType<typeof setInterval> | null = null;
function ensureCliIdleScanner(): void {
  if (cliIdleTimer) return;
  cliIdleTimer = setInterval(() => { void suspendIdleCliSessions(); }, Math.min(30_000, Math.max(1000, CLI_IDLE_SUSPEND_MS / 2)));
  cliIdleTimer.unref();
}

async function suspendIdleCliSessions(): Promise<void> {
  const now = Date.now();
  for (const session of cliSessions.values()) {
    if (session.bridge.status !== "idle" || now - session.bridge.lastUsedAt <= CLI_IDLE_SUSPEND_MS) continue;
    log.info(`[webchat] CLI 對話 ${session.convId} 閒置 ${Math.round((now - session.bridge.lastUsedAt) / 1000)}s，關閉 process（下次訊息 --resume 接回）`);
    try { await session.bridge.suspend(); }
    catch (err) { log.warn(`[webchat] CLI 對話 ${session.convId} suspend 失敗：${err instanceof Error ? err.message : String(err)}`); }
  }
}

/** catclaw 關閉時呼叫：回絕等作答的卡片、關掉所有網頁 CLI process（它們是 detached，不關會變孤兒） */
export async function shutdownWebCliSessions(): Promise<void> {
  if (cliIdleTimer) { clearInterval(cliIdleTimer); cliIdleTimer = null; }
  await Promise.allSettled([...cliSessions.keys()].map(id => closeCliSession(id)));
}

/** 附件 → CLI 訊息：圖片（≤5MB）照 Discord bridge 的格式轉成 inline image，其他檔案附路徑 */
function cliAttachments(convId: string, saved: ReturnType<typeof saveUploads>): { notes: string[]; paths: string[]; imageBlocks: StdinImageBlock[] } {
  const notes: string[] = [];
  const paths = [...saved.paths];
  const imageBlocks: StdinImageBlock[] = [];
  for (const ref of saved.refs) {
    if (!ref.isImage) continue;
    const path = findUpload(convId, ref.id);
    if (!path) continue;
    if (ref.size > CLI_IMAGE_MAX_BYTES) { paths.push(path); continue; }
    const mediaType = ref.mime as StdinImageBlock["source"]["media_type"];
    imageBlocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: readFileSync(path).toString("base64") } });
    notes.push(`[附件: ${ref.name} (${ref.mime}, ${Math.round(ref.size / 1024)}KB) 已以 inline image 附上]`);
  }
  return { notes, paths, imageBlocks };
}

/** CLI 對話收到訊息：原文送 CLI（不經 catclaw skill），回合在背景消費 */
async function acceptCliMessage(viewer: Viewer, conv: Conversation, text: string, uploads: UploadIn[]): Promise<string | null> {
  const blocked = cliConvBlockedReason(viewer, conv);
  if (blocked) return blocked;
  if (!text.trim() && uploads.length === 0) return "訊息是空的";

  let saved: ReturnType<typeof saveUploads>;
  try { saved = saveUploads(conv.id, uploads); }
  catch (err) { return err instanceof Error ? err.message : String(err); }
  const { notes, paths, imageBlocks } = cliAttachments(conv.id, saved);
  let cliText = text;
  if (notes.length > 0) cliText += `${cliText ? "\n" : ""}${notes.join("\n")}`;
  if (paths.length > 0) cliText += `\n\n[使用者附件，請用 Read 工具讀取]\n${paths.map(p => `- ${p}`).join("\n")}`;

  // 還在等作答的卡片當成拒絕：CLI 等作答時不會處理新訊息，不先回絕會卡住
  denyControlsOf(conv.id, "使用者沒有作答，改送了新訊息（見下一則），請依新訊息繼續。", "使用者改送新訊息");

  const userEntry: Entry = { kind: "user", id: randomUUID(), at: nowIso(), author: viewer.displayName, text, files: saved.refs };
  appendEntry(conv.id, userEntry);
  broadcast(conv.id, { type: "entry", entry: userEntry });
  touchConversation(conv, text);

  const session = await getCliSession(conv);
  void sendToCli(session, cliText, imageBlocks, viewer.displayName).catch(err => {
    log.error(`[webchat] 送 CLI 失敗 conv=${conv.id}：${err instanceof Error ? err.message : String(err)}`);
    pushNotice(conv.id, `❌ 送給 CLI 失敗：${err instanceof Error ? err.message : String(err)}`);
  });
  return null;
}

async function sendToCli(session: CliSession, text: string, imageBlocks: StdinImageBlock[], author: string): Promise<void> {
  // 閒置被關掉的 process 在這裡用 --resume 接回
  await session.bridge.ensureAlive({ drainInboundHistory: false });
  const handle = session.bridge.send(text, "web", { user: author, ...(imageBlocks.length > 0 ? { imageBlocks } : {}) });
  queueCliRun(session, handle);
}

/** 回合排進這個對話的佇列；一般訊息、插話、CLI 自發回合都走這裡 */
function queueCliRun(session: CliSession, handle: TurnHandle): void {
  session.chain = session.chain
    .then(() => runCliTurn(session, handle))
    .catch(err => { log.error(`[webchat] CLI 回合失敗 conv=${session.convId}：${err instanceof Error ? err.message : String(err)}`); });
}

async function runCliTurn(session: CliSession, handle: TurnHandle): Promise<void> {
  const convId = session.convId;
  const assistant: Extract<Entry, { kind: "assistant" }> = { kind: "assistant", id: randomUUID(), at: nowIso(), blocks: [] };
  const run: CliRun = { session, assistant };
  liveTurns.set(convId, []);
  liveBlocks.set(convId, assistant.blocks);
  broadcast(convId, { type: "turn_start" });
  notifyConversationsChanged(session.owner);
  try {
    for await (const evt of handle.events) handleCliEvent(run, evt);
  } catch (err) {
    assistant.error = `讀取 CLI 回覆失敗：${err instanceof Error ? err.message : String(err)}`;
  }
  // 回合已結束還沒作答的卡片（例如 process 掛了）：標成逾時，CLI 還活著就回 deny
  denyControlsOf(convId, "回合已結束", "回合已結束", "expired");
  if (session.stopRequested) {
    session.stopRequested = false;
    if (assistant.error) assistant.error = "已停止";
  }
  finishTurn(convId, assistant);
}

function handleCliEvent(run: CliRun, evt: CliBridgeEvent): void {
  const convId = run.session.convId;
  const blocks = run.assistant.blocks;
  switch (evt.type) {
    case "text_delta":
      appendTextBlock(blocks, "text", evt.text);
      broadcast(convId, { type: "text", text: evt.text });
      break;
    case "thinking_delta":
      appendTextBlock(blocks, "thinking", evt.text);
      broadcast(convId, { type: "thinking", text: evt.text });
      break;
    case "tool_call": {
      const id = evt.id ?? randomUUID();
      const filePath = evt.input?.file_path;
      if (typeof filePath === "string" && isPlanFile(filePath)) run.session.planFile = filePath;
      const params = preview(evt.input ?? "");
      blocks.push({ type: "tool", id, name: evt.title, params });
      broadcast(convId, { type: "tool_start", id, name: evt.title, params });
      break;
    }
    case "status":
      // 工具結果在 CLI 的 user 訊息裡（tool_result block，用 tool_use_id 對回工具卡）
      if (evt.subtype === "user") fillCliToolResults(convId, blocks, evt.raw);
      break;
    case "control_request":
      openControlCard(run, evt);
      break;
    case "session_init":
      if (evt.slashCommands) saveCliCommands(convId, evt.slashCommands);
      break;
    case "result":
      if (evt.is_error && evt.text) run.assistant.error = evt.text;
      else if (evt.text && !blocks.some(b => b.type === "text")) appendTextBlock(blocks, "text", evt.text);
      break;
    case "error":
      run.assistant.error = evt.message;
      break;
  }
}

/** tool_result 的內容 → 文字（字串直接用；陣列取 text，其他轉 JSON） */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return preview(content);
  const parts = content.map(c => {
    const item = c as { type?: string; text?: string };
    return item.type === "text" ? item.text ?? "" : preview(item);
  });
  return parts.join("\n");
}

function fillCliToolResults(convId: string, blocks: Block[], raw: unknown): void {
  const msg = raw as { parent_tool_use_id?: string | null; message?: { content?: unknown } } | null;
  // 子 agent 內部的工具結果不顯示（跟 provider 不轉發子 agent 文字一致）
  if (!msg || msg.parent_tool_use_id || !Array.isArray(msg.message?.content)) return;
  for (const item of msg.message.content as Array<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
    if (item.type !== "tool_result" || !item.tool_use_id) continue;
    const tool = blocks.find((b): b is ToolBlock => b.type === "tool" && b.id === item.tool_use_id);
    if (!tool) continue;
    tool.result = preview(toolResultText(item.content));
    if (item.is_error) tool.error = tool.result.slice(0, 300);
    broadcast(convId, { type: "tool_result", id: tool.id, result: tool.result, ...(tool.error ? { error: tool.error } : {}) });
  }
}

function saveCliCommands(convId: string, commands: string[]): void {
  const cli = updateCliConv(convId, c => { c.commands = commands; });
  if (cli) broadcast(convId, { type: "settings", settings: cliSettingsOf(cli) });
}

// ── CLI 權限／提問卡 ──

const minutes = (ms: number) => Math.round(ms / 60_000);

function parseQuestions(input: Record<string, unknown>): ControlQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions as Array<Record<string, unknown>> : [];
  return raw.map(q => ({
    question: String(q.question ?? ""),
    header: String(q.header ?? "問題"),
    options: (Array.isArray(q.options) ? q.options as Array<Record<string, unknown>> : [])
      .map(o => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })),
    multiSelect: q.multiSelect === true,
  }));
}

const isPlanFile = (p: string) => p.includes("/.claude/plans/") && p.endsWith(".md");

/**
 * ExitPlanMode 的計畫內容：input.plan 有就用；沒有（claude 2.1.3xx 先把計畫寫進 ~/.claude/plans/<名稱>.md、
 * 再送空的 ExitPlanMode）就讀 input.planFilePath 或這個 session 最近寫的計畫檔。
 */
function planText(input: Record<string, unknown>, planFile: string | undefined): string {
  const inline = String(input.plan ?? "").trim();
  if (inline) return inline;
  const path = typeof input.planFilePath === "string" && isPlanFile(input.planFilePath) ? input.planFilePath : planFile;
  if (!path) return "(空計畫)";
  try { return readFileSync(path, "utf-8").trim() || "(空計畫)"; }
  catch (err) {
    log.warn(`[webchat] 讀計畫檔 ${path} 失敗：${err instanceof Error ? err.message : String(err)}`);
    return "(空計畫：計畫檔讀不到)";
  }
}

function controlBlockFrom(evt: Extract<CliBridgeEvent, { type: "control_request" }>, planFile: string | undefined): ControlBlock {
  const base = { type: "control" as const, id: evt.requestId, tool: evt.tool, status: "pending" as const,
    expiresAt: new Date(Date.now() + CLI_CONTROL_TIMEOUT_MS).toISOString() };
  if (evt.tool === "AskUserQuestion") return { ...base, kind: "question", questions: parseQuestions(evt.input) };
  if (evt.tool === "ExitPlanMode") return { ...base, kind: "plan", plan: planText(evt.input, planFile) };
  return { ...base, kind: "permission", input: preview(evt.input) };
}

function openControlCard(run: CliRun, evt: Extract<CliBridgeEvent, { type: "control_request" }>): void {
  const convId = run.session.convId;
  const conv = loadConversations().find(c => c.id === convId);
  const block = controlBlockFrom(evt, run.session.planFile);
  // 隔離模式：AskUserQuestion 以外都送管理員審批
  const needsReview = conv?.cli?.mode === "isolated" && evt.tool !== "AskUserQuestion";
  if (needsReview) block.review = true;
  run.assistant.blocks.push(block);
  const timer = setTimeout(() => expireControl(evt.requestId), CLI_CONTROL_TIMEOUT_MS);
  timer.unref();
  const owner = needsReview ? loadUsers()[run.session.owner] : undefined;
  const requesterName = owner ? reviewerDisplayName(owner.accountId, run.session.owner) : run.session.owner;
  pendingControls.set(evt.requestId, {
    convId, bridge: run.session.bridge, block, input: evt.input, timer,
    ...(needsReview ? { review: { requester: run.session.owner, requesterName, convTitle: conv?.title ?? "", createdAt: nowIso() } } : {}),
  });
  broadcast(convId, { type: "control", block: { ...block } });
  log.info(`[webchat] CLI 對話 ${convId} 等${needsReview ? "管理員審批" : "作答"}：${evt.tool}（${evt.requestId.slice(0, 8)}）`);
  if (!needsReview) return;
  // 沒有任何管理員能審：照 DM 的規則直接拒絕，不退回發話者自審
  if (cliReviewers().length === 0) {
    settleControl(evt.requestId, { behavior: "deny", message: `沒有可審批的管理員，${evt.tool} 已自動拒絕。請結束本回合。` }, "denied", "沒有可審批的管理員，已自動拒絕");
    return;
  }
  notifyReviewers();
}

// ── 管理員審批（隔離模式的工具權限請求）──

/** 帳號顯示名（審批清單用）；找不到就用帳號名 */
function reviewerDisplayName(accountId: string, fallback: string): string {
  return accountLookup?.get(accountId)?.displayName ?? fallback;
}

/** 能審批的網頁帳號名（完整 CLI 權限的 platform-owner／admin，沒停用） */
function cliReviewers(): string[] {
  const names: string[] = [];
  for (const [name, u] of Object.entries(loadUsers())) {
    const role = accountLookup?.get(u.accountId)?.role;
    if (!u.disabled && role && ADMIN_ROLES.has(role) && effectiveCliAccess(u, role) === "full") names.push(name);
  }
  return names;
}

/** 待審批清單變了：通知所有審批者的分頁重抓 */
function notifyReviewers(): void {
  for (const name of cliReviewers()) for (const res of userStreams.get(name) ?? []) sendEvent(res, { type: "reviews" });
}

/** 待審批清單（只有請求本身的內容，不含對話紀錄） */
function listReviews(): Array<Record<string, unknown>> {
  const list: Array<Record<string, unknown>> = [];
  for (const [requestId, rec] of pendingControls) {
    if (!rec.review) continue;
    const { block } = rec;
    list.push({
      requestId, requester: rec.review.requester, requesterName: rec.review.requesterName, convTitle: rec.review.convTitle,
      tool: block.tool, kind: block.kind, plan: block.plan, input: block.input, createdAt: rec.review.createdAt, expiresAt: block.expiresAt,
    });
  }
  return list;
}

/** 管理員核准／拒絕；請求不存在回 false */
function decideReview(reviewer: Viewer, body: Record<string, unknown>): boolean {
  const requestId = str(body.requestId);
  const rec = pendingControls.get(requestId);
  if (!rec?.review) return false;
  const { block, input } = rec;
  const who = reviewer.displayName;
  log.info(`[webchat] ${reviewer.username} ${body.allow === true ? "核准" : "拒絕"} ${rec.review.requester} 的 ${block.tool}（${requestId.slice(0, 8)}）`);
  if (body.allow === true) return settleControl(requestId, { behavior: "allow", updatedInput: input }, "allowed", `✅ 管理員 ${who} 已核准`);
  const feedback = str(body.message).trim().slice(0, 2000);
  const message = block.kind === "plan"
    ? (feedback ? `管理員退回計畫：${feedback}` : "管理員退回計畫（未附意見），請結束本回合。")
    : `管理員拒絕 ${block.tool}${feedback ? `：${feedback}` : ""}`;
  return settleControl(requestId, { behavior: "deny", message }, "denied", `❌ 管理員 ${who} ${block.kind === "plan" ? "退回" : "拒絕"}${feedback ? `：${feedback}` : ""}`);
}

/** 回覆 CLI 並更新卡片；請求已結束回 false */
function settleControl(requestId: string, decision: { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message: string }, status: ControlStatus, answer: string): boolean {
  const rec = pendingControls.get(requestId);
  if (!rec) return false;
  pendingControls.delete(requestId);
  clearTimeout(rec.timer);
  rec.bridge.sendControlResponse(requestId, decision);
  rec.block.status = status;
  rec.block.answer = answer;
  broadcast(rec.convId, { type: "control", block: { ...rec.block } });
  if (rec.review) notifyReviewers();
  return true;
}

/** 逾時：照 Discord 版的說法回 deny，讓 CLI 結束回合 */
function expireControl(requestId: string): void {
  const rec = pendingControls.get(requestId);
  if (!rec) return;
  const min = minutes(CLI_CONTROL_TIMEOUT_MS);
  const firstQuestion = rec.block.questions?.[0]?.question ?? "";
  const message = rec.block.kind === "question" ? `使用者 ${min} 分鐘內未回答「${firstQuestion}」。請結束本回合，等使用者在網頁回覆後再繼續。`
    : rec.block.kind === "plan" ? `使用者 ${min} 分鐘內未核准計畫。請結束本回合，等使用者回覆後再繼續。`
    : `${min} 分鐘內無人回應，自動拒絕 ${rec.block.tool}`;
  settleControl(requestId, { behavior: "deny", message }, "expired", `${min} 分鐘內沒有作答，已自動拒絕`);
}

function denyControlsOf(convId: string, message: string, answer: string, status: ControlStatus = "denied"): void {
  for (const [requestId, rec] of pendingControls) {
    if (rec.convId === convId) settleControl(requestId, { behavior: "deny", message }, status, answer);
  }
}

/** 每題的答案（多選用「, 」接起來，跟 Discord 版一樣）；缺答案回錯誤字串 */
function questionAnswers(questions: ControlQuestion[], raw: unknown): Record<string, string> | string {
  const given = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const value = str(given[q.question]).trim().slice(0, 2000);
    if (!value) return `「${q.header}」還沒回答`;
    answers[q.question] = value;
  }
  return answers;
}

/** 擁有者在網頁作答；回傳錯誤字串（null = 成功），notFound 代表請求已結束或不屬於這個對話 */
function answerControl(convId: string, body: Record<string, unknown>): { error: string; notFound?: boolean; forbidden?: boolean } | null {
  const requestId = str(body.requestId);
  const rec = pendingControls.get(requestId);
  if (!rec || rec.convId !== convId) return { error: "這個請求已結束或不存在", notFound: true };
  if (rec.review) return { error: "這個請求要管理員審批，不能自己核准", forbidden: true };
  const allow = body.allow === true;
  const { block, input } = rec;

  if (block.kind === "question") {
    if (!allow) { settleControl(requestId, { behavior: "deny", message: "使用者略過了問題，請結束本回合，等使用者在網頁說明。" }, "denied", "已略過"); return null; }
    const answers = questionAnswers(block.questions ?? [], body.answers);
    if (typeof answers === "string") return { error: answers };
    settleControl(requestId, { behavior: "allow", updatedInput: { ...input, answers } }, "allowed", Object.values(answers).join("；"));
    return null;
  }

  if (block.kind === "plan") {
    if (allow) { settleControl(requestId, { behavior: "allow", updatedInput: input }, "allowed", "已核准"); return null; }
    const feedback = str(body.message).trim().slice(0, 2000);
    const message = feedback ? `使用者退回計畫：${feedback}` : "使用者退回計畫（未附意見），請結束本回合，等使用者在網頁說明修改方向。";
    settleControl(requestId, { behavior: "deny", message }, "denied", feedback ? `已退回：${feedback}` : "已退回");
    return null;
  }

  if (allow) settleControl(requestId, { behavior: "allow", updatedInput: input }, "allowed", "已允許");
  else settleControl(requestId, { behavior: "deny", message: `使用者在網頁拒絕 ${block.tool}` }, "denied", "已拒絕");
  return null;
}

/** 停止：先回絕等作答的卡片（CLI 等作答時收不到中斷），再中斷 CLI 回合 */
function stopCliTurn(convId: string): boolean {
  denyControlsOf(convId, "使用者按了停止，請結束本回合。", "已停止");
  const session = cliSessions.get(convId);
  if (!session || !liveTurns.has(convId)) return false;
  session.stopRequested = true;
  void session.bridge.interrupt().catch(err => log.warn(`[webchat] CLI 中斷失敗 conv=${convId}：${err instanceof Error ? err.message : String(err)}`));
  return true;
}

/** 開新 CLI 對話時的設定（依這個人的 cliAccess）；有錯回錯誤字串 */
function newCliSettings(viewer: Viewer, body: Record<string, unknown>): CliConvSettings | string {
  const isolated = viewer.cliAccess === "isolated";
  let workingDir: string | null;
  if (isolated) {
    if (body.skipPermissions === true) return "隔離模式不能跳過權限確認";
    const allowed = isolatedDirs(viewer.username, viewer.displayName);
    // 沒填就用個人工作區
    workingDir = str(body.workingDir).trim() ? resolveWorkingDir(str(body.workingDir)) : allowed[0]!;
    if (!workingDir || !allowed.includes(workingDir)) return "隔離模式只能用個人工作區或管理員指定的目錄";
    const denied = deniedByIsolation(workingDir);
    if (denied) return `工作目錄在隔離規則擋住的路徑 ${denied} 底下，CLI 會讀不到；請管理員把 cli-bridge-dm.json 的 teamWorkspaceRoot 或指定目錄移到 denyPaths 之外`;
  } else {
    workingDir = resolveWorkingDir(str(body.workingDir));
    if (!workingDir) return "工作目錄不存在或不是資料夾（要絕對路徑）";
  }
  const model = str(body.model).trim();
  if (model && !cliModelChoices().includes(model)) return `不認得的 CLI 模型 ${model}`;
  const effort = str(body.effort).trim();
  if (effort && !(CLI_EFFORT_LEVELS as string[]).includes(effort)) return `effort 不正確：${effort}`;
  return {
    mode: isolated ? "isolated" : "full", workingDir, skipPermissions: !isolated && body.skipPermissions === true,
    ...(model ? { model } : {}), ...(effort ? { effort: effort as CliEffortLevel } : {}),
  };
}

/** 管理員改某人的 CLI 權限；立即生效：這個人不能再用的 CLI session 直接關掉 */
async function setCliAccess(admin: Viewer, body: Record<string, unknown>, roleOf: (accountId: string) => Role | null): Promise<{ status: number; error: string } | null> {
  const username = str(body.username);
  const users = loadUsers();
  const user = users[username];
  if (!user) return { status: 404, error: "找不到帳號" };
  if (roleOf(user.accountId) === "platform-owner" && admin.role !== "platform-owner") return { status: 403, error: "只有 platform-owner 能改 platform-owner 的 CLI 權限" };
  const access = str(body.cliAccess);
  if (access && !(CLI_ACCESS_VALUES as string[]).includes(access)) return { status: 400, error: `CLI 權限不正確：${access}` };
  if (access) user.cliAccess = access as CliAccess; else delete user.cliAccess;
  if (Array.isArray(body.cliDirs)) {
    const dirs: string[] = [];
    for (const raw of body.cliDirs as unknown[]) {
      const real = resolveWorkingDir(str(raw));
      if (!real) return { status: 400, error: `目錄不存在或不是資料夾：${str(raw)}` };
      if (!dirs.includes(real)) dirs.push(real);
    }
    if (dirs.length > 0) user.cliDirs = dirs; else delete user.cliDirs;
  }
  saveUsers(users);
  const role = roleOf(user.accountId);
  const effective = role ? effectiveCliAccess(user, role) : "none";
  log.info(`[webchat] ${admin.username} 設定 ${username} 的 CLI 權限：${access || "(依角色)"} → ${effective}，指定目錄 ${user.cliDirs?.length ?? 0} 個`);
  // 已經不能用的 CLI session 關掉（full 對話但權限降成 isolated／none、isolated 但整個關掉）
  for (const conv of loadConversations()) {
    if (conv.owner !== username || !conv.cli || !cliSessions.has(conv.id)) continue;
    const stillOk = effective === "full" || (effective === "isolated" && conv.cli.mode === "isolated");
    if (!stillOk) await closeCliSession(conv.id);
  }
  notifyReviewers();
  return null;
}

/** CLI 對話換模型／effort：存檔後關掉 process，下一則訊息以 --resume 帶新參數重開 */
async function changeCliSettings(conv: Conversation, body: Record<string, unknown>): Promise<{ status: number; body: unknown }> {
  if (liveTurns.has(conv.id)) return { status: 409, body: { error: "回覆進行中，請等這輪結束再換" } };
  const model = "model" in body ? str(body.model).trim() : undefined;
  const effort = "thinking" in body ? str(body.thinking).trim() : undefined;
  if (model && !cliModelChoices().includes(model)) return { status: 400, body: { error: `不認得的 CLI 模型 ${model}` } };
  if (effort && !(CLI_EFFORT_LEVELS as string[]).includes(effort)) return { status: 400, body: { error: `effort 不正確：${effort}` } };
  const cli = updateCliConv(conv.id, c => {
    if (model !== undefined) { if (model) c.model = model; else delete c.model; }
    if (effort !== undefined) { if (effort) c.effort = effort as CliEffortLevel; else delete c.effort; }
  });
  if (!cli) return { status: 404, body: { error: "找不到對話" } };
  await closeCliSession(conv.id);
  const settings = cliSettingsOf(cli);
  broadcast(conv.id, { type: "settings", settings });
  return { status: 200, body: settings };
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error("內容太大（上限 40MB）")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown> : {}); }
      catch { reject(new Error("JSON 格式錯誤")); }
    });
    req.on("error", reject);
  });
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

function clientIp(req: IncomingMessage): string { return req.socket.remoteAddress ?? "?"; }

function pagePath(): string {
  // dist/web/webchat.js → dist/web/public/index.html（build 會從 src/web/public 複製過去）
  return join(dirname(fileURLToPath(import.meta.url)), "public", "index.html");
}

function ownConversation(viewer: Viewer, convId: string): Conversation | null {
  return loadConversations().find(c => c.id === convId && c.owner === viewer.username) ?? null;
}

/**
 * 處理 /chat 與 /api/webchat/*。由 dashboard server 在 token 檢查前呼叫。
 */
export async function handleWebChat(req: IncomingMessage, res: ServerResponse, path: string, method: string): Promise<void> {
  try {
    // 頁面本身不需登入（登入畫面在頁內）
    if (path === "/chat" || path === "/chat/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
      res.end(readFileSync(pagePath(), "utf-8"));
      return;
    }

    // 寫入類請求要帶自訂 header：瀏覽器跨站表單送不出來，擋 CSRF
    if (method !== "GET" && req.headers["x-webchat"] !== "1") { json(res, 403, { error: "缺少 X-Webchat header" }); return; }

    const api = path.slice("/api/webchat".length);

    // ── 不需登入 ──
    if (api === "/state" && method === "GET") {
      const viewer = await currentViewer(req);
      const needsSetup = ensureSetupCode() !== null;
      json(res, 200, { needsSetup, gitlab: loadGitlabConfig() !== null, viewer: viewer ? { ...viewer, isAdmin: ADMIN_ROLES.has(viewer.role), canReview: canReviewCli(viewer) } : null });
      return;
    }

    if (api === "/setup" && method === "POST") {
      const code = ensureSetupCode();
      const body = await readBody(req);
      if (!code) { json(res, 400, { error: "已經有帳號了，請直接登入" }); return; }
      if (str(body.code).trim() !== code) { noteLoginFailure(clientIp(req)); json(res, 403, { error: "設定碼不正確" }); return; }
      const err = await createWebUser({
        username: str(body.username).trim().toLowerCase(), password: str(body.password),
        displayName: str(body.displayName).trim(), role: "platform-owner", linkAccountId: str(body.linkAccountId),
      });
      if (err) { json(res, 400, { error: err }); return; }
      rmSync(join(dataDir(), "setup-code.txt"), { force: true });
      issueLogin(res, str(body.username).trim().toLowerCase());
      json(res, 200, { ok: true });
      return;
    }

    if (api === "/login" && method === "POST") {
      const ip = clientIp(req);
      if (loginBlocked(ip)) { json(res, 429, { error: "失敗次數太多，請 10 分鐘後再試" }); return; }
      const body = await readBody(req);
      const username = str(body.username).trim().toLowerCase();
      const user = loadUsers()[username];
      if (!user || !passwordMatches(user, str(body.password))) {
        noteLoginFailure(ip);
        json(res, 401, { error: "帳號或密碼錯誤" });
        return;
      }
      if (user.disabled) { json(res, 403, { error: "這個帳號已被管理員停用" }); return; }
      issueLogin(res, username);
      json(res, 200, { ok: true });
      return;
    }

    if (api === "/oauth/gitlab/start" && method === "GET") {
      const cfg = loadGitlabConfig();
      if (!cfg) { redirectToChat(res, { error: "GitLab 登入尚未設定" }); return; }
      const mode = new URL(req.url ?? "", "http://x").searchParams.get("mode") === "link" ? "link" : "login";
      if (mode === "link") {
        const me = await currentViewer(req);
        if (!me) { redirectToChat(res, { error: "請先登入再綁定 GitLab" }); return; }
        startGitlabLogin(res, cfg, "link", me.username);
        return;
      }
      startGitlabLogin(res, cfg, "login");
      return;
    }

    if (api === "/oauth/gitlab/callback" && method === "GET") {
      const cfg = loadGitlabConfig();
      const params = new URL(req.url ?? "", "http://x").searchParams;
      if (!cfg) { redirectToChat(res, { error: "GitLab 登入尚未設定" }); return; }
      if (params.get("error")) { redirectToChat(res, { error: `GitLab 拒絕授權：${params.get("error_description") ?? params.get("error")}` }); return; }
      try {
        redirectToChat(res, await finishGitlabLogin(res, cfg, params.get("code") ?? "", params.get("state") ?? ""));
      } catch (err) {
        log.warn(`[webchat] GitLab 登入失敗：${err instanceof Error ? err.message : String(err)}`);
        redirectToChat(res, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // ── 以下都要登入 ──
    const viewer = await currentViewer(req);
    if (!viewer) { json(res, 401, { error: "請先登入" }); return; }
    await ensureJobListeners();

    if (api === "/logout" && method === "POST") {
      const token = readCookieToken(req);
      if (token) { const logins = loadLogins(); delete logins[sha256(token)]; saveLogins(logins); }
      res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      json(res, 200, { ok: true });
      return;
    }

    if (api === "/password" && method === "POST") {
      const body = await readBody(req);
      const users = loadUsers();
      const user = users[viewer.username];
      if (user && !user.hash) { json(res, 400, { error: "這個帳號用 GitLab 登入、沒有密碼；需要密碼請找管理員重設" }); return; }
      if (!user || !passwordMatches(user, str(body.oldPassword))) { json(res, 403, { error: "舊密碼不正確" }); return; }
      if (str(body.newPassword).length < 8) { json(res, 400, { error: "新密碼至少 8 個字" }); return; }
      users[viewer.username] = { ...user, ...makeUser(user.accountId, str(body.newPassword)), createdAt: user.createdAt };
      saveUsers(users);
      json(res, 200, { ok: true });
      return;
    }

    // 對話列表變動通知
    if (api === "/events" && method === "GET") {
      if (!userStreams.has(viewer.username)) userStreams.set(viewer.username, new Set());
      openSse(req, res, userStreams.get(viewer.username)!);
      return;
    }

    // 輸入框上方的選單與斜線指令清單
    if (api === "/options" && method === "GET") {
      const { getProviderRegistry } = await import("../providers/registry.js");
      const { listSkills } = await import("../skills/registry.js");
      const platform = await import("../core/platform.js");
      const registry = getProviderRegistry();
      const aliases = registry.listAliases();
      // 整份模型目錄（已在用的 provider 底下的所有模型），選到時才建 provider
      const models = registry.listCatalog().map(id => {
        const names = aliases.filter(a => a.id === id).map(a => a.alias);
        return { id, label: names.length ? `${names.join(" / ")}（${id}）` : id };
      });
      const gate = platform.getPlatformPermissionGate();
      // 斜線清單：有 / 開頭 trigger、且這個角色的 tier 用得了的 skill
      const skills: Array<{ name: string; trigger: string; description: string }> = [];
      for (const sk of listSkills()) {
        const slash = sk.trigger.find(isSlashTrigger);
        if (!slash || !gate.checkTier(viewer.accountId, sk.tier).allowed) continue;
        skills.push({ name: sk.name, trigger: slash, description: sk.description });
      }
      skills.sort((a, b) => a.trigger.localeCompare(b.trigger));
      // CLI 對話的選單：依 cliAccess（none 不給；isolated 只列個人工作區與指定目錄、不能自填與跳過權限）
      const full = viewer.cliAccess === "full";
      const cli = viewer.cliAccess === "none" ? null : {
        access: viewer.cliAccess, models: cliModelChoices(), effortLevels: CLI_EFFORT_LEVELS, commands: CLI_DEFAULT_COMMANDS,
        workingDirs: full ? cliWorkingDirChoices() : isolatedDirs(viewer.username, viewer.displayName),
        canChooseAnyDir: full, canSkipPermissions: full,
      };
      json(res, 200, { models, thinkingLevels: THINKING_LEVELS, canChangeModel: await canChangeModel(viewer), skills, cli });
      return;
    }

    // 隔離 CLI 對話的待審批清單：只有審批者（完整 CLI 權限的管理員）看得到，只含請求內容
    if (api === "/reviews" && method === "GET") {
      if (!canReviewCli(viewer)) { json(res, 403, { error: "只有完整 CLI 權限的管理員能審批" }); return; }
      json(res, 200, { reviews: listReviews() });
      return;
    }
    if (api === "/reviews/decide" && method === "POST") {
      if (!canReviewCli(viewer)) { json(res, 403, { error: "只有完整 CLI 權限的管理員能審批" }); return; }
      if (!decideReview(viewer, await readBody(req))) { json(res, 404, { error: "這個請求已結束或不存在" }); return; }
      json(res, 200, { ok: true });
      return;
    }

    if (api === "/conversations" && method === "GET") {
      const mine = loadConversations().filter(c => c.owner === viewer.username).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      json(res, 200, mine.map(c => ({ ...c, running: liveTurns.has(c.id) })));
      return;
    }

    if (api === "/conversations" && method === "POST") {
      const body = await readBody(req);
      const conv: Conversation = {
        id: randomUUID().replace(/-/g, "").slice(0, 16), owner: viewer.username,
        title: str(body.title).trim().slice(0, 60) || "新對話", createdAt: nowIso(), updatedAt: nowIso(),
      };
      // CLI 對話：每個對話一條自己的 claude CLI session，依帳號的 cliAccess
      if (str(body.kind) === "cli") {
        if (viewer.cliAccess === "none") { json(res, 403, { error: "你沒有 CLI 對話權限（請管理員在帳號管理開通）" }); return; }
        const cli = newCliSettings(viewer, body);
        if (typeof cli === "string") { json(res, 400, { error: cli }); return; }
        conv.kind = "cli";
        conv.cli = cli;
        log.info(`[webchat] ${viewer.username} 開 CLI 對話 ${conv.id}（${cli.mode}）：${cli.workingDir}${cli.skipPermissions ? "（跳過權限確認）" : ""}`);
      }
      const all = loadConversations();
      all.push(conv);
      saveConversations(all);
      notifyConversationsChanged(viewer.username);
      json(res, 200, conv);
      return;
    }

    // /conversations/<id>/<動作>
    const convMatch = api.match(/^\/conversations\/([a-z0-9]{1,40})(\/[a-z]+)?(?:\/([a-f0-9-]{1,40}))?$/);
    if (convMatch) {
      const [, convId, action = "", fileId] = convMatch;
      const conv = ownConversation(viewer, convId!);
      if (!conv) { json(res, 404, { error: "找不到對話" }); return; }

      if (action === "/stream" && method === "GET") {
        if (!subscribers.has(conv.id)) subscribers.set(conv.id, new Set());
        openSse(req, res, subscribers.get(conv.id)!);
        sendEvent(res, { type: "sync", entries: readTranscript(conv.id).slice(-SYNC_ENTRIES), live: liveTurns.get(conv.id) ?? [] });
        sendEvent(res, { type: "settings", settings: await settingsOf(viewer, conv) });
        return;
      }

      // CLI 對話：送訊息、作答、換設定每次都照目前的 cliAccess 檢查（改名、刪除、停止不擋）
      const cliConv = conv.kind === "cli";
      const cliGated = action === "/messages" || action === "/answer" || action === "/settings";
      const cliBlocked = cliConv && method === "POST" && cliGated ? cliConvBlockedReason(viewer, conv) : null;
      if (cliBlocked) { json(res, 403, { error: cliBlocked }); return; }

      if (action === "/messages" && method === "POST") {
        const body = await readBody(req);
        const uploads = Array.isArray(body.files)
          ? (body.files as unknown[]).map(f => f as Record<string, unknown>).map(f => ({ name: str(f.name), mime: str(f.mime), data: str(f.data) })).filter(f => f.data)
          : [];
        const err = await acceptMessage(viewer, conv, str(body.text), uploads);
        if (err) { json(res, 400, { error: err }); return; }
        json(res, 200, { ok: true });
        return;
      }

      if (action === "/stop" && method === "POST" && cliConv) {
        const stopped = stopCliTurn(conv.id);
        if (stopped) broadcast(conv.id, { type: "status", text: "已要求停止" });
        json(res, 200, { ok: true, stopped });
        return;
      }

      // CLI 權限／提問卡作答：{ requestId, allow, answers?（提問：題目 → 答案）, message?（退回計畫的意見） }
      if (action === "/answer" && method === "POST" && cliConv) {
        const err = answerControl(conv.id, await readBody(req));
        if (err) { json(res, err.notFound ? 404 : err.forbidden ? 403 : 400, { error: err.error }); return; }
        json(res, 200, { ok: true });
        return;
      }

      if (action === "/settings" && method === "POST" && cliConv) {
        const r = await changeCliSettings(conv, await readBody(req));
        json(res, r.status, r.body);
        return;
      }

      if (action === "/stop" && method === "POST") {
        await rejectApprovalsOf(conv.id);
        const { abortRunningTurn } = await import("../skills/builtin/stop.js");
        const stopped = abortRunningTurn(sessionKeyOf(conv.id));
        if (stopped) broadcast(conv.id, { type: "status", text: "已要求停止" });
        json(res, 200, { ok: true, stopped });
        return;
      }

      if (action === "/approve" && method === "POST") {
        const body = await readBody(req);
        // 核准是把關：只有管理員以上能按「核准」；一般成員只能拒絕自己的，等不到核准就逾時拒絕
        if (body.approved === true && !ADMIN_ROLES.has(viewer.role)) { json(res, 403, { error: "只有管理員能核准執行" }); return; }
        const ok = await decideApproval(conv.id, str(body.approvalId), body.approved === true);
        if (!ok) { json(res, 404, { error: "這個核准已結束或不存在" }); return; }
        json(res, 200, { ok: true });
        return;
      }

      if (action === "/settings" && method === "POST") {
        const body = await readBody(req);
        const all = loadConversations();
        const target = all.find(c => c.id === conv.id)!;
        if ("model" in body) {
          const model = str(body.model).trim();
          if (model && !(await canChangeModel(viewer))) { json(res, 403, { error: "你的角色不能換模型" }); return; }
          const { getProviderRegistry } = await import("../providers/registry.js");
          const provider = model ? await getProviderRegistry().ensure(model) : undefined;
          if (model && !provider) { json(res, 400, { error: `找不到模型 ${model}` }); return; }
          if (provider) target.model = provider.id; else delete target.model;
          // 選單是最新的決定：清掉 /use 的覆寫，免得被它蓋過
          const { setChannelProviderOverride } = await import("../skills/builtin/use.js");
          setChannelProviderOverride(conv.id, null);
        }
        if ("thinking" in body) {
          const thinking = str(body.thinking);
          const valid = thinking === "" || thinking === "off" || (THINKING_LEVELS as readonly string[]).includes(thinking);
          if (!valid) { json(res, 400, { error: `思考等級不正確：${thinking}` }); return; }
          if (thinking) target.thinking = thinking as ThinkingChoice; else delete target.thinking;
          const { setChannelThinking } = await import("../skills/builtin/think.js");
          setChannelThinking(conv.id, null);
        }
        saveConversations(all);
        const settings = await settingsOf(viewer, target);
        broadcast(conv.id, { type: "settings", settings });
        json(res, 200, settings);
        return;
      }

      if (action === "/rename" && method === "POST") {
        const body = await readBody(req);
        const title = str(body.title).trim().slice(0, 60);
        if (!title) { json(res, 400, { error: "標題不能空白" }); return; }
        const all = loadConversations();
        const target = all.find(c => c.id === conv.id)!;
        target.title = title;
        saveConversations(all);
        notifyConversationsChanged(viewer.username);
        json(res, 200, { ok: true });
        return;
      }

      if (action === "/delete" && method === "POST") {
        if (liveTurns.has(conv.id)) { json(res, 409, { error: "回覆進行中，請先停止" }); return; }
        if (cliConv) await closeCliSession(conv.id);
        saveConversations(loadConversations().filter(c => c.id !== conv.id));
        rmSync(transcriptPath(conv.id), { force: true });
        rmSync(join(dataDir(), "uploads", conv.id), { recursive: true, force: true });
        try { const { getSessionManager } = await import("../core/session.js"); getSessionManager().delete(sessionKeyOf(conv.id)); }
        catch (err) { log.warn(`[webchat] 刪除 session 失敗 conv=${conv.id}：${err instanceof Error ? err.message : String(err)}`); }
        notifyConversationsChanged(viewer.username);
        json(res, 200, { ok: true });
        return;
      }

      if (action === "/files" && fileId && method === "GET") {
        const p = findUpload(conv.id, fileId);
        if (!p) { res.writeHead(404); res.end(); return; }
        const ext = extname(p).toLowerCase();
        const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[ext] ?? "application/octet-stream";
        const name = p.slice(p.indexOf("__") + 2);
        res.writeHead(200, {
          "Content-Type": mime,
          "Content-Disposition": `${mime.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
          "X-Content-Type-Options": "nosniff",
        });
        res.end(readFileSync(p));
        return;
      }
    }

    // ── 管理員：帳號管理 ──
    if (api.startsWith("/admin/")) {
      if (!ADMIN_ROLES.has(viewer.role)) { json(res, 403, { error: "需要管理員權限" }); return; }
      const { getAccountRegistry } = await import("../core/platform.js");
      const registry = getAccountRegistry();

      if (api === "/admin/users" && method === "GET") {
        const users = loadUsers();
        json(res, 200, {
          users: Object.entries(users).map(([username, u]) => {
            const acct = registry.get(u.accountId);
            return {
              username, accountId: u.accountId, displayName: acct?.displayName ?? "?", role: acct?.role ?? "?",
              disabled: u.disabled ?? false, gitlab: u.gitlab?.username ?? null, hasPassword: !!u.hash, createdAt: u.createdAt,
              cliAccess: u.cliAccess ?? "", cliEffective: acct ? effectiveCliAccess(u, acct.role) : "none", cliDirs: u.cliDirs ?? [],
            };
          }),
          accounts: Object.entries(registry.getIndex()).map(([accountId, a]) => ({ accountId, displayName: a.displayName, role: a.role })),
          roles: ROLES,
        });
        return;
      }

      if (api === "/admin/users" && method === "POST") {
        const body = await readBody(req);
        const role = str(body.role) as Role;
        // 只有 platform-owner 能建 platform-owner
        if (role === "platform-owner" && viewer.role !== "platform-owner") { json(res, 403, { error: "只有 platform-owner 能建立同等級帳號" }); return; }
        const err = await createWebUser({
          username: str(body.username).trim().toLowerCase(), password: str(body.password),
          displayName: str(body.displayName).trim(), role, linkAccountId: str(body.linkAccountId),
        });
        if (err) { json(res, 400, { error: err }); return; }
        json(res, 200, { ok: true });
        return;
      }

      if (api === "/admin/reset-password" && method === "POST") {
        const body = await readBody(req);
        const users = loadUsers();
        const user = users[str(body.username)];
        if (!user) { json(res, 404, { error: "找不到帳號" }); return; }
        if (str(body.password).length < 8) { json(res, 400, { error: "密碼至少 8 個字" }); return; }
        // 保留 GitLab 綁定與停用狀態，只換密碼
        users[str(body.username)] = { ...user, ...makeUser(user.accountId, str(body.password)), createdAt: user.createdAt };
        saveUsers(users);
        json(res, 200, { ok: true });
        return;
      }

      if (api === "/admin/delete-user" && method === "POST") {
        const body = await readBody(req);
        const username = str(body.username);
        if (username === viewer.username) { json(res, 400, { error: "不能刪除自己" }); return; }
        const users = loadUsers();
        if (!users[username]) { json(res, 404, { error: "找不到帳號" }); return; }
        // GitLab 帳號刪了下次登入會自動建回來，所以改成停用
        const disableOnly = !!users[username]!.gitlab;
        if (disableOnly) users[username]!.disabled = true;
        else delete users[username];
        saveUsers(users);
        const logins = loadLogins();
        for (const [k, v] of Object.entries(logins)) if (v.username === username) delete logins[k];
        saveLogins(logins);
        log.info(`[webchat] ${viewer.username} ${disableOnly ? "停用" : "刪除"}網頁帳號 ${username}（catclaw 帳號保留）`);
        json(res, 200, { ok: true, disabled: disableOnly });
        return;
      }

      // CLI 權限：{ username, cliAccess: "none"|"isolated"|"full"|""（"" = 回到依角色的預設）, cliDirs?: 絕對路徑[] }
      if (api === "/admin/cli-access" && method === "POST") {
        const body = await readBody(req);
        const err = await setCliAccess(viewer, body, (id) => registry.get(id)?.role ?? null);
        if (err) { json(res, err.status, { error: err.error }); return; }
        json(res, 200, { ok: true });
        return;
      }

      if (api === "/admin/enable-user" && method === "POST") {
        const body = await readBody(req);
        const users = loadUsers();
        const user = users[str(body.username)];
        if (!user) { json(res, 404, { error: "找不到帳號" }); return; }
        delete user.disabled;
        saveUsers(users);
        json(res, 200, { ok: true });
        return;
      }

      if (api === "/admin/gitlab" && method === "GET") {
        const cfg = readJson<Partial<GitlabConfig>>("gitlab.json", {});
        json(res, 200, { url: cfg.url ?? "", clientId: cfg.clientId ?? "", hasSecret: !!cfg.clientSecret, redirectUri: cfg.redirectUri ?? "", enabled: loadGitlabConfig() !== null });
        return;
      }

      if (api === "/admin/gitlab" && method === "POST") {
        const body = await readBody(req);
        const old = readJson<Partial<GitlabConfig>>("gitlab.json", {});
        const url = str(body.url).trim().replace(/\/+$/, "");
        const redirectUri = str(body.redirectUri).trim();
        if (url && !/^https?:\/\/[^/\s]+/.test(url)) { json(res, 400, { error: "GitLab 網址格式不正確" }); return; }
        if (redirectUri && !/^https?:\/\/[^/\s]+\/api\/webchat\/oauth\/gitlab\/callback$/.test(redirectUri)) { json(res, 400, { error: "回呼網址格式不正確" }); return; }
        const next: Partial<GitlabConfig> = {
          url, clientId: str(body.clientId).trim(), redirectUri,
          // Secret 留空代表不變；要清掉 GitLab 登入就把 Application ID 清空
          clientSecret: str(body.clientSecret).trim() || old.clientSecret || "",
        };
        if (!next.clientId) next.clientSecret = "";
        writeJson("gitlab.json", next);
        try { chmodSync(join(dataDir(), "gitlab.json"), 0o600); } catch (err) { log.warn(`[webchat] gitlab.json 設權限失敗：${err instanceof Error ? err.message : String(err)}`); }
        log.info(`[webchat] ${viewer.username} 更新 GitLab 登入設定（${loadGitlabConfig() ? "已啟用" : "未啟用"}）`);
        json(res, 200, { ok: true, enabled: loadGitlabConfig() !== null });
        return;
      }
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    log.error(`[webchat] ${method} ${path} 失敗：${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    else try { res.end(); } catch { /* ignore */ }
  }
}

// ── 給 dashboard 判斷後台權限用 ─────────────────────────────────────────────

/** 是否已建立任何網頁帳號 */
export function hasWebUsers(): boolean {
  return Object.keys(loadUsers()).length > 0;
}

/** 這個請求是否帶著網頁版管理員（platform-owner／admin）的登入 cookie */
export async function isWebAdminRequest(req: IncomingMessage): Promise<boolean> {
  const viewer = await currentViewer(req);
  return !!viewer && ADMIN_ROLES.has(viewer.role);
}
