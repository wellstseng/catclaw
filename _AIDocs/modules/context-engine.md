# modules/context-engine — Context 壓縮策略

> 檔案：`src/core/context-engine.ts`
> 更新日期：2026-04-11

## 職責

Strategy Pattern 架構的 Context Engineering 引擎。
管理 messages 歷史的 token 使用量，透過漸進式衰減 + 壓縮控制 context window。

## 策略一覽

| 策略 | 預設啟用 | 觸發條件 | 行為 |
|------|---------|---------|------|
| `decay` | ✓ | 每次 build（always） | 依 turn age 漸進壓縮/移除舊訊息 |
| `compaction` | ✓ | tokens > triggerTokens (20000) | LLM 摘要壓縮舊訊息 |
| `overflow-hard-stop` | ✓ | tokens > window × 0.95 | 緊急截斷至 4 條 |

執行順序：decay → compaction → overflow-hard-stop

## 核心型別

### ContextStrategy

```typescript
interface ContextStrategy {
  name: string;
  enabled: boolean;
  shouldApply(ctx: ContextBuildContext): boolean;
  apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext>;
}
```

### ContextBuildContext

```typescript
interface ContextBuildContext {
  messages: Message[];
  sessionKey: string;
  turnIndex: number;
  estimatedTokens: number;
}
```

### ContextBreakdown

```typescript
interface ContextBreakdown {
  totalMessages: number;
  estimatedTokens: number;
  strategiesApplied: string[];
  tokensBeforeCE?: number;
  tokensAfterCE?: number;
  overflowSignaled?: boolean;
  strategyDetails?: StrategyDetail[];  // per-strategy token 變化
}
```

### Message CE Metadata

每條 Message 可攜帶 CE metadata（`providers/base.ts`）：

| 欄位 | 說明 |
|------|------|
| `turnIndex` | 所屬 turn index |
| `timestamp` | 建立時間戳 |
| `compressionLevel` | 0=原始, 1=精簡, 2=核心, 3=stub |
| `originalTokens` | 壓縮前的原始 token 數 |
| `compressedBy` | 執行壓縮的策略名稱 |

## DecayStrategy（漸進式衰減）

每次 build 都執行。依據 message 的 turn age 計算 targetLevel，漸進壓縮。

### 模式

- **auto**（預設）：`targetLevel = max(discrete, continuous with tempo)` — 三合一
- **discrete**：固定閾值，依 minAge 跳級
- **continuous**：`retainRatio = e^(-baseDecay × age)`，平滑曲線
- **time-aware**：continuous + tempo multiplier（依對話節奏調整）

### Decay Levels

| Level | 預設 minAge | maxTokens | 行為 |
|-------|-----------|-----------|------|
| L1 | 1 | 2000 | 精簡（截斷長內容） |
| L2 | 3 | 500 | 核心（只保留關鍵內容） |
| L3 | 6 | 80 | stub（極簡佔位） |
| L4 | 10 | — | 移除 |

### Continuous Retain Ratio → Level 映射

| retainRatio 範圍 | Level |
|-----------------|-------|
| > 0.80 | L0（原始） |
| > 0.40 | L1 |
| > 0.10 | L2 |
| > 0.05 | L3 |
| ≤ 0.05 | L4（移除） |

### Tempo Multiplier

`tempoMultiplier = clamp(avgIntervalSec / referenceIntervalSec, 0.5, 2.0)`

高頻對話（間隔短）→ multiplier < 1 → 衰減慢；低頻對話 → multiplier > 1 → 衰減快。

### DecayStrategyConfig

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `mode` | "auto" | discrete / continuous / time-aware / auto |
| `baseDecay` | 0.3 | 指數衰減係數 |
| `referenceIntervalSec` | 60 | tempo 參考間隔（秒） |
| `tempoRange` | [0.5, 2.0] | tempo multiplier 上下限 |
| `levels` | 見上表 | 自訂 decay level 定義 |

## CompactionStrategy

觸發條件：`estimatedTokens > triggerTokens`（預設 20000）

有 ceProvider → LLM 摘要壓縮：
1. 保留最近 `preserveRecentTurns × 2` 條 messages
2. 舊的 messages → 扁平化為文字 → LLM 摘要
3. 摘要結果作為 `[對話摘要]` user message 置入
4. System messages 不壓縮

無 ceProvider → fallback sliding-window（保留最近 N 輪 + repairToolPairing）

### CompactionConfig

| 欄位 | 預設 | 說明 |
|------|------|------|
| `enabled` | true | 開關 |
| `triggerTokens` | 20000 | 觸發閾值 |
| `preserveRecentTurns` | 5 | 保留最近 N 輪不壓縮 |

## OverflowHardStopStrategy

最後防線。觸發條件：tokens > window × 0.95。
截斷至最後 4 條 messages。設定 `overflowSignaled = true`。

## Tool Pairing Repair

`repairToolPairing(messages)` — 截斷後修補 tool_use/tool_result 孤立：
- 移除無對應 tool_result 的 tool_use
- 移除無對應 tool_use 的 tool_result
- 移除因此變空的 messages

## Token 估算

`estimateTokens(messages)` — 粗估（~4 chars/token）。
優先使用 `message.tokens`（per-message 精確值），無則用 chars ÷ 4。

## 全域單例

```typescript
initContextEngine(cfg?)  → ContextEngine   // 接受 decay / compaction / overflowHardStop 設定
getContextEngine()       → ContextEngine | null
```

## 設定路徑

CE 設定統一在 `catclaw.json` 的 `contextEngineering` 區塊：

```json
{
  "contextEngineering": {
    "enabled": true,
    "toolBudget": { "resultTokenCap": 8000, ... },
    "memoryBudget": 2000,
    "strategies": {
      "decay": { "enabled": true, "mode": "auto", "baseDecay": 0.15 },
      "compaction": { "enabled": true, "triggerTokens": 20000 },
      "overflowHardStop": { "enabled": true, "hardLimitUtilization": 0.95 }
    }
  }
}
```
