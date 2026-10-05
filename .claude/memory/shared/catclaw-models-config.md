# catclaw-models-config

- Scope: shared
- Confidence: [固]
- Trigger: model, models-config, 模型設定, provider, alias, routing, 切換模型, primary, fallback
- Created-at: 2026-04-06

## 知識

### models-config.json 是模型設定唯一真相源

位置：`$CATCLAW_CONFIG_DIR/models-config.json`（即 `~/.catclaw/models-config.json`）

catclaw.json 不再放 agentDefaults / modelsConfig / modelRouting。
啟動時由 config.ts 讀取 models-config.json 並合成到 runtime config。

### 設定結構

```json
{
  "primary": "sonnet",
  "fallbacks": ["haiku"],
  "aliases": {
    "sonnet": "anthropic/claude-sonnet-4-6",
    "opus": "anthropic/claude-opus-4-6",
    "haiku": "anthropic/claude-haiku-4-5-20251001"
  },
  "providers": {
    "ollama": { "baseUrl": "http://localhost:11434" }
  },
  "routing": {
    "default": "sonnet",
    "channels": {},
    "roles": {},
    "projects": {}
  }
}
```

### 欄位說明

- **primary**：全域預設模型（alias 或 "provider/model" 格式）
- **fallbacks**：primary 不可用時依序嘗試的備援清單
- **aliases**：簡短名 → "provider/model" 對照表
- **providers**：per-provider 額外設定（baseUrl、embeddingModel 等）
- **routing**：模型路由覆蓋（channel/project/role 各層級）

### 路由優先級

```
routing.channels[channelId] > routing.projects[projectId] > routing.roles[role] > routing.default > primary
```

### 查詢方式

- 用 `config_get` 工具：`config_get path="modelRouting"` 可查當前路由設定
- 用 `config_get path="agentDefaults"` 可查當前模型設定
- Dashboard「模型設定」面板可 GUI 切換 primary 和編輯 routing

### 變更歷程

- 2026-04-04：models-config.json 統一化。之前模型設定散落在 catclaw.json 的 agentDefaults / modelsConfig / modelRouting。

## 行動

- （依知識內容判斷）
