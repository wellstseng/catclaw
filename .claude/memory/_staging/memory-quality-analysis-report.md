# CatClaw 記憶品質分析報告

> 日期：2026-04-08
> 觸發：trace 145541eb-51c2-4a45-991d-a7f0c9558f42

## 根因分析

### ACT-R 回饋迴圈（已修復）

recall Step 5 用 `0.7*cosine + 0.3*ACT-R + 0.15*keyword_bonus` 混合排序。
touchAtom() 每次召回 +1 confirmations → 更高 ACT-R activation → 更容易被召回。

**結果**：5 個 atom（confirmations 25~35）壟斷所有查詢，13 個 atom（confirmations=0）永遠不會被召回。

### 證據：Trace 145541eb

查詢「你知道這個頻道的用途嗎」（頻道：#生涯/職涯），自動召回結果：

| # | Atom | Score | 相關性 |
|---|------|-------|--------|
| 1 | discord-aguang-ai | 0.804 | 無關 |
| 2 | message-completeness | 0.674 | 無關 |
| 3 | promote-trigger-rule | 0.651 | 無關 |
| 4 | tianting-discord-info | 0.643 | 弱相關 |
| 5 | code-review-pre-review-web | 0.62 | 無關 |

正確答案 `wells-career-direction`（3 confirmations）未被召回。LLM 自己用 tool 二次搜尋才找到。

### Atom 統計快照（修復前）

- 45 atoms, [固]=35, [觀]=3, [臨]=7
- 平均 confirmations: 7.2
- Top 5 壟斷 atoms: memory-write-rules(35), message-completeness(34), promote-trigger-rule(31), code-review-pre-review-web(28), discord-aguang-ai(25)
- 13 atoms 從未被召回（confirmations=0）

## 修復措施

| 措施 | 說明 |
|------|------|
| 移除 ACT-R | recall 改為純 cosine + keyword 微調(0.05)，管線 7→5 步 |
| 移除 Related-Edge Spreading | 減少噪音來源 |
| 降低 consolidation 門檻 | autoPromote 20→3, halfLife 30→14d, archive 0.3→0.2 |
| 重置膨脹 confirmations | 10 個 atom (>10) 重置為 3 |
| Memory Dashboard | Atom Browser + Recall Tester + Stats Panel |

## 預期改善

- 查詢「你知道這個頻道的用途嗎」→ 預期 wells-career-direction 進入 top 5
- 低 confirmations 但語意相關的 atom 不再被壓制
- Recall Tester 可即時驗證召回品質

## 修復後驗證結果（2026-04-08）

### Recall Tester 實測

| Query | 修復前 #1 | 修復後 #1 | 改善 |
|-------|-----------|-----------|------|
| 「你知道這個頻道的用途嗎」 | discord-aguang-ai (0.804, 無關) | tianting-discord-info (0.597, 相關) | ✅ 語意匹配取代壟斷 |
| 「團隊成員」 | 未測 | team-roster (0.613) | ✅ 直接命中 |
| 「投資分析」 | 未測 | investment-system (0.704) | ✅ 直接命中 |

### 移除 ACT-R 的影響分析

**正面：**
- 消除了 confirmation 壟斷問題（高 confirmation atom 不再自我強化）
- 低使用率但語意相關的 atom 可以被正確召回
- 召回結果可預測：純 cosine 相似度，排序透明

**風險/代價：**
- 失去「常用 = 重要」的啟發式加權。對於真正重要且高頻使用的 atom，不再有額外排序優勢
- 若兩個 atom cosine 分數接近，無法以使用頻率打破平手
- **緩解**：keyword 微調 +0.05 提供了 trigger 精準匹配的額外區分

### 移除 Related-Edge Spreading 的影響分析

**正面：**
- 消除了「A 相關 B → B 搭便車進入結果」的噪音傳播
- 結果更純粹：每個 atom 靠自身語意得分

**風險/代價：**
- 失去「概念擴散」能力。例如查詢「Discord 設定」只命中 discord-config，不再自動帶出 discord-permission（即使兩者 related）
- **緩解**：若未來需要，可用更保守的方式重新引入（如只在 cosine > 0.5 時才 spread，且 spread 權重 < 0.1）

### Atom 統計快照（修復後）

- 45 atoms, [固]=35, [觀]=5, [臨]=5
- Confirmation 分布：0 (13), 1-3 (20), 4-10 (12), 11+ (0)
- 壟斷問題已消除（最高 confirmations 重置為 ≤10）

## 後續建議

1. **Embedding model 升級**：qwen3:1.7b 語意理解能力有限，考慮升級到更大的 embedding model
2. **Trigger 清洗**：部分 atom trigger 過於寬泛（如「discord」出現在多個 atom），可精煉
3. **定期品質監控**：透過 Dashboard Memory tab 的 Recall Tester 定期抽測
4. **觀察 Related-Edge 需求**：若使用者反映「相關知識沒被帶出來」，考慮以保守方式重新引入 spreading
