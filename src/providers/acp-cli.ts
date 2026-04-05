/**
 * @file providers/acp-cli.ts
 * @description CLI Provider — 透過 AI Agent CLI（Claude / Gemini / Codex）spawn 做 LLM 推理
 *
 * 使用訂閱制額度（Max Plan / Gemini Pro 等），不走 API 計費。
 * 純推理模式（supportsToolUse = false），tool 任務應由 fallback chain 走 API provider。
 *
 * 支援的 CLI 後端：
 * - claude: `claude -p "prompt" --output-format stream-json --max-turns 1`
 * - gemini: `gemini -p "prompt" --output-format stream-json`
 * - codex:  `codex --quiet --full-auto "prompt"`（text 輸出，無 stream-json）
 *
 * 三者都支援 -p（non-interactive prompt）模式，Claude 和 Gemini 共用 stream-json 格式。
 */

import { spawn } from "node:child_process";
import { log } from "../logger.js";
import type {
  LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent,
  ProviderUsage, ContentBlock,
} from "./base.js";
import { resolveWorkspaceDir } from "../core/config.js";

// ── CLI 後端定義 ─────────────────────────────────────────────────────────────

export type CliBackend = "claude" | "gemini" | "codex";

interface CliBackendConfig {
  /** CLI 執行檔名（可由 CliProviderOpts.command 覆寫） */
  defaultCommand: string;
  /** 建構 spawn args */
  buildArgs(prompt: string): string[];
  /** 輸出格式 */
  outputFormat: "stream-json" | "text";
  /** context window 大小 */
  maxContextTokens: number;
}

const CLI_BACKENDS: Record<CliBackend, CliBackendConfig> = {
  claude: {
    defaultCommand: "claude",
    buildArgs: (prompt) => [
      "-p",
      "--output-format", "stream-json",
      "--max-turns", "1",
      "--verbose",
      prompt,
    ],
    outputFormat: "stream-json",
    maxContextTokens: 200_000,
  },
  gemini: {
    defaultCommand: "gemini",
    buildArgs: (prompt) => [
      "-p", prompt,
      "--output-format", "stream-json",
    ],
    outputFormat: "stream-json",
    maxContextTokens: 1_000_000,
  },
  codex: {
    defaultCommand: "codex",
    buildArgs: (prompt) => [
      "--quiet",
      "--full-auto",
      prompt,
    ],
    outputFormat: "text",
    maxContextTokens: 200_000,
  },
};

// ── 建構選項 ─────────────────────────────────────────────────────────────────

export interface CliProviderOpts {
  /** CLI 後端類型 */
  backend: CliBackend;
  /** 覆寫 CLI 執行檔路徑 */
  command?: string;
  /** 覆寫工作目錄（預設 resolveWorkspaceDir） */
  cwd?: string;
  /** 額外環境變數 */
  env?: Record<string, string>;
}

// ── Message[] → prompt 文字 ──────────────────────────────────────────────────

function formatMessagesAsPrompt(messages: Message[], systemPrompt?: string): string {
  const parts: string[] = [];

  if (systemPrompt) {
    parts.push(`<system>\n${systemPrompt}\n</system>\n`);
  }

  for (const msg of messages) {
    const role = msg.role === "user" ? "Human" : "Assistant";
    const text = typeof msg.content === "string"
      ? msg.content
      : flattenContentBlocks(msg.content);

    if (text.trim()) {
      parts.push(`${role}: ${text}`);
    }
  }

  return parts.join("\n\n");
}

function flattenContentBlocks(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":   parts.push(b.text); break;
      case "tool_use":    parts.push(`[Tool call: ${b.name}]`); break;
      case "tool_result": parts.push(`[Tool result: ${b.content}]`); break;
      case "image":       parts.push("[Image]"); break;
    }
  }
  return parts.join("\n");
}

// ── stream-json 解析型別 ─────────────────────────────────────────────────────

