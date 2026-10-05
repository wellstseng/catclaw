# ai-github-catclaw-integration-5

- Scope: shared
- Confidence: [固]
- Trigger: catclaw github, github integration, AI code review, github webhook, catclaw agent github
- Created-at: 2026-05-21
- Related: ai-github-mcp-server-1, ai-github-actions-llm-2, ai-github-autonomous-agents-3, code-review-pre-review-web

## 知識

# CatClaw × GitHub 工具整合方案

### 整合架構圖

```
CatClaw（朱蒂/溫蒂）
    ↓ MCP Protocol
GitHub MCP Server（oauth認證）
    ↓
GitHub: Issues / PRs / Actions / Security

GitHub Events（PR/Issue webhook）
    ↓ Webhook
CatClaw HTTP Endpoint
    ↓ Agent 分析
AI Review 結果 → 預審網頁 → 人工確認 → Redmine
```

### 優先整合順序

### ⭐⭐⭐ 第一優先：GitHub MCP Server
- **工作量**：低（設定 MCP server URL + OAuth）
- **效益**：Agent 直接操作 GitHub，無需寫 API 程式碼
- **設定**：catclaw.json 加入 MCP server 設定
  ```json
  { "url": "https://api.githubcopilot.com/mcp/", "toolsets": ["context","issues","pull_requests","actions"] }
  ```

### ⭐⭐⭐ 第二優先：PR Webhook → AI Review → 預審網頁
- 對應 `code-review-pre-review-web` 規劃
- GitHub webhook → CatClaw → LLM 分析 → 預審頁面
- 人工勾選 + 填「不採用原因」→ 上 Redmine
- 不採用原因存入知識庫

### ⭐⭐ 第三優先：GitHub Actions + GitHub Models
- 在 CI 加入 AI 步驟（代碼 review、文件檢查）
- 費用低，GitHub Models free quota 夠用

### ⭐ 未來選項：OpenHands 整合
- 當需要「自主解決複雜 Issue」時考慮
- 可串接 CatClaw 觸發 OpenHands 執行任務

### 安全邊界原則（必須遵守）

1. AI Agent 只能推 `copilot/*` 或 `ai/*` 等專屬分支
2. PR merge 永遠需要人工確認
3. CI/CD 觸發需要人工審核閘
4. GitHub MCP 預設使用唯讀模式，需要時才開寫入

### 朱蒂可以立即做的事（透過 GitHub MCP）

- "查看今天 catclaw repo 有哪些待 review 的 PR"
- "幫我開一個 Issue，描述這個 Bug：..."
- "分析最近一次 CI 失敗的原因"
- "列出所有 critical Dependabot 警告"

### 溫蒂可以做的事（監控/摘要）

- 定期摘要 GitHub Issues 狀態
- 通知有新的 PR 需要 review
- 追蹤技術債 Issues 的進度

## 行動

- （依知識內容判斷）
