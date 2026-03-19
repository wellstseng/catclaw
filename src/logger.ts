/**
 * @file logger.ts
 * @description 簡易 log level 控制
 *
 * 依據 LOG_LEVEL 環境變數決定輸出層級。
 * 層級由低到高：debug < info < warn < error < silent
 * 預設 info，debug 訊息不會輸出。
 */

/** 支援的 log level */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

/** 從環境變數解析 log level，無效值 fallback info */
function resolveLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return "info";
}

const currentLevel = resolveLevel();

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

export const log = {
  debug: (...args: unknown[]) => {
    if (shouldLog("debug")) console.log(...args);
  },
  info: (...args: unknown[]) => {
    if (shouldLog("info")) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (shouldLog("warn")) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (shouldLog("error")) console.error(...args);
  },
};