interface StreamContentBlock {
  type: string;
  text?: string;
  thinking?: string;
}

interface StreamAssistantMessage {
  id: string;
  content: StreamContentBlock[];
}

// ── CliProvider ──────────────────────────────────────────────────────────────

export class CliProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  readonly supportsToolUse = false;
  readonly maxContextTokens: number;
  readonly modelId: string;

  private backend: CliBackendConfig;
  private command: string;
  private cwdOverride?: string;
  private extraEnv?: Record<string, string>;
  private backendType: CliBackend;

  constructor(id: string, opts: CliProviderOpts) {
    this.backendType = opts.backend;
    this.backend = CLI_BACKENDS[opts.backend];
    this.id = id;
    this.name = `CLI:${opts.backend} (${id})`;
    this.modelId = `cli-${opts.backend}`;
    this.maxContextTokens = this.backend.maxContextTokens;
    this.command = opts.command ?? this.backend.defaultCommand;
    this.cwdOverride = opts.cwd;
    this.extraEnv = opts.env;
  }

  async stream(messages: Message[], opts: ProviderOpts = {}): Promise<StreamResult> {
    const cwd = this.cwdOverride ?? resolveWorkspaceDir();
    const prompt = formatMessagesAsPrompt(messages, opts.systemPrompt);
    const args = this.backend.buildArgs(prompt);

    log.debug(`[cli:${this.id}] spawn: ${this.command} backend=${this.backendType} msgs=${messages.length} prompt=${prompt.length}字`);

    const proc = spawn(this.command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, ...this.extraEnv },
      detached: process.platform !== "win32",
    });

    log.debug(`[cli:${this.id}] pid=${proc.pid}`);

    // AbortSignal
    const killProc = (sig: NodeJS.Signals) => {
      try { if (proc.pid) process.kill(-proc.pid, sig); }
      catch { proc.kill(sig); }
    };
    const abortHandler = () => {
      killProc("SIGTERM");
      setTimeout(() => { if (!proc.killed) killProc("SIGKILL"); }, 250);
    };
    opts.abortSignal?.addEventListener("abort", abortHandler, { once: true });

    const events: ProviderEvent[] = [];
    let finalText = "";
    let finalStopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn";

    if (this.backend.outputFormat === "stream-json") {
      await this.parseStreamJson(proc, events, opts, abortHandler, (text, sr) => {
        finalText = text;
        if (sr) finalStopReason = sr;
      });
    } else {
      await this.parsePlainText(proc, events, opts, abortHandler, (text) => {
        finalText = text;
      });
    }

    // done event
    events.push({ type: "done", stopReason: finalStopReason, text: finalText, usage: undefined });

    const estInput = Math.round(prompt.length / 4);
    const estOutput = Math.round(finalText.length / 4);
    const usage: ProviderUsage = {
      input: estInput, output: estOutput, totalTokens: estInput + estOutput,
      model: this.modelId, providerType: `cli-${this.backendType}`, estimated: true,
    };

    log.debug(`[cli:${this.id}] 完成 stopReason=${finalStopReason} text=${finalText.length}字 ~tokens=${usage.totalTokens}`);

    async function* makeIterable(): AsyncIterable<ProviderEvent> { yield* events; }

    return {
      events: makeIterable(),
      stopReason: finalStopReason,
      toolCalls: [],
      text: finalText,
      usage,
    };
  }

  // ── stream-json 解析（Claude / Gemini）─────────────────────────────────────

  private parseStreamJson(
    proc: ReturnType<typeof spawn>,
    events: ProviderEvent[],
    opts: ProviderOpts,
    abortHandler: () => void,
    onResult: (text: string, stopReason?: "end_turn" | "tool_use" | "max_tokens") => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let buffer = "";
      let stderrTail = "";
      let lastMessageId = "";
      let lastTextLength = 0;
      let lastThinkingLength = 0;
      let resultText = "";

      proc.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let obj: Record<string, unknown>;
          try { obj = JSON.parse(trimmed); } catch { continue; }

          const type = obj["type"] as string | undefined;

          if (type === "assistant") {
            const msg = obj["message"] as StreamAssistantMessage | undefined;
            if (!msg?.content) continue;

            if (msg.id !== lastMessageId) {
              lastMessageId = msg.id;
              lastTextLength = 0;
              lastThinkingLength = 0;
            }

            const fullThinking = msg.content
              .filter(b => b.type === "thinking")
              .map(b => b.thinking ?? "").join("");
            if (fullThinking.length > lastThinkingLength) {
              events.push({ type: "thinking_delta", thinking: fullThinking.slice(lastThinkingLength) });
              lastThinkingLength = fullThinking.length;
            }

            const fullText = msg.content
              .filter(b => b.type === "text")
              .map(b => b.text ?? "").join("");
            if (fullText.length > lastTextLength) {
              events.push({ type: "text_delta", text: fullText.slice(lastTextLength) });
              lastTextLength = fullText.length;
            }
            continue;
          }

          if (type === "result") {
            const rt = obj["result"] as string | undefined;
            if (obj["is_error"]) {
              events.push({ type: "error", message: rt ?? "CLI 回傳錯誤" });
            }
            if (rt) resultText = rt;
            const sr = obj["stop_reason"] as string | undefined;
            onResult(resultText, sr === "max_tokens" ? "max_tokens" : undefined);
            continue;
          }
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-500);
      });

      proc.on("close", (code) => {
        log.debug(`[cli:${this.id}] closed, code=${code}`);
        if (buffer.trim()) {
          try {
            const obj = JSON.parse(buffer.trim()) as Record<string, unknown>;
            if (obj["type"] === "result") {
              const rt = obj["result"] as string | undefined;
              if (rt) resultText = rt;
            }
          } catch { /* ignore */ }
        }

        opts.abortSignal?.removeEventListener("abort", abortHandler);

        if (opts.abortSignal?.aborted) {
          events.push({ type: "error", message: "回應逾時，已取消" });
        } else if (code !== 0 && code !== null) {
          events.push({ type: "error", message: `CLI 異常退出（exit ${code}）${stderrTail ? `：${stderrTail.slice(-100)}` : ""}` });
        }

        if (!resultText) {
          resultText = events
            .filter((e): e is { type: "text_delta"; text: string } => e.type === "text_delta")
            .map(e => e.text).join("");
        }
        onResult(resultText);
        resolve();
      });

      proc.on("error", (err) => {
        events.push({ type: "error", message: `無法啟動 ${this.command}：${err.message}` });
        opts.abortSignal?.removeEventListener("abort", abortHandler);
        onResult("");
        resolve();
      });
    });
  }

  // ── 純文字解析（Codex 等）──────────────────────────────────────────────────

  private parsePlainText(
    proc: ReturnType<typeof spawn>,
    events: ProviderEvent[],
    opts: ProviderOpts,
    abortHandler: () => void,
    onResult: (text: string) => void,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      let fullText = "";
      let stderrTail = "";

      proc.stdout!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        fullText += text;
        events.push({ type: "text_delta", text });
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-500);
      });

      proc.on("close", (code) => {
        log.debug(`[cli:${this.id}] closed, code=${code}`);
        opts.abortSignal?.removeEventListener("abort", abortHandler);

        if (opts.abortSignal?.aborted) {
          events.push({ type: "error", message: "回應逾時，已取消" });
        } else if (code !== 0 && code !== null) {
          events.push({ type: "error", message: `CLI 異常退出（exit ${code}）${stderrTail ? `：${stderrTail.slice(-100)}` : ""}` });
        }

        onResult(fullText);
        resolve();
      });

      proc.on("error", (err) => {
        events.push({ type: "error", message: `無法啟動 ${this.command}：${err.message}` });
        opts.abortSignal?.removeEventListener("abort", abortHandler);
        onResult("");
        resolve();
      });
    });
  }
}
