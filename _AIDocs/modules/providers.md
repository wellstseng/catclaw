# providers — LLM Provider 系統

> 更新日期：2026-03-28

## 檔案

| 檔案 | 說明 |
|------|------|
| `src/providers/base.ts` | 型別定義：LLMProvider, Message, ProviderOpts, StreamResult, ProviderEvent |
| `src/providers/registry.ts` | ProviderRegistry：載入、取得、列表 |
| `src/providers/claude-api.ts` | ClaudeApiProvider（@mariozechner/pi-ai） |
| `src/providers/auth-profile-store.ts` | AuthProfileStore：多憑證管理 + cooldown |
| `src/providers/ollama.ts` | OllamaProvider（OpenAI-compat API） |
| `src/providers/openai-compat.ts` | OpenAICompatProvider（第三方 OpenAI-compat） |
| `src/providers/codex-oauth.ts` | CodexOAuthProvider（pi-ai OAuth） |

## ClaudeApiProvider（claude-api.ts）

使用 `@mariozechner/pi-ai` v0.58.0 的 `streamSimpleAnthropic` 呼叫 Anthropic API。

### 核心流程

```
stream(messages, opts)
  ↓ AuthProfileStore.pick() → credential
  ↓ getModel("anthropic", modelId)
  ↓ toPiMessages(messages) — catclaw → pi-ai 格式
  ↓ toPiTools(tools) — JSON Schema → Type.Unsafe(schema)
  ↓ streamSimpleAnthropic(model, context, { apiKey, maxTokens, signal, temperature })
  ↓ _convertEvent() — pi-ai events → catclaw ProviderEvent
  → StreamResult { events, stopReason, toolCalls, text }
```

### OAuth vs API Key 自動偵測

`streamSimpleAnthropic` 內部自動處理：
- `sk-ant-oat01-...` → `Authorization: Bearer` + OAuth betas headers
- `sk-ant-api...` → `x-api-key`

### 訊息格式轉換

catclaw 使用 Anthropic-native 格式（tool_result 在 user content blocks）；
pi-ai 使用分離的 `ToolResultMessage`（role: "toolResult"）。

轉換邏輯：
- `buildToolNameMap()` — 從 assistant 訊息建立 `tool_use_id → toolName` 反查表
- `toPiMessages()` — user string → UserMessage；user tool_result blocks → ToolResultMessage；assistant → AssistantMessage（TextContent + ToolCall）
- `toPiTools()` — `input_schema` JSON Schema → `Type.Unsafe(schema)`（typebox）

### ProviderEvent 對應

| pi-ai event | catclaw ProviderEvent |
|------------|----------------------|
| `text_delta` | `{ type: "text_delta", text }` |
| `thinking_delta` | `{ type: "thinking_delta", thinking }` |
| `toolcall_end` | `{ type: "tool_use", id, name, params }` |
| `done` (end_turn) | `{ type: "done", stopReason: "end_turn", text }` |
| `done` (toolUse) | `{ type: "done", stopReason: "tool_use", text }` |
| `error` | `{ type: "error", message }` |

### 設定（catclaw.json）

```jsonc
"providers": {
  "claude-oauth": {
    "type": "claude-api",
    "model": "claude-sonnet-4-6"   // 選填，預設 claude-sonnet-4-6
    // 無 token/profiles 欄位 — 憑證從 auth-profile.json 讀
  }
}
```

**不使用** `token: "${ENV_VAR}"` 或 `profiles[]`，已移除。

## AuthProfileStore（auth-profile-store.ts）

多憑證輪替 + cooldown 管理。

### 資料分離

| 用途 | 路徑 |
|------|------|
| 憑證（user-editable） | `{CATCLAW_WORKSPACE}/agents/default/auth-profile.json` |
| 狀態（runtime-managed） | `{CATCLAW_WORKSPACE}/data/auth-profiles/{providerId}-profiles.json` |

### 憑證檔格式

```json
[{ "id": "key-1", "credential": "sk-ant-oat01-..." }]
```

### 生命週期

1. `new AuthProfileStore({ providerId, persistPath, credentialsFilePath })` + `load()`
2. `load()` → 讀 state 檔 → 讀憑證檔 → `_mergeCredentials()`（更新 credential，保留 state）
3. `pick()` → 找第一個未 disabled + cooldown 未過期的 profile
4. 呼叫失敗 → `setCooldown(id, reason)` 設 cooldown 或永久停用

### Cooldown 時長

| reason | 時長 |
|--------|------|
| `rate_limit` | 15 分鐘 |
| `overloaded` | 5 分鐘 |
| `billing` | 永久停用 |
| `auth` | 永久停用 |

### 陷阱

- 永久停用後必須刪 state 檔（`data/auth-profiles/{id}-profiles.json`）再重啟才能恢復
- 憑證檔只讀不寫（由使用者維護）；state 檔由 runtime 自動更新
