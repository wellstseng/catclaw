# Session: 2026-04-07 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: .catclaw, abc都做你覺得可以符合catclaw的目標嗎, atom, bonus, byterover, catclaw, collab-anchor, collab-experiment, computeactivation, consolidate, context, cosine
- Last-used: 2026-04-07
- Created: 2026-04-07
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-01

## 摘要

General-focused session (8 prompts). abc都做你覺得可以符合catclaw的目標嗎？

## 知識

- [臨] 工作區域: project-catclaw (13 files), planning (1 files), .catclaw-memory (1 files)
- [臨] 修改 15 個檔案
- [臨] 引用 atoms: collab-anchor, reference-claudecode, collab-experiment, preferences, decisions, workflow-rules, toolchain, toolchain-ollama, workflow-svn, workflow-icld
- [臨] ACT-R 的 computeActivation 函式會取代 consolidate.ts L26 的 decayScore，統一用 ACT-R 數學模型計算
- [臨] 測試策略直接測試 matchTriggers、computeActivation 兩個純函式，並模擬 Step 5/6 驗證 keyword bonus、ACT
- [臨] A-MEM dynamic links 需在 extract.ts 新增向量相似度比對邏輯，自動填入 related 欄位，需 vector service 穩
- [臨] ACT-R→consolidate方案減少複雜度，30行改動純內部重構，符合「簡單可控」目標
- [臨] A-MEM dynamic links需額外運行vector search，增加延遲與複雜度，20-30個atom手動維護related足夠
- [臨] ByteRover Context Tree需300+行重構，5級progressive retrieval過度設計，違反「禁止過早抽象」原則
- [臨] 排序邏輯調整為 0.7×cosine + 0.3×ACT-R + keyword bonus，向量搜尋仍為唯一候選來源
- [臨] MEMORY.md 兼任 atom 登記簿與排序加分器（+0.15），但 keyword match 無法產生新候選
- [臨] +0.15 bonus 只影響 cosine 差距 <0.15 的邊緣案例，通常不改變排序結果
- [臨] MEMORY.md 是索引文件，atom .md 檔是 ground truth，LanceDB 是可丟棄的加速層
- [臨] /migrate rebuild 只重建 MEMORY.md，engine.rebuildIndex() 不會從 .md 重新 embed
- [臨] 缺乏「遍歷所有 atom .md → embedOne → upsert」的全量重建工具，建議新增 vector resync 指令
- [臨] 向量寫入使用 fire-and-forget 模式（atom.ts:L250），失敗不阻擋 MD 檔寫入
- [臨] 向量庫離線時不會 fallback 到 MEMORY.md keyword match（recall.ts:L37）
- [臨] /migrate vector-resync 子命令需遍歷 global/project/account 目錄執行 seedFromDir
- [臨] 閱讀 15 個檔案
- [臨] 閱讀區域: project-catclaw (14), .catclaw-memory (1)
- [臨] 覆轍信號: same_file_3x:recall-smoke.mjs, same_file_3x:recall.ts, same_file_3x:migrate.ts, retry_escalation

## 關聯

- 意圖分布: general (7), build (1)
- Referenced atoms: collab-anchor, reference-claudecode, collab-experiment, preferences, decisions, workflow-rules, toolchain, toolchain-ollama, workflow-svn, workflow-icld

## 閱讀軌跡

- 讀 15 檔: src/memory (6), project/catclaw (2), src/core (2), memory/_staging (1), skills/builtin (1)

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-07 | 自動建立 episodic atom (v2.2) | session:69da0317 |
