# [續接] Provider 架構重構 — Phase 2/3/4

## 背景
Provider/Model 設定檔三層分離重構（對齊 OpenClaw 格式），Phase 1 已完成。

## Phase 1 完成內容（已提交）

### 新建檔案
1. **`src/providers/model-ref.ts`** — "provider/model" 格式解析
   - `parseModelRef()`, `parseModelRefDirect()`, `normalizeProviderId()`, `formatModelRef()`, `buildAliasMap()`
   - Provider alias: claude→anthropic, bedrock→amazon-bedrock 等

2. **`src/providers/models-config.ts`** — models.json 產生與載入
   - `ensureModelsJson()` — 啟動時從 catclaw.json modelsConfig + 內建目錄產生 models.json
   - 內建 provider: anthropic(4 models), openai(2), openai-codex(1)
   - `findModelDefinition()`, `listAllModels()`, `loadModelsJson()`

### 修改檔案
3. **`src/core/config.ts`** — 新增 V2 三層型別
   - `ModelDefinition`, `ModelProviderDefinition`, `ModelsJsonConfig` (models.json)
   - `AuthProfileCredential`, `AuthProfilesJson`, `ProfileUsageStats` (auth-profile.json)
   - `AgentDefaultsConfig`, `ModelsConfig`, `AuthConfig` (catclaw.json 新區塊)
   - `ModelApi` type: "anthropic-messages" | "openai-completions" | "openai-codex-responses" | "ollama"
   - BridgeConfig 新增: `agentDefaults?`, `modelsConfig?`, `authConfig?`
   - RawConfig 同步更新
   - loadConfig() return 加入新欄位
   - 舊 ProviderEntry 標記 @deprecated

4. **`src/providers/auth-profile-store.ts`** — 完全重寫對齊 OpenClaw
   - profileId 格式 "provider:name"
   - 三種 credential: api_key / token / oauth
   - `pickForProvider(provider)` — round-robin 選取
   - `order`, `usageStats`, `lastGood` 追蹤
   - V1→V2 自動遷移（舊陣列格式 → 新格式）
   - 全域單例: `initAuthProfileStore()`, `getAuthProfileStore()`

5. **`src/providers/claude-api.ts`** — 適配新 AuthProfileStore API
   - 建構改用 `new AuthProfileStore(filePath)` 單參數
   - `pick()` → `pickForProvider("anthropic")`
   - `list()` → `listAll()`
   - `getAvailableCount()` → `getAvailableCount("anthropic")`

## Phase 2 待做（Provider 重構 — 核心）

### Task 5: registry.ts 重構
- `buildProviderRegistry()` 改為從 models.json + auth-profile + agentDefaults 建立
- 新流程：
  1. 讀 models.json → 取得 provider 連線資訊 (baseUrl, api type)
  2. 從 auth-profile store → 取得 credential
  3. 從 agentDefaults.models → 取得要啟用的 model ref
  4. 自動判斷 provider type（從 api 欄位）
- 保留舊的 `entries: Record<string, ProviderEntry>` 路徑作為 fallback

### Task 6: 4 個 provider 適配
- claude-api.ts: model 資訊從 models.json 讀（contextWindow, cost 等）
- ollama.ts: 連線資訊可從 models.json 的 ollama provider 讀
- openai-compat.ts: baseUrl + token 從 models.json + auth-profile
- codex-oauth.ts: OAuth credential 從 auth-profile

### Task 7: platform.ts 啟動流程
- 新啟動順序：
  1. loadConfig()
  2. ensureModelsJson(workspaceDir, config.modelsConfig)
  3. initAuthProfileStore(authProfilePath) + load()
  4. buildProviderRegistry() 用新邏輯
- CE compaction provider 建立改用 model-ref

### Task 8: 周邊檔案更新（~20 個）
需要更新的 provider/model 參數：
- tools: llm-task.ts (provider→model-ref), spawn-subagent.ts, config-patch.ts
- skills: configure.ts, use.ts, status.ts, config-manage.ts
- core: session.ts (providerId), event-bus.ts, context-engine.ts, agent-loop.ts, turn-audit-log.ts
- cron.ts (defaultProvider→model-ref)
- discord.ts, inbound-history.ts
- agent-registry.ts, accounts/registry.ts
- providers: circuit-breaker.ts, failover-provider.ts, base.ts
- ollama/client.ts, vector/embedding.ts, memory/recall.ts

## Phase 3: catclaw.example.json + catclaw.js 更新
- 範本改成新三層格式
- catclaw.js 初始化邏輯對應

## Phase 4: Dashboard 動態欄位
- Config GUI 移除舊 providers 區，改成 Models/Agent/Auth 頁籤
- 依 provider type 動態顯示欄位

## 重要設計決策
- 斷開舊格式（不做向後相容）
- models.json 用內建目錄 + catclaw.json 自訂 merge（不用 pi-ai auto-discovery，太複雜）
- auth-profile.json 對齊 OpenClaw 格式（"provider:name" key）
- catclaw.json 用 "provider/model" 引用格式 + alias

## 影響範圍
共 ~31 個檔案（29 .ts + catclaw.example.json + catclaw.js）
