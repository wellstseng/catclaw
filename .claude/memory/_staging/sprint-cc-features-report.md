# Claude Code 功能導入 Sprint 報告

> 日期：2026-04-04
> 執行者：朱蒂（Claude Code CLI）
> 模式：AI 自主開發

---

## 總覽

| # | 功能 | 狀態 | 說明 |
|---|------|------|------|
| F1 | Tool Result Snip | ⏭ 已存在 | `truncateToolResult` + 三層 cap 機制已完備 |
| F2 | 壓縮後檔案恢復 | ✅ 新增 | autoCompact 後自動讀取最近 5 個編輯檔案 |
| F3 | Memoization | ⏭ 不需要 | CatClaw per-turn 一次性組裝，架構已自然避免 |
| F4 | Batch Partition | ✅ 新增 | concurrencySafe tool 並行執行 |
| — | CacheSafeParams | ❌ 跳過 | pi-ai 不支援 Anthropic cache_control |
| — | Bridge Mode | ❌ 跳過 | 已有 Discord 作為遠端介面 |
| — | BUDDY | ❌ 跳過 | 純 UI 裝飾，無實用價值 |
| — | Agent Teams | ❌ 跳過 | 架構太大，需另開 Sprint |
| — | Coordinator Mode | ❌ 跳過 | 架構太大，需另開 Sprint |

---

## 已完成功能詳情

### F2: 壓縮後檔案恢復（Post-compact Recovery）

**Commit**: `f700e84`
**檔案**: `src/core/agent-loop.ts`

**機制**:
1. 在 agent-loop 啟動時註冊 `file:modified` 監聽器
2. 追蹤最近 5 個被編輯的檔案路徑（LRU）
3. autoCompact 觸發壓縮後，自動讀取這些檔案的前 30 行
4. 注入為 `[壓縮後恢復]` user message，讓 LLM 知道自己剛才在改什麼

**效果**: 避免 autoCompact 後 LLM 「失憶」，不知道自己剛改了哪些檔案

### F4: Batch Partition（並行 tool 執行）

**Commit**: `f700e84`
**檔案**: `src/core/agent-loop.ts`, `src/tools/types.ts`, 7 個 tool 檔案

**機制**:
1. Tool 介面新增 `concurrencySafe?: boolean` 欄位
2. 7 個唯讀 tool 標記為 `concurrencySafe: true`:
   - read_file, glob, grep, web_fetch, web_search, memory_recall, config_get
3. LLM 一次回傳多個 tool call 時，agent-loop 自動分流：
   - concurrencySafe tool（≥2 個）→ `Promise.all` 並行
   - 寫入 tool → 維持串行
4. 原有的 spawn_subagent 並行邏輯不受影響

**效果**: LLM 同時要求讀 3 個檔案時，3 個 read_file 並行執行，而非串行等待

---

## 附帶修正

### Output Token Recovery — Provider 映射完善

**Commit**: `1b9a2d0` + `f700e84`

所有 provider 現在正確映射 `max_tokens` stop reason：
- `claude-api`: pi-ai `"length"` → `max_tokens`
- `openai-compat`: finish_reason `"length"` → `max_tokens`
- `codex-oauth`: `response.incomplete` → `max_tokens`
- `ollama`: done_reason `"length"` → `max_tokens`

---

## 本次 Session 完整 Commit 歷史

| Commit | 說明 |
|--------|------|
| `fdfb946` | feat(configure): Codex OAuth 登入流程 |
| `1b9a2d0` | feat(agent-loop): Output Token Recovery |
| `f700e84` | feat(agent-loop): Post-compact Recovery + Batch Partition |

---

## Gemma 4 本地模型導入

**狀態**: ✅ 完成

**作業內容**:
1. Ollama 升級 0.18.0 → 0.20.0（使用者手動完成）
2. `ollama pull gemma4` — 9.6GB (12B 參數)
3. `models.json` 新增 gemma4:latest 定義（reasoning: true, multimodal, 32K context）
4. `catclaw.json` 新增別名 `gemma` + modelsConfig 模型定義
5. 測試確認：文字回應 ✅、Native tool calling ✅

**Gemma 4 特性**:
- Google 開源（Apache 2.0）
- 12B 預設、支援 multimodal（text + image）
- 原生 tool use 支援（Ollama tools API）
- 內建 reasoning 能力

---

## 未來可考慮（需另開 Sprint）

1. **Coordinator Mode** — 規劃與執行分離（主 agent 只派工，worker 執行）
2. **Agent Teams** — 多獨立 session 協調（比 subagent 更進階）
3. **Microcompact** — 壓縮時重用舊摘要（需 prompt cache 支援效果最佳）
4. **contextCollapse** — 90% context 時漸進壓縮（比 autoCompact 更精細）
5. **Worktree 隔離** — subagent 在 git worktree 副本工作
