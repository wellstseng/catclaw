# modules/mcp-client — MCP Server 連線

> 檔案：`src/mcp/client.ts`
> 更新日期：2026-04-06

## 職責

連接外部 MCP server（stdio JSON-RPC 2.0），自動取得 tool 清單並註冊到 ToolRegistry。
每個 server 一個 `McpClient` 實例。

## 設定

```jsonc
// catclaw.json
"mcp": {
  "servers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "my-mcp-server"],
      "env": { "API_KEY": "..." },
      "tier": "elevated",     // 此 server 所有 tool 的預設 tier（預設 elevated）
      "deferred": true        // deferred 模式：不注入完整 schema 到 LLM context（預設 true）
    }
  }
}
```

## 連線流程

```
McpClient.start()
  ↓ spawn(command, args)          — stdio: pipe/pipe/pipe
  ↓ JSON-RPC: initialize          — protocolVersion: "2024-11-05"
  ↓ notification: initialized
  ↓ JSON-RPC: tools/list          — 取得 server 提供的 tool 清單
  ↓ _registerTools()              — 註冊到 ToolRegistry
  → ready
```

## Tool 命名

MCP tool 註冊名稱格式：`mcp_{serverName}_{toolName}`

例：server `github`、tool `create_issue` → `mcp_github_create_issue`

## Tool 執行

```typescript
client.call(toolName: string, args: Record<string, unknown>): Promise<string>
```

發送 JSON-RPC `tools/call` → 回傳 `content[].text` 合併文字。
timeout: 30 秒。

## 崩潰重連

- 程序退出或啟動失敗 → 自動重連
- 最多 3 次，間隔指數退避（1s → 2s → 4s）
- 重連成功 → retries 歸零
- 超過上限 → 放棄（log warn）

## JSON-RPC 通訊

| 方向 | 說明 |
|------|------|
| → stdin | `JsonRpcRequest { jsonrpc: "2.0", id, method, params }` |
| ← stdout | `JsonRpcResponse { jsonrpc: "2.0", id, result?, error? }` |
| ← stderr | debug log |

每個 request 有獨立 id，pending Map 追蹤 resolve/reject。

## 整合點

| 呼叫者 | 用途 |
|--------|------|
| `platform.ts` | 遍歷 `config.mcp.servers` 建立 McpClient + start() |
| ToolRegistry | `_registerTools()` 自動註冊 tool |
| `agent-loop.ts` | 透過 ToolRegistry 正常呼叫 MCP tool |
