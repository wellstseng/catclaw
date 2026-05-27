description: Use when user says `/relay [next-step instruction]` — auto-collects in-progress work from todos / git / atoms, generates a self-contained handoff prompt, writes to staging for `/continue` to pick up later. Catclaw 版的 ~/.claude /resume（命名改避混淆）。

# /relay — 自動續接 Prompt 產生器

> 自動從 todos / git / atoms 推斷可續接工作，生成 self-contained prompt 並存入 staging。
> 跟 ~/.claude `/resume` 對等，命名改 `/relay` 避免跟 catclaw cli-bridge resume 概念混淆。
> 配對：`/handoff`（手寫端）/ `/continue`（讀取端）。

## 使用方式

```
/relay [下一步指示]
```

### 參數

| 參數 | 必填 | 說明 | 範例 |
|------|------|------|------|
| 下一步指示 | 否 | 明確指定下次要做什麼（省略則自動推斷） | `繼續寫 御神具技術報告 Chapter 5-10` |

### 使用範例

```
/relay
/relay 繼續實作 catclaw skill port，從 /relay 收尾開始
/relay 接續 TSLG 御神具技術報告 Chapter 5
```

## Step 1: 收集可續接的工作

掃描以下來源：

1. **進行中的 atoms** — 用 `glob` 掃 `~/.catclaw/memory/**/*.md` 找標記 🔄 或 「進行中」的 atom
2. **任務清單** — 檢查 `task_manage` tool 取現有 todo（未完成項）
3. **最近 git 變更** — `git status` + `git log --oneline -5`
4. **既有 staging** — 用 `glob` 掃 `~/.catclaw/workspace/_staging/next-phase-*.md` 看是否有未消化任務

### 分流邏輯

- **有 $ARGUMENTS** → 直接以 $ARGUMENTS 為下一步指示，跳到 Step 2
- **無 $ARGUMENTS** → 列出所有找到的可續接工作，等待使用者選擇後再繼續：

```
找到 N 個可續接的工作：
  1. [tslg-tech-report] 御神具技術報告 Chapter 5-10 未完成（🔄）
  2. [catclaw-skill-port] /handoff /continue /relay 三 skill port（進行中）
  3. [最近 commit] feat(agent-loop) Preemptive Long-Task Detection（49f09f5）

請選擇（數字），或輸入新的指示：
```

- **無 $ARGUMENTS 且無任何可續接工作** → 提示「找不到未完成的工作，請指定下一步」，結束

## Step 2: 彙整工作狀態

根據選定的工作（來自使用者選擇或 $ARGUMENTS），彙整：
- **已完成**：本 session 完成了什麼（1-3 句）
- **下一步**：接下來要做什麼（具體步驟）
- **關鍵上下文**：新 session 需要知道的檔案路徑、決策、注意事項

## Step 3: 生成續接 Prompt

根據 Step 2 的彙整，生成一個**自包含**的續接 prompt。格式：

```
[續接] {任務名稱}

## 背景
{1-3 句說明這個任務的來龍去脈}

## 已完成
{上一個 session 做完的事，條列}

## 本階段目標
{這個 session 要完成的具體步驟，條列}

## 關鍵上下文
- 相關檔案：{路徑列表}
- 注意事項：{任何新 session 需要知道的坑點或決策}
- commit hash（若有）：{前 8 碼}

## 完成條件
{怎樣算完成，包括驗證方式}

完成後請執行：驗證 → 上 GIT → 如有下一階段則再次 /relay
```

**重要**：prompt 必須自包含——新 session 不會有當前 session 的 context，所有必要資訊都要寫進去。

## Step 4: 確認 + 顯示給使用者

將生成的 prompt 顯示給使用者，等待確認或調整：

```
續接 prompt 已準備好：

[續接] {任務名稱}
...

下一步：
  A. 我立刻把它存到 staging → 用 `/continue` 啟動
  B. 你直接複製貼到新對話 / 新 channel 開始
  C. 我繼續調整內容
```

## Step 5: 寫入 Staging

使用者確認後（選 A），決定檔案名稱並用 `write_file` 寫入：

```
~/.catclaw/workspace/_staging/next-phase-{name}.md
```

`{name}` 的決定順序：
1. **有顯式 `--name` 或使用者指定** → 直接使用
2. **無** → 從 Step 3 任務名稱自動推導短名（英文小寫、空格換 `-`、去除特殊字元、不超過 40 字元）
3. 推導後**顯示檔名讓使用者確認**：「將存為 next-phase-{name}.md，OK？」

若同名檔已存在，顯示舊內容第一行並詢問是否覆蓋。

## Step 6: 回報

```
✅ 續接 prompt 已存入 staging：
   ~/.catclaw/workspace/_staging/next-phase-{name}.md

下一步：
- 同 channel：`/clear` 後輸入 `/continue` 自動讀取
- 新 channel / 別 agent：複製 prompt 內容貼上
- 跨機器（公司電腦）：git pull → `/continue` 讀取
```

## catclaw 環境差異（vs ~/.claude /resume）

| 項目 | ~/.claude /resume | catclaw /relay |
|------|-------------------|---------------|
| 自動開新 session | ✅ MCPControl VS Code | ❌ 不適用（catclaw 是 Discord） |
| Staging 路徑 | `~/.claude/projects/{slug}/memory/_staging/` | `~/.catclaw/workspace/_staging/` |
| 跨 project 隔離 | ✅ per-slug | ❌ 全域 staging（catclaw 走 channel 隔離） |
| 命名 | /resume | /relay（避免跟 cli-bridge resume 混淆） |

catclaw 沒有 VS Code 自動開新 session 的部分（走 Discord）— 使用者自己 `/clear` 或開新 channel 後用 `/continue` 銜接。
