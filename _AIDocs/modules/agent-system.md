# Agent System — Multi-Agent 設定與型別

> 對應原始碼：`src/core/agent-loader.ts`、`src/core/agent-registry.ts`、`src/core/agent-types.ts`
> 更新日期：2026-04-06

## 概觀

CatClaw 支援多 bot 部署（`--agent <id>`），每個 agent 可覆寫頂層 config。
同時定義 Typed Agent（explore / plan / build / review）供 subagent spawn 使用。

## 三個檔案職責

| 檔案 | 職責 |
|------|------|
| `agent-loader.ts` | CLI `--agent` 解析 + config 深合併 + per-agent data 路徑 |
| `agent-registry.ts` | `AgentRegistry` class + `deepMerge()` 工具函式 |
| `agent-types.ts` | `AgentTypeConfig` 介面 + 預定義 `AGENT_TYPES` |

## agent-loader.ts

### 核心函式

| 函式 | 說明 |
|------|------|
| `parseAgentArg(argv?)` | 解析 `--agent <id>` 或 `--agent=<id>` |
| `resolveAgentDataDir(agentId, catclawDir?)` | 回傳 `~/.catclaw/agents/{id}/` |
| `loadAgentConfig(base, agentId)` | 從 `base.agents[agentId]` 深合併，自動設定 per-agent session/vectordb 路徑 |

### Per-agent 路徑

```
~/.catclaw/agents/{agentId}/
  ├── sessions/        # session 持久化
  └── _vectordb/       # 向量資料庫
```

## agent-registry.ts

### deepMerge 規則

- 純值 → agent 覆寫頂層
- Object → 遞迴合併（agent 優先）
- Array → agent 完全替換（不 concat）

### AgentRegistry class

| 方法 | 說明 |
|------|------|
| `list()` | 列出所有已設定 agent ID |
| `has(agentId)` | 確認是否存在 |
| `resolve(agentId, base)` | 深合併回傳完整 config |

全域單例：`initAgentRegistry(agents: AgentsConfig)` / `getAgentRegistry()` / `resetAgentRegistry()`

## agent-types.ts

### AgentTypeConfig 介面

```ts
interface AgentTypeConfig {
  label: string;
  allowedTools: string[] | null;  // null = 不限制
  systemPrompt: string;
  modelOverride?: string;
  defaultMaxTurns: number;
  defaultTimeoutMs: number;
}
```

### 預定義 AGENT_TYPES

| Type | Label | Tools | maxTurns | timeout |
|------|-------|-------|----------|---------|
| `default` | General Purpose | 全部 | 10 | 120s |
| `coding` | Coding | read/write/edit/run/glob/grep | 15 | 180s |
| `explore` | Explore | read/glob/grep | 8 | 60s |
| `plan` | Plan | read/glob/grep | 8 | 90s |
| `build` | Build | read/write/edit/run/glob/grep | 20 | 300s |
| `review` | Review | read/glob/grep/run | 10 | 120s |

### 工具函式

| 函式 | 說明 |
|------|------|
| `getAgentType(type)` | 取得 config（fallback to default） |
| `listAgentTypes()` | 列出所有可用 types（供 tool_search / system prompt） |

## config.json 範例

```json
{
  "agents": {
    "support-bot": {
      "discord": { "token": "${SUPPORT_BOT_TOKEN}" },
      "providers": { "claude-api": { "model": "claude-haiku-4-5-20251001" } }
    },
    "dev-bot": {
      "discord": { "token": "${DEV_BOT_TOKEN}" }
    }
  }
}
```

## PM2 多 bot 部署

```js
// ecosystem.config.cjs
{ name: "catclaw-support", script: "dist/index.js", args: "--agent support-bot" }
{ name: "catclaw-dev",     script: "dist/index.js", args: "--agent dev-bot" }
```
