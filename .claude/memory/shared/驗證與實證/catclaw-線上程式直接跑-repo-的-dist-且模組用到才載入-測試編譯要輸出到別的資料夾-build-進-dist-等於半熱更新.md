# catclaw 線上程式直接跑 repo 的 dist 且模組用到才載入-測試編譯要輸出到別的資料夾-build 進 dist 等於半熱更新

- Scope: shared
- Author: wellstseng
- Source: session 6fb15a66 2026-11-06（~/.claude v6 整併進 catclaw）
- Confidence: [臨]
- Trigger: dist, build, tsc, smoke test, 測試編譯, 重啟, 熱更新, outDir, 冒煙
- Created-at: 2026-11-06
- Quote: 「全部都做 目標讓catclaw的代理品質更好 測試也請確實 要重啟要跟我確認」

## 知識

- [臨] 線上 catclaw 是 `node <repo>/dist/index.js`，大量 `await import()` 用到才載入；bridge 新開的 MCP 子行程（dist/mcp/discord-server.js）也直接讀 dist。改完程式跑 `tsc`／`pnpm build` 編進 repo 的 dist，等於讓還沒重啟的線上行程半新半舊（已載入的是舊碼、之後才 import 的拿到新碼）
- [臨] 驗證時改編到暫存資料夾：`npx tsc --outDir <暫存>/dist`，再把 package.json 複製過去（ESM 要 type:module）、node_modules 用 symlink 指回 repo，tests/*.mjs 複製到 `<暫存>/tests/`，它們的 `../dist/` 就指到暫存版
- [臨] 要證明測試抓得到改動：`git archive HEAD src tsconfig.json package.json | tar -x -C <另一暫存>` 編一份原版，同一支測試在原版要紅
- [臨] scripts/smoke-test-s5.mjs 的 mock provider 沒回 usage，agentLoop 那幾支在 HEAD 原版就是紅的（6 支），不能拿來當回歸基準；新寫 agentLoop 測試要在 stream() 回傳裡帶 usage:{input,output,cacheRead,cacheWrite}，並先 trace.recordContextStart()

## 行動

- catclaw 改碼後的驗證一律編到暫存 outDir，不碰 repo dist
- 上線＝build 進 dist＋重啟兩件一起做，且先問使用者
