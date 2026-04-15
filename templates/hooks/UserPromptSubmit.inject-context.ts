/**
 * 範例 Hook：UserPromptSubmit → 動態前置上下文
 *
 * 示範 modifying hook：回傳 { action: "modify", data: { prompt: ... } }
 * 即可把新 prompt 傳遞給後續流程（仍會再跑下一個 hook）。
 */

import { defineHook } from "../../src/hooks/sdk.js";

export default defineHook(
  {
    event: "UserPromptSubmit",
    name: "inject-context",
    timeoutMs: 2000,
  },
  async (input) => {
    // 範例：在使用者問「現在幾點」時補上系統時間
    if (/(現在幾點|what time|current time)/i.test(input.prompt)) {
      const now = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei" });
      return {
        action: "modify",
        data: { prompt: `[系統時間：${now}]\n\n${input.prompt}` },
      };
    }
    return { action: "allow" };
  },
);
