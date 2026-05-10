/**
 * @file tools/builtin/vision-file.ts
 * @description vision_file — 對本地圖片做一次 vision LLM 分析（OCR、描述、結構化抽取等）
 *
 * 通用工具：path + prompt → vision-capable LLM → 文字（或 JSON）
 * 不負責下載、編輯、嵌字；不走 Discord 中轉。
 */

import { promises as fs } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Tool, ToolContext } from "../types.js";
import type { Message, ImageBlock, TextBlock } from "../../providers/base.js";
import { getProviderRegistry } from "../../providers/registry.js";
import { log } from "../../logger.js";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;  // 10 MB
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

type SupportedMime = "image/png" | "image/jpeg" | "image/webp";

/** Magic bytes 偵測 MIME；回 null 代表不支援的格式。 */
function detectMime(buf: Buffer): SupportedMime | null {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
    return "image/jpeg";
  }
  if (buf.length >= 12 &&
      buf.toString("ascii", 0, 4) === "RIFF" &&
      buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

export const tool: Tool = {
  name: "vision_file",
  description: `對本地圖片做一次 vision LLM 分析。
讀取本機圖片路徑（PNG / JPEG / WEBP，≤10MB）、傳給 vision-capable 模型解析。
通用工具，prompt 自由：OCR、描述、結構化抽取、UI 截圖診斷皆可。
不負責下載、不走 Discord 中轉、不綁定特定業務。`,
  resultTokenCap: 4000,
  timeoutMs: 0,  // 自管 timeout
  tier: "standard",
  deferred: true,
  parameters: {
    type: "object",
    properties: {
      path:           { type: "string",  description: "本地圖片絕對路徑（PNG / JPEG / WEBP）" },
      prompt:         { type: "string",  description: "給 vision 模型的任務指令" },
      system:         { type: "string",  description: "額外 system prompt" },
      maxTokens:      { type: "number",  description: `回應上限 token（預設 ${DEFAULT_MAX_TOKENS}）` },
      responseFormat: { type: "string",  description: "text（預設）或 json，json 時做 best-effort parse", enum: ["text", "json"] },
      timeoutMs:      { type: "number",  description: `逾時毫秒（預設 ${DEFAULT_TIMEOUT_MS}）` },
    },
    required: ["path", "prompt"],
  },

  async execute(params, _ctx: ToolContext) {
    const rawPath  = String(params["path"] ?? "").trim();
    const prompt   = String(params["prompt"] ?? "").trim();
    if (!rawPath) return { error: "path 不能為空" };
    if (!prompt)  return { error: "prompt 不能為空" };

    const systemPrompt = params["system"] ? String(params["system"]) : undefined;
    const maxTokens    = typeof params["maxTokens"] === "number"   ? params["maxTokens"]   : DEFAULT_MAX_TOKENS;
    const responseFmt  = params["responseFormat"] === "json" ? "json" : "text";
    const timeoutMs    = typeof params["timeoutMs"] === "number"   ? params["timeoutMs"]   : DEFAULT_TIMEOUT_MS;

    // ── 解析路徑、檢查檔案 ──
    let realPath: string;
    try {
      realPath = await fs.realpath(pathResolve(rawPath));
    } catch {
      return { error: `FILE_NOT_FOUND: ${rawPath}` };
    }
    let stat;
    try {
      stat = await fs.stat(realPath);
    } catch {
      return { error: `FILE_NOT_FOUND: ${realPath}` };
    }
    if (!stat.isFile()) {
      return { error: `FILE_NOT_FOUND: 非一般檔案 ${realPath}` };
    }
    if (stat.size > DEFAULT_MAX_BYTES) {
      return { error: `FILE_TOO_LARGE: ${stat.size} bytes（上限 ${DEFAULT_MAX_BYTES}）` };
    }

    // ── 讀檔、偵測 MIME ──
    let buf: Buffer;
    try {
      buf = await fs.readFile(realPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `IMAGE_READ_FAILED: ${msg}` };
    }
    const mimeType = detectMime(buf);
    if (!mimeType) {
      return { error: `UNSUPPORTED_IMAGE_TYPE: 僅支援 PNG / JPEG / WEBP（${realPath}）` };
    }
    const base64 = buf.toString("base64");

    // ── 取 provider（一律用 registry default，不開放工具參數指定，避免 LLM 亂帶 alias 燒 token）──
    const registry = getProviderRegistry();
    if (!registry) return { error: "ProviderRegistry 尚未初始化" };
    let provider;
    try {
      provider = registry.resolve();
    } catch {
      return { error: "找不到 provider" };
    }

    // ── 組 messages ──
    const imageBlock: ImageBlock = { type: "image", data: base64, mimeType };
    const textBlock:  TextBlock  = { type: "text",  text: prompt };
    const messages: Message[] = [{ role: "user", content: [imageBlock, textBlock] }];

    const finalSystem = responseFmt === "json"
      ? `${systemPrompt ? systemPrompt + "\n\n" : ""}請只輸出符合任務描述的 JSON，不加任何說明、markdown、code fence。`
      : systemPrompt;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log.debug(`[vision-file] provider=${provider.id} path=${realPath} mime=${mimeType} bytes=${buf.length}`);

      const result = await provider.stream(messages, {
        ...(finalSystem ? { systemPrompt: finalSystem } : {}),
        abortSignal: controller.signal,
        maxTokens,
      });

      let text = "";
      for await (const evt of result.events as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === "text_delta" && evt.text) text += evt.text;
      }

      const out: Record<string, unknown> = {
        text,
        model: provider.id,
        mimeType,
        path: realPath,
        usage: {
          inputTokens:  result.usage.input,
          outputTokens: result.usage.output,
        },
      };

      if (responseFmt === "json") {
        const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
        try {
          out["json"] = JSON.parse(cleaned);
        } catch {
          // best-effort：保留 text，json 為 null + 警示
          out["json"] = null;
          out["jsonParseError"] = `JSON_PARSE_FAILED: ${cleaned.slice(0, 200)}`;
        }
      }

      log.debug(`[vision-file] 完成 provider=${provider.id} text=${text.length}字`);
      return { result: out };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "aborted" || controller.signal.aborted) {
        return { error: "LLM_CALL_FAILED: vision_file timeout" };
      }
      return { error: `LLM_CALL_FAILED: ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  },
};
