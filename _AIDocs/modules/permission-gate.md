# modules/permission-gate — 權限閘門

> 檔案：`src/accounts/permission-gate.ts`
> 更新日期：2026-04-06

## 職責

角色 Tier 為基礎的 tool 存取控制。決定每個帳號可以看到和使用哪些 tool。
LLM 看到的 tool list 由 `listAvailable()` 物理過濾後產生（移除的 tool 不出現在 schema 中）。

## Tier 分級

```typescript
type ToolTier = "public" | "standard" | "elevated" | "admin" | "owner";
```

### 角色 → Tier 對照

| 角色 | 可存取 Tier | allow 最高突破至 |
|------|------------|----------------|
| platform-owner | public, standard, elevated, admin, owner | owner |
| admin | public, standard, elevated, admin | owner |
| developer | public, standard, elevated | admin |
| member | public, standard | elevated |
| guest | public | standard |

## 權限判定流程（check）

```
1. deny 優先
   - 帳號 permissions.deny 包含此 tool → 拒絕
   - 角色 roleDenyTools 包含此 tool → 拒絕

2. allow 覆寫
   - 帳號 permissions.allow 包含此 tool
   - 且 tool.tier ≤ 角色的 ROLE_MAX_ALLOW_TIER → 允許
   - owner tier tool 永遠不可被 allow 覆寫（除非角色本身是 platform-owner）

3. Role Tool Set
   - getRoleExtraTools(role) 包含此 tool → 允許

4. Tier 檢查
   - tool.tier 在角色的 ROLE_TIER_ACCESS 中 → 允許
   - 否則 → 拒絕
```

## API

```typescript
class PermissionGate {
  constructor(accountRegistry: AccountRegistry, toolRegistry: ToolRegistry)

  checkAccess(accountId: string): PermissionResult       // 帳號是否可進門（不針對特定 tool）
  check(accountId: string, toolName: string): PermissionResult  // 單一 tool 權限
  checkTier(accountId: string, tier: ToolTier): PermissionResult // Tier-only（Skill 用）
  listAvailable(accountId: string): ToolDefinition[]      // 帳號可用的完整 tool 清單
}

interface PermissionResult {
  allowed: boolean;
  reason?: string;
}
```

## listAvailable 組裝邏輯

1. 基礎 tier 過濾（角色可存取的 tier）
2. 移除帳號 deny 清單
3. 加入 allow 覆寫（突破 tier 但有上限）
4. 加入角色 extra tools（getRoleExtraTools）
5. 移除角色 deny tools（getRoleDenyTools）
6. 轉換為 ToolDefinition[]（toDefinition）

## 全域單例

```typescript
initPermissionGate(accountRegistry, toolRegistry): PermissionGate
getPermissionGate(): PermissionGate
resetPermissionGate(): void
```

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `agent-loop.ts` | `listAvailable()` 產生 LLM 可見的 tool list |
| `agent-loop.ts` | `check()` 每次 tool_use 前的權限檢查 |
| `skills/` | `checkTier()` skill 執行前的 tier 層級檢查 |
| `platform.ts` | `initPermissionGate()` 初始化 |
