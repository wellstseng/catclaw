# Session: 2026-04-04 .catclaw-models-config.json

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: .catclaw, channel, chat, codex, config, config.json, dashboard有嗎, decisions-architecture, defaultmodel, discord, episodic, json
- Last-used: 2026-04-04
- Created: 2026-04-04
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-04-28

## 摘要

Build-focused session (3 prompts). /resume

## 知識

- [臨] 工作區域: .catclaw-models-config.json (1 files)
- [臨] 修改 1 個檔案
- [臨] 引用 atoms: nodejs-ecosystem, toolchain-ollama, toolchain, decisions-architecture
- [臨] models-config.json與models.json中ollama/openai-codex的models陣列存在重複，設計上前者為使用者設定、後者為完
- [臨] embeddingModel欄位為必要配置，defaultModel可省略但保留更安全
- [臨] session key 前綴使用 discord:ch:，專屬於 S-V2-6 平台
- [臨] BUILTIN_PROVIDERS 內建 openai-codex（含 gpt-5.4）但不包含 ollama
- [臨] models-config.json 中 openai-codex 的 models 陣列可移除（BUILTIN 已重複），ollama 的 models 陣列
- [臨] 閱讀 9 個檔案
- [臨] 閱讀區域: project-catclaw (7), projects (1), .catclaw-models-config.json (1)

## 關聯

- 意圖分布: build (2), general (1)
- Referenced atoms: nodejs-ecosystem, toolchain-ollama, toolchain, decisions-architecture

## 閱讀軌跡

- 讀 9 檔: memory/_staging (4), src/core (2), memory/episodic (1), wellstseng/.catclaw (1), src/providers (1)

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-04 | 自動建立 episodic atom (v2.2) | session:9c713e3d |
