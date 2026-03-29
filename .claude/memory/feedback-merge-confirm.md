# Feedback: merge 前必須明確確認

- Confidence: [固]
- Trigger: merge, git merge, 合併, 上 GIT, push main

## 知識

- [固] git merge（尤其 merge 到 main/master）屬於不可逆操作，**必須在執行前明確向使用者確認**，不可自行判斷「已完成所有前置作業就代表可以 merge」

## Why
2026-03-26：staging 任務說「整合驗收 + 部署」，AI 完成驗收後自行 merge platform-rebuild → main 並 push，使用者說「我還沒要 merge」，必須 force push 回滾。

## How to apply
完成驗收/測試後，問：「驗收通過，要我現在 merge 到 main 嗎？」等使用者說「是」才執行。不論 staging 文件描述多麼像「應該 merge」。
