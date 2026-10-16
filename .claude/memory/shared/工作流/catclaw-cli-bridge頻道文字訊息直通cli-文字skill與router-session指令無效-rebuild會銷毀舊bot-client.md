# catclaw-cli-bridge頻道文字訊息直通CLI-文字skill與router-session指令無效-rebuild會銷毀舊bot-client

- Scope: shared
- Author: wellstseng
- Source: commit 03fa71c
- Confidence: [臨]
- Trigger: cli-bridge, 開新對話, session new, rebuildBridgeForChannel, startNewSession, /session clear, /reset-session, bridge skill
- Created-at: 2026-10-16
- Decided-by: wellstseng

## 知識

- [臨] cli-bridge 頻道的文字訊息（handleIndependentBotMessage）不經 skill registry，msg.content 原樣轉給 claude CLI；要在 bridge 頻道加文字指令，必須在 handleIndependentBotMessage 轉發前攔截，掛成 skill 不會被叫到
- [臨] 文字 /session clear、Discord /reset-session 只清一般 router 的 SessionManager，對 bridge 的 CLI session 無效；bridge 開新對話要走 Discord 原生 /session action:new 或文字口令（皆呼叫 cli-bridge/index.ts startNewSession）
- [臨] bridge 重啟（/restart、自動重啟）只要 cli-bridges.json 仍有 channel sessionId 就 --resume 舊 session，不等於開新對話
- [臨] rebuildBridgeForChannel 會 shutdown 舊 bridge → 同 token 共用 bot client refCount 歸零即 destroy；rebuild 之後不能再用原 msg.reply，回覆要在 rebuild 前送，或用新 bridge.getSender().send()

## 行動

- bridge 頻道新增文字指令 → 在 handleIndependentBotMessage 攔截，不寫 skill
- rebuild 後的 Discord 回覆走新 bridge sender
