# tool-output-store

> 對應原始碼：`src/core/tool-output-store.ts`
> 建立日期：2026-05-04（CatClaw 整合 Hermes 計畫項目 6）

## 用途

把 subagent 範本（commit `6912b68`）推廣到一般 tool result。≥ 閾值的 tool result 寫到
`~/.catclaw/workspace/data/tool-outputs/{safeKey}/t{turn}-{tool}-{nonce}.txt`，
prompt 中只塞 stub（含絕對路徑），LLM 想看完整內容用 `read_file` 即可。

與既有兩套並列：
| 路徑 | 來源 | 觸發時機 |
|------|------|---------|
| `data/subagent-results/{runId}.md` | `agent-loop.ts:1391` | subagent 結果 > 8000 字 |
| `data/externalized/{sessionKey}/...` | `context-engine.ts:356 externalizeMessage` | CE Level 2 外部化 |
| **`data/tool-outputs/{sessionKey}/...`** | **`tool-output-store.ts`（本檔）** | **tool result ≥ per-tool 閾值** |

## Exports

```typescript
export const TOOL_OUTPUT_STUB_PREFIX = "[tool_result_externalized:";

export interface ExternalizedToolOutput {
  stub: string;          // 塞回 tool_result content 的 stub 字串
  filePath: string;      // 寫檔絕對路徑
  originalTokens: number;
}

export interface ExternalizeToolOpts {
  toolName: string;
  text: string;          // 原始 tool result 文字
  sessionKey: string;
  turnIndex: number;     // 用於檔名，不必嚴格對應 session.turnCount
  args?: unknown;
}

export function shouldExternalizeToolOutput(toolName: string, text: string): boolean;
export function externalizeToolOutput(opts: ExternalizeToolOpts): ExternalizedToolOutput;
export function isExternalizedStub(text: string): boolean;
export function cleanupToolOutputs(ttlDays?: number): { cleaned: number; freedBytes: number };
```

## 閾值表

| Tool | Token threshold（chars ×4 估算） | 備註 |
|------|--------------------------------|------|
| `read_file` | 2000 | |
| `grep` | 1500 | 命中常很長，提早外部化 |
| `glob` | 1500 | 同上 |
| `run_command` | 3000 | stderr 有意義，多保 |
| `web_search` | 2000 | |
| 其他 | 2000 | DEFAULT |
| `mcp_*` | — | **跳過外部化**（圖片 / 結構化資料） |

## Stub 格式

```
[tool_result_externalized: <toolName> | <metadata> | 完整內容 @ <abs_path>]
↑ 上方為 tool_result 的外部化指標（CatClaw 自動截斷）。完整原始輸出已寫入該絕對路徑，
如需檢視請呼叫 read_file 讀取。Stub 不含原文，勿從 stub 推測缺失內容。
```

`metadata` 由 per-tool helper 產出：read_file 給 path/行/KB；grep 給 pattern/行/KB；
run_command 給 cmd/exit/行；其他 fallback 為 行/KB。

## 接入點

- `agent-loop.ts:134 truncateToolResult` 加 `opts?: { sessionKey, turnIndex, args }`，
  簽名改回傳 `{ text: string; externalized?: ExternalizedToolOutput }`。
  外部化優先：tokens ≥ threshold 且非 mcp_* → 寫檔分支；失敗 fallthrough 到既有
  `TRUNCATION_STRATEGIES` truncation。
- 三個 caller (L1737/1810/2028) destructure + 補 opts；spawn / concurrent BatchResult
  type 加 externalized 欄位。
- `context-engine.ts:269 truncateBlocks` 內 tool_result 判斷加 `isExternalizedStub` 短路
  （防 stub 被 CE 二次壓縮丟失指標路徑）。
- `message-trace.ts TraceToolCall.externalized` 欄位 + `recordToolExternalized()` method
  （給 sequential caller 在 trace 已寫入後 attach）。
- `platform.ts initPlatform` 末尾接 `cleanupToolOutputs(14)`（startup 一次性 TTL 清理）。

## 注意事項

- `cleanupToolOutputs(ttlDays=14)` 預設 14 天 TTL，未來可由 config 覆寫
- 失敗（寫檔錯誤等）throw，caller `agent-loop.ts truncateToolResult` 內 try/catch
  fallthrough 到既有 truncation 策略，不阻塞主流程
- session crash + restore：snapshot store 同層 fs，tool-outputs 的檔不會被清掉，stub
  路徑仍指向同檔，能正確讀回
