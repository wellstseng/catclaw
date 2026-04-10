# 假設錯誤（Wrong Assumptions）

- Scope: project
- Confidence: [臨]
- Type: procedural
- Created: 2026-04-04

## 知識

- [臨] 使用config_get查詢模型資訊 → 依賴config_get而非system prompt → 直接注入system prompt（根因: 假設錯誤）  (2026-04-04)

- [臨] system prompt未包含模型資訊 → 未在system prompt中注入模型資訊 → 添加模型資訊到system prompt（根因: 認知偏差）  (2026-04-04)

## 行動

- 同全域 failures 共通行動規則
