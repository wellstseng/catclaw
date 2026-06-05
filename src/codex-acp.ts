/**
 * @file codex-acp.ts
 * @description Codex CLI 串流對話實作（對稱 acp.ts，但走 codex app-server JSON-RPC）
 *
 * 與 acp.ts 對比：
 * - acp.ts 跑 `claude -p --output-format stream-json`，stdout 直接 NDJSON
 * - codex-acp.ts 跑 `codex app-server`，stdio 用 JSON-RPC 2.0 雙向協議
 *
 * Flow（每次一個獨立 codex CLI subprocess）：
 *   1. spawn `codex app-server`
 *   2. send `initialize` request → wait response → send `initialized` notify
 *   3. send `thread/start`（首次）或 `thread/resume`（有 sessionId） → 得 threadId
 *   4. send `turn/start` with input=[{type:"text", text}]
 *   5. listen notifications：
 *        item/agentMessage/delta  → text_delta
 *        item/reasoning/textDelta → thinking_delta
 *        item/started (tool 類)   → tool_call
 *        turn/completed           → done
 *        error                    → error
 *   6. 關 process
 *
 * 注意：CodexJsonRpcClient 在 src/cli-bridge/providers/codex.ts 是 internal 不 export，
 *      這裡寫個簡化版（不含 server-request handler，cron 場景不需要 approval flow）。
 */

import { spawn } from "node:child_process";
import { log } from "./logger.js";
import { resolveWorkspaceDir, resolveCodexBin, config } from "./core/config.js";
import type { AcpEvent } from "./acp.js";

// ── 簡化版 JSON-RPC 2.0 client（cron 場景單向 — 不處理 server request）─────

interface RpcOptions {
  onNotification: (method: string, params: Record<string, unknown>) => void;
}

class MinimalCodexRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: unknown) => void; reject: (e: unknown) => void }>();
  constructor(
    private stdin: NodeJS.WritableStream,
    private opts: RpcOptions,
  ) {}

  request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  handleIncoming(obj: Record<string, unknown>): void {
    const id = obj["id"] as number | string | undefined;
    const method = obj["method"] as string | undefined;

    // Response to our request
    if (id != null && (obj["result"] !== undefined || obj["error"] !== undefined)) {
      const numId = typeof id === "number" ? id : Number(id);
      const p = this.pending.get(numId);
      if (p) {
        this.pending.delete(numId);
        if (obj["error"] !== undefined) p.reject(obj["error"]);
        else p.resolve(obj["result"]);
      }
      return;
    }

    // Server request — 我們在 cron 場景下「全部拒絕」（沒有 approval flow）
    if (method && id != null) {
      this.stdin.write(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "codex-acp: server request 不支援（cron 場景無 approval flow）" },
      }) + "\n");
      return;
    }

    // Server notification
    if (method) {
      this.opts.onNotification(method, (obj["params"] ?? {}) as Record<string, unknown>);
      return;
    }
  }

  rejectAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      try { p.reject(new Error(reason)); } catch { /* ignore */ }
    }
    this.pending.clear();
  }
}

// ── 主 API ──────────────────────────────────────────────────────────────────

/**
 * 執行一輪 Codex 對話，以 AsyncGenerator 串流 AcpEvent（與 runClaudeTurn 對稱）。
 *
 * @param sessionId codex thread id（首次為 null，每次獨立 thread）
 * @param text 使用者輸入文字
 * @param channelId Discord channel ID（傳給 codex 做為 CATCLAW_BRIDGE_CHANNEL_ID env）
 * @param signal AbortSignal，用於取消進行中的 turn
 */
