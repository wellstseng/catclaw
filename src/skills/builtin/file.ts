/**
 * @file skills/builtin/file.ts
 * @description /file skill — Inline File Reference 助手（項目 8）
 *
 * 用法：
 *   /file                                 → 顯示用法
 *   /file <path>                          → 產 `@file:"path"` 字串
 *   /file <path>:<lineStart>-<lineEnd>    → 產 `@file:"path:start-end"` 字串
 *
 * 使用者複製回傳字串貼到下則訊息中，message-pipeline 會自動展開
 * （參見 src/core/context-references.ts）。同樣支援 `@folder:` / `@git:` /
 * `@url:` / `@diff` / `@staged` 但本 skill 只處理 file 形式（最常用）。
 */

import type { Skill } from "../types.js";

export const skill: Skill = {
  name: "file",
  description:
    "Inline file reference 助手：產出 @file:\"path[:lineStart-lineEnd]\" 字串供使用者複製到下則訊息夾帶檔案內容（項目 8）",
  tier: "standard",
  trigger: ["/file"],

  async execute({ args }) {
    const arg = args.trim();
    if (!arg) {
      return {
        text:
          "📄 **Inline File Reference**\n" +
          "用法：`/file <path>[:lineStart-lineEnd]`\n\n" +
          "例：\n" +
          "• `/file src/core/agent-loop.ts:130-160` — 帶行號範圍\n" +
          "• `/file CLAUDE.md` — 整檔（≤50KB）\n\n" +
          "回應的 `@file:\"...\"` 字串貼到下則訊息即可自動展開（pipeline 內處理）。\n" +
          "其他語法（直接寫在訊息中也會被展開）：\n" +
          "• `@folder:<path>` — 列出資料夾內容（深度 2）\n" +
          "• `@git:<commitish>` — 該 commit 的 diff/stat\n" +
          "• `@url:<https://...>` — 網頁內容\n" +
          "• `@diff` / `@staged` — 當前 git diff / staging diff",
      };
    }

    // 拒絕含空格（語法上會破壞展開），引導使用引號形式
    const stripped = arg.replace(/^["']|["']$/g, "").trim();
    if (/\s/.test(stripped)) {
      return {
        text: `❌ 路徑不該含空格。可改用引號形式：\`@file:"${stripped}"\``,
        isError: true,
        validation: true,
      };
    }

    return {
      text:
        `📄 已產出 inline reference（複製到下則訊息即會自動展開）：\n\n` +
        `\`\`\`\n@file:"${stripped}"\n\`\`\``,
    };
  },
};
