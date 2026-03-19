# modules/logger — Log Level 控制

> 檔案：`src/logger.ts`

## 職責

提供層級化 log 輸出，取代直接使用 `console.log`。

## 層級

| 層級 | 數值 | 輸出方式 | 用途 |
|------|------|---------|------|
| `debug` | 0 | `console.log` | 串流細節、訊息過濾結果 |
| `info` | 1 | `console.log` | Bot 上線、session 建立（預設） |
| `warn` | 2 | `console.warn` | 警告 |
| `error` | 3 | `console.error` | 錯誤 |
| `silent` | 4 | — | 完全靜音 |

## API

```typescript
import { log, setLogLevel } from "./logger.js";

setLogLevel("debug");   // 由 index.ts 啟動時呼叫

log.debug("...");        // 只在 debug 層級顯示
log.info("...");         // debug + info 層級顯示
log.warn("...");         // debug + info + warn 層級顯示
log.error("...");        // debug + info + warn + error 層級顯示
```

## 設定

`config.json` 的 `logLevel` 欄位，由 `index.ts` 呼叫 `setLogLevel()` 設定。
