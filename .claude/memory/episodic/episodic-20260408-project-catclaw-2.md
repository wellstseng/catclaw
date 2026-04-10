# Session: 2026-04-08 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: catclaw, channel, chat, collab-experiment, continue, core, dashboard, dashboard面板又壞了, discord, doextract, edit, episodic
- Last-used: 2026-04-08
- Created: 2026-04-08
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-02

## 摘要

General-focused session (17 prompts). <channel source="plugin:discord:discord" chat_id="1485277764205547630" message_id="1491320231736381501" user="wellstseng" user_id="480042204346449920" ts="2026-04-08T06:14:10.636Z">
/continue
</channe

## 知識

- [臨] 工作區域: project-catclaw (11 files), tmp-test-edit-guard.mjs (3 files), tmp-test-write-guard.mjs (2 files), tmp-test-failure-recall.mjs (1 files), guardian (1 files)
- [臨] 修改 18 個檔案
- [臨] 引用 atoms: nodejs-ecosystem, toolchain, collab-experiment, fix-escalation, workflow-svn, workflow-rules
- [臨] File Size Guard write_file 拒絕 ≥600KB，邊界 512000B 通過、512001B 拒絕
- [臨] Failure Recall 過濾條件：7天內、minCount≥2、輸出含「⚠️ 已知 tool 陷阱」標記
- [臨] src/core/dashboard.ts 第2634行 pipelineDeleteModel 的 onclick 用單反斜線 \' 造成 SyntaxErr
- [臨] `doExtract`未使用`extraction.model`配置，直接呼叫`getOllamaClient().generate()`無model參數
- [臨] Dashboard需新增Extract模型選擇器，沿用Embedding選擇器的UI模式
- [臨] pipeline API的PUT handler需新增處理`extraction`配置的邏輯
- [臨] 閱讀 14 個檔案
- [臨] 閱讀區域: project-catclaw (13), settings.json (1)
- [臨] 版控查詢 3 次
- [臨] 覆轍信號: same_file_3x:test-edit-guard.mjs, same_file_3x:dashboard.ts, same_file_3x:dashboard.md, retry_escalation

## 關聯

- 意圖分布: general (15), debug (2)
- Referenced atoms: nodejs-ecosystem, toolchain, collab-experiment, fix-escalation, workflow-svn, workflow-rules

## 閱讀軌跡

- 讀 14 檔: src/core (3), tools/builtin (2), src/workflow (2), _AIDocs/modules (2), memory/_staging (1)
- 版控查詢 3 次

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-08 | 自動建立 episodic atom (v2.2) | session:69c3506f |
