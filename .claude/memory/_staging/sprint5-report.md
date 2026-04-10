# Sprint 5 報告 — CatClaw vs Claude Code 差距補齊

**日期**：2026-04-05
**Commits**：328044f, 1829499
**Branch**：main
**執行者**：朱蒂（Claude Opus 4.6）自主開發模式

---

## 目標

補齊 CatClaw 與 Claude Code 之間的關鍵功能差距，提升完成度從約 65-70% 至更高水準。

---

## 完成項目

### 1. Hook 系統（最高優先）

**做了什麼**：
- 建立 `src/hooks/` 模組（4 個檔案，372 行）
  - `types.ts`：定義 4 種 Hook 事件型別（PreToolUse / PostToolUse / SessionStart / SessionEnd）
  - `hook-runner.ts`：核心執行器，spawn `sh -c` process，stdin 寫 JSON，stdout 讀 JSON
  - `hook-registry.ts`：鏈式執行邏輯 + 全域單例 + config hot-reload
  - `index.ts`：公開介面 re-export

**為什麼做**：
- Hook 系統是 Claude Code 的安全 + 擴展性基石
- 沒有 Hook，使用者無法在 tool 執行前後插入自訂邏輯（審計、過濾、修改）
- 這是差距分析中「影響最大」的缺失功能

**如何做**：
- 設計參考 Claude Code 的 PreToolUse hook：外部 shell command，JSON stdin/stdout
- `runBeforeToolCall()` 從同步改為 async（因 hook 是 async shell command）
- 三個 tool 執行路徑（spawn parallel / concurrencySafe batch / sequential）全部整合
- Hook 定義放在 `catclaw.json` 的 `hooks[]` 欄位，config 的 `RawConfig` 和 `BridgeConfig` 都新增 hooks 欄位
- Config hot-reload 時自動 `hookRegistry.reload()`
- Platform init 時初始化 HookRegistry（即使無 hooks 也初始化空 registry）

**關鍵設計決策**：
- **Fail-open**：Hook timeout / error / 解析失敗 → passthrough（不阻擋 agent loop）
- **Chain semantics**：PreToolUse 第一個 `block` 即中止；`modify` 可改 params 傳遞下一個 hook
- **toolFilter**：可指定只在特定 tool 觸發（避免對每個 tool call 都 spawn process）
- **64KB stdin 限制**：payload 超過 64KB 自動截斷 toolParams

**潛在問題**：
- Hook command 的 subprocess overhead（~10-50ms），但 5s timeout 內可接受
- 大量 hook 配置 × 大量 tool call = 顯著延遲。建議 hook 數量控制在 3-5 個以內
- Hook command 執行時的安全性由使用者負責（CatClaw 不 sandbox hook commands）

**整合點**：
- `src/core/config.ts`：BridgeConfig + RawConfig 新增 `hooks` 欄位，hot-reload 支援
- `src/core/platform.ts`：initPlatform 第 12 步初始化 HookRegistry
- `src/core/agent-loop.ts`：`runBeforeToolCall` 改 async，3 個 tool 執行路徑整合 PreToolUse + PostToolUse

**Config 範例**：
```json
{
  "hooks": [
    {
      "name": "audit-log",
      "event": "PreToolUse",
      "command": "node /path/to/audit-hook.js",
      "timeoutMs": 3000,
      "toolFilter": ["run_command", "write_file"]
    }
  ]
}
```

### 2. /compact 指令

**做了什麼**：
- 新增 `src/skills/builtin/compact.ts`（66 行）
- 對標 Claude Code 的 `/compact` 指令

**為什麼做**：
- Claude Code 使用者可手動觸發 context 壓縮
- CatClaw 雖有 CE 自動策略，但缺乏使用者手動觸發的入口
- `/session compact` 存在但不直覺，`/compact` 更符合 Claude Code 使用者習慣

**如何做**：
- 直接呼叫 ContextEngine.build()，顯示壓縮前後的 messages 數和 token 數
- 未達壓縮門檻時提示使用 `/context` 查看詳細分布

### 3. /context 指令

**做了什麼**：
- 新增 `src/skills/builtin/context.ts`（126 行）
- 對標 Claude Code 的 `/context` 指令

**為什麼做**：
- Claude Code 的 `/context` 讓使用者即時了解 token 消耗分布
- 有助於使用者判斷何時該壓縮或清空 session

**如何做**：
- 統計 user / assistant / tool 三類 token 分布
- 計算 context window 使用率百分比，用 █░ bar 視覺化
- 顯示上次 CE 策略狀態
- 使用率 >80% 警告，>60% 提示

### 4. Dashboard Trace Context Snapshot 圖示

**做了什麼**：
- Trace 表格新增 `Ctx` 欄位，有 Context Snapshot 的 trace 顯示 📋 圖示

**為什麼做**：
- Wells 反映 trace 列表看不出哪些有 context snapshot
- 點擊 trace 行後可展開 context snapshot 細節，但需要先知道哪些有

**如何做**：
- 檢查 `trace.hasContextSnapshot` 欄位，有則顯示 📋 圖示

---

## 測試方式

### 編譯測試
- `tsc --noEmit`：零錯誤
- `npm run build`：成功

### 功能測試（需手動驗證）
1. **Hook 系統**：
   - 在 catclaw.json 加入 hook 設定
   - 驗證 PreToolUse hook 可阻擋或修改 tool params
   - 驗證 PostToolUse hook 可修改 tool result
   - 驗證 hook timeout 不阻擋 agent loop
   
2. **/compact**：
   - 發送幾條訊息累積 session
   - 執行 `/compact`，確認壓縮前後數據正確

3. **/context**：
   - 在有 session 的頻道執行 `/context`
   - 確認 token 分布、使用率 bar、CE 狀態顯示正確

4. **Dashboard Trace Ctx 欄位**：
   - 發送訊息觸發新 trace
   - Dashboard Traces tab 確認 📋 圖示出現

### 測試結果
- 編譯通過 ✅
- Build 成功 ✅
- 已 push 至 GitHub ✅
- 手動功能測試待 Wells 驗證

---

## 統計

| 項目 | 數值 |
|------|------|
| 新增檔案 | 6 |
| 修改檔案 | 4 |
| 新增行數 | +670 |
| 刪除行數 | -15 |

---

## 完成度更新

Hook 系統 + /compact + /context + Dashboard 增強後，估計 CatClaw 完成度從 **65-70%** 提升至約 **73-75%**。

### 剩餘差距（依優先順序）
1. **Pattern-based Permission**（`Bash(git *)` 風格）— 精細權限控制
2. **MCP Client 通用化** — 讓 CatClaw 連接外部 MCP servers
3. **Worktree 隔離** — Subagent 獨立工作目錄
4. **Remote triggers / dispatch** — 從外部觸發 CatClaw 任務
5. **Prompt caching** — API-level cache control 優化
