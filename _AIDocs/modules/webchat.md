# modules/webchat — 網頁版聊天（/chat）

> 檔案：`src/web/webchat.ts`（伺服器）、`src/web/public/index.html`（頁面）
> 更新日期：2026-11-11

## 職責

不經 Discord 的完整聊天介面：帳號密碼登入、每人自己的對話列表、逐字串流回覆、工具卡片、停止、插話、圖片／檔案附件、Markdown 與程式碼排版、斜線指令（打 / 跳出清單）、每個對話各自選模型與思考等級、執行核准卡、子 agent／背景工作進度卡。用在 Discord 連不上（公司防火牆擋）或想要 Claude Code Desktop 式介面時。

對話有兩種：**一般對話**（agent loop，下面「一則訊息怎麼跑」）與 **CLI 對話**（每個對話一條專屬的 Claude Code CLI session，見「CLI 對話」一節）。

## 掛載

- 跟 dashboard 共用同一個 HTTP server 與埠（預設 8088），網址 `http://<主機>:<埠>/chat`。
- `dashboard.ts` 在 token 檢查**之前**把 `/chat`、`/api/webchat/*` 轉給 `handleWebChat()`；網頁版有自己的 cookie 登入，不吃 dashboard token。
- 頁面檔不經 tsc：`build`／`pm2:restart` 會把 `src/web/public` 複製到 `dist/web/public`，伺服器每次請求讀檔（改頁面不必重啟，但要重新複製）。

## 帳號

- 第一次（`webchat/users.json` 沒有任何帳號）：伺服器產生一次性設定碼，寫到 `{CATCLAW_CONFIG_DIR}/webchat/setup-code.txt` 並印在 log；頁面用設定碼建立第一個 platform-owner。建完設定碼刪除。
- 管理員（platform-owner／admin）側欄左下多一個 🛠「後台」連結，新分頁開 `/dashboard`。
- 之後由 platform-owner／admin 在頁面左下 👥 建帳號、重設密碼、刪網頁帳號（catclaw 帳號與記憶保留）。只有 platform-owner 能建 platform-owner。
- 每個網頁帳號對應一個 catclaw 帳號（`accounts/registry`，identity `web:<帳號名>`）：新建會產生 `web-<帳號名>`；也可綁定既有帳號（例如 Discord owner），綁定時沿用該帳號的角色與記憶。
- 密碼 scrypt＋salt；登入 cookie `catclaw_web`（HttpOnly、SameSite=Strict、30 天），伺服器只存 token 的 sha256；同一 IP 10 分鐘內失敗 10 次就擋。
- 所有非 GET 請求要帶 `X-Webchat: 1` header（跨站表單送不出，擋 CSRF）。

## GitLab 登入

- 管理員在 👥 帳號管理的「GitLab 登入」填 GitLab 網址、回呼網址、Application ID、Secret（存 `webchat/gitlab.json`，權限 600；Secret 讀回只回 `hasSecret`，留空存檔不變；Application ID 清空就關閉）。填齊立即生效、不用重啟；登入頁才出現「🦊 用 GitLab 登入」。
- GitLab 端：Applications 新增，Redirect URI 填 `http://<主機>:<埠>/api/webchat/oauth/gitlab/callback`（要跟設定的回呼網址一字不差），Scopes 勾 `openid`、`profile`、`email`。
- 流程：`/api/webchat/oauth/gitlab/start` 產生一次性 state（10 分鐘）與 PKCE → GitLab `/oauth/authorize` → `/oauth/gitlab/callback` 用 code＋secret＋verifier 換 token、讀 `/oauth/userinfo`（sub、nickname、name）。
- 找 `gitlab.sub` 對應的網頁帳號就登入；沒有就自動建 `web-<帳號名>`（member），帳號名取 GitLab nickname 小寫、撞名加 `-gitlab`。不限群組，能登入這個 GitLab 的人都能進。
- 既有帳號綁定：已登入的人按側欄 🦊（`start?mode=link`），綁定後用 GitLab 登入就是同一個帳號。綁誰在 start 時記進 state——登入 cookie 是 SameSite=Strict，從 GitLab 轉回來的回呼請求不會帶 cookie。
- GitLab 帳號沒有密碼（不能密碼登入、不能自己改密碼）；管理員可以重設密碼給它，綁定保留。
- 管理員對 GitLab 帳號按「停用」（不能真的刪，否則下次登入會自動建回來）：登入失效、GitLab 與密碼登入都擋，可再「啟用」。密碼帳號仍是真的刪除。
- 錯誤（逾時／state 用過、拒絕授權、換 token 失敗、停用）轉回 `/chat#login-error=…` 顯示在登入頁。

## 一則訊息怎麼跑

