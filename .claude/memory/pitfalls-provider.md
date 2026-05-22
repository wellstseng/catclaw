---
name: pitfalls-provider
description: Provider stream 設計陷阱 — 缺 idle watchdog 造成 LLM 錯誤時使用者無限等待
type: project
confidence: 觀
date: 2026-05-20
related: pitfalls-cli, architecture
---

## Trigger

- 新增 / 修改 LLM provider
- 「LLM 不回覆」「一直等待」類議題
- rate limit、stream 卡死、turn timeout 異常

## 陷阱：provider stream 缺 idle watchdog

**症狀**：使用者送訊息後 catclaw 永遠等待、不發任何 ⚠️ 錯誤訊息到 Discord。trace 統計顯示 `status:"error"` 為 0 筆（全是 completed / aborted）— 因為 stream finalize 路徑沒走到。

**根因**：provider 端 fetch 回 200、SSE stream 開始解析，但 server 因 rate-limit 軟卡 / 連線僵死**遲遲不送任何 event**。`reader.read()` 永遠 await → callWithRetry 不會 throw → agent-loop 不會 yield error。

**修法（樣板來自 claude-api.ts:329-352）**：

每個 stream-based provider 必須：

1. `const STREAM_IDLE_MS = 60_000`（對齊 claude-api）
2. `lastEventMs` 在 stream 進入後初始化
3. `setInterval(5000)` watchdog 檢查 `Date.now() - lastEventMs > STREAM_IDLE_MS` → 設 `idledOut = true` + `controller.abort()`
4. 在 chunk handler / event loop 內每收到 event 更新 `lastEventMs = Date.now()`
5. try / catch / finally：catch 內若 `idledOut` 為 true → throw 帶 `stream idle timeout` 的清楚錯誤；finally 永遠 clearInterval
6. **watchdog 啟動時機**：response.ok 通過後才 start（避開 fetch 失敗路徑漏 clearInterval）

throw 後路徑：callWithRetry retry 3 次 → 都 idle 就最終 throw → agent-loop catch → yield `{ type: "error" }` → reply-handler 發 ⚠️ 到 Discord。使用者最多等 `maxAttempts × STREAM_IDLE_MS = 3 分鐘`。

## 已實作對照

| provider | 有 idle watchdog | 備註 |
|----------|-----------------|------|
| `claude-api.ts` | ✅ L329-352 | 60s watchdog + child AbortController |
| `codex-oauth.ts` | ✅ 2026-05-20 commit `016e677` | 仿 claude-api |
| `openai-compat.ts` | ❓ 未檢查 | 若也用 SSE stream 須補 |
| `ollama.ts` | ❓ 未檢查 | 同上 |
| `acp-cli.ts` | N/A | 是 CLI spawn 不是 HTTP stream，另有 timeout 機制 |

## 為什麼是 [觀] 不是 [固]

驗證需等 codex rate-limit 實際觸發後觀察 Discord 是否在 1-3 分鐘內收到 ⚠️ 訊息。Restart 後反覆出現驗證一致 → 升 [固]。
