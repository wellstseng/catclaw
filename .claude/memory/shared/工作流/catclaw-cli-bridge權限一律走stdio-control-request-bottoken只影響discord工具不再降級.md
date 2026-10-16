# catclaw-cli-bridge權限一律走stdio-control-request-botToken只影響discord工具不再降級

- Scope: shared
- Author: wellstseng
- Source: commit 66d7214
- Confidence: [臨]
- Trigger: cli-bridge, botToken, bypassPermissions, dangerouslySkipPermissions, control-request.ts, main-bot
- Created-at: 2026-10-16
- Related: claude-p-permission-prompt-tool-stdio協定-control-request帶request-id與requesttool-name-回覆behavior與updatedinput

## 知識

- [臨] cli-bridge 的 Claude spawn 固定帶 `--permission-prompt-tool stdio` + `--allowedTools TaskCreate,TaskUpdate,TaskList,TaskGet`；`dangerouslySkipPermissions` 只決定要不要加 `--dangerously-skip-permissions`。缺 botToken 只是不載 `--mcp-config`（CLI 內少 `discord` 工具），不影響權限模式。discord-server.ts 是 REST-only，沒有 request_permission。
- [臨] 權限互動全在 `src/cli-bridge/control-request.ts`：AskUserQuestion → 每題一個 StringSelectMenu（「其他」開 modal）、ExitPlanMode → 核准／退回（退回 modal 填意見成為 deny message）、其他工具 → 允許／拒絕。只有觸發 turn 的使用者能按；逾時 `CATCLAW_PERMISSION_TIMEOUT_MS`（預設 10 分鐘）deny；dashboard / cron 來源的 turn 由 bridge.ts 直接 deny。

## 行動

- 改 bridge 權限行為先看 control-request.ts 與 providers/claude.ts buildSpawn
