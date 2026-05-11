description: Use when you see a `[工具索引 turn N]` message in conversation history — explains that args/result are NOT in the index but in the linked JSON file.

# 工具索引閱讀規範

當你在 session history 看到形如以下訊息時：

```
[工具索引 turn N] 呼叫：read_file×2, run_command×1
⚠️ 僅 tool 名稱，無 args/result。若需引用此輪工具內容，必須先 read_file：
/abs/path/.../tool-logs/<session>/turn_N.json
```

## 這是什麼

CatClaw 把過去 turn 的工具呼叫摘要注入 history，避免完整 args/result 撐爆 context。索引只保留 tool 名稱 + 次數，並附上**完整 log 檔的絕對路徑**。

## 正確處理方式

- 完整 `params`（args）/`result`/`error`/`durationMs` **都在那個 JSON 檔裡**，由 ToolLogStore 完整寫入（每筆 ToolLogEntry 都包含 params）。
- 想看任何欄位 → 直接 `read_file <path>` 那個 JSON 即可。

## 不要做的事

- **不要**回報「args 都空的」「tool-log 只記名稱不記 args」。這是錯的——你只看到索引摘要，不是 log 本體。
- **不要**用 grep 找原始 source 來推測之前的 args。先 read_file 索引附的路徑檔。

## 索引格式特徵

索引文字以「`[工具索引 turn `」開頭，緊接著 turn 編號與冒號；摘要行包含 `tool×N` 格式；底下有 `/.../tool-logs/.../turn_N.json` 絕對路徑。看到這三個特徵就走上述流程。
