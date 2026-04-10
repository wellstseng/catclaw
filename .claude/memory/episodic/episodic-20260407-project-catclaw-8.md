# Session: 2026-04-07 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: atom, atoms, byterover, cache, catclaw, catclaw有精簡過, claude, collab-anchor, computeactivation, config, cosine, current
- Last-used: 2026-04-07
- Created: 2026-04-07
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-01

## 摘要

General-focused session (8 prompts). <ide_opened_file>The user opened the file /Users/wellstseng/.catclaw/models-config.json in the IDE. This may or may not be related to the current task.</ide_opened_file>
目前系統跟原子記憶的差異有哪些

## 知識

- [臨] 工作區域: project-catclaw (8 files)
- [臨] 修改 8 個檔案
- [臨] 引用 atoms: collab-anchor, decisions, decisions-architecture, preferences, toolchain, toolchain-ollama, feedback-memory-path, workflow-rules, workflow-svn, workflow-icld
- [臨] 原子記憶 v2.11 有分層衰減機制：[臨]30d/[觀]60d/[固]90d → _distant/
- [臨] 原子系統 Hook 管線有 7 個事件：SessionStart/UserPromptSubmit/PostToolUse/Stop/SessionEnd 等
- [臨] 全域 atoms 存於 ~/.claude/memory/，內建系統存於 ~/.claude/projects/{slug}/memory/
- [臨] CatClaw Session Memory（對話筆記員）是規格未要求的獨有功能，實作於 session-memory.ts
- [臨] Vector 搜尋僅使用 LanceDB cosine metric，已移除 keyword+ranked hybrid 模式
- [臨] Recall Cache 采用 Jaccard ≥ 0.7 且 60s TTL 的雙重條件觸發機制
- [臨] ACT-R computeActivation() 已實作在 src/memory/atom.ts:272，但 context-builder 和 recall
- [臨] ByteRover 的 progressive retrieval 目前只實現 1 級（vector search），而規格的 Hybrid（keyword →
- [臨] A-MEM dynamic links 可透過 recall 後讀取 atom 的 related 欄位（score 打折）實現基礎版，無需新依賴
- [臨] ACT-R 接線在 recall.ts Step 4 排序，finalScore = 0.7×cosine + 0.3×activation_norm
- [臨] Related-Edge Spreading 在 Step 4 之後對 top-N 結果的 related atom 展開，score ×0.6 折扣
- [臨] Progressive Retrieval 在 Step 2 前加 keyword 快篩（matchTriggers），命中 atom 直接進結果池（score
- [臨] recall.ts 管線從 5 步 Vector-Only 升級為 7 步 Progressive Hybrid，新增 keyword 快篩、ACT-R 混合排
- [臨] KEYWORD_BONUS = 0.15，COSINE_WEIGHT = 0.7，ACTIVATION_WEIGHT = 0.3，RELATED_SCORE_D
- [臨] 閱讀 17 個檔案
- [臨] 閱讀區域: project-catclaw (14), memory-system (1), projects (1), .catclaw-memory (1)
- [臨] 版控查詢 3 次
- [臨] 覆轍信號: same_file_3x:recall.ts, same_file_3x:memory-engine.md, retry_escalation

## 關聯

- 意圖分布: general (7), build (1)
- Referenced atoms: collab-anchor, decisions, decisions-architecture, preferences, toolchain, toolchain-ollama, feedback-memory-path, workflow-rules, workflow-svn, workflow-icld

## 閱讀軌跡

- 讀 17 檔: src/memory (10), memory/_reference (1), -Users-wellstseng-project-catclaw/memory (1), src/workflow (1), tools/builtin (1)
- 版控查詢 3 次

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-07 | 自動建立 episodic atom (v2.2) | session:02d4a751 |
