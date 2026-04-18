# Tool Log Store — Tool 執行記錄持久化

> 對應原始碼：`src/core/tool-log-store.ts`
> 更新日期：2026-04-18

## 概觀

每個 turn 的完整 tool 執行結果存為獨立 JSON 檔，session history 只存索引摘要，不佔 LLM token。

## 設計原理

```
Tool results → tool-log-store（完整 JSON）
Session history → "[工具索引 turn N] 呼叫：read_file×2, edit_file×1 + ⚠️ 警語"（索引摘要）
```

## ToolLogStore class

| 方法 | 說明 |
|------|------|
| `save(sessionKey, turnIndex, tools)` | 儲存 turn 的 tool log，回傳絕對路徑（空陣列不存） |
| `cleanup(retentionDays=7)` | 清除超過 N 天未修改的目錄 |
| `static buildIndexSummary(tools, logPath, turnIndex?)` | 產生索引摘要文字（含 turn 編號 + ⚠️ 警語） |

## 儲存格式

```
{dataDir}/tool-logs/{safe_session_key}/turn_{n}.json
```

### ToolLogEntry

```ts
interface ToolLogEntry {
  id: string;
  name: string;
  params: unknown;
  result: unknown;
  error?: string;
  durationMs: number;
}
```

### 索引摘要範例

```
[工具索引 turn 42] 呼叫：read_file×2, edit_file×1
⚠️ 僅 tool 名稱，無 args/result。若需引用此輪工具內容，必須先 read_file：
/abs/path/data/tool-logs/discord_ch_111/turn_42.json
```

> **舊格式**（仍存於既有 session）：`[工具記錄] read_file×2 → path`

## 全域單例

`initToolLogStore(dataDir)` / `getToolLogStore()`
