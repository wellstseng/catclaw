# Sprint 3 完整報告（自主開發模式 Session 3）

> 日期：2026-04-02  
> 執行方式：自主開發（Wells 授權，不需逐步確認）  
> Branch：platform-rebuild  
> Session：3（context 壓縮後續接）

---

## 背景

Sprint 3 分兩個批次執行：

- **S3-前期**（另一 session）：功能擴充（image vision、MCP client、exec-approval、web_fetch/web_search 等）— 記錄於 `_staging/next-phase.md`
- **S3-後期（本 session）**：UX 打磨 + Provider 認證架構重構

本報告聚焦 S3-後期（本 session）。

---

## 完成項目

### 1. Streaming Reply（即時串流回覆）

**提交**：`629c769`、`3f57ae5`

**問題**：bot 先發 💭 佔位訊息，LLM 回應結束後整段替換 → Discord UX 差，長回應感覺死掉了。

**修復**：
- `reply-handler.ts` 實作 live-edit 模式：每收到 `text_delta` 事件即 `message.edit()`
- 節流：每 1.5 秒最多一次 edit（避免觸發 Discord rate limit）
- `catclaw.json` 新增 `streamingReply: true/false` 開關
- 結果：使用者看到文字逐步出現

**副產品**：error 發生在首段文字前時，直接 edit 佔位訊息顯示錯誤，不留空白 💭。

---

### 2. Provider Mode 欄位

**提交**：`8423246`、`b51edad`

**問題**：`ClaudeApiProvider` 只有一條認證路徑，無法明確指定用 OAuth token 還是 API key。CE compaction 用 `"claude-haiku"` 也解析失敗（`getModel()` 回傳 undefined）。

**修復**：
- `config.ts` 新增 `mode?: "token" | "api" | "password"` 欄位
- `"token"` = OAuth（sk-ant-oat...，auth-profile.json）
- `"api"` = API key（sk-ant-api...，直接帶 token 欄位）
- `"password"` = HTTP Basic Auth（nginx/caddy 前端 auth proxy）
- `ClaudeApiProvider` constructor 依 mode 分流，`forceApi` 跳過 AuthProfileStore

**CE compaction 同步修復**：
- 新增 `MODEL_ALIASES` 對應表（`"claude-haiku"` → `"claude-haiku-4-5"` 等）
- compaction 現在正確解析 short name → 完整 pi-ai model ID

---

### 3. Password Mode（HTTP Basic Auth）for Ollama + OpenAI-Compat

**提交**：（ollama 含於 `8423246`）、`9d4c853`

**問題**：Ollama / OpenAI-compat 後面如果掛了 nginx/caddy + basic auth proxy，沒有地方設認證。

**修復**（`OllamaProvider`）：
- constructor：`mode==="password" && username != null` → `authHeader = Basic base64(user:pass)`
- 新增 `private _headers()` 統一產生含 Authorization 的 headers dict
- `/api/show`（init）和 `/api/chat`（stream）都改用 `_headers()`

**修復**（`OpenAICompatProvider`）：
- 移除獨立 `private token` 欄位，認證統一走 `authHeader`
- 同樣邏輯：`mode==="password"` → Basic；有 token → Bearer
- `init()` 的 `/api/show` fetch 也注入 auth header

---

### 4. Provider modelId 公開 + /status /use 顯示

**提交**：`9dd6939`、`d3dfcdb`、`c09f81e`、`936452c`

**問題**：`/status` 和 `/use` 只顯示 provider ID，不知道實際使用哪個 model。

**修復**：
- `base.ts` 的 `LLMProvider` interface 新增 `readonly modelId?: string`
- 所有 provider（`claude-api`、`ollama`、`openai-compat`、`codex-oauth`、`failover`）公開 `modelId`
- `/status` 顯示：`` `claude` (claude-sonnet-4-6) ``
- `/use` 切換時列出 model ID 供確認

---

### 5. autoThread + /system /use per-channel override

**提交**：`32e3a19`、`11680a4`

**功能**：
- `autoThread: true` 在 channel 設定 → 每條訊息自動建立 Thread，保持頻道整潔
- `/system` skill：隨時查看/切換目前 session 的 system prompt
- `/use` skill：per-channel 切換 provider（不影響其他頻道）

---

## 架構影響

| 檔案 | 變更類型 | 說明 |
|------|---------|------|
| `src/core/config.ts` | 新增欄位 | `mode`, `username`, `password` in ProviderEntry |
| `src/providers/base.ts` | interface 擴充 | `modelId?` 加入 LLMProvider |
| `src/providers/claude-api.ts` | 重構 | mode 分流 + MODEL_ALIASES |
| `src/providers/ollama.ts` | 擴充 | password mode + `_headers()` |
| `src/providers/openai-compat.ts` | 擴充 | password mode + 移除冗餘 token 欄位 |
| `src/providers/codex-oauth.ts` | 小改 | modelId 公開 |
| `src/providers/failover-provider.ts` | 小改 | get modelId() delegate |
| `src/core/reply-handler.ts` | 重構 | streaming live-edit + error placeholder fix |
| `src/skills/builtin/status.ts` | 更新 | 顯示 modelId |
| `src/skills/builtin/use.ts` | 更新 | 顯示 modelId |
| `src/skills/builtin/system.ts` | 新增 | system prompt 管理 |

---

## 問題與教訓

### 1. 模式命名被使用者更正一次

最初用 `"oauth"` 代表 OAuth token，`"token"` 代表 API key。Wells 更正：
- `"token"` = OAuth token（sk-ant-oat...）
- `"api"` = API key（sk-ant-api...）
這是因為 OpenClaw 那邊有既有慣例，應先調查再命名。

### 2. context 壓縮後遺失進行中工作狀態

Session 因 context 壓縮銜接，`openai-compat.ts` 的 `stream()` 方法未更新的狀態沒有正確傳遞，壓縮摘要有抓到但細節不夠精確。解法：壓縮前存 `_staging/` checkpoint。

### 3. 回應只在 terminal 沒在 Discord

這個 session 有幾輪忘記用 `reply` tool，直接在 terminal 回應。Wells 提醒後才修正。
規則：**Discord 頻道來的訊息，回應一律走 `mcp__plugin_discord_discord__reply`。**

---

## Token 估算

| 項目 | 估算 |
|------|------|
| 本 session 主對話 | ~80,000 |
| 前一 session（壓縮前） | ~120,000 |
| 合計 S3-後期 | ~200,000 |

---

## 下一步

見 `_staging/next-phase.md` Sprint 4 草案：
- 觀測性強化（/stats、crash 自動通知）
- Discord UX（長回應分頁、reaction 控制 tool call）
- platform-rebuild merge to main（126 commits ahead）
