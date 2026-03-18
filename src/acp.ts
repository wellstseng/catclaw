/**
 * @file acp.ts
 * @description ACP protocol 實作（直接 spawn acpx，不依賴 OpenClaw）
 *
 * 提供兩個核心函式：
 * - ensureAcpSession：確保 ACP session 存在（首次建立或已存在均可）
 * - runAcpTurn：執行一輪對話，以 AsyncGenerator 串流 AcpEvent
 *
 * ACP CLI 指令格式參考自 openclaw/extensions/acpx/src/runtime.ts。
 */

import { spawn } from "node:child_process";

// ── 型別定義 ────────────────────────────────────────────────────────────────

/** ACP event 類型聯集 */
export type AcpEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; title: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "status"; raw: unknown };

// ── 工具函式 ────────────────────────────────────────────────────────────────

/**
 * 解析單行 JSON 字串為 AcpEvent
 * 無法識別的格式 → 回傳 status event（靜默忽略）
 * @param line 單行 JSON 字串
 */
function parseLine(line: string): AcpEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // 非 JSON 行（例如 acpx 的 debug log）直接略過
    return null;
  }

  const type = obj["type"] as string | undefined;

  if (type === "text_delta") {
    return { type: "text_delta", text: (obj["text"] as string) ?? "" };
  }
  if (type === "tool_call" || type === "tool_use") {
    // NOTE: tool title 欄位名稱在不同版本 acpx 可能不同，保守做法兩個都試
    const title =
      (obj["title"] as string) ??
      (obj["name"] as string) ??
      "unknown tool";
    return { type: "tool_call", title };
  }
  if (type === "done" || type === "result") {
    return { type: "done" };
  }
  if (type === "error") {
    return { type: "error", message: (obj["message"] as string) ?? String(obj) };
  }

  return { type: "status", raw: obj };
}

// ── 主要 API ────────────────────────────────────────────────────────────────

/**
 * 確保指定名稱的 ACP session 存在
 * 若 session 不存在則建立；已存在則直接返回
 * @param sessionName session 名稱（通常是 channelId）
 * @param cwd Claude session 工作目錄
 * @param acpxCmd acpx binary 路徑
 * @throws 若 acpx 執行失敗或輸出中找不到 session ID
 */
export async function ensureAcpSession(
  sessionName: string,
  cwd: string,
  acpxCmd: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "--format", "json",
      "--json-strict",
      "--cwd", cwd,
      "sessions", "ensure",
      "--name", sessionName,
    ];

    const proc = spawn(acpxCmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `acpx sessions ensure 失敗（exit ${code}）: ${stderr.trim()}`
          )
        );
        return;
      }

      // 驗證輸出中有 session 相關欄位，確認 session 確實建立成功
      const lines = stdout.split("\n");
      const hasSession = lines.some((line) => {
        try {
          const obj = JSON.parse(line.trim()) as Record<string, unknown>;
          return (
            "agentSessionId" in obj ||
            "acpxSessionId" in obj ||
            "sessionId" in obj ||
            obj["type"] === "session"
          );
        } catch {
          return false;
        }
      });

      if (!hasSession) {
        // NOTE: 部分版本 acpx 在 session 已存在時僅輸出 {"type":"ok"}，視為成功
        const hasOk = lines.some((line) => {
          try {
            const obj = JSON.parse(line.trim()) as Record<string, unknown>;
            return obj["type"] === "ok" || obj["status"] === "ok";
          } catch {
            return false;
          }
        });
        if (!hasOk && stdout.trim() === "") {
          reject(
            new Error(
              `acpx sessions ensure 輸出無法識別 session，stdout: ${stdout.trim()}`
            )
          );
          return;
        }
      }

      resolve();
    });

    proc.on("error", (err) => {
      reject(new Error(`無法啟動 acpx：${err.message}`));
    });
  });
}

/**
 * 執行一輪 ACP 對話，以 AsyncGenerator 串流 AcpEvent
 * @param sessionName session 名稱
 * @param text 使用者輸入文字
 * @param cwd Claude session 工作目錄
 * @param acpxCmd acpx binary 路徑
 * @param signal AbortSignal，用於取消進行中的 turn
 * @yields AcpEvent（text_delta / tool_call / done / error / status）
 */
export async function* runAcpTurn(
  sessionName: string,
  text: string,
  cwd: string,
  acpxCmd: string,
  signal?: AbortSignal
): AsyncGenerator<AcpEvent> {
  const args = [
    "--format", "json",
    "--json-strict",
    "--cwd", cwd,
    "--approve-all",
    "prompt",
    "--session", sessionName,
    "--file", "-",
  ];

  const proc = spawn(acpxCmd, args, { stdio: ["pipe", "pipe", "pipe"] });

  // 發送 prompt 並關閉 stdin，觸發 acpx 開始處理
  proc.stdin.write(text, "utf8");
  proc.stdin.end();

  // 處理 AbortSignal：先送 cancel 指令，再 SIGTERM，250ms 後 SIGKILL
  const abortHandler = () => {
    const cancelArgs = [
      "--format", "json",
      "--json-strict",
      "--cwd", cwd,
      "cancel",
      "--session", sessionName,
    ];
    // 非同步發送 cancel，不等待結果
    const cancelProc = spawn(acpxCmd, cancelArgs, { stdio: "ignore" });
    cancelProc.on("error", () => {/* 靜默忽略 cancel 指令的錯誤 */});

    // NOTE: SIGTERM → 250ms → SIGKILL，給 acpx 機會優雅關閉
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 250);
  };

  signal?.addEventListener("abort", abortHandler, { once: true });

  // 用 Promise 收集 events，讓 generator 可以 yield
  const eventQueue: Array<AcpEvent | null> = []; // null 代表結束
  let resolveNext: (() => void) | null = null;

  const push = (event: AcpEvent | null) => {
    eventQueue.push(event);
    resolveNext?.();
    resolveNext = null;
  };

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    // 按換行切割，逐行解析
    const lines = buffer.split("\n");
    // 最後一個可能是不完整行，保留在 buffer
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseLine(line);
      if (event) push(event);
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    // stderr 通常是 acpx 的 debug/warning log，不轉成 event，僅靜默忽略
    // 若需要 debug 可在此 console.error
    void chunk;
  });

  proc.on("close", (code) => {
    // 沖出 buffer 中殘留的最後一行（若 acpx 未以換行結尾）
    if (buffer.trim()) {
      const event = parseLine(buffer);
      if (event) push(event);
    }

    // 若 process 非正常結束（非 abort）且沒有收到 done event，補一個 error event
    if (code !== 0 && !signal?.aborted) {
      push({ type: "error", message: `acpx 異常退出（exit ${code}）` });
    }

    // 結束信號
    push(null);
    signal?.removeEventListener("abort", abortHandler);
  });

  proc.on("error", (err) => {
    push({ type: "error", message: `無法啟動 acpx：${err.message}` });
    push(null);
    signal?.removeEventListener("abort", abortHandler);
  });

  // Generator 主迴圈：等待 eventQueue 有資料再 yield
  while (true) {
    if (eventQueue.length === 0) {
      // 等待下一筆資料
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }

    const event = eventQueue.shift();
    if (event === null) break; // 結束信號
    if (event === undefined) continue;

    yield event;

    // 收到 done 後不再等待後續 event
    if (event.type === "done") break;
  }
}
