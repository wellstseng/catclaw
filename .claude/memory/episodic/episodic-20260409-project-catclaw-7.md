# Session: 2026-04-09 project-catclaw

- Scope: project:-users-wellstseng-project-catclaw
- Confidence: [臨]
- Type: episodic
- Trigger: account, admin, agent, agentconfig, agentid, agentpersonaconfig, agents, agent一定要有subagent可選, agent會不會比較好分辨, behavior, catclaw, claude
- Last-used: 2026-04-09
- Created: 2026-04-09
- Confirmations: 0
- TTL: 24d
- Expires-at: 2026-05-03

## 摘要

General-focused session (18 prompts). /continue 先討論記憶處理

## 知識

- [臨] 工作區域: project-catclaw (28 files)
- [臨] 修改 28 個檔案
- [臨] MemoryLayer 增加 'persona' 層，RecallContext 加 personaId?，persona agent 搜 global + p
- [臨] persona memory dir 在 spawn 時用 mkdirSync(recursive) 建立，避免 agent 寫入 edge case
- [臨] saveToMemory 路徑邏輯：有 personaId → ${workspaceDir}/memory/persona/${personaId}/，無則維
- [臨] 系統用 namespace 隔離記憶，每個 namespace 對應 LanceDB 獨立 table，如 global/project__catclaw/ac
- [臨] persona agent recall 時搜 global + persona 兩層，寫入只進 persona namespace，不讀 project/ac
- [臨] global 記憶層路徑為 ~/.claude/memory/，專案層為 {project}/.claude/memory/，帳號層按 accountId 分檔
- [臨] persona agent 回憶時預設搜尋 global + persona，但建議改為 project + persona 以提高相關性
- [臨] CatClaw 記憶層分為 global/project/account/persona 四層，persona agent 搜尋範圍包含全部四層但寫入只限 pe
- [臨] ~/.catclaw/memory/ 目前所有記憶（如 team-roster、投資系統）都混在 global 層，未使用 project 子目錄
- [臨] investor-agent-behavior.md 等 agent 規則目前存於 global 層，未實現 persona 隔離
- [臨] 採用 global/account/persona 三層結構，不拆 project 層。理由：project 記憶已綁定 account，且目前無多人共用 bo
- [臨] recall 範圍固定公式：global + account(當前使用者) + persona(若為 agent context)
- [臨] 寫入歸類規則：平台規則→global，個人相關→account，agent 知識→persona
- [臨] CatClaw 的 memory 三層 (global/account/persona) 管理自身記憶，專案知識庫 (_AIDocs) 作為外部唯讀查閱源，不寫
- [臨] 記憶分層架構：global（~/.catclaw/memory/）、account（accounts/{id}/）、persona（agents/{agentI
- [臨] recall 公式確認：persona agent 搜尋 global + account + persona 三層，非僅 global + persona
- [臨] spawn-subagent.ts 新增 mkdirSync 建立 persona memory dir，saveToMemory 改寫入 persona di
- [臨] agent 與 subagent 身份差異在於是否有 agents/{id}/ 目錄，subagent 用獨立目錄但無 agent 身份
- [臨] ToolContext 中 agentId 欄位同時用於 top-level agent 與 spawn 出的 subagent
- [臨] 變數名稱重整：personaId → agentId，AgentPersonaConfig → AgentConfig，personaSystemPrompt 
- [臨] agent 與 subagent 差異僅在生命週期：agent 獨立持久，subagent 跟 parent 綁定。兩者皆有身份/記憶/設定
- [臨] rename 涉及 55 處 7 個檔案：personaId → agentId，AgentPersonaConfig → AgentConfig 等
- [臨] agent 和 subagent 共用 AgentConfig，spawn 時指定 agent 身份取代 persona
- [臨] ToolContext 的 personaId 改為 agentId，語意為「當前身份 ID」
- [臨] loadAgentConfig 改為 loadAgentBootConfig（啟動合併配置），loadPersonaConfig 接手原名稱
- [臨] spawn-subagent.ts 中 spawn 參數 persona → agent，session key persona: → agent:，check
- [臨] agent-loader.ts 重命名 loadAgentConfig → loadAgentBootConfig，loadPersonaConfig → lo
- [臨] config.ts 中 AgentPersonaConfig 重命名為 AgentConfig，types.ts/guard.ts/subagent-regis
- [臨] 閱讀 20 個檔案
- [臨] 閱讀區域: project-catclaw (16), .catclaw-workspace (2), .catclaw-memory (1), planning (1)
- [臨] 版控查詢 2 次
- [臨] 覆轍信號: same_file_3x:agent-loader.ts, same_file_3x:guard.ts, same_file_3x:spawn-subagent.ts, retry_escalation

## 關聯

- 意圖分布: general (13), build (3), debug (1), design (1)

## 閱讀軌跡

- 讀 20 檔: _AIDocs/modules (4), src/core (3), src/memory (2), .catclaw/workspace (2), memory/_staging (1)
- 版控查詢 2 次

## 行動

- session 自動摘要，TTL 24d 後自動淘汰
- 若需長期保留特定知識，應遷移至專屬 atom

## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-04-09 | 自動建立 episodic atom (v2.2) | session:9fe89dc9 |
