# 08 — Claude CLI 指令參考

> 本專案使用 Claude Code CLI（`claude`）進行對話，不使用 API SDK。

## 完整指令格式

```bash
claude -p \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --dangerously-skip-permissions \
  [--resume <session_id>] \
  "<prompt>"
```

## Flag 說明

| Flag | 必要性 | 說明 |
|------|--------|------|
| `-p` | 必要 | Print mode（非互動式） |
| `--output-format stream-json` | 必要 | 輸出 NDJSON 串流 |
| `--verbose` | 必要 | stream-json 必須搭配，否則 CLI 報錯 |
| `--include-partial-messages` | 必要 | 輸出中間態 assistant 事件（累積文字），實現串流效果 |
| `--dangerously-skip-permissions` | 必要 | 跳過工具權限確認（bot 無法互動式確認） |
| `--resume <id>` | 選用 | 延續既有 session（首次不帶） |

## stdio 配置

```
stdin:  "ignore"   ← prompt 透過 positional arg 傳入
stdout: "pipe"     ← 讀取 JSON 串流
stderr: "pipe"     ← 除錯用，非解析目標
```

> **陷阱**：stdin 若為 `"pipe"` 且未關閉，claude 會等待 stdin 輸入而永遠不輸出。

## stream-json Event 格式

每行一個 JSON 物件（NDJSON）。

### `system` — 系統事件

```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "abc-123-...",
  ...
}
```

用途：取得 `session_id`，用於後續 `--resume`。

### `assistant` — 中間態 / 最終回覆

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_xxx",
    "content": [
      { "type": "text", "text": "累積到目前的完整文字..." },
      { "type": "tool_use", "name": "Read", "id": "tu_xxx" }
    ]
  },
  ...
}
```

**重要**：`text` 是**累積文字**（不是 delta）。需要 diff `lastTextLength` 提取新增部分。

### `result` — Turn 結束

```json
{
  "type": "result",
  "result": "最終回覆文字",
  "is_error": false,
  "session_id": "abc-123-..."
}
```

`is_error: true` 表示 Claude CLI 回傳錯誤。

### 其他 Event（靜默忽略）

- `hook_started` / `hook_response`
- `rate_limit_event`
- 其他未知 type
