/**
 * @file providers/codex-oauth.ts
 * @description OpenAI Codex OAuth Provider
 *
 * 使用 OpenAI Responses API（/v1/responses），與舊版 /v1/chat/completions 不同。
 * OpenClaw 原始碼確認：推論端點為 https://api.openai.com/v1/responses（WS 或 HTTP SSE）
 *
 * 認證流程：
 * 1. 讀取 ~/.codex/auth.json（或 oauthTokenPath 自訂路徑）
 * 2. 檢查 expires_at → 過期時發 HTTP refresh 請求
 * 3. 更新 auth.json + 用 access_token 作 Bearer header
 *
 * auth.json 格式（OpenAI OAuth 標準格式）：
 * {
 *   "access_token": "...",
 *   "refresh_token": "...",
 *   "expires_at": 1234567890,   // epoch seconds
 *   "token_type": "Bearer"
 * }
 */

import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent, ToolCall,
} from "./base.js";
import type { ProviderEntry } from "../core/config.js";
import type { AuthProfileStore, CooldownReason } from "./auth-profile-store.js";

// ── OAuth token JSON 格式 ─────────────────────────────────────────────────────
//
// Codex CLI 在 2025 改成 nested 格式：
//   { "auth_mode": "chatgpt",
//     "tokens": { "access_token", "refresh_token", "id_token", "account_id" },
//     "last_refresh": ISO timestamp }
// 沒有 expires_at — exp 要從 access_token 這個 JWT 的 payload.exp 解出來。
//
// 舊版 catclaw 寫的 flat 格式（refresh 寫回時用）仍然支援作為 fallback。

interface CodexAuthJsonFlat {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;    // epoch seconds
  token_type?: string;
}

interface CodexAuthJsonNested {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;  // ISO timestamp
}

type CodexAuthJson = CodexAuthJsonFlat | CodexAuthJsonNested;

interface ExtractedTokens {
  access_token: string | undefined;
  refresh_token: string | undefined;
  expires_at_ms: number;  // 0 = 不知道
}

/**
 * 把 refresh 後的新 token 寫回 auth.json，保留原本格式：
 * - 原本是 nested（Codex CLI 標準）→ 更新 tokens.access_token / refresh_token + last_refresh
 * - 原本是 flat（catclaw 舊版自己寫的）→ 沿用 flat 結構
 * - 從未存在 / 解析失敗 → 預設 nested
 */
function mergeAuthJson(original: CodexAuthJson, fresh: CodexAuthJsonFlat): CodexAuthJson {
  const nested = original as CodexAuthJsonNested;
  const isNested = !!nested.tokens || !!nested.auth_mode;
  if (isNested) {
    return {
      ...nested,
      tokens: {
        ...(nested.tokens ?? {}),
        access_token: fresh.access_token,
        refresh_token: fresh.refresh_token ?? nested.tokens?.refresh_token,
      },
      last_refresh: new Date().toISOString(),
    };
  }
  return fresh;
}

