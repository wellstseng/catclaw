# context-references

> 對應原始碼：`src/core/context-references.ts`
> 建立日期：2026-05-04（CatClaw 整合 Hermes 計畫項目 8）

## 用途

使用者訊息含 `@file:` / `@folder:` / `@git:` / `@url:` / `@diff` / `@staged` 時，
pipeline 預處理階段自動解析並展開內容到訊息末尾，避免額外 tool round-trip。

## 6 種 kind

| Kind | 語法 | 行為 | 上限 |
|------|------|------|------|
| `file` | `@file:"path"` 或 `@file:"path:lineStart-lineEnd"` 或 `@file:path` | 讀檔 + 行號標註 | 50KB |
| `folder` | `@folder:path` 或 `@folder:"path"` | tree -L 2 風格列舉 | 200 entries |
| `git` | `@git:<commitish>` | `git show --stat <commitish>` | 100KB |
| `url` | `@url:<https://...>` | global fetch + AbortSignal.timeout(10s) | 50KB |
| `diff` | `@diff` | `git diff` 當前 working tree | 100KB |
| `staged` | `@staged` | `git diff --staged` | 100KB |

## Exports

```typescript
export type ReferenceKind = "file" | "folder" | "git" | "url" | "diff" | "staged";

export interface ExpandedReference {
  kind: ReferenceKind;
  raw: string;          // 原 @xxx 字樣（含前綴 @）
  target: string;       // path / commitish / url（diff/staged 為空）
  ok: boolean;
  content: string;      // 成功：展開內容；失敗：錯誤說明
  sizeBytes?: number;
}

export interface ExpandReferencesOpts {
  cwd?: string;         // 預設 process.cwd()
}

export function hasReferences(prompt: string): boolean;
export async function expandReferences(prompt: string, opts?: ExpandReferencesOpts):
  Promise<{ expanded: string; results: ExpandedReference[] }>;
```

## Regex

```
(?<![\w/])@(diff\b|staged\b|file:(?:"[^"]+"|[^\s,。；]+)|folder:(?:"[^"]+"|[^\s,。；]+)|git:[^\s,。；]+|url:[^\s,。；]+)
```

- Negative lookbehind `(?<![\w/])` 避免 `foo@bar.com` / `path/file@x` 誤觸
- 結尾 char class 排除中文標點（`，` `。` `；`）便利夾在中文句中

## 安全邊界

- **路徑**：拒絕含 `..` 任何 segment / 拒絕含 `.ssh / .aws / .gnupg / id_rsa / .env / password / secret / credentials` 等敏感 pattern
- **URL**：必須 `http://` 或 `https://`，10s timeout
- **Git**：commitish 限定 `[a-zA-Z0-9_./~@^-]+` 字符集（防 shell 注入）
- **大小**：file 50KB / folder 200 entries / git 100KB / url 50KB

## 接入點

- `message-pipeline.ts` 內 `sanitizeMemoryText` 後加 `expandReferences` 階段。
  `hasReferences()` 快速 check 避免每訊息都跑展開。
- `message-trace.ts MessageTraceEntry.referencesExpanded` 欄位 +
  `recordReferencesExpanded()` method。
- 新 `/file <path>[:lines]` skill (`src/skills/builtin/file.ts`)：助手字串產生器，
  使用者貼 `/file src/foo.ts:10-20` → 回傳 `@file:"src/foo.ts:10-20"` 字串。

## 失敗處理

- 路徑不存在 / 不安全 / 大小超限 / git/url 失敗時，**保留原 `@xxx` 字樣**（讓 LLM 看到使用者意圖），
  在訊息末尾額外加 `[inline-ref kind@target ⚠️ 失敗]\n<原因>\n[/inline-ref]` 區塊。
- pipeline 整段 try/catch 包，展開失敗只 warn log 不阻塞訊息送出。