export async function* runCodexTurn(
  sessionId: string | null,
  text: string,
  channelId: string,
  signal?: AbortSignal,
): AsyncGenerator<AcpEvent> {
  const cwd = resolveWorkspaceDir();
  const codexCmd = resolveCodexBin();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CATCLAW_BRIDGE_CHANNEL_ID: channelId,
  };
  if (config.discord.token) env.DISCORD_TOKEN = config.discord.token;

  log.debug(`[codex-acp] spawn: ${codexCmd} app-server`);

  const proc = spawn(codexCmd, ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env,
    windowsHide: true,
    detached: process.platform !== "win32",
  });

  if (!proc.stdin || !proc.stdout) {
    yield { type: "error", message: "codex process stdin/stdout 不可用" };
    return;
  }

  const killProc = (sig: NodeJS.Signals) => {
    try {
      if (proc.pid) process.kill(-proc.pid, sig);
    } catch {
      proc.kill(sig);
    }
  };
  const abortHandler = () => {
    killProc("SIGTERM");
    setTimeout(() => { if (!proc.killed) killProc("SIGKILL"); }, 250);
  };
  signal?.addEventListener("abort", abortHandler, { once: true });

  // ── Event queue ──
  const eventQueue: Array<AcpEvent | null> = [];
  let resolveNext: (() => void) | null = null;
  const push = (event: AcpEvent | null) => {
    eventQueue.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  // ── RPC client ──
  let sawAgentMessage = false;
  const rpc = new MinimalCodexRpc(proc.stdin, {
    onNotification: (method, params) => {
      switch (method) {
        case "item/agentMessage/delta": {
          const delta = params["delta"] as string | undefined;
          if (delta) push({ type: "text_delta", text: delta });
          return;
        }
        case "item/reasoning/textDelta":
        case "item/reasoning/summaryTextDelta": {
          const delta = params["delta"] as string | undefined;
          if (delta) push({ type: "thinking_delta", text: delta });
          return;
        }
        case "item/started": {
          const item = params["item"] as { type?: string; name?: string; tool?: string } | undefined;
          if (!item) return;
          // agentMessage 邊界處理：多段 agentMessage 中間插段落
          if (item.type === "agentMessage") {
            if (sawAgentMessage) push({ type: "text_delta", text: "\n\n" });
            sawAgentMessage = true;
            return;
          }
          // tool 類 item 視為 tool_call
          const title = item.tool ?? item.name ?? item.type ?? "tool";
          if (item.type && /Tool|Call|Exec|Search|FileChange/i.test(item.type)) {
            push({ type: "tool_call", title });
          }
          return;
        }
        case "turn/completed": {
          const turn = params["turn"] as { status?: string; error?: { message?: string } } | undefined;
          if (turn?.status === "failed") {
            push({ type: "error", message: turn?.error?.message ?? "codex turn failed" });
          } else {
            push({ type: "done" });
          }
          return;
        }
        case "error": {
          const errObj = params["error"] as { message?: string } | undefined;
          const willRetry = !!params["willRetry"];
          if (!willRetry) {
            push({ type: "error", message: errObj?.message ?? "codex unknown error" });
          }
          return;
        }
      }
    },
  });

  // ── stdout 解析 ──
  let buffer = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as Record<string, unknown>;
        rpc.handleIncoming(obj);
      } catch {
        // 非 JSON 行（log 等），忽略
      }
    }
  });

  // ── stderr / close ──
  let stderr = "";
  proc.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
  proc.on("close", (code) => {
    rpc.rejectAllPending(`codex process closed (exit ${code})`);
    if (code !== 0 && eventQueue.length === 0) {
      push({ type: "error", message: `codex 異常退出（exit ${code}）${stderr ? `：${stderr.slice(-100)}` : ""}` });
    }
    push(null); // 結束信號
  });
  proc.on("error", (err) => {
    push({ type: "error", message: `codex spawn 失敗：${err.message}` });
    push(null);
  });

  // ── handshake → thread → turn ──
  void (async () => {
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "catclaw-codex-acp", version: "1.0.0" },
        protocolVersion: "1.0",
      });
      rpc.notify("initialized");

      let threadId: string;
      if (sessionId) {
        try {
          const r = await rpc.request<{ thread?: { id: string } }>("thread/resume", { threadId: sessionId });
          threadId = r?.thread?.id ?? sessionId;
        } catch {
          const r = await rpc.request<{ thread: { id: string } }>("thread/start", {});
          threadId = r.thread.id;
        }
      } else {
        const r = await rpc.request<{ thread: { id: string } }>("thread/start", {});
        threadId = r.thread.id;
      }
      push({ type: "session_init", sessionId: threadId });

      await rpc.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      });
      // turn/completed 由 notification 觸發 push done，這裡不額外推
    } catch (err) {
      push({ type: "error", message: `codex turn 失敗：${err instanceof Error ? err.message : String(err)}` });
      push(null);
    }
  })();

  // ── yield event loop ──
  try {
    while (true) {
      while (eventQueue.length === 0) {
        await new Promise<void>(r => { resolveNext = r; });
      }
      const ev = eventQueue.shift();
      if (ev === null) break; // close 信號
      if (ev !== undefined) {
        yield ev;
        if (ev.type === "done" || ev.type === "error") break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    if (!proc.killed) {
      killProc("SIGTERM");
      setTimeout(() => { if (!proc.killed) killProc("SIGKILL"); }, 250);
    }
  }
}