/** 從 flat 或 nested auth.json 抽出 token 與過期時間（exp 來自 JWT 解析） */
function extractCodexTokens(auth: CodexAuthJson): ExtractedTokens {
  const flat = auth as CodexAuthJsonFlat;
  const nested = auth as CodexAuthJsonNested;
  // Nested 有 tokens 子物件 → 用它；否則用 flat 頂層欄位
  const access = nested.tokens?.access_token ?? flat.access_token;
  const refresh = nested.tokens?.refresh_token ?? flat.refresh_token;
  // exp：先看 flat.expires_at（舊格式），不然解 JWT payload.exp（nested 格式必走這條）
  let expMs = 0;
  if (typeof flat.expires_at === "number") {
    expMs = flat.expires_at * 1000;
  } else if (access) {
    try {
      const payload = access.split(".")[1];
      if (payload) {
        const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
        const decoded = JSON.parse(Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8")) as { exp?: number };
        if (typeof decoded.exp === "number") expMs = decoded.exp * 1000;
      }
    } catch { /* JWT 解析失敗 → expMs 留 0，讓上層當作過期觸發 refresh */ }
  }
  return { access_token: access, refresh_token: refresh, expires_at_ms: expMs };
}

// ── Responses API 型別 ────────────────────────────────────────────────────────

interface ResponsesInputItem {
  role?: "user" | "assistant";
  type?: string;
  content?: ResponsesContentBlock[];
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesContentBlock {
  type: "input_text" | "output_text";
  text: string;
}

interface ResponsesChunk {
  type: string;
  delta?: string;
  /** 頂層 item_id（delta 事件用，對應 item.id） */
  item_id?: string;
  item?: {
    id?: string;
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  response?: {
    status?: string;
    error?: { message?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
}

// ── 預設值 ────────────────────────────────────────────────────────────────────

const DEFAULT_TOKEN_PATH = "~/.codex/auth.json";
const DEFAULT_REFRESH_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const DEFAULT_MODEL = "openai-codex/gpt-5.4";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// token 提前 5 分鐘刷新
const REFRESH_BUFFER_MS = 5 * 60_000;

// ── CodexOAuthProvider ────────────────────────────────────────────────────────

export class CodexOAuthProvider implements LLMProvider {
  readonly id: string;
  readonly name = "Codex OAuth";
  readonly supportsToolUse = true;
  readonly maxContextTokens = 128_000;

  private baseUrl: string;
  readonly modelId: string;
  private tokenPath: string;
  private refreshUrl: string;
  private clientId?: string;
  private authStore?: AuthProfileStore;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;  // epoch ms
  // 追蹤 auth.json mtime，避免外部進程（Codex CLI 也用同一份 auth.json）refresh 後
  // catclaw 還用 cached 舊 token → 401。每次發請求前比對 mtime，有變動就重讀。
  private cachedFileMtime = 0;

  constructor(id: string, entry: ProviderEntry, authStore?: AuthProfileStore) {
    this.id = id;
    this.baseUrl = (entry.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.modelId = entry.model ?? DEFAULT_MODEL;

    const rawPath = (entry as unknown as Record<string, unknown>)["oauthTokenPath"] as string | undefined
      ?? DEFAULT_TOKEN_PATH;
    this.tokenPath = rawPath.startsWith("~") ? rawPath.replace("~", homedir()) : resolve(rawPath);

    this.refreshUrl = (entry as unknown as Record<string, unknown>)["oauthRefreshUrl"] as string | undefined
      ?? DEFAULT_REFRESH_URL;

    this.clientId = (entry as unknown as Record<string, unknown>)["oauthClientId"] as string | undefined;
    this.authStore = authStore;
  }

  // ── Token 取得（含自動刷新） ───────────────────────────────────────────────

  async getAccessToken(): Promise<string> {
    const now = Date.now();

    // 仍有效 → 還要確認 auth.json 沒被外部進程改寫
    // 沒這層檢查時，Codex CLI（也用同一個 ~/.codex/auth.json）refresh 後，
    // catclaw 仍用記憶體裡的舊 token → 401 → 看起來像「過期」
    if (this.cachedToken && now < this.tokenExpiresAt - REFRESH_BUFFER_MS) {
      try {
        const stat = statSync(this.tokenPath);
        if (stat.mtimeMs === this.cachedFileMtime) {
          return this.cachedToken;
        }
        log.info(`[codex-oauth] auth.json 被外部進程更新（mtime ${this.cachedFileMtime} → ${stat.mtimeMs}），重讀 token`);
      } catch { /* stat 失敗 → 走下面 re-read */ }
    }

    // 讀取 auth.json
    if (!existsSync(this.tokenPath)) {
      throw new Error(
        `[codex-oauth] auth.json 不存在：${this.tokenPath}\n` +
        `請先安裝 Codex CLI 並執行 codex auth login`
      );
    }

    let auth: CodexAuthJson;
    let fileMtime = 0;
    try {
      auth = JSON.parse(readFileSync(this.tokenPath, "utf-8")) as CodexAuthJson;
      fileMtime = statSync(this.tokenPath).mtimeMs;
    } catch (err) {
      throw new Error(`[codex-oauth] 解析 auth.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    // 抽出 token（自動處理 flat / nested 兩種格式 + JWT exp 解析）
    const extracted = extractCodexTokens(auth);

    // 尚未過期 → 直接用
    if (extracted.access_token && now < extracted.expires_at_ms - REFRESH_BUFFER_MS) {
      this.cachedToken = extracted.access_token;
      this.tokenExpiresAt = extracted.expires_at_ms;
      this.cachedFileMtime = fileMtime;
      return extracted.access_token;
    }

    // 需要刷新
    if (!extracted.refresh_token) {
      throw new Error(`[codex-oauth] token 已過期且無 refresh_token，請重新執行 codex auth login`);
    }

    log.info(`[codex-oauth] token 過期，刷新中...`);
    const refreshed = await this._refresh(extracted.refresh_token);

    // 寫回 auth.json：保留原本檔案結構（auth_mode / last_refresh 等），只更新 tokens 子物件
    // 不能直接 JSON.stringify(refreshed) 蓋掉，那會把 Codex CLI 用的 nested 格式破壞掉
    try {
      const merged = mergeAuthJson(auth, refreshed);
      writeFileSync(this.tokenPath, JSON.stringify(merged, null, 2), "utf-8");
      this.cachedFileMtime = statSync(this.tokenPath).mtimeMs;
    } catch (err) {
      log.warn(`[codex-oauth] 寫回 auth.json 失敗：${err instanceof Error ? err.message : String(err)}`);
    }

    this.cachedToken = refreshed.access_token;
    this.tokenExpiresAt = (refreshed.expires_at ?? 0) * 1000;
    return refreshed.access_token;
  }

  /** 強制丟棄記憶體 cache，下次 getAccessToken 會重讀 auth.json（用於 401 回應後重試） */
  invalidateCache(): void {
    this.cachedToken = null;
    this.tokenExpiresAt = 0;
    this.cachedFileMtime = 0;
  }

  private async _refresh(refreshToken: string): Promise<CodexAuthJsonFlat> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.clientId ?? CODEX_CLIENT_ID,
    });

    const resp = await fetch(this.refreshUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`[codex-oauth] refresh 失敗 HTTP ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as Record<string, unknown>;

    const expiresIn = (data["expires_in"] as number | undefined) ?? 3600;
    return {
      access_token: data["access_token"] as string,
      refresh_token: (data["refresh_token"] as string | undefined) ?? refreshToken,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_type: (data["token_type"] as string | undefined) ?? "Bearer",
    };
  }

  // ── 主要串流方法（使用 Codex Responses API）─────────────────────────────

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    // auth-profile-store: 更新 lastUsed（Codex OAuth 用 pickForProvider 記錄使用時間）
    const pick = this.authStore?.pickForProvider("openai-codex");
    const activeProfileId = pick?.profileId;

    let token = await this.getAccessToken();
    let accountId = extractAccountId(token);
    let triedRefresh = false;
    const controller = new AbortController();
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => controller.abort());
    }

    // 轉換 Anthropic 格式 → Responses API input 格式
    const input = convertToResponsesInput(messages);

    const body: Record<string, unknown> = {
      model: this.modelId,
      input,
      store: false,
      stream: true,
      text: { verbosity: "medium" },
      include: ["reasoning.encrypted_content"],
      tool_choice: "auto",
      parallel_tool_calls: true,
    };

    if (opts.systemPrompt) body["instructions"] = opts.systemPrompt;

    // tool_use 支援
    if (opts.tools?.length) {
      body["tools"] = opts.tools.map(t => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
        strict: null,
      }));
    }

    if (opts.maxTokens) body["max_output_tokens"] = opts.maxTokens;

    // Codex 端點：{baseUrl}/codex/responses
    const codexUrl = resolveCodexUrl(this.baseUrl);
    log.debug(`[codex-oauth:${this.id}] POST ${codexUrl} model=${this.modelId} msgs=${messages.length}`);

    // 401 retry：Codex CLI（共用 auth.json）剛好在我們發送的瞬間 refresh 過 → server 認新 token
    // → 我們手上的舊 token 直接被吊銷 → 401。這時丟掉 cache 重讀檔再試一次。
    let response: Response;
    while (true) {
      response = await fetch(codexUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
          "Authorization": `Bearer ${token}`,
          "chatgpt-account-id": accountId,
          "OpenAI-Beta": "responses=experimental",
          "originator": "pi",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 401 && !triedRefresh) {
        triedRefresh = true;
        log.warn(`[codex-oauth:${this.id}] 401 偵測：可能 Codex CLI 已 refresh 過 auth.json，丟 cache 重讀後重試`);
        this.invalidateCache();
        token = await this.getAccessToken();
        accountId = extractAccountId(token);
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      // auth-profile-store: 依 HTTP status 設定 cooldown
      if (activeProfileId && this.authStore) {
        const reason: CooldownReason | null =
          response.status === 401 || response.status === 403 ? "auth" :
          response.status === 429 ? "rate_limit" :
          response.status === 402 ? "billing" :
          response.status === 503 ? "overloaded" : null;
        if (reason) this.authStore.setCooldown(activeProfileId, reason);
      }
      throw new Error(`[codex-oauth:${this.id}] HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    if (!response.body) throw new Error(`[codex-oauth:${this.id}] 無 response body`);

    const events: ProviderEvent[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";
    const parsedUsage: { input: number; output: number; totalTokens: number }[] = [];
    const toolCalls: ToolCall[] = [];

    await parseResponsesApiStream(response.body, (chunk) => {
      const event = processResponsesChunk(chunk, toolCalls);
      if (event) {
        events.push(event);
        if (event.type === "text_delta") finalText += event.text;
        if (event.type === "done") {
          finalStopReason = event.stopReason;
          const u = (event as Extract<ProviderEvent, { type: "done" }>).usage;
          if (u) parsedUsage.push({ input: u.input, output: u.output, totalTokens: u.totalTokens });
        }
      }
    });

    if (toolCalls.length > 0) finalStopReason = "tool_use";

    async function* makeIterable(): AsyncIterable<ProviderEvent> {
      yield* events;
    }

    const apiUsage = parsedUsage[0];
    const estimated = !apiUsage;
    const inputTokens = apiUsage?.input ?? 0;
    const outputTokens = apiUsage?.output ?? Math.round(finalText.length / 4);
    const totalTokens = apiUsage?.totalTokens ?? (inputTokens + outputTokens);
    log.debug(`[codex-oauth:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字 input=${inputTokens} output=${outputTokens}${estimated ? "(est)" : ""}`);

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls,
      text: finalText,
      usage: { input: inputTokens, output: outputTokens, totalTokens, model: this.modelId, providerType: "codex-oauth", estimated },
    };
  }
}

// ── 格式轉換：Anthropic → Responses API input ─────────────────────────────────

function convertToResponsesInput(messages: Message[]): ResponsesInputItem[] {
  const result: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({
        role: msg.role === "user" ? "user" : "assistant",
        content: [{
          type: msg.role === "user" ? "input_text" : "output_text",
          text: msg.content,
        }],
      });
      continue;
    }

    for (const block of msg.content) {
      if (block.type === "text") {
        result.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: [{
            type: msg.role === "user" ? "input_text" : "output_text",
            text: block.text,
          }],
        });
      } else if (block.type === "tool_use") {
        result.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input),
        });
      } else if (block.type === "tool_result") {
        result.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
        });
      }
    }
  }

  return result;
}

// ── Responses API SSE 解析 ────────────────────────────────────────────────────

async function parseResponsesApiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (chunk: ResponsesChunk) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as ResponsesChunk;
          onChunk(chunk);
        } catch { /* 忽略非 JSON 行 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── ResponsesChunk → ProviderEvent ────────────────────────────────────────────

/** function call arguments 累積 buffer（call_id → 累積字串） */
const argBuffers = new Map<string, { name: string; args: string }>();
/** item.id → call_id 對照表（delta 事件只有頂層 item_id，需映射回 call_id） */
const itemIdToCallId = new Map<string, string>();

function processResponsesChunk(chunk: ResponsesChunk, toolCalls: ToolCall[]): ProviderEvent | null {
  switch (chunk.type) {
    // 文字 delta
    case "response.output_text.delta":
      return chunk.delta ? { type: "text_delta", text: chunk.delta } : null;

    // function call 開始（記錄 call_id + name，建立 item.id → call_id 映射）
    case "response.output_item.added":
      if (chunk.item?.type === "function_call" && chunk.item.call_id) {
        argBuffers.set(chunk.item.call_id, { name: chunk.item.name ?? "", args: "" });
        if (chunk.item.id) itemIdToCallId.set(chunk.item.id, chunk.item.call_id);
      }
      return null;

    // function call arguments delta（頂層 item_id 映射回 call_id）
    case "response.function_call_arguments.delta": {
      const callId = chunk.item?.call_id ?? (chunk.item_id ? itemIdToCallId.get(chunk.item_id) : undefined);
      if (callId) {
        const buf = argBuffers.get(callId);
        if (buf && chunk.delta) buf.args += chunk.delta;
      }
      return null;
    }

    // function call 完成（優先用累積的 args，空字串 fallback 到 item.arguments）
    case "response.output_item.done":
      if (chunk.item?.type === "function_call" && chunk.item.call_id) {
        const buf = argBuffers.get(chunk.item.call_id);
        const argsStr = (buf?.args || chunk.item.arguments) ?? "{}";
        let params: object = {};
        try { params = JSON.parse(argsStr) as object; } catch { /* 忽略 */ }
        toolCalls.push({ id: chunk.item.call_id, name: chunk.item.name ?? buf?.name ?? "", params });
        argBuffers.delete(chunk.item.call_id);
        if (chunk.item.id) itemIdToCallId.delete(chunk.item.id);
      }
      return null;

    // 完成（Codex 端點可能回 response.completed 或 response.done）
    case "response.completed":
    case "response.done": {
      argBuffers.clear();
      const status = chunk.response?.status;
      const sr = toolCalls.length > 0 ? "tool_use"
        : status === "incomplete" ? "max_tokens"
        : "end_turn";
      const u = chunk.response?.usage;
      const usage = u ? {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
      } : undefined;
      return { type: "done", stopReason: sr, text: "", usage };
    }

    // 截斷（incomplete 也可能單獨事件）
    case "response.incomplete":
      argBuffers.clear();
      return { type: "done", stopReason: "max_tokens", text: "" };

    // 失敗
    case "response.failed":
      throw new Error(`[codex-oauth] response.failed: ${chunk.response?.error?.message ?? "unknown"}`);

    default:
      return null;
  }
}

// ── Codex URL 解析（對齊 pi-ai）─────────────────────────────────────────────

function resolveCodexUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

// ── JWT accountId 擷取 ──────────────────────────────────────────────────────

function extractAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    const payload = JSON.parse(atob(parts[1]!));
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (!accountId) throw new Error("No chatgpt_account_id in JWT");
    return accountId as string;
  } catch (err) {
    throw new Error(`[codex-oauth] 無法從 token 擷取 accountId：${err instanceof Error ? err.message : String(err)}`);
  }
}
