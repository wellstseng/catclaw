# Smoke Test 未覆蓋清單

記錄於 2026-03-26，S1+S2 完成後。

## 待補測項目

### Ollama failover
- 情境：primary（rdchat）離線時自動切換 fallback（local）
- 測法：啟動時 mock primary host 為無效位址，驗證 fallback 接手
- 歸屬：smoke-test-s2.mjs

### Discord bot 啟動
- 情境：完整 Discord Gateway 連線 + 訊息收發
- 測法：需 S3 session manager + Discord token 連線
- 歸屬：smoke-test-s3.mjs（待建）

### 多 namespace 跨層向量搜尋
- 情境：global / project/{id} / account/{id} 各自隔離，跨層不污染
- 測法：三個 namespace 各寫一筆，搜尋各層驗證不互漏
- 歸屬：smoke-test-s2.mjs

### Platform 完整啟動序列
- 情境：index.ts 啟動 → Config → EventBus → OllamaClient → VectorService → Discord
- 測法：需 S4 platform bootstrap 完成後再跑 E2E
- 歸屬：smoke-test-e2e.mjs（待建）

### Config env var 展開錯誤處理
- 情境：catclaw.json 含 `${MISSING_VAR}` 時應報錯
- 測法：mockenv + 驗證拋出正確訊息
- 歸屬：smoke-test-s1.mjs
