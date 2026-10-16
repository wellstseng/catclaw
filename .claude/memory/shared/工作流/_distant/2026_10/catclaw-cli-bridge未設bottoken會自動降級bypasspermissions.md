# catclaw-cli-bridge未設botToken會自動降級bypassPermissions

- Scope: shared
- Author: wellstseng
- Confidence: [臨]
- Trigger: cli-bridge, botToken, bypassPermissions, dangerouslySkipPermissions, request_permission, main-bot
- Created-at: 2026-10-16

## 知識

- [臨] cli-bridges.json 沒設 botToken（主 bot 共用模式）時，writeMcpConfig 會回傳 null，審批用的 catclaw-bridge-discord MCP 不會注入。這時即使 channel 設了 dangerouslySkipPermissions:false，也會被 fail-soft 降級成 --dangerously-skip-permissions（src/cli-bridge/providers/claude.ts），init 事件的 permissionMode 會是 bypassPermissions。只有設了獨立的 botToken，工具權限才會走 Discord 按鈕審批。

## 行動

- 說明 bridge 權限行為之前，先確認有沒有 botToken，不要只看 dangerouslySkipPermissions


## 演化日誌

| 日期 | 變更 | 來源 |
|------|------|------|
| 2026-10-16 | 退役移入 _distant/：commit 66d7214 後 bridge 權限一律走 --permission-prompt-tool stdio，缺 botToken 不再降級為 bypass；內容已失效，由新 atom 取代 | memory-audit --delete |
