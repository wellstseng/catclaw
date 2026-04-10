# Inbound History — 未處理訊息記錄

> 對應原始碼：`src/discord/inbound-history.ts`
> 更新日期：2026-04-06

## 概觀

記錄未進入 agent loop 的 Discord 訊息（append-only JSONL），
下次 agent loop 啟動時注入為上下文，讓 AI 能看到「漏掉」的對話。

## 三 Bucket 處理流程

```
inject() 時按時間分桶：
  Bucket A（< fullWindowHours）     → 全量帶入
  Bucket B（fullWindow ~ decayWindow）→ LLM 壓縮（上限 bucketBTokenCap）
    Decay II：壓縮後仍超上限 → 截舊再壓（上限 decayIITokenCap，純程式）
  Bucket C（> decayWindowHours）     → 直接清除
```

消費後刪除該批 entries。

## InboundEntry

```ts
interface InboundEntry {
  ts: string;           // ISO 8601
  platform: string;     // "discord"
  channelId: string;
  authorId: string;
  authorName: string;
  content: string;
  wasProcessed: false;
}
```

## 儲存

JSONL 格式，路徑：`{dataDir}/inbound/discord_{channelId}_{scope}.jsonl`（channelId + scope 經 sanitize）

### Scope 隔離

每個 bot/agent 有獨立的 inbound history 檔案：
- 主 bot：scope = `"main"`（預設）
- CLI Bridge bot：scope = bridge label（如 `"judy-cli"`）
- 同一訊息可同時寫入多個 scope（`appendToScopes()`）

### 全域單例

- `initInboundHistoryStore(dataDir)` — 初始化
- `getInboundHistoryStore()` — 取得實例

### 額外公開方法

| 方法 | 說明 |
|------|------|
| `append(channelId, entry, scope?)` | 追加 entry 到指定 scope（預設 "main"） |
| `appendToScopes(channelId, entry, scopes)` | 追加 entry 到多個 scope |
| `consumeForInjection(..., scope?)` | 消費指定 scope 的 entries 並注入 |
| `listChannels()` | 列出所有有記錄的頻道（含 scope 資訊） |
| `readEntries(channelId, scope?)` | 讀取指定頻道 + scope 的 entries |
| `clearChannel(channelId, scope?)` | 清除指定頻道 + scope 的記錄 |
| `clearChannelAllScopes(channelId)` | 清除指定頻道所有 scope 的記錄 |
| `clearAll()` | 清除所有頻道記錄 |

## 與 message-pipeline 的關係

`message-pipeline.ts` 的 Inbound 階段會呼叫 `injectInboundHistory()` 將 Bucket A/B 結果注入 messages。