1. 先比對 skill trigger（跟 Discord 同順序）：命中就直接執行，結果以「系統」訊息顯示；回覆進行中打 `/stop` 也走這裡。`SkillContext.platform = "web"`，`/context`、`/compact`、`/session` 會找 `web:ch:<對話 id>` 的 session。
2. 該對話有回合在跑 → `pushInterruptMessage` 插話（附件不能插話）。
3. 否則開新回合（背景執行，HTTP 立即回）：角色／專案 → rate limit → provider 路由 → `runMessagePipeline(platform:"api")` → `agentLoop(platform:"web")`，session key `web:ch:<對話 id>`。
4. 網頁一律 `showToolCalls: "all"`，不跟 Discord 的 `showToolCalls` 設定。

## 模型與思考等級

- 輸入框上方兩個選單，設定存在 `conversations.json` 該對話的 `model`／`thinking`，下一則訊息生效。
- 模型優先序：`/use` 覆寫 > 對話選的模型 > `modelRouting` 預設。思考：`/think` 覆寫 > 對話設定（`off` 是強制關閉）> 模式 > dashboard 預設。
- `/use`、`/think` 的覆寫存在記憶體（重啟就沒）；在選單改設定時會清掉對應覆寫，所以「後設定的贏」。畫面在選單旁標示「由 /use 覆寫」。
- 換模型的權限沿用 `/use` 的 tier（admin）；沒權限的角色選單是灰的，API 回 403。思考等級每個人都能改。
- 模型清單 = `ProviderRegistry.listCatalog()`：已在用的 provider（有憑證）底下 models.json 的所有模型，依 provider 分組、新的排前面；有 alias 的顯示成「alias（provider/model）」。選到時 `ensure()` 才建 provider；憑證不在的 provider（例如這台沒有 `~/.codex/auth.json`）整組不列。
- `GET /api/webchat/options`：模型清單、思考等級、能不能換模型、斜線指令清單（只列有 `/` 觸發字、且使用者角色 tier 過得了的 skill）。

## 執行核准

- `safety.execApproval.enabled` 開著時，`run_command`／`write_file`／`edit_file`（白名單外）與 guard 軟擋都會在對話裡推一張核准卡：指令、核准／拒絕按鈕、逾時倒數。
- 走 agent-loop 的 `execApproval.requestApproval`（不送 Discord DM）；按鈕打 `POST /conversations/<id>/approve {approvalId, approved}` → `exec-approval.resolveApproval`。
- 只有對話擁有者看得到、按得到（別人的對話一律 404，approvalId 不屬於該對話也 404）；「核准」另外要擁有者是 platform-owner／admin，一般成員只能拒絕，等不到核准就逾時拒絕（把關不能由發問者自己放行）。網頁的核准人不是 `dmUserId` 指定的那個人。
- 卡片狀態：等待中 → 已核准／已拒絕／逾時自動拒絕。等核准時按停止或打 `/stop` 會先把核准當拒絕（agent-loop 等核准時不看中止訊號，不先拒絕要等到逾時）。

## 子 agent 與背景工作

- `spawn_subagent`（async；模型常把 async 送成字串 `"true"`，工具兩種都認）與 `run_background_command` 回傳「已啟動」時，對話中多一張進度卡（執行中、經過時間）。
- 回合內完成：agent-loop 的 `subagent_relay`／`background_job_relay` 事件更新卡片（完成／失敗、結果摘要 1500 字）。
- 回合結束後才完成：webchat 自己聽 eventBus（`subagent:*`、`background-job:*`，只處理 `web:ch:` 開頭的 session），改寫紀錄裡那張卡並推給畫面；找不到原卡就新增一筆。

## CLI 對話

側欄「⌨ CLI 對話」開一個對話專屬的 `claude` CLI session（provider 固定 claude，重用 `cli-bridge/bridge.ts` 的 `CliBridge`＋`ClaudeProvider`）。不寫 `cli-bridges.json`、不碰綁 Discord 頻道的 bridge。

### 權限（每個帳號的 cliAccess）

| 值 | 能做什麼 |
|----|---------|
| `none` | 不能開、不能用（按鈕不出現，API 403） |
| `isolated` | 工作目錄只能是個人工作區 `<teamWorkspaceRoot>/<網頁帳號名>`（第一次建立並寫 CLAUDE.md）或管理員指定的目錄；CLI 以隔離模式啟動；不能跳過權限確認；工具權限送管理員審批 |
| `full` | 任選工作目錄（候選清單＋自填）、載入完整 `~/.claude`、可選「跳過權限確認」 |

