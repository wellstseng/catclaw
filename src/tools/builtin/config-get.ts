/**
 * @file tools/builtin/config-get.ts
 * @description config_get — 讓 Claude 讀取 catclaw.json 設定
 *
 * 敏感欄位（token/apiKey/secret/password）自動遮蔽為 ***。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "../types.js";
import { resolveCatclawDir } from "../../core/config.js";

const SECRET_SEGMENTS = new Set(["token", "apikey", "secret", "password", "apikey"]);

function containsSecret(path: string): boolean {
  return path.toLowerCase().split(".").some(seg => SECRET_SEGMENTS.has(seg));
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(resolveCatclawDir(), "catclaw.json"), "utf-8")) as Record<string, unknown>;
}

function getNestedPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((cur, key) => {
    if (cur == null || typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

function filterSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 8 || obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj;
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SECRET_SEGMENTS.has(k.toLowerCase()) ? "***" : filterSecrets(v, depth + 1);
  }
  return result;
}

export const tool: Tool = {
  name: "config_get",
  description: [
    "讀取 catclaw.json 設定。",
    "path 省略則回傳完整 config；指定 dot-path 則回傳該欄位值。",
    "敏感欄位（token/apiKey/secret）自動遮蔽。",
    "範例：path=\"memory.recall\" 回傳 recall 區塊；path=\"discord.guilds\" 回傳所有 guild 設定。",
  ].join(" "),
  tier: "admin",
  resultTokenCap: 1000,
  concurrencySafe: true,
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "dot-path，例如 \"memory\" 或 \"discord.guilds.123.channels\"。省略則回傳完整 config。",
      },
    },
    required: [],
  },
  async execute(params) {
    const path = typeof params["path"] === "string" ? params["path"].trim() : "";
    if (path && containsSecret(path)) {
      return { error: "禁止讀取敏感欄位（token/apiKey/secret/password）" };
    }
    try {
      const raw = readRaw();
      const val = path ? getNestedPath(raw, path) : raw;
      if (val === undefined) return { error: `路徑不存在：${path}` };
      return { result: filterSecrets(val) };
    } catch (err) {
      return { error: `讀取失敗：${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
