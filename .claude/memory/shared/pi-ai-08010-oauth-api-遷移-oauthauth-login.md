# pi-ai-0.80.10-oauth-api-遷移-OAuthAuth-login

- Scope: shared
- Author: wellstseng
- Confidence: [臨]
- Trigger: pi-ai, loginOpenAICodex, openaiCodexOAuth, codex oauth, pi-ai 升級, OAuthAuth, gpt-5.6
- Created-at: 2026-07-20

## 知識

- [臨] pi-ai 0.80.10 移除 `@earendil-works/pi-ai/oauth` 的 `loginOpenAICodex`；`/oauth` 子路徑降為 type-only。功能入口改 `openaiCodexProvider().auth.oauth.login(interaction)`（import `@earendil-works/pi-ai/providers/openai-codex`）
- [臨] 新 AuthInteraction = `{ prompt(AuthPrompt): Promise<string>, notify(AuthEvent): void, signal? }`。login 先發 `select` prompt 選登入方式（回 "browser" 或 "device_code"），browser 流程再 notify `auth_url` + 立即發 `manual_code` prompt 與 localhost:1455 callback 賽跑
- [臨] 坑：manual_code prompt 是「立即啟動」而非「callback 失敗才啟動」——handler 內的逾時計時器/錯誤狀態寫入必須在 `prompt.signal` abort 時清除，否則 browser callback 成功後計時器照跑、事後誤標 error（catclaw dashboard.ts 踩過）
- [臨] 回傳 OAuthCredential 欄位不變：`{access, refresh, expires, accountId}`，下游轉存 ~/.codex/auth.json 邏輯免改
- [臨] catclaw models-config.json mode=merge 會合併 pi-ai 內建 registry——pi-ai 升級帶進的新模型（如 gpt-5.6-sol/luna/terra）只需加 alias，不用動 agents/default/models.json

## 行動

- pi-ai 升級後 tsc 報 oauth import 錯誤 → 依上述新 API 遷移，注意 signal abort 清計時器
- 新模型只加 models-config.json alias 即可
