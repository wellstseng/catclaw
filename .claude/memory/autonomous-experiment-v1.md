# 自主開發實驗 V1 — 結果與指南

- Scope: project
- Confidence: [固]
- Trigger: 自主開發, autonomous, harness agent, PM subagent, 實驗指南, AI協作指南
- Last-used: 2026-04-01
- Confirmations: 1

## 知識

### 實驗概述
- 日期：2026-04-01
- 目標：PM（Claude Code）監督 + subagent 執行完整開發週期
- 結果：成功，4 phase 全部完成，commit 23464a0

### Phase 結構（有效模式）
1. Phase 1：Explore subagent 平行盤點（功能清單 + 差距分析）
2. Phase 2：透過 MCP Discord 對 bot 發測試訊息，觀察實際行為
3. Phase 3：PM 直接修改 source code + tsc build + signal/RESTART
4. Phase 4：git commit + 推送 + 向 Wells 回報

### 發現的 Bug（已修復 in 23464a0）
- Bug #1：system prompt 無日期注入 → discord.ts 加 Asia/Taipei 時間
- Bug #2：writeAtom() 不更新 MEMORY.md index → 補 upsertIndex() call
- Bug #3：bash 黑名單缺 eval / shell -c / find -exec / setuid 等 7 條

### 行為觀察（AI 協作陷阱）
- [觀] bot 重啟後讀 channel history，會試圖「重做」已完成的工作 → PM 需主動發「停止」
- [觀] 外部修改 source code 後 bot 不知道 → 驗證時需清楚說明「已由外部完成」
- [觀] spawn_subagent 在 1 turn 就結束是 LLM 行為問題，不是 bug
- [固] 安全邊界測試（對 bot 發危險指令）是可靠的驗證方式

### Harness Agent 概念
- PM = Claude Code session（有 git、fs、MCP 工具）
- Worker = spawn_subagent 或 Explore agent（有限工具）
- 控制點：PM 監控 channel 回應、可發 steer 指令、可直接改 source code
- 失控預防：bot 開始亂跑時發「停止所有動作」立即有效

### 待後續處理
- Session 檔案競態（需加 mutex）
- Upload 目錄定期清理
- Tool loop A→B→A 繞過模式

## 行動

- 下次大型功能開發可複用此 4-phase 結構
- 測試時用 /migrate seed 觸發 LanceDB 重建（Ollama 需在線）
- bot 身份混淆（把自己叫茱蒂而非 CatClaw）：CATCLAW.md identity 強化
