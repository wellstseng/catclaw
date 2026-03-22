# PM2 進程管理 + 重啟機制

> 檔案：`catclaw.js`、`ecosystem.config.cjs`

## 概述

CatClaw 使用 PM2 做進程管理。透過 signal file 機制觸發重啟，tsc 編譯不會自動重啟。

## 檔案

| 檔案 | 用途 |
|------|------|
| `catclaw.js` | 跨平台管理腳本（start/stop/restart/logs/status） |
| `ecosystem.config.cjs` | PM2 設定（watch signal/ 目錄） |
| `signal/RESTART` | 重啟信號檔（JSON: `{channelId, time}`） |

## 管理指令

```bash
node catclaw.js start                    # tsc 編譯 + pm2 start ecosystem.config.cjs
node catclaw.js stop                     # pm2 stop catclaw
node catclaw.js restart                  # tsc 編譯 + 寫 signal/RESTART 觸發重啟
node catclaw.js logs                     # pm2 logs catclaw
node catclaw.js status                   # pm2 status
node catclaw.js reset-session            # 清除所有 channel 的 session（sessions.json）
node catclaw.js reset-session <channelId> # 只清除指定 channel 的 session
```

### reset-session 細節

- 讀取 `CATCLAW_WORKSPACE` 環境變數定位 `sessions.json`（未設定則 fallback 到 `~/.catclaw/workspace`）
- 路徑：`<CATCLAW_WORKSPACE>/data/sessions.json`
- 指定 channelId：只刪除對應 key，其他 session 保留
- 不指定：覆寫整個 sessions.json 為 `{ sessions: {} }`
- bot 不需重啟即可生效（下次訊息自動開新 session）

## 重啟機制

```
編譯程式碼 → tsc → dist/ 更新（不觸發重啟）
                     ↓
            使用者確認重啟
                     ↓
       寫入 signal/RESTART（帶 channelId）
                     ↓
       PM2 偵測 signal/ 目錄變更 → 重啟進程
                     ↓
       index.ts ready 事件讀 signal/RESTART
                     ↓
       在觸發頻道發送 [CatClaw] 已重啟（時間）
                     ↓
       刪除 signal/RESTART（防重複通知）
```

## ecosystem.config.cjs

```javascript
module.exports = {
  apps: [{
    name: "catclaw",
    script: "dist/index.js",
    watch: ["signal"],      // 只監聽 signal/ 目錄
    watch_delay: 1000,
    autorestart: true,
  }]
};
```

> NOTE: tsc 編譯到 dist/ 不會觸發重啟，因為 PM2 只監聽 signal/ 目錄。

## triggerRestart(channelId?)

`catclaw.js` 中的函式，寫入 signal file：

```json
{ "channelId": "123456789", "time": "2026-03-20T22:00:00+08:00" }
```

- channelId 來源：`CATCLAW_CHANNEL_ID` 環境變數（由 acp.ts spawn 時設定）
- 手動執行 `node catclaw.js restart` 時無 channelId（不通知）

## 首次部署注意

首次使用 `node catclaw.js start` 啟動即可。
若修改了 `ecosystem.config.cjs`，需先 `npx pm2 delete catclaw` 再 `start`（PM2 `stop` 不會重讀 config）。