- 存在 `users.json` 的 `cliAccess`／`cliDirs`；沒設定依角色：platform-owner、admin → full，其他（含 GitLab 自動建的 member）→ none。
- 管理員在 👥 帳號管理的「CLI」欄逐人設定（下拉＋📁 指定目錄，伺服器驗證目錄存在）；`POST /admin/cli-access {username, cliAccess, cliDirs?}`。只有 platform-owner 能改 platform-owner。
- 立即生效：送訊息、作答、換設定每次重查；改成不能再用的對話，CLI process 當場關掉。full 開的對話在權限降成 isolated 後不能再用（要開新的）。
- 隔離設定沿用私訊 team 的 `cli-bridge-dm.json`：`teamWorkspaceRoot`（沒有就 `~/catclaw-web`）、`team.denyPaths`（沒有就本機家目錄）、`team.disallowedTools`、`team.claudeMdTemplatePath`。CLI 啟動加 `--setting-sources project,local`、`permissions.deny` 擋 denyPaths、`--disallowedTools`（同 cli-bridge.md「私訊 bridge」的 team 隔離）。工作目錄若在 denyPaths 底下，開對話直接拒絕（CLI 會讀不到自己的目錄）。

### 開對話

- full：工作目錄候選 = `cli-bridges.json` 各 bridge 的 workingDir＋`cli-bridge-dm.json` 的 ownerWorkingDir（去重、只留存在的）；也可自填。伺服器 realpath 驗證是存在的資料夾，否則 400。
- 權限模式：「每次詢問權限」（預設，明確傳 `--permission-mode default`，蓋掉 `~/.claude/settings.json` 的 defaultMode；但 full 會載入 `~/.claude` 的 allow 規則，列在裡面的工具照樣直接放行，只有沒列到的才跳權限卡）或「跳過權限確認」（`--dangerously-skip-permissions`；提問與計畫核准仍會問，工作目錄專案設定的 ask 規則 CLI 也照樣會問）。
- 模型：claude CLI 的別名（opus／sonnet／haiku／fable）＋`cli-bridges.json` 設過的模型；effort：low～max（`--effort`）。換模型或 effort 會關掉 process，下一則訊息以 `--resume` 帶新參數重開；回合進行中換回 409。

### 一則訊息怎麼跑

1. 原文直送 CLI（`bridge.send(text, "web")`，不包 `<channel>` tag、不經 catclaw skill，所以 `/compact` 等 CLI 原生指令照樣能用）。斜線清單在 CLI 對話列 CLI 回報的指令（system/init 的 slash_commands，存在對話設定）。
2. 圖片（≤5MB）照 Discord bridge 的格式轉成 inline image；其他檔案（與更大的圖）存檔後把路徑附在訊息裡讓 CLI 用 Read 讀。
3. 回合進行中再送 → 直接 send（CLI 自己排隊／插話），畫面上舊回合收尾、新回合接著顯示；CLI 自發的背景回合（source=background）也顯示成一則回覆。
4. 事件對應：text／thinking 照舊；`tool_call`（帶 tool_use id 與參數）＋CLI 的 user 訊息裡的 tool_result（用 tool_use_id 對回）組成一張工具卡；子 agent 內部的工具結果不顯示。
5. 停止 → 先把等作答的卡片當拒絕，再 `bridge.interrupt()`；錯誤顯示「已停止」。

### CLI 的提問與權限（control_request）

- AskUserQuestion → 每題選項（單選／多選）＋「其他」自填，答案照 `control-request.ts` 的格式（多選用「, 」接）塞回 `updatedInput.answers`。
- ExitPlanMode → Markdown 顯示計畫＋核准／退回（退回可填意見，成為 deny message）。claude 2.1.3xx 先把計畫寫進 `~/.claude/plans/<名稱>.md` 再送空的 ExitPlanMode，所以 input 沒有 plan 時讀 `planFilePath` 或這個 session 最近寫的計畫檔。
- 其他工具 → 工具名與 input＋允許／拒絕。
- `POST /conversations/<id>/answer {requestId, allow, answers?, message?}`；只有對話擁有者能作答。逾時（`CATCLAW_PERMISSION_TIMEOUT_MS`，預設 10 分鐘）、按停止、改送新訊息都回 deny。卡片在進行中回合的事件裡，重新整理接得回、可作答。
- **isolated 對話**：AskUserQuestion 仍由發話者回答；其他（含 ExitPlanMode）送管理員審批——發話者卡片顯示「⏳ 已送管理員審批 → 結果」、自己作答 403；完整 CLI 權限的 platform-owner／admin 側欄 🛡 顯示待審批數（`/events` 推 `reviews`），面板列出是誰、哪個對話、工具與 input／plan（不給看整個對話），`GET /reviews`、`POST /reviews/decide {requestId, allow, message?}`。沒有任何審批者 → 直接 deny，不退回發話者自審。

### 保活

