# trajectory-fingerprint

> 對應原始碼：`src/workflow/trajectory-fingerprint.ts`
> 建立日期：2026-05-04（CatClaw 整合 Hermes 計畫項目 12 階段 2 plumbing）

## 用途

把 trace 最後 N turn 壓縮成「失敗 pattern」用於：
1. **Record**：dashboard 標 `falsePositive=false`（真失敗）時，把該 trace 的 fingerprint 寫入 `~/.catclaw/workspace/data/failure-fingerprints.jsonl`
2. **Match**：未來 agent-loop 啟動 turn 前比對歷史 → 命中歷史失敗 pattern → 主動警告（**plumbing 已備，未接 agent-loop — 樣本不足比對 recall 為 0**）

## 階段對應

- 階段 1 已落地（commit `2247d0b` / `a42ea53` / `c713410`）：guardianHits schema + dashboard panel + jsonl 匯出
- **階段 2 plumbing（本檔）**：fingerprint compute / record / match helpers
- 階段 3 不做：用 fingerprint 集 fine-tune 小模型 — 外部訓練 pipeline，本專案範圍外

## Exports

```typescript
export interface TrajectoryFingerprint {
  pattern: {
    toolSeq: string[];        // 最後 5 turn 的 tool 名稱序列
    userTextHints: string[];  // user 訊息 keyword (≥3 char, top 5)
    statusSeq: string[];      // stopReason 序列
  };
  hash: string;               // SHA-256 前 16 hex
}

export function computeTrajectoryFingerprint(trace: MessageTraceEntry): TrajectoryFingerprint;
export function recordFailureFingerprint(trace: MessageTraceEntry, rule: string): void;
export function matchAgainstFailureDB(current: TrajectoryFingerprint): FailureRecord[];
export function getFailureFingerprintCount(): number;
```

## 命中策略

任一 yes 即視為命中：
1. `hash` 完全相同（同 pattern）
2. `toolSeq` 完全相同（不同 user hints 但 tool 順序一致）

樣本不足（< 100）時 recall ≈ 0；plan 寫的「真有用」門檻是 100 標註樣本。

## 接入點

- `message-trace.ts TraceStore.updateGuardianHit`：標 `falsePositive=false` 時
  fire-and-forget 呼 `recordFailureFingerprint(entry, rule)`
- **未接**：`agent-loop.ts` 啟動 turn 前 / Guardian 規則觸發前比對 — 等樣本累積後再加

## 樣本累積路徑

1. catclaw 日常使用累積 trace
2. Guardian 規則觸發（rut / oscillation / retry_escalation / skill_interrupted）→ 寫 guardianHits
3. Wells 從 dashboard「Guardian」tab 標 ✅ 正確 / ❌ 誤報
4. 「正確」（即真失敗）→ 自動 recordFailureFingerprint
5. 累積 ≥100 → 啟用 agent-loop 比對分支
6. 累積 ≥500 → 評估階段 3 LLM-based Guardian（外部訓練）

## 設計選擇

- **N=5 turn**：太少 pattern 太散，太多 hash 太精準（過擬合）
- **SHA-256 前 16 hex**：collision 機率 < 1e-9，足以區分萬筆
- **toolSeq fuzzy match**：tool 順序相同但 user hints 不同也算命中 — 提高 recall

## 不做
- 模糊距離計算（Levenshtein / cosine）— 先用精確比對
- 樣本權重（時間衰減 / 標註者信心）— 先做純筆數
