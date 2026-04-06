# modules/task-store — 任務 CRUD

> 檔案：`src/core/task-store.ts`
> 更新日期：2026-04-06

## 職責

Per-session 結構化任務追蹤。LLM 透過 tool 建立、更新、查詢任務。
生命週期跟隨 session，不持久化到磁碟。

## Task 型別

```typescript
type TaskStatus = "pending" | "in_progress" | "completed";

interface Task {
  id: string;           // 自增數字（per-store）
  subject: string;
  description?: string;
  status: TaskStatus;
  blocks: string[];     // 此任務阻擋了哪些任務
  blockedBy: string[];  // 此任務被哪些任務阻擋
  createdAt: number;
  updatedAt: number;
}
```

## TaskStore API

```typescript
class TaskStore {
  create(subject: string, description?: string): Task
  get(id: string): Task | undefined
  list(filter?: { status?: TaskStatus }): Task[]    // 依 createdAt 排序
  update(id: string, updates: { subject?, description?, status?, addBlocks?, addBlockedBy? }): Task | undefined
  delete(id: string): boolean
  clear(): void
}
```

### 依賴管理

- `addBlocks` / `addBlockedBy` 自動建立雙向關聯
- 任務 completed → 自動解除被此任務阻擋的 blockedBy 關聯
- 任務 delete → 清理所有雙向關聯

## Per-Session Store

```typescript
getTaskStore(sessionKey: string): TaskStore       // 取得或建立
deleteTaskStore(sessionKey: string): void          // 清除
listAllTasks(): Array<{ sessionKey, tasks[] }>     // 供 dashboard 使用
```

每個 session（channelId）有獨立的 TaskStore 實例，透過 `sessionKey` 索引。

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `tools/task.ts` | LLM tool：task_create / task_update / task_list |
| `task-ui.ts` | 按鈕互動時 update/delete |
| `dashboard.ts` | `listAllTasks()` API |
| `session.ts` | session 結束時 `deleteTaskStore()` |
