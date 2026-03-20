# modules/reply — Discord 回覆分段 + Typing

> 檔案：`src/reply.ts`

## 職責

接收 `AcpEvent` 串流 → 累積文字 → 分段傳送到 Discord → 管理 typing indicator。

## API

### `createReplyHandler(originalMessage, bridgeConfig): (event: AcpEvent) => Promise<void>`

Factory 函式，建立閉包封裝的 event handler。回傳的函式可直接傳給 `session.enqueue` 的 `onEvent`。

## 分段邏輯

Discord 訊息上限 2000 字（`TEXT_LIMIT`）。

`flush(flushAll)` 切割 buffer 並傳送：

- `flushAll = false`：buffer >= 2000 才傳（串流累積中）
- `flushAll = true`：傳送所有剩餘 buffer（done / error / tool_call 時）

傳送順序：

- 第一段 → `message.reply()`（Discord 引用回覆）
- 後續 → `channel.send()`（直接傳送）

## Code Fence 平衡

跨 chunk 的 `` ``` `` 必須正確開關，否則 Discord 渲染破碎。

| 函式 | 邏輯 |
|------|------|
| `countCodeFences(text)` | 計算 `` ``` `` 出現次數 |
| `closeFenceIfOpen(text)` | 奇數個 → 尾端補 `` ``` `` |

跨 chunk 處理：

1. chunk 有奇數個 fence → 尾端補關 → 標記 `prevChunkHadOpenFence = true`
2. 下個 chunk 開頭補 `` ```\n `` → 恢復 code block

## Typing Indicator

- 收到訊息後立即 `sendTyping()`
- 每 8 秒 `setInterval` 重發（Discord typing 約 10 秒自然消失）
- 第一則回覆送出後 `clearInterval`（`stopTyping()`）
- `done` / `error` event 也會觸發 `stopTyping()`

## 檔案上傳模式（fileUploadThreshold）

當回覆總文字超過 `fileUploadThreshold`（預設 4000 字）時，自動切換為檔案模式：

1. `text_delta` 只累積 `totalText`，不再 flush chunk
2. `done` 時將完整文字上傳為 `response.md`（附前 150 字預覽）

設 0 = 停用。

## MEDIA Token 解析

Claude CLI 回覆中若包含 `MEDIA: /path/to/file`，reply.ts 會自動：

1. `extractMediaTokens(text)` — 正規表達式 `/\bMEDIA:\s*`?([^\n`]+)`?/gi` 抽取路徑
2. 移除 MEDIA token，清理多餘空行
3. 只接受絕對路徑（`/` 開頭），避免誤抓
4. `uploadMediaFile(path)` — `readFile` → `AttachmentBuilder` → Discord 附件上傳

整合位置：`done` event handler 中，先 `extractMediaTokens(totalText)` 取得清理後文字 + 路徑，送出文字後逐一上傳檔案。

## Event 處理

| Event | 行為 |
|-------|------|
| `text_delta` | 累積到 buffer + totalText；超過 threshold 進入 fileMode |
| `thinking_delta` | `showThinking` 開啟時累積推理文字 → scheduleFlush；收到 text 時 flush thinking buffer |
| `tool_call` | 若 `showToolCalls` 開啟 → `flush(true)` → 傳送 `🔧 使用工具：{title}` |
| `done` | `stopTyping()` → 抽取 MEDIA token → flush 或上傳 .md → 上傳 media 檔案 |
| `error` | `stopTyping()` → `flush(true)` → 傳送 `⚠️ 發生錯誤：{message}` |
| `status` | 靜默忽略 |

## 型別注意

使用 `SendableChannels`（非 `TextBasedChannel`）避免 `PartialGroupDMChannel` 缺少 `send()` 的 TS 錯誤。
