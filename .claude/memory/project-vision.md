---
name: catclaw-project-vision
description: catclaw 專案定位 — 專案知識代理人（Discord bot），團隊成員透過 Discord 頻道向 Claude 詢問專案知識
type: project
---

# catclaw 專案定位

catclaw 的目標是實作**專案知識代理人**（Project Knowledge Agent）。
團隊成員在 Discord 頻道向 bot 提問，bot 透過 Claude CLI 回答專案相關問題。

## 設計決策

- **Session 策略：per-channel**（非 per-user）— 專案知識是共享的，同頻道的人共享上下文
- **使用場景**：多人多頻道皆有，團隊協作為主
- **技術棧**：discord.js + Claude Code CLI（`claude -p --output-format stream-json`）
