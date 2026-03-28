# skills — 內建 Skill 系統

> 更新日期：2026-03-28

## 檔案結構

```
src/skills/
  types.ts          — Skill, SkillContext, SkillResult 型別
  registry.ts       — loadBuiltinSkills(), loadPromptSkills(), matchSkill()
  builtin/          — TypeScript 執行型 skills
    account.ts      — /account（帳號管理）
    configure.ts    — /configure（provider/model 設定）
    help.ts         — /help
    migrate.ts      — /migrate
    project.ts      — /project
    register.ts     — /register
    restart.ts      — 重啟
    stop.ts         — /stop
    queue.ts        — /queue
    rollback.ts     — /rollback
    subagents.ts    — /subagents
    turn-audit.ts   — /turn-audit
  builtin-prompt/   — SKILL.md 格式 prompt-type skills
```

## Skill 型別

```typescript
interface Skill {
  name: string;
  description: string;
  tier: "admin" | "elevated" | "standard";  // 對應 PermissionGate
  trigger: string[];                          // 觸發字串（前綴匹配）
  execute(ctx: SkillContext): Promise<SkillResult>;
}

interface SkillContext {
  authorId: string;
  guildId?: string;
  channelId: string;
  args: string;         // trigger 之後的文字
}

interface SkillResult {
  text: string;
  isError?: boolean;
}
```

## Registry

- `loadBuiltinSkills()` — 掃描 `dist/skills/builtin/*.js`，auto-import `export const skill` 或 `export const skills[]`
- `loadPromptSkills()` — 掃描 `dist/skills/builtin-prompt/**/SKILL.md`
- `matchSkill(text)` — 前綴匹配 trigger，回傳 `{ skill, args }`

## /configure skill

tier: admin | trigger: `/configure`

### 子命令

| 命令 | 說明 |
|------|------|
| `/configure` / `/configure show` | 顯示目前 provider/model 設定 |
| `/configure model <id> [--provider <id>]` | 更改指定 provider 的 model（寫入 catclaw.json，hot-reload 自動生效） |
| `/configure provider <id>` | 切換預設 provider |
| `/configure models` | 列出 pi-ai 支援的 Anthropic 模型清單 |

### 實作細節

直接讀寫 `$CATCLAW_CONFIG_DIR/catclaw.json`，config 的 hot-reload（fs.watch debounce 500ms）自動套用。
不需要重啟。
