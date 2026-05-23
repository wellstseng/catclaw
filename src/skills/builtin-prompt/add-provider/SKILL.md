---
description: Use when the user wants to add a new conversation LLM provider to catclaw (e.g. "加 remote ollama" / "新增 openai-compat 端點" / "把 LLM 切到 192.168.x.x 上的 ollama"). Walks through editing ~/.catclaw/models-config.json, registering an alias, and restarting. **Do NOT** edit catclaw.json `agentDefaults` (deprecated, ignored). **Do NOT** assume hot-reload — provider registry requires `./catclaw restart`.
---

# 新增對話 LLM Provider

V2 架構下，對話 LLM 真相源是 `~/.catclaw/models-config.json`（不是 `catclaw.json`）。新增一個 provider（如遠端 ollama、自架 OpenAI-compat 端點）的標準流程。

## 重要前提

- **catclaw.json 的 `agentDefaults` 區塊已廢棄**，寫了會被忽略並 `log.warn`。**不要**動它。
- **對話 LLM 的 ollama**（V2 provider）跟 **memory pipeline 的 ollama**（OllamaClient，embedding/extraction）是**兩條獨立路徑**，host/model 不共用。本 skill 只處理對話 LLM。
- **provider registry 不熱重載** — 改 `models-config.json` 後**必須** `./catclaw restart` 才生效（這跟 memory pipeline 的 Ollama 後端設定卡熱重載不一樣）。

## SOP（以遠端 Ollama 為例）

### Step 1 — 確認後端可達 + 模型存在

在動 config 前先驗證，避免改完發現連不上要回退。

```bash
# 驗 host 可達
curl --max-time 5 http://192.168.88.22:11434/api/version

# 驗模型存在（id 完整名）
curl --max-time 5 http://192.168.88.22:11434/api/tags | python3 -c "import json,sys;[print(' -',m['name']) for m in json.load(sys.stdin).get('models',[])]"
```

連不上就先確認對方 ollama daemon 跑著、port 開、防火牆設定。

### Step 2 — 編輯 `~/.catclaw/models-config.json`

使用 Read + Edit 工具（不要 cat / sed）。加 `providers.{providerKey}` entry：

```jsonc
"providers": {
  // ...其他 provider 不動
  "ollama-remote": {
    "baseUrl": "http://192.168.88.22:11434",
    "api": "ollama",                       // 對應 OllamaProvider；其他可選：anthropic-messages / openai-completions / openai-codex-responses
    "defaultModel": "juilpark/gemma-4-31B-it-uncensored-heretic:q4_k_m",
    "thinkMode": false,                    // qwen3 等 thinking 模型才 true
    "numPredict": 2048,                    // 對話 LLM 一般用 2048；memory pipeline 才用 512
    "timeout": 600000,
    "models": [
      {
        "id": "juilpark/gemma-4-31B-it-uncensored-heretic:q4_k_m",
        "name": "Gemma 4 31B Heretic (remote 192.168.88.22)",
        "reasoning": true,
        "input": ["text", "image"],
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "contextWindow": 32768,
        "maxTokens": 8192
      }
    ]
  }
}
```

**providerKey 命名規則**：`ollama-{用途}`（如 `ollama-remote` / `ollama-local`），這樣 `apiToProviderType` 跟 `id.startsWith("ollama-")` heuristic 都能正確識別成 ollama。

**Cost 全 0**：本地 / 私有部署沒成本，這個欄位給 dashboard 統計用。

### Step 3 — 加 alias（強烈建議）

長 model id（如 `juilpark/gemma-4-31B-it-uncensored-heretic:q4_k_m`）每次打太累。在同個檔案的 `aliases` 加：

```jsonc
"aliases": {
  // ...
  "heretic": "ollama-remote/juilpark/gemma-4-31B-it-uncensored-heretic:q4_k_m"
}
```

之後 `primary` 或 dashboard 切換都可以用 `heretic` 短名。

### Step 4 —（可選）切換 primary

如果要把對話 LLM 切過去，同檔案改：

```jsonc
"primary": "heretic"     // 或 "ollama-remote/juilpark/..." 完整 ref
```

或讓 Wells 之後自己用 dashboard / `/configure model heretic` 切。

### Step 5 — 重啟

```bash
./catclaw restart
```

### Step 6 — 驗證

```bash
# Component Health 應出現新 provider
curl -s http://localhost:8088/api/health | python3 -c "import json,sys;[print(c['name'],'→',c['status']) for c in json.load(sys.stdin)['components'] if 'llm:' in c['name']]"
```

期望看到 `llm:ollama-remote/.../heretic：healthy`。失敗看 `pm2 logs catclaw | grep ollama-remote`。

## 其他 provider 類型對照

| 用途 | api 欄位 | 額外欄位 | 認證 |
|------|---------|---------|------|
| Ollama / Ollama-compat | `ollama` | `defaultModel`, `thinkMode`, `numPredict`, `timeout` | 通常無 |
| OpenAI-compat（OpenAI / 任何相容端點） | `openai-completions` | `baseUrl` | auth-profile.json `api_key` |
| Anthropic Claude | `anthropic-messages` | `baseUrl: "https://api.anthropic.com/v1"` | auth-profile.json `api_key` 或 oauth |
| OpenAI Codex | `openai-codex-responses` | `baseUrl: "https://chatgpt.com/backend-api"` | auth-profile.json oauth |

需要憑證的 provider，**不要**把 token 寫進 `models-config.json` — 寫到 `~/.catclaw/workspace/agents/default/auth-profile.json`，或從 dashboard Auth 分頁加。

## 反例（不要做）

❌ 編 `catclaw.json` 內 `agentDefaults` / `provider` / `providers`（V1 + V2-deprecated 都已廢棄，自動會被 `migrate-v2` 拔掉）

❌ 直接寫 token 進 `models-config.json`（敏感資料應走 auth-profile）

❌ 改完不 restart 就期待新 provider 出現（provider registry 啟動時才註冊）

❌ Memory pipeline 跟對話 LLM 共用同一個 provider entry — 它們是兩條獨立路徑，memory pipeline 改 `catclaw.json` 的 `ollama` block，對話 LLM 改 `models-config.json`

## 失敗排查

| 症狀 | 看哪裡 |
|------|--------|
| `pm2 logs` 出現 `provider-registry-v2] models.json 中找不到 model` | `models-config.json` 內 `providers.{key}.models[].id` 跟 alias 對應不上 |
| `Startup Health` 顯示 `✗ llm:...：unreachable` | 後端服務沒起、host 寫錯、port 寫錯、防火牆擋 |
| Dashboard Auth 分頁「模型設定」面板看不到新 provider | 一般是 `restart` 沒跑成功（看 `pm2 status catclaw` 是否 `online`） |
| `[config] models-config.json 缺少 primary` | `primary` 欄位空、或 alias 對應不到任何 model ref |

## 相關文件

- `wiki/Provider-System.md` — Provider 系統設計 + V2 三層分離
- `README.md` 內「models-config.json」章節 — 完整 schema
- `src/migration/v1-to-v2-provider.ts` — 若使用者環境是舊 V1，先跑 `./catclaw migrate-v2`
