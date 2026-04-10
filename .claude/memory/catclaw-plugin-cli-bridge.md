---
name: CatClaw Plugin — Claude CLI 持久 Bridge 設計方向
description: CatClaw 擴充 Claude CLI 持久 bridge，透過 stdin stream-json 持久 process 實現遠端通訊，保留完整原子記憶系統
type: project
---

## 目標

CatClaw 擴充一種新的 agent 類型：**Claude CLI 持久 bridge**。讓朱蒂（Claude CLI + 原子記憶系統）可以透過 CatClaw 的 Discord 介面遠端通訊，不用坐在電腦前。

**Why:** Claude CLI 有完整的原子記憶系統（hooks、guardian、萃取、向量搜尋），這套記憶系統跟著 CLI session 走。現在朱蒂用 `--channels` plugin 運作，但 CatClaw 沒有控制權。改由 CatClaw 驅動後，CatClaw 掌控路由、記錄、生命週期。

**How to apply:** 實作時基於 `--input-format stream-json` 持久模式，不基於舊 acp.ts。

## 已確認設計決策（v3, 2026-04-09）

1. **一個 channel 一個 process** — CLI session 是單對話，多 channel 共用會混亂 context
2. **初期用 `--dangerously-skip-permissions`** — 後續可改為 control_request/response 審批
3. **Inbound History 做為 stdin 前置注入** — 離線期間的訊息用「你離線時有以下訊息...」格式注入
4. **不排隊，直送 stdin** — CLI 自己管內部 queue，CatClaw 只追蹤狀態
5. **中斷用 SIGINT** — 5s 超時 → 重啟 process
6. **Dashboard 控制台** — 即時監控 + 歷程追蹤 + Console 輸入 + 中斷/重啟

## 架構

```
src/cli-bridge/
  types.ts          — CliBridgeEvent, CliBridgeConfig 型別
  process.ts        — CliProcess（持久 child process 封裝，EventEmitter）
  bridge.ts         — CliBridge（生命週期 + 直送 + TurnHandle）
  stdout-log.ts     — StdoutLogger（完整 stdout 日誌）
  index.ts          — 匯出 + 全域單例
```

路由位置：discord.ts 中 Agent Loop 路由之前，依 catclaw.json `cliBridge.channels` 判定。

## 實作進度

| Sprint | 內容 | 狀態 |
|--------|------|------|
| S1 | types.ts + process.ts | 進行中 |
| S2 | bridge.ts + stdout-log.ts | 待開始 |
| S3 | index.ts + config.ts + discord.ts 路由 | 待開始 |
| S4 | handleCliBridgeReply() | 待開始 |
| S5 | Dashboard API + WebSocket | 待開始 |
| S6 | Dashboard Web UI | 待開始 |

## 技術細節

### Claude CLI 持久模式（已驗證可行）

啟動指令：
```bash
claude -p --input-format stream-json --output-format stream-json --verbose --dangerously-skip-permissions
```

stdin NDJSON：
```json
{"type":"user","message":{"role":"user","content":"使用者訊息"}}
{"type":"keep_alive"}
```

stdout events: assistant / result / tool_use_summary / hook_started / hook_response / control_request 等 23+ 種

### 其他 model 不走此路線

Gemini/Codex 等走現有 CatClaw 架構（Agent Loop + Provider / subagent），不需做成持久 CLI bridge。

## 備註

- 舊 `src/acp.ts` 是歷史殘留（spawn `claude -p` one-shot），新設計不基於它
- 溫蒂現走 `core/agent-loop.ts` + Provider 系統，與此 plugin 為並行存在的兩種 agent 類型
- 設計文件完整版：`/tmp/cli-bridge-design-v3.md`（已上傳 Discord）
