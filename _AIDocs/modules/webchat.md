# modules/webchat — 網頁版聊天（/chat）

> 檔案：`src/web/webchat.ts`（伺服器）、`src/web/public/index.html`（頁面）
> 更新日期：2026-11-11

## 職責

不經 Discord 的完整聊天介面：帳號密碼登入、每人自己的對話列表、逐字串流回覆、工具卡片、停止、插話、圖片／檔案附件、Markdown 與程式碼排版、斜線指令（打 / 跳出清單）、每個對話各自選模型與思考等級、執行核准卡、子 agent／背景工作進度卡。用在 Discord 連不上（公司防火牆擋）或想要 Claude Code Desktop 式介面時。

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
- 模型清單 = provider registry 已註冊的 provider，有 alias 的顯示成「alias（provider/model）」（`ProviderRegistry.listAliases()`）。
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

## 即時更新

- `GET /api/webchat/conversations/<id>/stream`（SSE）：連上先送 `sync`（最近 300 筆紀錄＋進行中回合已發生的事件）與 `settings`，之後推 `entry`／`turn_start`／`text`／`thinking`／`tool_start`／`tool_result`／`tool_blocked`／`approval`／`job`／`settings`／`status`／`turn_end`。`approval`、`job` 是整張卡片，畫面依 id 取代。重新整理或另開分頁都接得回進行中的回覆。
- 文字逐字出現：`providers/claude-api.ts` 邊收邊吐（見 providers.md「StreamResult：邊收邊吐」），其他 provider 仍整段出現。
- `GET /api/webchat/events`：對話列表變動通知（新增、改名、刪除、回合開始結束）。

## 資料（`{CATCLAW_CONFIG_DIR}/webchat/`）

| 檔案 | 內容 |
|------|------|
| `users.json` | 帳號名 → accountId、salt、hash |
| `logins.json` | 登入 token 的 sha256 → 帳號名、到期時間 |
| `conversations.json` | 對話列表（id、owner、標題、時間、選的模型與思考等級） |
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

## 驗證腳本

端到端（API）與真實瀏覽器（Chrome＋playwright）兩支，加一支量文字事件抵達時間的串流計時，對隔離的 catclaw 執行個體跑（複製設定、改埠 8099、拿掉 Discord token、關 cron／CLI bridge／MCP）。測試提示一律加「不要使用任何工具」，否則 agent 可能把內容寫進綁定專案目錄。
