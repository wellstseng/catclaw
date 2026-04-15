#!/usr/bin/env node
/**
 * @file hooks/hook-runtime.ts
 * @description TS / JS hook 執行入口
 *
 * 用法：`node hook-runtime.js <scriptPath>` 或 `bunx tsx hook-runtime.ts <scriptPath>`
 *
 * 流程：
 * 1. 讀 stdin → JSON.parse → HookInput
 * 2. 動態 import scriptPath → 拿 default export
 * 3. 驗證 isDefinedHook → 呼叫 handler(input)
 * 4. 結果寫 stdout（JSON.stringify HookAction）
 *
 * 失敗時印錯誤到 stderr + exit 非零（hook-runner 會視為 passthrough）
 */

import { pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";
import { isDefinedHook } from "./sdk.js";
import type { HookInput, HookAction } from "./types.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const metadataOnly = args.includes("--metadata-only");
  const scriptPath = args.find(a => !a.startsWith("--"));
  if (!scriptPath) {
    process.stderr.write("hook-runtime: missing scriptPath argument\n");
    process.exit(2);
  }

  // metadata-only 模式：載入腳本 → 印 metadata JSON → exit
  if (metadataOnly) {
    const absPathMeta = pathResolve(scriptPath);
    const urlMeta = pathToFileURL(absPathMeta).href;
    try {
      const modMeta = (await import(urlMeta)) as { default?: unknown };
      if (!isDefinedHook(modMeta.default)) {
        process.stderr.write("hook-runtime: default export is not a DefinedHook\n");
        process.exit(5);
      }
      process.stdout.write(JSON.stringify(modMeta.default.metadata));
      return;
    } catch (err) {
      process.stderr.write(`hook-runtime: metadata import failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(4);
    }
  }

  // 1. 讀 stdin
  const raw = await readStdin();
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    process.stderr.write(`hook-runtime: stdin not valid JSON: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  }

  // 2. 動態載入腳本
  const absPath = pathResolve(scriptPath);
  const url = pathToFileURL(absPath).href;
  let mod: { default?: unknown };
  try {
    mod = (await import(url)) as { default?: unknown };
  } catch (err) {
    process.stderr.write(`hook-runtime: import failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(4);
  }

  const exported = mod.default;
  if (!isDefinedHook(exported)) {
    process.stderr.write(`hook-runtime: default export is not a DefinedHook (use defineHook from sdk)\n`);
    process.exit(5);
  }

  // 3. 呼叫 handler
  let action: HookAction;
  try {
    const handlerInput = input as Parameters<typeof exported.handler>[0];
    const result = await exported.handler(handlerInput);
    action = result;
  } catch (err) {
    process.stderr.write(`hook-runtime: handler threw: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(6);
  }

  // 4. 寫 stdout
  process.stdout.write(JSON.stringify(action));
}

void main();
