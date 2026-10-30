# feedback-截斷的顯示名不能當判重依據-要看底層定義再說重複

- Scope: shared
- Author: wellstseng
- Source: catclaw session 2026-10-27, _AIDocs/_CHANGELOG.md 2026-10-27 row
- Confidence: [臨]
- Trigger: 排程重複, cron-jobs.json, 名字相同, 判重, duplicate, 去重, 顯示名截斷
- Created-at: 2026-10-27

## 知識

- [臨] 2026-10-26 看 cron-jobs.json 時以 name 欄位判定「intraday-market-radar 10 個排程兩兩重複」並寫進回報；隔天查 action.command 才發現是兩支不同腳本（00631L 雷達 / 核心 ETF 回調雷達）各 5 時段，名字相同只因 name 由 content.slice(0,30) 截斷、前 30 字都是 `--verbose bash /Users/wellstse`。
- [臨] 顯示名／標題／摘要欄位是「人看的縮影」，常有截斷、模板化、取名 bug；判定「重複／可刪」這類會導致刪東西的結論，必須比對真正決定行為的欄位（command、prompt、expr、target），並至少做一次 diff。
- [臨] 錯誤回報已送出後要主動更正，並把「為何看起來重複」的機制一併說明，不只說「我看錯了」。

## 行動

- 看到多筆同名項目先 dump 完整定義（command/args/schedule）再下「重複」結論
- 會引發刪除的判定，附上 diff 證據才寫進回報
- 已送出的誤判在下次回報第一句更正