- sessionId 存在 `conversations.json` 該對話的 `cli.sessionId`（`bridge.setSessionIdStore`）。閒置 `CATCLAW_WEB_CLI_IDLE_MS`（預設 10 分鐘）關掉 process，下一則訊息 `--resume` 接回；catclaw 關閉時（`index.ts shutdown` → `shutdownWebCliSessions`）一起關掉 CLI process（它們是 detached，不關會變孤兒），重啟後下一則訊息 `--resume` 接回。
- 刪除對話會關掉 process；`~/.claude/projects/` 裡的 CLI session 檔保留。
- stdout／turns 日誌：`webchat/cli-logs/web-<對話 id>/`。

## 即時更新

- `GET /api/webchat/conversations/<id>/stream`（SSE）：連上先送 `sync`（最近 300 筆紀錄＋進行中回合已發生的事件）與 `settings`，之後推 `entry`／`turn_start`／`text`／`thinking`／`tool_start`／`tool_result`／`tool_blocked`／`approval`／`job`／`settings`／`status`／`turn_end`。`approval`、`job` 是整張卡片，畫面依 id 取代。重新整理或另開分頁都接得回進行中的回覆。
- 文字逐字出現：`providers/claude-api.ts` 邊收邊吐（見 providers.md「StreamResult：邊收邊吐」），其他 provider 仍整段出現。
- `GET /api/webchat/events`：對話列表變動通知（新增、改名、刪除、回合開始結束）；審批者另外收 `reviews`（待審批清單變了）。
- CLI 對話另有 `control`（權限／提問卡，整張卡片依 id 取代）。

## 資料（`{CATCLAW_CONFIG_DIR}/webchat/`）

| 檔案 | 內容 |
|------|------|
| `users.json` | 帳號名 → accountId、salt／hash（密碼帳號）、gitlab {sub, username}、disabled、cliAccess、cliDirs |
| `gitlab.json` | GitLab 登入設定（url、clientId、clientSecret、redirectUri） |
| `logins.json` | 登入 token 的 sha256 → 帳號名、到期時間 |
| `conversations.json` | 對話列表（id、owner、標題、時間、選的模型與思考等級；CLI 對話另有 kind、cli {mode, workingDir, skipPermissions, model, effort, sessionId, commands}） |
| `cli-logs/web-<id>/` | CLI 對話的 stdout.jsonl／turns.jsonl |
| `transcripts/<id>.jsonl` | 畫面紀錄（使用者訊息、AI 回覆的文字／思考／工具卡片／核准卡／進度卡、系統訊息），不受 CE 壓縮影響；背景工作晚完成時會改寫該行 |
| `uploads/<id>/<fileId>__<檔名>` | 附件；圖片同時以 base64 送 vision，其他檔案路徑附在訊息讓 AI 用 read_file 讀 |

刪除對話會一起刪紀錄、附件與 catclaw 端 session。

## 已知限制

- 只有 claude-api 是逐字串流；ollama／openai-compat／codex-oauth／CLI provider 的文字仍是一輪一次出現。
- 串流途中斷線不會重試（已顯示的文字收不回），錯誤附在回覆後面。
- 對話只有本人看得到，沒有多人共用頻道。
- 背景工作或子 agent 在回合結束後才完成時，只更新卡片，不會像 Discord 那樣喚醒 agent 開新回合（wake-agent 只認 Discord 頻道）。
- `run_background_command` 的 stdout 檔固定寫在 `~/.catclaw/workspace/data/jobs/stdout`，不跟 `CATCLAW_CONFIG_DIR`。
- 子 agent 進度只有「執行中／完成／失敗」，沒有中間步驟。
- Markdown／程式碼上色套件從 jsdelivr 載入；瀏覽器連不到時退回純文字。
- CLI 對話的文字是一個 content block 一次出現（bridge 沒開 `--include-partial-messages`），不是逐字。
- CLI 對話回合進行中被 catclaw 強制關閉（kill -9）時，這輪的回覆不會寫進紀錄（正常關閉會先收尾）。

## 驗證腳本

端到端（API）與真實瀏覽器（Chrome＋playwright）兩支，加一支量文字事件抵達時間的串流計時，對隔離的 catclaw 執行個體跑（複製設定、改埠 8099、拿掉 Discord token、關 cron／CLI bridge／MCP）。測試提示一律加「不要使用任何工具」，否則 agent 可能把內容寫進綁定專案目錄。

CLI 對話另有 API 與瀏覽器兩支，跑真的 claude CLI：工作目錄用 scratchpad 底下自建的空資料夾、提示只做無害動作；隔離模式在測試副本寫一份 `cli-bridge-dm.json` 把個人工作區根指到 scratchpad。執行個體用 `CATCLAW_PERMISSION_TIMEOUT_MS=45000 CATCLAW_WEB_CLI_IDLE_MS=20000` 縮短逾時與閒置時間；重啟測試要保留資料（不重建設定副本）。
