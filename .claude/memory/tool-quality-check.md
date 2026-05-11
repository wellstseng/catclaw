# Reference: pnpm quality-check 自檢 catclaw 執行品質

- Scope: project
- Confidence: [固]
- Trigger: quality-check, 自檢, 品質檢查, 幻覺偵測, hallucination, 套娃, externalization recursion, trace 異常, agent loop 異常, pnpm quality-check
- Last-used: 2026-05-11
- Confirmations: 1

## 知識

- [固] 入口：`pnpm quality-check`，腳本在 `scripts/quality-check.mjs`
- [固] 掃 `~/.catclaw/workspace/data/traces/*.jsonl` + 必要 fallback
- [固] CLI flags：`--days N`、`--channel <id>`、`--json`、`--min low|med|high`
- [固] Exit code：有 HIGH 命中→1，否則 0（可掛 CI / pre-commit）

## 偵測規則

| Rule | Severity | 命中條件 |
|------|----------|----------|
| empty-result-confident | HIGH | ≥60% 工具回空且 LLM stopReason=end_turn、response ≥200 字、含確信語氣（中文：有的/找到/完整紀錄/盤點完；英文：done/found/complete/verified） |
| externalization-recursion | HIGH | read_file 或 run_command 讀 `tool-outputs/` 路徑且結果含 `\\\"` 多層轉義 → tool-output-store 套娃 |
| cross-turn-repeat | MED | 同 tool+params hash 在單 trace 內 ≥3 次 |
| output-size-anomaly | MED | 同 tool 結果 length 偏離 trace 中位數 ≥5×（中位數需 ≥50 字） |
| tool-error-ignored | MED | exitCode≠0，後續 end_turn 且 response 未含「失敗/錯誤/error/fail」 |

## Why

2026-05-11 在 thread `1502707027292454983` 發現 Wendy 程式開發 session 嚴重幻覺。盤過 18 筆 trace 後鎖定兩個根因：
- `82facda0`：grep/glob 全空，仍宣稱「有的，phase0 有完整紀錄」並編造盤點清單
- `35543a48`：tool-output 外部化 recursion，read_file 讀外部化檔取得多層 `\\\\\"` 轉義內容，最後寫 /tmp 繞開

30 天範圍掃描發現 externalization-recursion 共命中 14 次／6 個 trace —— 是普遍性 bug，不是單一事件。Wells 明確要求 AI 自己能檢視 catclaw 執行品質，所以做成 CLI 自檢工具，不靠手檢。

## 行動

何時跑：
1. 使用者抱怨 agent 行為怪異／幻覺 → 立刻 `pnpm quality-check --channel <id>`
2. 大段對話收尾前 → 自檢一輪
3. 改 `tool-output-store.ts` / `agent-loop.ts` / `prompt-assembler.ts` 後 → 驗 regression
4. 全域巡檢 → `pnpm quality-check --days 30 --min med`

擴規則：規則函式都集中在 `scripts/quality-check.mjs` 內、加進 `RULES` 陣列即可。
