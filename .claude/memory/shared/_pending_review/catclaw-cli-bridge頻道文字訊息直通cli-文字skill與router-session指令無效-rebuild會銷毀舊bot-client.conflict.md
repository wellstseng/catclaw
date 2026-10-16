# Write-time conflict: catclaw-cli-bridge頻道文字訊息直通CLI-文字skill與router-session指令無效-rebuild會銷毀舊bot-client

- Detected-at: 2026-10-16T07:49:10.267Z
- Incoming-author: wellstseng
- Detector: gemma4:e4b
- Pending-review-by: management

## Incoming knowledge

```
[臨] cli-bridge 頻道的文字訊息（handleIndependentBotMessage）不經 skill registry，msg.content 原樣轉給 claude CLI；要在 bridge 頻道加文字指令，必須在 handleIndependentBotMessage 轉發前攔截，掛成 skill 不會被叫到
[臨] 文字 /session clear、Discord /reset-session 只清一般 router 的 SessionManager，對 bridge 的 CLI session 無效；bridge 開新對話要走 Discord 原生 /session action:new 或文字口令（皆呼叫 cli-bridge/index.ts startNewSession）
[臨] bridge 重啟（/restart、自動重啟）只要 cli-bridges.json 仍有 channel sessionId 就 --resume 舊 session，不等於開新對話
[臨] rebuildBridgeForChannel 會 shutdown 舊 bridge → 同 token 共用 bot client refCount 歸零即 destroy；rebuild 之後不能再用原 msg.reply，回覆要在 rebuild 前送，或用新 bridge.getSender().send()
```

## Conflicting existing atoms

- **pitfalls-cli** (layer=`shared:c--projects-catclaw`, similarity=0.757, class=UNSTABLE(UNRELATED))
  preview: �u�M sessionId ���M��x �� Dashboard Memory tab ������¹��
- **codereview-dashboard-ai�����򱵬O��resume������prompt-���s�}�l�~�M������** (layer=`shared:c--projects-tslg-develop`, similarity=0.727, class=CONTRADICT)
  preview: - [�{] �u claude CLI ���ҡ]2.1.x�^�G`claude -p --input-format stream-json --output-format stream-json --resume <id>` ���e���h user 
- **project-structure** (layer=`shared:C--Users-wellstseng--catclaw-workspace`, similarity=0.721, class=UNRELATED)
  preview: ``` �� session.ts (per-channel ��C) �� acp.ts (spawn claude CLI, stream-json) �� reply.ts (��y�^�� Discord)

## Resolution

管理職 `/conflict-review`：
1. 編輯既有 atom 或 incoming — 以消解事實衝突
2. 若 incoming 有獨立價值 → approve（搬草稿到 `shared/`）
3. 若 incoming 錯誤 → reject（僅刪本報告，既有 atom 不動）
