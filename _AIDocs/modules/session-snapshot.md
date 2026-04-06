# Session Snapshot — Turn 快照與回退

> 對應原始碼：`src/core/session-snapshot.ts`
> 更新日期：2026-04-06

## 概觀

Agent loop 開始前快照 session messages，供 `/stop` 中斷回退或 `/rollback` 手動還原。

## 生命週期

| 情境 | 行為 |
|------|------|
| 正常完成 + 無 CE 壓縮 | 刪除快照 |
| 正常完成 + CE 壓縮 | 保留 48h（供 /rollback） |
| `/stop` 中斷 | 還原快照 → 刪除 |

## SessionSnapshotStore class

| 方法 | 說明 |
|------|------|
| `save(sessionKey, turnIndex, messages, ceApplied?)` | 建立快照 |
| `get(sessionKey, turnIndex)` | 讀取特定 turn 快照 |
| `list(sessionKey)` | 列出所有可用快照（按 turnIndex 降序） |
| `delete(sessionKey, turnIndex)` | 刪除快照 |
| `cleanup()` | TTL 清理：過期的刪除，無 expiresAt 超過 1h 的孤立檔也刪除 |

## 儲存格式

```
{dataDir}/session-snapshots/{safe_session_key}_snap_{turnIndex}.json
```

### SessionSnapshotRecord

```ts
interface SessionSnapshotRecord {
  sessionKey: string;
  turnIndex: number;
  messages: Message[];
  snapshotAt: string;    // ISO 8601
  ceApplied: boolean;
  expiresAt?: string;    // 48h TTL（CE 壓縮時設定）
}
```

## 全域單例

`initSessionSnapshotStore(dataDir)` / `getSessionSnapshotStore()`
