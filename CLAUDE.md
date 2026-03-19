# claude_discord — 專案指引

## 專案簡介

輕量 Discord → Claude CLI bridge。
不依賴 OpenClaw，使用 discord.js + Claude Code CLI（`claude -p --output-format stream-json`）。

## 知識庫

開工前先讀 `_AIDocs/_INDEX.md`，架構細節在 `_AIDocs/01-ARCHITECTURE.md`。

## 程式碼規範

### 註解要求（強制）

**所有生成的程式碼必須附帶完整註解：**

1. **檔頭必須包含：**
   ```typescript
   /**
    * @file <filename>
    * @description <這個檔案的用途與功能說明>
    *
    * <詳細說明：這個模組負責什麼、與其他模組的關係>
    */
   ```

2. **函式／方法必須有 JSDoc：**
   ```typescript
   /**
    * <函式說明>
    * @param <name> <說明>
    * @returns <說明>
    */
   ```

3. **複雜邏輯區塊必須有行內說明：**
   - 條件判斷的業務邏輯（為什麼這樣判斷）
   - 非直覺的數字常數（為什麼是這個值）
   - 非同步流程控制（例如 Promise chain 串行的原因）

4. **陷阱或邊界條件旁標記 `// NOTE:`：**
   ```typescript
   // NOTE: DM 必須加 Partials.Channel，否則 discord.js 不會觸發 DM 事件
   ```

### 語言

- 程式碼：TypeScript（ESM）
- 註解語言：中文（技術術語可英文）
- 變數/函式命名：英文 camelCase

### 其他

- 嚴格型別，不用 `any`
- 每個模組職責單一
- 不加不必要的 abstraction（YAGNI）
