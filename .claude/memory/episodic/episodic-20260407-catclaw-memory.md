# Session: 2026-04-07 .catclaw-memory

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: .catclaw, access, account, accountdir, accountid, accounts, catclaw, episodic, global, lancedb, memory, minscore
- Last-used: 2026-04-07
- Created: 2026-04-07
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-01

## 摘要

Design-focused session (24 prompts). /continue

## 知識

- [臨] 工作區域: .catclaw-memory (1 files)
- [臨] 修改 1 個檔案
- [臨] CatClaw memory.recall 預設關閉 vectorSearch（需手動啟用），依賴 Ollama embedding 且離線時降級為空
- [臨] Recall 流程包含 5 個階段：Trigger 匹配 → Vector 搜尋 → Related Edge BFS → 合併去重 → ACT-R 排序
- [臨] MD Trigger 匹配 100% 可靠，Vector 搜尋需 Ollama 在線，cosine similarity ≥ 0.65 為有效閾值
- [臨] 原子系統僅在 Global 層運作（~/.catclaw/memory/），Project/Account 層目錄不存在，導致無法儲存專案/帳號層記憶
- [臨] Trigger 匹配機制依賴關鍵字硬匹配，未啟用 Vector Search，導致語意相近查詢無法觸發 atom
- [臨] vectorSearch 已啟用且 vectorMinScore=0.35（過低）導致低相關結果混入
- [臨] Trigger substring 匹配與 Vector 搜尋同時啟用 → 重複召回+排序混亂
- [臨] LanceDB _distance 平方計算使 minScore 門檻失效
- [臨] vectorMinScore=0.35太低，可能召回大量低相關atom，且70個global atom無project/account分層導致資料混雜
- [臨] Trigger substring匹配過寬+score=1.0壓垮vector搜尋，導致重複召回與排序混亂
- [臨] LanceDB_distance平方問題使minScore門檻失效，影響全部vector search效果
- [臨] 閱讀 38 個檔案
- [臨] 閱讀區域: project-catclaw (31), .catclaw-memory (5), .catclaw-catclaw.json (1), .catclaw-workspace (1)

## 關聯

- 意圖分布: design (13), general (5), debug (5), build (1)

## 閱讀軌跡

- 讀 38 檔: src/memory (10), _AIDocs/modules (7), src/workflow (5), src/core (4), .catclaw/memory (4)

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-07 | 自動建立 episodic atom (v2.2) | session:bca82bbc |
