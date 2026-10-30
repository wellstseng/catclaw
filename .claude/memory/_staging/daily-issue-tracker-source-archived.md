# 懸案：daily-issue-tracker cron 來源已封存（待 Wells 裁決）

- 建立：2026-08-10 發現，2026-08-16 落地備忘
- 狀態：**OPEN**，等 Wells 回 A/B/C

## 現狀
cron `daily-issue-tracker` 每日掃 `~/WellsDB/CatClaw議題追蹤/*.md`。該資料夾已於 **2026-08-10（13:45）** 被 Wells 在一次 WellsDB 大重整中移入 `~/WellsDB/封存/`。live 路徑已不存在，cron 每天 glob 抓 no-match 空跑。

## 證據（讀過，非臆測）
- `封存/CatClaw議題追蹤/`：原資料夾原封搬移（那條 `[已回覆]` 議題 + README + attachments + 已處理/）。
- `封存/CatClaw/議題追蹤/`：更舊的 stub（只剩 4/27 README）。
- `find ~/WellsDB -type d -iname '*議題*'` → 只在「封存」下，**無任何 live 位置**。
- 內容未改、無新議題；封存前已 ~2.5 個月零新進件。→ 純封存搬移。

## 待決（2026-08-10 提出，Wells 至今未回）
- **A 退役 cron（建議）**：來源已封存 + 長期零進件，續留只會空跑誤報。
- **B 重指路徑**：若議題追蹤搬到新 live 位置，取得路徑後改 cron 指過去。
- **C 維持現狀**：每天照跑，抓到死路徑回報一行。

## 現行停損（未回前預設 C）
每日 `[ -d ~/WellsDB/CatClaw議題追蹤 ]` 驗證 → 回一行「來源仍封存」。不誤報成正常掃描、不動 cron、不掃封存副本當 live。

## 危險（給未來 session）
**勿**把 `封存/` 下的副本當 live 議題處理——那等於把 Wells 主動封存的東西挖回工作流，違反其整理意圖。

## 裁決後動作
- A → 定位 cron 定義（在 catclaw repo；依 task rule #5「動 cron 核心 = commit 但不 push 留 review」）後停用。
- B → 取得新路徑，改 cron。
- C → 維持。
