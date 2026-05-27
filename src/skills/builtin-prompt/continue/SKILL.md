description: Use when user says `/continue` or 「續接」 — scans `_staging/next-phase-*.md`, reads selected file, deletes it, and immediately starts the embedded task. Pairs with `/handoff` (write side).

# /continue — 續接暫存任務

> 讀取 staging 區的續接 prompt 並立即執行。輕量版續接，適合已備好下一步的場景。
> 跨 Discord channel / agent 通用 staging。支援多任務並存選擇。

## 使用方式

```
/continue
```

無需輸入參數。多個任務時自動列出選單，選數字即可。

## Step 1: 掃描暫存區

用 **glob tool** 掃描 catclaw 全域 staging：

```
~/.catclaw/workspace/_staging/next-phase-*.md
```

> staging 在 `~/.catclaw/workspace/_staging/`（catclaw 全域 staging，跨 channel / agent 通用）。
> 不像 ~/.claude 是 per-project staging，catclaw 環境用單一 staging 區。

### 分流

- **掃描到 1 個檔案** → 自動選定該檔案，繼續 Step 2
- **掃描到多個檔案** → 列出清單讓使用者**選數字**：

```
_staging/ 下有 N 個待續任務：
  1. tslg-tech-report — [續接] TSLG 御神具技術分析報告
  2. catclaw-skill-port — [續接] catclaw skill port from ~/.claude

請選擇（輸入數字）：
```

> 清單中的名稱取自檔名 `next-phase-{name}.md` 的 `{name}` 部分，摘要取自檔案第一行或前 60 字。

- **掃描到 0 個檔案** → 回覆「沒有待續任務。`~/.catclaw/workspace/_staging/` 下無 `next-phase-*.md` 檔。使用 `/relay` 可從 atoms/git/todo 推斷續接工作。」→ 結束

## Step 2: 讀取並刪除

1. 用 `read_file` 讀取選定檔案的全部內容，記住內容
2. **立即刪除**該檔案（用 `run_command rm` 或對應工具，防止重複執行）

## Step 3: 執行

將讀取到的內容視為**任務 prompt**，立即開始執行。不需要使用者確認，直接動工。

**注意**：如果任務的完成條件中包含「產出下一階段續接 prompt」，在任務完成時用 `write_file` 寫入新的 `next-phase-{name}.md`（保持原任務名稱）。
