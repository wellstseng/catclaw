# Write-time conflict: catclaw-cli-bridge權限一律走stdio-control-request-botToken只影響discord工具不再降級

- Detected-at: 2026-10-16T05:09:54.681Z
- Incoming-author: wellstseng
- Detector: gemma4:e4b
- Pending-review-by: management

## Incoming knowledge

```
[臨] 2026-10-16 起 cli-bridge 的 Claude spawn 固定帶 `--permission-prompt-tool stdio` + `--allowedTools TaskCreate,TaskUpdate,TaskList,TaskGet`；`dangerouslySkipPermissions` 只決定要不要加 `--dangerously-skip-permissions`。缺 botToken 只是不載 `--mcp-config`（CLI 內少 `discord` 工具），不再影響權限模式。舊的 MCP `request_permission` 路徑與 discord-server 的 Gateway 登入已刪，discord-server.ts 現為 REST-only。
[臨] 權限互動全在 `src/cli-bridge/control-request.ts`：AskUserQuestion → 每題一個 StringSelectMenu（「其他」開 modal）、ExitPlanMode → 核准／退回（退回 modal 填意見成為 deny message）、其他工具 → 允許／拒絕。只有觸發 turn 的使用者能按；逃時 `CATCLAW_PERMISSION_TIMEOUT_MS`（預設 10 分鐘）deny；dashboard / cron 來源的 turn 由 bridge.ts 直接 deny。
```

## Conflicting existing atoms

- **catclaw-cli-bridge���]bottoken�|�۰ʭ���bypasspermissions** (layer=`shared:c--projects-catclaw`, similarity=0.826, class=CONTRADICT)
  preview: - [�{] cli-bridges.json �S�] botToken�]�D bot �@�μҦ��^�ɡAwriteMcpConfig �|�^�� null�A�f��Ϊ� catclaw-bridge-discord MCP ���|�`�J�C�o�ɧY�� channe
- **claude-cli-stream-json���V�|��-�v���ШD�npermission-prompt-tool-stdio�[initialize����-�ʤ@�N�۰ʩڵ�** (layer=`shared:c--projects-tslg-develop`, similarity=0.802, class=AGREE)
  preview: - [�{] `--permission-mode bypassPermissions` �U�������ݡ]tool_result_meta.permission_decision reason_type=mode�^�A�� `--disallowed
- **claude-p-permission-prompt-tool-stdio��w-control-request�arequest-id�Prequesttool-name-�^��behavior�Pupdatedinput** (layer=`global`, similarity=0.798, class=UNSTABLE(AGREE))
  preview: - [�{] �Y�ϥ[�F `--dangerously-skip-permissions`�AAskUserQuestion / ExitPlanMode ���|�o control_request�]requires_user_interaction

## Resolution

管理職 `/conflict-review`：
1. 編輯既有 atom 或 incoming — 以消解事實衝突
2. 若 incoming 有獨立價值 → approve（搬草稿到 `shared/`）
3. 若 incoming 錯誤 → reject（僅刪本報告，既有 atom 不動）
