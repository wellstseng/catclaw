/**
 * @file tools/builtin/read-file.ts
 * @description read_file — 讀取檔案內容（elevated tier）
 */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import type { Tool } from "../types.js";

const MAX_FILE_SIZE = 200_000; // 200KB

// ── PDF 讀取（透過 python3 fallback）─────────────────────────────────────────

function readPdf(filePath: string, pages?: string): { text?: string; error?: string } {
  // 寫臨時 .py 檔案再執行，避免 shell escape 問題
  const pyScript = `
import sys, json
file_path = sys.argv[1]
pages_arg = sys.argv[2] if len(sys.argv) > 2 else ""

try:
    from PyPDF2 import PdfReader
    reader = PdfReader(file_path)
    if pages_arg:
        parts = pages_arg.split("-")
        start = int(parts[0]) - 1
        end = int(parts[-1]) if len(parts) > 1 else start + 1
    else:
        start, end = 0, len(reader.pages)
    text = ""
    for i in range(max(0, start), min(end, len(reader.pages))):
        text += f"--- Page {i+1} ---\\n" + reader.pages[i].extract_text() + "\\n"
    print(json.dumps({"text": text, "pages": len(reader.pages)}))
except ImportError:
    try:
        import fitz
        doc = fitz.open(file_path)
        if pages_arg:
            parts = pages_arg.split("-")
            start = int(parts[0]) - 1
            end = int(parts[-1]) if len(parts) > 1 else start + 1
        else:
            start, end = 0, len(doc)
        text = ""
        for i in range(max(0, start), min(end, len(doc))):
            text += f"--- Page {i+1} ---\\n" + doc[i].get_text() + "\\n"
        print(json.dumps({"text": text, "pages": len(doc)}))
    except ImportError:
        print(json.dumps({"error": "PDF 解析需要 PyPDF2 或 PyMuPDF。安裝：pip3 install PyPDF2"}))
except Exception as e:
    print(json.dumps({"error": str(e)[:500]}))
`;
  const tmpPy = join(tmpdir(), `catclaw-pdf-${Date.now()}.py`);
  try {
    writeFileSync(tmpPy, pyScript);
    const args = pages ? [filePath, pages] : [filePath];
    const result = execSync(
      `python3 ${JSON.stringify(tmpPy)} ${args.map(a => JSON.stringify(a)).join(" ")}`,
      { encoding: "utf-8", timeout: 30_000 },
    );
    return JSON.parse(result.trim());
  } catch {
    const stat = statSync(filePath);
    return { text: `[PDF 檔案] 大小：${stat.size} bytes。無法解析文字內容。\n提示：安裝 PyPDF2（pip3 install PyPDF2）可啟用 PDF 文字擷取。` };
  } finally {
    try { unlinkSync(tmpPy); } catch { /* ignore */ }
  }
}

// ── Jupyter Notebook 讀取 ───────────────────────────────────────────────────

function readNotebook(filePath: string): string {
  const raw = readFileSync(filePath, "utf-8");
  const nb = JSON.parse(raw) as {
    cells: Array<{
      cell_type: string;
      source: string[];
      outputs?: Array<{ text?: string[]; output_type: string; data?: Record<string, string[]> }>;
    }>;
  };

  const parts: string[] = [];
  for (let i = 0; i < nb.cells.length; i++) {
    const cell = nb.cells[i]!;
    const src = Array.isArray(cell.source) ? cell.source.join("") : String(cell.source);
    const tag = cell.cell_type === "code" ? "python" : "markdown";
    parts.push(`### Cell ${i + 1} [${cell.cell_type}]\n\`\`\`${tag}\n${src}\n\`\`\``);

    if (cell.cell_type === "code" && cell.outputs?.length) {
      const outTexts: string[] = [];
      for (const out of cell.outputs) {
        if (out.text) outTexts.push(out.text.join(""));
        if (out.data?.["text/plain"]) outTexts.push(out.data["text/plain"].join(""));
      }
      if (outTexts.length) {
        parts.push(`**Output:**\n\`\`\`\n${outTexts.join("\n").slice(0, 2000)}\n\`\`\``);
      }
    }
  }
  return parts.join("\n\n");
}

export const tool: Tool = {
  name: "read_file",
  description: "讀取檔案內容",
  tier: "elevated",
  resultTokenCap: 4000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "檔案路徑（絕對路徑或相對路徑）" },
      offset: { type: "number", description: "起始行號（1-based，省略為從頭）" },
      limit:  { type: "number", description: "最多讀取行數（省略為全部）" },
      pages:  { type: "string", description: "PDF 頁碼範圍（如 '1-5'、'3'）。僅 .pdf 檔案適用。" },
    },
    required: ["path"],
  },
  async execute(params, ctx) {
    const filePath = resolve(String(params["path"] ?? ""));

    if (!existsSync(filePath)) return { error: `檔案不存在：${filePath}` };

    // 目錄偵測：回傳目錄列表而非 EISDIR 錯誤
    try {
      if (statSync(filePath).isDirectory()) {
        const entries = readdirSync(filePath, { withFileTypes: true })
          .map(e => (e.isDirectory() ? e.name + "/" : e.name))
          .sort();
        return { result: `這是一個目錄，包含 ${entries.length} 個項目：\n${entries.join("\n")}` };
      }
    } catch { /* stat 失敗就繼續嘗試讀取 */ }

    // PDF 檔案：特殊處理
    const ext = extname(filePath).toLowerCase();
    if (ext === ".pdf") {
      const pages = params["pages"] ? String(params["pages"]) : undefined;
      const pdf = readPdf(filePath, pages);
      if (pdf.error) return { error: pdf.error };
      ctx.eventBus.emit("file:read", filePath, ctx.accountId);
      return { result: pdf.text ?? "[PDF 無文字內容]" };
    }

    // Jupyter Notebook：特殊處理
    if (ext === ".ipynb") {
      try {
        const nbContent = readNotebook(filePath);
        ctx.eventBus.emit("file:read", filePath, ctx.accountId);
        return { result: nbContent };
      } catch (err) {
        return { error: `Notebook 解析失敗：${err instanceof Error ? err.message : String(err)}` };
      }
    }

    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch (err) {
      return { error: `讀取失敗：${err instanceof Error ? err.message : String(err)}` };
    }

    if (content.length > MAX_FILE_SIZE) {
      content = content.slice(0, MAX_FILE_SIZE) + "\n...[截斷，超過 200KB]";
    }

    // offset / limit 行號切割
    const offset = typeof params["offset"] === "number" ? params["offset"] : 1;
    const limit  = typeof params["limit"]  === "number" ? params["limit"]  : undefined;

    if (offset > 1 || limit !== undefined) {
      const lines = content.split("\n");
      const start = Math.max(0, offset - 1);
      const end   = limit !== undefined ? start + limit : undefined;
      content = lines.slice(start, end).join("\n");
    }

    ctx.eventBus.emit("file:read", filePath, ctx.accountId);

    return { result: content };
  },
};
