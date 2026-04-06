# modules/task-ui — Discord 任務按鈕互動

> 檔案：`src/core/task-ui.ts`
> 更新日期：2026-04-06

## 職責

監聽 EventBus 的 `task:ui` 事件，在 Discord 頻道發送帶有 ActionRow 按鈕的任務列表。
使用者可透過按鈕直接變更任務狀態，無需輸入文字。

## 按鈕 ID 格式

```
task_{action}_{sessionId}_{taskId}
```

| Action | 對應狀態 | 按鈕樣式 |
|--------|---------|---------|
| `progress` | `in_progress` | Primary（藍） |
| `complete` | `completed` | Success（綠） |
| `delete` | 刪除任務 | Danger（紅） |

## 訊息格式

```
📋 Tasks (3)
⏳ #1 [pending] 修復登入 bug
🔄 #2 [in_progress] 重構 API
✅ #3 [completed] 更新文件
```

- 最多顯示 5 個未完成任務的按鈕（Discord 限制 5 ActionRows/message）
- 已完成的任務不顯示按鈕

## EventBus 監聽

```typescript
registerTaskUiListener(sessionIdResolver: (channelId: string) => string | undefined): void
```

監聽 `task:ui` 事件 → 解析 sessionId → 組裝 Components → `channel.send()`

## 按鈕互動處理

```typescript
handleTaskButtonInteraction(interaction: ButtonInteraction): Promise<boolean>
```

1. 解析 `customId` → `{ action, sessionId, taskId }`
2. `delete` → `store.delete()` → 回覆刪除確認
3. 其他 → `store.update({ status })` → 重建完整任務列表 UI

回傳 `true` 表示已處理，`false` 表示非 task 按鈕。

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `discord.ts` | `setTaskUiDiscordClient()` 注入 Discord Client |
| `discord.ts` | `registerTaskUiListener()` 啟動 EventBus 監聽 |
| `discord.ts` | `handleTaskButtonInteraction()` 處理按鈕互動 |
| `tools/task.ts` | `eventBus.emit("task:ui", ...)` 觸發 UI 更新 |
