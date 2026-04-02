# Next Phase — Sprint 4 計畫（2026-04-02 更新）

> 前情：Sprint 3（S3-後期）已完成，詳見 `sprint3-final-report.md`

## Sprint 3 全部完成（截至 2026-04-02）

### S3-前期完成項目
- ✅ Subagent cascade abort
- ✅ /stop + queue clear + /clear skill
- ✅ web_fetch + web_search（DuckDuckGo）
- ✅ Exec-approval：Discord buttons + allowedPatterns whitelist
- ✅ interruptOnNewMessage per-channel
- ✅ MCP client：外部 server stdio JSON-RPC
- ✅ Image Vision：Discord 圖片 base64 → LLM
- ✅ External skills dir：~/.catclaw/skills/ 自動載入
- ✅ 原子記憶系統移植驗證

### S3-後期完成項目
- ✅ Streaming reply（live-edit 串流回覆）
- ✅ Provider mode 欄位（token/api/password）
- ✅ MODEL_ALIASES（claude-haiku/sonnet/opus → 完整 ID）
- ✅ Password mode（HTTP Basic Auth）for Ollama + OpenAI-compat
- ✅ Provider modelId 公開（/status /use 顯示）
- ✅ autoThread per-channel
- ✅ /system skill

---

## Sprint 4 候選（尚未確認優先序）

| 優先 | 項目 | 說明 |
|------|------|------|
| 高 | **platform-rebuild merge to main** | 126 commits ahead，確認穩定後 merge |
| 高 | **觀測性強化** | /stats 指令、crash 自動 Discord 通知、per-session token 用量 |
| 中 | **Discord UX 改善** | 長回應分頁、reaction 控制 tool call（✅確認/❌取消）、進度條 |
| 中 | **Pending 清理** | MCP plugin bot 帳號配對、LanceDB migration |
| 低 | **Multi-provider 健康監控** | /status 顯示所有 provider 狀態 + latency |

## 待確認（需 Wells 決策）
- Sprint 4 優先序：Wells 有特定方向嗎？
- platform-rebuild merge 時機：確認穩定了嗎？
