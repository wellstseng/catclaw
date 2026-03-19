# modules/session — Session 快取 + 串行佇列

> 檔案：`src/session.ts`

## 職責

1. 維護 `channelId → sessionId`（UUID）的快取
2. 以 Promise chain 實作 per-channel 串行佇列
3. 對外只暴露 `enqueue()`，呼叫方不需要關心 session 細節

## Session 策略

| 場景 | Session Key | 行為 |
|------|------------|------|
| Guild 頻道 | `channelId` | 同頻道共享對話 |
| DM | `channelId`（每人唯一） | per-user session |

- 首次對話：不帶 `--resume`，claude CLI 自動建立 session
- `session_init` event → 取得 UUID → 快取
- 後續：`--resume <UUID>` 延續上下文

## Per-Channel 串行佇列

```
同一 channel：turn1 → turn2 → turn3（Promise chain 串行）
不同 channel：完全並行
```

實作：`queues: Map<channelId, Promise<void>>`

- 每個新 turn `.then()` 接在上一個 Promise 尾端
- 完成後 `.finally()` 清理 Map（避免記憶體洩漏）
- 錯誤不向上傳播（`.catch()` 攔截，避免 chain 中斷）

## API

### `enqueue(channelId, text, onEvent, opts)`

```typescript
interface EnqueueOptions {
  cwd: string;           // Claude session 工作目錄
  claudeCmd: string;     // CLI binary 路徑
  turnTimeoutMs: number; // 回應超時毫秒數
}
```

**Turn Timeout**：

- `new AbortController()` + `setTimeout(turnTimeoutMs)`
- 超時 → `ac.abort()` → acp.ts 收到 signal → SIGTERM → SIGKILL
- 超時訊息：`回應超時（Ns），已取消`
- `.finally(() => clearTimeout(timer))` 正常完成時清除 timer

## session_init 攔截

`runTurn()` 攔截 `session_init` event → 存入 `sessionCache` → **不轉發**給 reply handler。
上層 reply.ts 永遠不會收到 `session_init`。
