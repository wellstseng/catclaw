description: Use when user requests next-session handoff prompt / 寫續接 prompt / 交接 — produces a 6-block self-sufficient prompt that the next session can run blind. Pairs with `/continue` (read side).

# /handoff — 跨 Session Handoff Prompt Builder

> 強制 6 區塊 self-sufficient 模板，避免下 session 裸奔。
> 與 `/continue`（讀取端）配對：本 skill 是寫入端。

## 觸發

使用者要求「給下 session 的 prompt」「續接 prompt」「交接」「寫 next-phase」「handoff」時主動執行。
若使用者已徒手寫，主動對照 6 區塊清單並補齊缺項。

## 核心原則

**讀者 ≠ 當下對話者**。下個 Claude / Discord session 沒有看到本次對話的任何內容。
凡是「我們剛才討論的」「之前說的」「那個方法」這類代詞，下個讀者都無法解析。

## 必填 6 區塊（缺一拒絕完成）

### 1.【前置脈絡】
- 專案根目錄絕對路徑（例：`C:/Projects/TSLG`）
- 工作分支 / 工作目錄
- 為什麼做這件事（**含 why**，不只 what）

### 2.【已完成】
- Phase 編號或階段名稱
- commit hash（前 8 碼）+ push 狀態
- 已通過的驗證（測試/編譯/手測）

### 3.【權威來源】
- 檔案路徑:行號清單
- 下個 session 該**先讀**什麼才能進入狀況
- 外部資源（文件 URL、內網路徑、權限要求）

### 4.【產出位置】
- 已產出的檔案（路徑）
- 接下來要產出的檔案（路徑 + 格式）

### 5.【做法】
- 步驟清單（可條列）
- **指明工具選擇**（避免下個 session 重新評估）
  - 例：用 `write_file` 不用 inline reply、用 `spawn_subagent` 不直接執行

### 6.【決策依據】
- 為什麼選此做法
- 拒絕了哪些 alternatives 與原因
- 已知限制 / 已知坑

## 輸出格式

整段 prompt 包在 ` ``` ` code block，使用者可直接複製貼上。

若使用者要求存到 staging：用 `write_file` 寫成 `~/.catclaw/workspace/_staging/next-phase-{name}.md`，由下次 `/continue` 自動讀取。

> staging 路徑：`~/.catclaw/workspace/_staging/`（catclaw 全域 staging 區，跨 Discord channel / agent 通用）
> 檔名 `{name}` 從任務名稱推導（英文小寫、空格換 `-`、不超過 40 字元）

## 反模式（自我檢查清單）

執行前對照，命中任一 → 拒絕完成並補齊：

- ❌ 「繼續 X Phase 2」這種一句話 prompt
- ❌ 只有 what 沒有 why（下個 session 不知道判斷標準）
- ❌ 使用「我們」「剛才」「之前」「那個」等指代當前對話的代詞
- ❌ 引用「對話中的決定」但未列出該決定本身
- ❌ 缺權威來源（下個 session 不知道該先讀哪個檔）
- ❌ 缺 commit hash（下個 session 無法定位「已完成」的程式碼版本）

## 與 /continue 的關係

| Skill | 角色 | 動作 |
|-------|------|------|
| `/handoff` | **寫入端** | 產出 self-sufficient prompt，可選擇存 staging |
| `/continue` | **讀取端** | 讀 `_staging/next-phase-*.md` 並執行 |

不存 staging 也可：直接給使用者複製貼上的 code block。

## 範例對照

### ❌ 反例
```
繼續 TSLG 御神具 Phase 2：寫技術報告。
```
→ 下個 session 不知道：規格檔在哪、Phase 1 做了什麼、技術報告該包含什麼

### ✅ 正例
```
【前置脈絡】
- 專案：C:/Projects/TSLG（御神具系統技術文件 Phase 2）
- 任務：產出技術分析報告（玩法版已完成）
- Why：規格從 Anti規格書 同步到 DesignDoc 後需技術視角分析衝突點與 schema

【已完成】
- Phase 1：玩法分析報告 `分析報告_玩法.md` 已 SVN commit r966
- 規格來源：DesignDoc 已含完整 4 份檔案（規格主文 / 企劃表格 / 玩法分析）

【權威來源】
- 規格主文：C:/Projects/TSLG/DesignDoc/裝備系統規格/TSLG_開發規格_裝備系統.md
- 企劃表格：C:/Projects/TSLG/DesignDoc/裝備系統規格/TSLG_開發規格_裝備系統_企劃表格.md
- 玩法分析（避免重複）：C:/Projects/TSLG/DesignDoc/裝備系統規格/分析報告_玩法.md

【產出位置】
- 接下來：C:/Projects/TSLG/DesignDoc/裝備系統規格/分析報告_技術.md（新檔）

【做法】
1. spawn_subagent 處理整包寫檔（避免主對話 inline 寫長文撞 max_tokens）
2. task 內含完整素材路徑 + 章節結構（10 章 + Mermaid 圖）
3. 子 agent end_turn 後等 wake 自動回報
4. 完成後 SVN commit + 回報使用者

【決策依據】
- 為什麼 spawn_subagent：分章寫的 long-task pattern，主對話避免被截斷
- 為什麼不 inline reply 寫：trace eb4a5751 案例顯示 inline 寫長文撞 max_tokens × 4 燒 token
- 已知坑：御神具規格中文路徑要用絕對路徑 + read_file 直接讀（不要 glob）
```

## Step 1：判斷觸發

從使用者最近的訊息抓取以下意圖之一：
- 「給下 session 的 prompt」「下一個 session 用的 prompt」
- 「續接」「交接」「下次繼續」
- 「寫 next-phase」「handoff」

抓不到 → skill 不執行，回覆「沒偵測到 handoff 意圖，請明確說明」。

## Step 2：蒐集 6 區塊

對照當前對話脈絡，逐一填入 6 區塊。任一區塊資訊不足 → 主動向使用者補問，**不要猜**。

## Step 3：對照反模式清單

逐項檢查，命中任一 → 回頭補齊，**不要交付**。

## Step 4：輸出

包在 code block。若使用者要求存 staging：用 `write_file` 寫入 `~/.catclaw/workspace/_staging/next-phase-{name}.md`。

完成後告知使用者：「prompt 已產出，可直接貼到新 session 開頭」或「已存到 staging，下次 `/continue` 自動讀取」。
