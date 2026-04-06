# modules/accounts — 帳號 + 角色 + 權限 + Identity Linking

> 檔案：`src/accounts/registry.ts` + `src/accounts/`
> 更新日期：2026-04-05

## 檔案

| 檔案 | 說明 |
|------|------|
| `registry.ts` | AccountRegistry：帳號 CRUD + identity 反查 |
| `permission-gate.ts` | PermissionGate：角色 → tool tier 過濾 |
| `registration.ts` | RegistrationManager：邀請碼 + 自助註冊 |
| `identity-linker.ts` | IdentityLinker：帳號綁定多平台身份 |
| `role-tool-sets.ts` | 角色可用 tool tier 對照表 |

## 角色

```typescript
type Role = "platform-owner" | "admin" | "developer" | "member" | "guest";
```

| 角色 | Tool Tier 權限 |
|------|---------------|
| platform-owner | standard + elevated + admin |
| admin | standard + elevated + admin |
| developer | standard + elevated |
| member | standard |
| guest | public（受 rate limit，extraTools 補 read_file/glob/grep） |

## Account 型別

```typescript
interface Account {
  accountId: string;
  displayName: string;
  role: Role;
  identities: Identity[];
  projects: string[];
  preferences: AccountPreferences;
  disabled?: boolean;
  createdAt: string;
  lastActiveAt: string;
}

interface Identity {
  platform: "discord" | "line" | "telegram" | "slack" | "web";
  platformId: string;
  linkedAt: string;
}
```

## 資料結構

```
~/.catclaw/accounts/
  ├── _registry.json          — 索引（accounts + identityMap）
  └── {accountId}/
      └── profile.json        — 完整帳號資料
```

## AccountRegistry API

| 方法 | 說明 |
|------|------|
| `init()` | 載入索引 |
| `create(opts)` | 建立帳號 + 更新索引 |
| `get(accountId)` | 取得帳號（快取優先） |
| `update(accountId, patch)` | 更新帳號 |
| `resolveIdentity(platform, platformId)` | 身份反查 → accountId |
| `linkIdentity(accountId, platform, platformId)` | 綁定新身份 |
| `listAccountIds()` | 列出所有帳號 ID |
| `touch(accountId)` | 更新 lastActiveAt 時間戳 |
| `getIndex()` | 取得完整索引（accountId → identity 映射） |

## PermissionGate

```typescript
class PermissionGate {
  listAvailable(accountId: string): ToolDefinition[]
  check(accountId: string, toolName: string): PermissionResult  // { allowed: boolean; reason?: string }
}
```

根據 `role-tool-sets.ts` 的對照表過濾可用工具。

## RegistrationManager

兩種註冊流程：

**A. 邀請碼**：
1. Admin 用 `/register invite` 產生邀請碼
2. Guest 用 `/register {邀請碼}` 升級為 member
3. 邀請碼一次性，使用後失效

**B. 配對碼**（`createPairingCode` / `approvePairing`）：

1. 使用者在 Discord 請求配對 → 取得 6 碼
2. Admin 審批後綁定帳號

## IdentityLinker

三種綁定方式：
- `linkDirect(accountId, platform, platformId)` — Admin 直接綁定
- `requestLink(...)` → `confirmLink(...)` — 驗證碼流程

一個帳號可綁定多個平台身份（Discord + Line + ...）。
