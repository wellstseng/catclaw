/**
 * @file core/platform.ts
 * @description 平台子系統初始化器
 *
 * 一次性初始化所有新子系統（provider / session / tool / permission / safety）
 * 並提供「是否啟用新平台路徑」的判斷。
 *
 * 策略：config.providers 有設定 → 啟用新 agentLoop 路徑
 *       否則 → 保留舊 Claude CLI 路徑（向下相容）
 *
 * 身份解析（S6 暫時版，S9 補完整帳號系統）：
 *   - admin.allowedUserIds 中的 Discord ID → platform-owner
 *   - 其餘 → guest（暫用 discord:{platformId} 作為 accountId）
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger.js";
import type { BridgeConfig } from "./config.js";

import { AccountRegistry } from "../accounts/registry.js";
import { ToolRegistry, initToolRegistry } from "../tools/registry.js";
import { PermissionGate, initPermissionGate } from "../accounts/permission-gate.js";
import { SafetyGuard, initSafetyGuard } from "../safety/guard.js";
import { SessionManager, initSessionManager } from "./session.js";
import { eventBus } from "./event-bus.js";
import { buildProviderRegistryV2, initProviderRegistry } from "../providers/registry.js";
import { ensureModelsJson, loadModelsJson } from "../providers/models-config.js";
import { initAuthProfileStore, getAuthProfileStore } from "../providers/auth-profile-store.js";
import { initWorkflow } from "../workflow/bootstrap.js";
import { initRegistrationManager } from "../accounts/registration.js";
import { initIdentityLinker } from "../accounts/identity-linker.js";
import { initProjectManager, type ProjectManager } from "../projects/manager.js";
import { initMemoryEngine, type MemoryEngine } from "../memory/engine.js";
import { initOllamaClient, getOllamaClient, swapOllamaClient, OllamaClient, buildBackendsFromConfig } from "../ollama/client.js";
import { initEmbeddingProvider, hasEmbeddingProvider, getEmbeddingProvider } from "../vector/embedding-provider.js";
import { initExtractionProvider, hasExtractionProvider, getExtractionProvider } from "../memory/extraction-provider.js";
import { reportStartupSummary } from "./health-monitor.js";
import { initRateLimiter, getRateLimiter, type RateLimiter } from "./rate-limiter.js";
import { renameSessions } from "../migration/rename-sessions.js";
import { initTraceStore, getTraceStore, getTraceContextStore } from "./message-trace.js";
import { initContextEngine } from "./context-engine.js";
import { initSubagentRegistry } from "./subagent-registry.js";
import { initBackgroundJobRegistry } from "./background-job-registry.js";
import { initToolLogStore, getToolLogStore } from "./tool-log-store.js";
import { initInboundHistoryStore } from "../discord/inbound-history.js";
import { initSessionSnapshotStore, getSessionSnapshotStore } from "./session-snapshot.js";
import { initCollabConflictDetector, connectToEventBus as connectCollabToEventBus } from "../safety/collab-conflict.js";

// ── 子系統實例（module-level singleton） ─────────────────────────────────────

let _accountRegistry: AccountRegistry | null = null;
let _toolRegistry: ToolRegistry | null = null;
let _projectManager: ProjectManager | null = null;
let _memoryEngine: MemoryEngine | null = null;
let _rateLimiter: RateLimiter | null = null;
let _permissionGate: PermissionGate | null = null;
let _safetyGuard: SafetyGuard | null = null;
let _sessionManager: SessionManager | null = null;
let _ready = false;
let _memoryRoot: string | null = null;
// init 失敗時保留錯誤資訊給 dashboard /api/status 暴露給使用者
let _initError: { stage: string; message: string; stack?: string; at: string } | null = null;

export function getPlatformInitError(): typeof _initError {
  return _initError;
}

export function setPlatformInitError(err: NonNullable<typeof _initError>): void {
  _initError = err;
}

// ── 初始化 ────────────────────────────────────────────────────────────────────

/**
 * 初始化所有平台子系統。
 * 僅在 config.providers 有設定時才啟動（否則 skip，保持舊路徑）。
 *
 * @param config 全域設定
 * @param catclawDir CATCLAW_CONFIG_DIR（config/memory/accounts）
 * @param distDir dist/ 路徑（用於 loadFromDirectory）
 * @param workspaceDir CATCLAW_WORKSPACE（data/agents/CATCLAW.md）
 */
export async function initPlatform(
  config: BridgeConfig,
  catclawDir: string,
  distDir: string,
  workspaceDir?: string,
): Promise<void> {
  const wsDir = workspaceDir ?? join(catclawDir, "workspace");
  const { getBootAgentDataDir } = await import("./agent-loader.js");
  const bootAgentDir = getBootAgentDataDir(catclawDir);
  log.info(`[platform] 初始化新平台子系統... bootAgent=${bootAgentDir}`);

  // ── 0. Dashboard 提前啟動 ─────────────────────────────────────────────────
  // 提到最早：任何後續 init 步驟 throw 時，dashboard 仍是活的，使用者可從 GUI 看到 error
  // 並從 dashboard 改設定（如補 models-config.json aliases）後 restart 救回
  if (config.dashboard?.enabled) {
    try {
      const { initDashboard } = await import("./dashboard.js");
      initDashboard(config.dashboard.port ?? 8088, config.dashboard.token);
      log.info(`[platform] Dashboard 早期啟動於 port ${config.dashboard.port ?? 8088}（其他 init 進行中，部分 API 待 init 完成）`);
    } catch (err) {
      log.warn(`[platform] Dashboard 早期啟動失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 1. AccountRegistry ─────────────────────────────────────────────────────
  _accountRegistry = new AccountRegistry(catclawDir);
  _accountRegistry.init();

  // 自動建立 admin 帳號（S6 暫時：從 config.admin.allowedUserIds 取得）
  for (const discordId of (config.admin?.allowedUserIds ?? [])) {
    const existing = _accountRegistry.resolveIdentity("discord", discordId);
    if (!existing) {
      const accountId = `discord-owner-${discordId}`;
      try {
        _accountRegistry.create({
          accountId,
          displayName: `Admin(${discordId})`,
          role: "platform-owner",
          identities: [{ platform: "discord", platformId: discordId, linkedAt: new Date().toISOString() }],
        });
        log.info(`[platform] 自動建立 platform-owner 帳號：${accountId}`);
      } catch {
        // 帳號已存在（重啟時）
      }
    }
  }

  // ── 2. Tool Registry ───────────────────────────────────────────────────────
  _toolRegistry = initToolRegistry({ defaultTimeoutMs: config.contextEngineering?.toolBudget?.toolTimeoutMs ?? 0 });
  const builtinDir = join(distDir, "tools", "builtin");
  await _toolRegistry.loadFromDirectory(builtinDir);

  // ── 3. Permission Gate ─────────────────────────────────────────────────────
  _permissionGate = initPermissionGate(_accountRegistry, _toolRegistry);

  // ── 4. Safety Guard ────────────────────────────────────────────────────────
  _safetyGuard = initSafetyGuard(config.safety, catclawDir);

  // ── 5. Provider Registry ───────────────────────────────────────────────────
  // V2 三層分離 — 對話 LLM 真相源在 models-config.json（B 方案）
  // 偵測 catclaw.json 殘留 legacy（V1 provider/providers 或 V2-deprecated agentDefaults）→ 自動 migrate
  // 條件：catclaw.json 有 legacy 區塊，**且** models-config.json 沒對齊（避免每次都跑）
  const { resolveConfigPath, reloadConfigNow } = await import("./config.js");
  let rawCfgForCheck: Record<string, unknown> = {};
  try { rawCfgForCheck = JSON.parse(readFileSync(resolveConfigPath(), "utf-8")); } catch { /* ignore */ }
  const hasLegacy = !!rawCfgForCheck["provider"] || !!rawCfgForCheck["providers"] || !!rawCfgForCheck["providerRouting"] || !!rawCfgForCheck["agentDefaults"];
  if (hasLegacy) {
    log.info("[platform] 偵測到 catclaw.json 內 legacy 區塊（provider/providers/providerRouting/agentDefaults），自動 migrate...");
    const { migrateV1ToV2 } = await import("../migration/v1-to-v2-provider.js");
    const mr = await migrateV1ToV2({ configPath: resolveConfigPath(), workspaceDir: wsDir });
    log.info(`[platform] migrate-v2 status=${mr.status}; 變動 ${mr.changes.length} 項${mr.backupPath ? `；備份 ${mr.backupPath}` : ""}`);
    if (mr.requiresManualReview?.length) {
      for (const note of mr.requiresManualReview) log.warn(`[platform] migrate-v2 需手動確認：${note}`);
    }
    if (mr.status === "migrated") reloadConfigNow();
  }
  if (!config.agentDefaults?.model?.primary) {
    throw new Error("[platform] models-config.json 缺少 primary（對話 LLM 未設定）— 請至 dashboard Auth 分頁設定，或執行 `./catclaw migrate-v2`");
  }
  log.info("[platform] V2 provider 設定（三層分離）");
  ensureModelsJson(wsDir, config.modelsConfig);
  const modelsJson = loadModelsJson(wsDir);
  const authProfilePath = join(wsDir, "agents", "default", "auth-profile.json");
  initAuthProfileStore(authProfilePath);
  const authStore = getAuthProfileStore();
  const providerRegistry = await buildProviderRegistryV2(
    config.agentDefaults,
    modelsJson,
    authStore,
    config.providerRouting ?? {},
  );
  initProviderRegistry(providerRegistry);

  // ── 6. Session Manager ─────────────────────────────────────────────────────
  const sessionCfg = config.session ?? {
    ttlHours: 168,
    maxHistoryTurns: 50,
    compactAfterTurns: 30,
    persistPath: join(wsDir, "data", "sessions-v2"),
  };
  _sessionManager = initSessionManager(sessionCfg, eventBus);
  // V1 → V2 session 檔名遷移（加 platform 前綴，冪等）
  const sessionPersistDir = join(wsDir, "data", "sessions-v2");
  renameSessions({ persistDir: sessionPersistDir, platform: "discord" });
  await _sessionManager.init();

  // ── 6.5 Task Store 持久化 ──────────────────────────────────────────────────
  {
    const { initTaskPersistence } = await import("./task-store.js");
    initTaskPersistence(join(wsDir, "data", "tasks"));
  }

  // ── 7. Registration + Identity Linker ─────────────────────────────────────
  initRegistrationManager(catclawDir, _accountRegistry);
  initIdentityLinker(_accountRegistry);

  // ── 8. Project Manager ─────────────────────────────────────────────────────
  _projectManager = initProjectManager(join(wsDir, "data"));

  // ── 8.5 Ollama Client（供 embedding 使用）─────────────────────────────────
  const ollamaActive = config.ollama?.enabled !== false && !!config.ollama;
  if (ollamaActive) {
    initOllamaClient(config.ollama!);
    log.info(`[platform] OllamaClient 初始化：${config.ollama!.primary?.host ?? "http://localhost:11434"}`);
  }

  // ── 8.6 Embedding Provider（provider 抽象層）──────────────────────────────
  if (config.memoryPipeline?.embedding) {
    // Cross-validate：embedding 配 ollama 但 ollama 沒啟用 → 啟動就 fail loud
    // 不延後到首次 embed 才掛（過去這樣會被 health-monitor 通報但服務已半殘）
    if (config.memoryPipeline.embedding.provider === "ollama" && !ollamaActive) {
      throw new Error(
        `[platform] config 不一致：memoryPipeline.embedding.provider="ollama" 但 config.ollama 未啟用。` +
        `請在 catclaw.json 補 ollama 區塊（含 enabled:true 與 primary.host），` +
        `或把 memoryPipeline.embedding.provider 改成其他可用 provider。`
      );
    }
    initEmbeddingProvider(config.memoryPipeline.embedding);
  }

  // ── 8.7 Extraction Provider（provider 抽象層）─────────────────────────────
  if (config.memoryPipeline?.extraction) {
    if (config.memoryPipeline.extraction.provider === "ollama" && !ollamaActive) {
      log.warn(`[platform] memoryPipeline.extraction.provider="ollama" 但 ollama 未啟用，將略過 extraction（不阻塞 startup）`);
    } else {
      try {
        initExtractionProvider(config.memoryPipeline.extraction);
      } catch (err) {
        log.warn(`[platform] ExtractionProvider 初始化失敗（萃取將靜默跳過）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 9. Memory Engine ───────────────────────────────────────────────────────
  const memoryConfig = { ...(config.memory ?? {}) };

  const defaultMemoryCfg = {
    enabled: true,
    root: join(bootAgentDir, "memory"),
    vectorDbPath: config.memory?.vectorDbPath ?? join(catclawDir, "_vectordb"),
    contextBudget: 3000,
    contextBudgetRatio: { global: 0.3, project: 0.4, account: 0.3 },
    writeGate: { enabled: true, dedupThreshold: 0.80 },
    recall: { triggerMatch: true, vectorSearch: false, relatedEdgeSpreading: true, vectorMinScore: 0.65, vectorTopK: 5 },
    extract: { enabled: true, perTurn: true, maxItemsPerTurn: 3, accumCharThreshold: 200, accumTurnThreshold: 5, cooldownMs: 120_000 },
    consolidate: { autoPromoteThreshold: 20, suggestPromoteThreshold: 8, decay: { enabled: false, halfLifeDays: 30, archiveThreshold: 0.1 } },
    episodic: { enabled: false, ttlDays: 24 },
    rutDetection: { enabled: false, windowSize: 14, minOccurrences: 2 },
    oscillation: { enabled: false },
  };
  const resolvedMemoryCfg = { ...defaultMemoryCfg, ...memoryConfig };
  // boot agent 的 memory root 必須指向 agents/{bootAgentId}/memory/（覆蓋 config fallback）
  resolvedMemoryCfg.root = join(bootAgentDir, "memory");
  resolvedMemoryCfg.vectorDbPath = config.memory?.vectorDbPath ?? join(catclawDir, "_vectordb");
  _memoryRoot = resolvedMemoryCfg.root;

  if (resolvedMemoryCfg.enabled !== false) {
    _memoryEngine = initMemoryEngine(resolvedMemoryCfg);
    try { await _memoryEngine.init(); } catch (err) {
      log.warn(`[platform] MemoryEngine init 失敗（繼續）：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── 9.5 Rate Limiter ───────────────────────────────────────────────────────
  _rateLimiter = initRateLimiter(config.rateLimit ?? {
    guest:    { requestsPerMinute: 5 },
    member:   { requestsPerMinute: 30 },
    admin:    { requestsPerMinute: 120 },
  });

  // ── 9.6 Context Engine ─────────────────────────────────────────────────────
  const ceCfg = config.contextEngineering;
  if (ceCfg?.enabled !== false) {
    const ce = initContextEngine({
      decay: ceCfg?.strategies?.decay,
      compaction: ceCfg?.strategies?.compaction,
      overflowHardStop: ceCfg?.strategies?.overflowHardStop,
      dataDir: join(wsDir, "data"),
    });
    // 若 compaction 指定了 model，取得或建立專用 CE provider 並注入
    const ceModel = ceCfg?.strategies?.compaction?.model;
    if (ceModel) {
      // 優先從 registry 取（支援 alias / model-ref）
      const { getProviderRegistry: getRegistry } = await import("../providers/registry.js");
      const ceProvider = getRegistry().get(ceModel);
      if (ceProvider) {
        ce.setCeProvider(ceProvider);
        log.info(`[platform] CE compaction provider: ${ceModel} (resolved)`);
      } else {
        log.warn(`[platform] CE compaction model "${ceModel}" 無法從 registry 解析，LLM 摘要不可用（將使用截斷 fallback）。請檢查 catclaw.json contextEngineering.strategies.compaction.model 設定`);
      }
    }
    log.info("[platform] ContextEngine 初始化完成");
  }

  // ── 9.65 Subagent Registry ─────────────────────────────────────────────────
  initSubagentRegistry(config.subagents?.maxConcurrent ?? 3);
  log.info("[platform] SubagentRegistry 初始化完成");

  // ── 9.66 Background Job Registry（本地 shell 長期程式追蹤） ───────────────
  const bgRegistry = initBackgroundJobRegistry();
  bgRegistry.setEventHandlers({
    onComplete: (r) => {
      // 先 emit：parent turn 還活著時 agent-loop listener 會接住
      eventBus.emit("background-job:completed", r.parentSessionKey, r.jobId, r.label, r.exitCode ?? null, r.stdoutPath);
      // Fallback：300ms 後若 parent stream 已退場 → wake-agent 喚醒新 turn 由 agent 自報
      setTimeout(() => {
        void (async () => {
          try {
            const { isParentStreamActive, getDiscordClient } = await import("./subagent-discord-bridge.js");
            if (!r.discordChannelId || isParentStreamActive(r.discordChannelId)) return;
            const injected = [
              `[平台喚醒] 你之前 spawn 的背景 job 已完成。`,
              `- jobId: ${r.jobId}`,
              `- label: ${r.label}`,
              `- exitCode: ${r.exitCode ?? "null"}`,
              r.stdoutPath ? `- stdout: ${r.stdoutPath}` : "",
              r.expectedOutputs?.length ? `- expectedOutputs: ${r.expectedOutputs.slice(0, 3).join(", ")}` : "",
              ``,
              `請依本 session 之前的脈絡判斷後續：執行下一步、回報使用者、或結束。`,
              `（你 end_turn 後事件無人接，由平台自動為你重啟 turn。）`,
            ].filter(Boolean).join("\n");
            // 先建 trace（讓 ping 訊息能附 traceId 短碼，使用者可在 dashboard 追蹤 wake turn）
            const { MessageTrace } = await import("./message-trace.js");
            const { randomUUID } = await import("node:crypto");
            const wakeTrace = MessageTrace.create(randomUUID(), r.discordChannelId, r.accountId ?? "_system", "wake");
            wakeTrace.recordInbound({ text: injected.slice(0, 200), attachments: 0 });
            // 即時 ping：避免 wake turn 30-60s 期間使用者完全沒訊號；附 traceId 短碼
            try {
              const client = getDiscordClient();
              if (client) {
                const ch = await client.channels.fetch(r.discordChannelId);
                if (ch && "send" in ch) {
                  const ok = r.exitCode === 0 || r.exitCode === null;
                  await (ch as { send: (s: string) => Promise<unknown> }).send(`${ok ? "✅" : "⚠️"} 背景 Job 完成：${r.label}（exitCode=${r.exitCode ?? "null"}）— agent 處理中⋯ \`[trace ${wakeTrace.traceId.slice(0, 8)}]\``);
                }
              }
            } catch (e) { log.warn(`[bg-job] 即時 ping 失敗：${e instanceof Error ? e.message : String(e)}`); }
            const { wakeAgentForCompletion } = await import("./wake-agent.js");
            const wakeResult = await wakeAgentForCompletion({
              sessionKey: r.parentSessionKey,
              channelId: r.discordChannelId,
              accountId: r.accountId ?? "_system",
              agentId: r.agentId,
              injectedMessage: injected,
              source: "background-job",
              recordId: r.jobId,
              trace: wakeTrace,
            });
            if (!wakeResult.ok) {
              log.warn(`[bg-job] wake 失敗（${wakeResult.reason}），fallback 走 Discord 文字通知`);
              const { sendBgJobNotification } = await import("./bg-job-discord-bridge.js");
              await sendBgJobNotification(r, { type: "completed" });
            }
          } catch (err) { log.warn(`[bg-job] fallback notify 失敗：${err instanceof Error ? err.message : String(err)}`); }
        })();
      }, 300);
    },
    onFail: (r, reason) => {
      eventBus.emit("background-job:failed", r.parentSessionKey, r.jobId, r.label, reason);
      setTimeout(() => {
        void (async () => {
          try {
            const { isParentStreamActive, getDiscordClient } = await import("./subagent-discord-bridge.js");
            if (!r.discordChannelId || isParentStreamActive(r.discordChannelId)) return;
            // 失敗 case：wake + 同時保留平台 Discord 通知（雙保險）
            const injected = [
              `[平台喚醒] 你之前 spawn 的背景 job ❌ 失敗。`,
              `- jobId: ${r.jobId}`,
              `- label: ${r.label}`,
              `- exitCode: ${r.exitCode ?? "null"}`,
              `- reason: ${reason}`,
              r.stdoutPath ? `- stdout: ${r.stdoutPath}` : "",
              ``,
              `請判斷根因（看 stdout 尾段）、決定是否重試或回報使用者。`,
              `（你 end_turn 後事件無人接，由平台自動為你重啟 turn。）`,
            ].filter(Boolean).join("\n");
            // 先建 trace（讓 ping 訊息能附 traceId 短碼）
            const { MessageTrace } = await import("./message-trace.js");
            const { randomUUID } = await import("node:crypto");
            const wakeTrace = MessageTrace.create(randomUUID(), r.discordChannelId, r.accountId ?? "_system", "wake");
            wakeTrace.recordInbound({ text: injected.slice(0, 200), attachments: 0 });
            // 即時 ping：失敗也要快速通知，wake turn 才有時間做根因分析；附 traceId
            try {
              const client = getDiscordClient();
              if (client) {
                const ch = await client.channels.fetch(r.discordChannelId);
                if (ch && "send" in ch) {
                  await (ch as { send: (s: string) => Promise<unknown> }).send(`❌ 背景 Job 失敗：${r.label}（${reason}）— agent 分析中⋯ \`[trace ${wakeTrace.traceId.slice(0, 8)}]\``);
                }
              }
            } catch (e) { log.warn(`[bg-job] 即時 ping 失敗：${e instanceof Error ? e.message : String(e)}`); }
            const { wakeAgentForCompletion } = await import("./wake-agent.js");
            void wakeAgentForCompletion({
              sessionKey: r.parentSessionKey,
              channelId: r.discordChannelId,
              accountId: r.accountId ?? "_system",
              agentId: r.agentId,
              injectedMessage: injected,
              source: "background-job",
              recordId: r.jobId,
              trace: wakeTrace,
            }).then(wakeResult => {
              if (!wakeResult.ok) log.warn(`[bg-job] failed wake 失敗（${wakeResult.reason}），平台通知仍會送`);
            });
            // 失敗 case 不論 wake 成功與否一律送平台通知（避免 agent 不擅長處理失敗 case 漏報）
            const { sendBgJobNotification } = await import("./bg-job-discord-bridge.js");
            await sendBgJobNotification(r, { type: "failed", reason });
          } catch (err) { log.warn(`[bg-job] fallback notify 失敗：${err instanceof Error ? err.message : String(err)}`); }
        })();
      }, 300);
    },
  });
  // Startup Recovery：deferred 到 Discord clientReady 後才呼叫（見 discord.ts:clientReady listener）。
  // 只做被動收斂，不 emit / wake，避免重啟本身觸發 agent 工作流。
  log.info("[platform] BackgroundJobRegistry 初始化完成（runStartupRecovery 將於 Discord clientReady 後被動收斂）");

  // ── 9.66 Collab Conflict Detector ─────────────────────────────────────────
  if (config.safety?.collabConflict?.enabled !== false) {
    initCollabConflictDetector({
      windowMs: config.safety?.collabConflict?.windowMs ?? 300_000,
    });
    connectCollabToEventBus(eventBus as unknown as { on: (event: string, listener: (...args: unknown[]) => void) => void });
    log.info("[platform] CollabConflictDetector 初始化完成");
  }

  // ── 9.7 Tool Log Store + Trace Store ────────────────────────────────────────
  const auditDataDir = join(wsDir, "data");
  initToolLogStore(auditDataDir);
  initInboundHistoryStore(auditDataDir);
  initSessionSnapshotStore(auditDataDir);
  initTraceStore(auditDataDir);

  // 啟動時執行一次清理，並每 24h 自動滾動（防止日誌無限累積）
  function runDataCleanup() {
    try { getToolLogStore()?.cleanup(); } catch { /* 靜默 */ }
    try { getSessionSnapshotStore()?.cleanup(); } catch { /* 靜默 */ }
    try { getTraceStore()?.cleanup(); } catch { /* 靜默 */ }
    try { getTraceContextStore()?.cleanup(); } catch { /* 靜默 */ }
    log.debug("[platform] 日誌滾動清理完成");
  }
  runDataCleanup();
  setInterval(runDataCleanup, 24 * 3600_000).unref(); // unref：不阻止 process 退出

  // ── 9.8 Dashboard 已提前在 step 0 啟動（讓 init 失敗時仍能從 GUI 看 error）─

  // ── 9.9 Log Error Monitor ──────────────────────────────────────────────────
  {
    const { initLogErrorMonitor } = await import("./log-error-monitor.js");
    initLogErrorMonitor();
  }

  // ── 10. Workflow Engine ─────────────────────────────────────────────────────
  const workflowDataDir = join(wsDir, "data", "workflow");
  const memoryDir = join(bootAgentDir, "memory");
  const agentsDir = join(wsDir, "agents");
  initWorkflow(
    config.workflow,
    workflowDataDir,
    memoryDir,
    process.cwd(),
    agentsDir,
    config.fileWatcher,
    config.memory.extract,
  );

  // ── 10b. Failure Recall Cache（非同步，不阻塞啟動）────────────────────────
  import("./prompt-assembler.js").then(m => m.refreshFailureRecallCache()).catch(() => {});

  // ── 11. MCP Servers ─────────────────────────────────────────────────────────
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    const { McpClient } = await import("../mcp/client.js");
    for (const [name, srvCfg] of Object.entries(config.mcpServers)) {
      // catclaw-discord 特例：env.DISCORD_TOKEN 未設時自動 fallback 到 config.discord.token，
      // 避免使用者透過 dashboard preset 新增後忘記填 token 撞 401
      let effectiveCfg = srvCfg;
      if (name === "catclaw-discord" && !srvCfg.env?.DISCORD_TOKEN && config.discord?.token) {
        effectiveCfg = { ...srvCfg, env: { ...(srvCfg.env || {}), DISCORD_TOKEN: config.discord.token } };
      }
      const client = new McpClient(name, effectiveCfg, _toolRegistry!);
      client.start().catch(err =>
        log.warn(`[platform] MCP server ${name} 啟動失敗：${err instanceof Error ? err.message : String(err)}`)
      );
    }
    log.info(`[platform] MCP servers 啟動：${Object.keys(config.mcpServers).join(",")}`);
  }

  // ── 12. Hook Registry + Scanner ────────────────────────────────────────────
  {
    const { initHookRegistry } = await import("../hooks/hook-registry.js");
    const { HookScanner } = await import("../hooks/hook-scanner.js");
    const { resolveAgentDataDir } = await import("./agent-loader.js");
    const { promises: fsp } = await import("node:fs");

    const globalHooksDir = join(wsDir, "hooks");
    const agentIds: string[] = [];
    try {
      const agentsRoot = join(wsDir, "agents");
      const entries = await fsp.readdir(agentsRoot, { withFileTypes: true });
      for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".")) agentIds.push(e.name);
    } catch { /* 無 agents 目錄 */ }

    const agentDirs = new Map<string, string>();
    for (const aid of agentIds) agentDirs.set(aid, join(resolveAgentDataDir(aid, catclawDir), "hooks"));

    const registry = initHookRegistry({ global: config.hooks ?? [] });

    const scanner = new HookScanner({
      globalDir: globalHooksDir,
      agentDirs,
      onChange: () => {
        void (async () => {
          try {
            const res = await scanner.scan();
            const merged = [...(config.hooks ?? []), ...res.global];
            registry.reload({ global: merged, byAgent: res.byAgent });
          } catch (err) {
            log.warn(`[platform] Hook 熱重載失敗：${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      },
    });
    const scanRes = await scanner.scan();
    const mergedGlobal = [...(config.hooks ?? []), ...scanRes.global];
    registry.reload({ global: mergedGlobal, byAgent: scanRes.byAgent });
    scanner.startWatching();
    const totalByAgent = Array.from(scanRes.byAgent.values()).reduce((s, l) => s + l.length, 0);
    log.info(`[platform] Hook 系統：config=${(config.hooks ?? []).length}, global-fs=${scanRes.global.length}, agent-fs=${totalByAgent}`);
  }

  // ── 12.5 Startup Health Check（fail-loud：驗證關鍵組件實際可用）──────────
  await runStartupHealthCheck(config);

  _ready = true;
  log.info(`[platform] 初始化完成 primary=${config.agentDefaults?.model?.primary ?? "(未設定)"}`);

  // ── 12.6 Tool Output Cleanup（項目 6）：startup 一次性 TTL 清理 ───────────
  try {
    const { cleanupToolOutputs } = await import("./tool-output-store.js");
    cleanupToolOutputs(14);
  } catch (err) {
    log.warn(`[platform] Tool output cleanup 失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 12.7 Message Index 初始化（項目 9 Phase 1）：跨 session 訊息全文索引 ──
  try {
    const { initMessageIndex } = await import("../memory/message-index-store.js");
    initMessageIndex();
  } catch (err) {
    log.warn(`[platform] Message index init 失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 12.8 Skill Improvement 提案 TTL 清理（項目 10 Week 4）：30 天 auto-discard ──
  try {
    const { purgeStaleSkillImprovements } = await import("../memory/skill-improvement-store.js");
    purgeStaleSkillImprovements(30);
  } catch (err) {
    log.warn(`[platform] Skill improvement TTL purge 失敗：${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 12.9 Skill Candidate 提案 TTL 清理 + idle 掃描（hermes 自動學習 a）─────
  try {
    const { purgeStaleSkillCandidates } = await import("../memory/skill-candidate-store.js");
    purgeStaleSkillCandidates(14);
  } catch (err) {
    log.warn(`[platform] Skill candidate TTL purge 失敗：${err instanceof Error ? err.message : String(err)}`);
  }
  // Idle 掃描：每 5 分鐘掃 active sessions，超過 idleMinutes 沒動作 → 觸發判官一次
  {
    const idleMinutes = config.safety?.skillCandidate?.idleMinutes ?? 20;
    if (idleMinutes > 0) {
      const idleMs = idleMinutes * 60_000;
      const lastJudgedAt = new Map<string, number>();  // sessionKey → epoch ms（in-memory，程序重啟即重置）
      setInterval(() => {
        const enabled = config.safety?.skillCandidate?.enabled !== false;
        if (!enabled) return;
        const now = Date.now();
        const everyN = config.safety?.skillCandidate?.everyNTurns ?? 5;
        for (const session of _sessionManager!.list()) {
          if (now - session.lastActiveAt < idleMs) continue;
          const judgedAt = lastJudgedAt.get(session.sessionKey);
          if (judgedAt && judgedAt >= session.lastActiveAt) continue;  // 已為這段 idle 跑過
          if (session.turnCount === 0) continue;
          lastJudgedAt.set(session.sessionKey, now);
          void (async () => {
            try {
              const { buildRecentTurnsForJudge, loadAgentSkillNamesSafe } = await import("./agent-loop.js");
              const { judgeSkillCandidate } = await import("../skills/skill-candidate-judge.js");
              const currentTurnIdx = session.turnCount - 1;
              const recentTurns = buildRecentTurnsForJudge(session.sessionKey, session, currentTurnIdx, null, everyN);
              // Agent ID 在 session 沒直接記錄 — 用 channel-derived default fallback
              // （未來如要精準，可在 Session 加 lastAgentId 欄位）
              const agentId = "default";
              const existing = loadAgentSkillNamesSafe(agentId);
              await judgeSkillCandidate({
                channelId: session.channelId, agentId, sessionKey: session.sessionKey,
                triggeredBy: "idle",
                recentTurns,
                existingSkillNames: existing,
              });
            } catch (err) {
              log.debug(`[skill-candidate] idle judge 失敗（靜默）：${err instanceof Error ? err.message : String(err)}`);
            }
          })();
        }
      }, 5 * 60_000).unref();
      log.info(`[platform] Skill candidate idle 掃描已啟動（idleMinutes=${idleMinutes}）`);
    }
  }

  // ── 13. 工具 + Skill 摘要注入（延遲 2s 等 MCP server 連線完成）────────────
  setTimeout(async () => {
    try {
      const { setToolSummary, setSkillSummary } = await import("./prompt-assembler.js");
      const tools = _toolRegistry!.all().map(t => ({ name: t.name, description: t.description }));
      setToolSummary(tools);
      log.info(`[platform] 工具摘要已注入（${tools.length} 個工具）`);

      const { listSkills } = await import("../skills/registry.js");
      const skills = listSkills().map(s => ({ name: s.name, description: s.description, trigger: s.trigger }));
      setSkillSummary(skills);
      log.info(`[platform] Skill 摘要已注入（${skills.length} 個 skill）`);
    } catch (err) {
      log.warn(`[platform] 摘要注入失敗：${err instanceof Error ? err.message : String(err)}`);
    }
  }, 2000);
}

// ── Startup Health Check ─────────────────────────────────────────────────────

/**
 * 對啟動時關鍵組件做實際 verify，集中印出紅綠燈摘要。
 * 失敗的不會 throw（保留 graceful，確保 dashboard 仍可訪問），
 * 但會在 log 大聲喊 + 寫入 health-monitor，後續可被 dashboard / Discord 通報訂閱。
 */
async function runStartupHealthCheck(config: BridgeConfig): Promise<void> {
  const items: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Ollama backend reachability + 各 model 存在性
  if (config.ollama?.enabled !== false && config.ollama) {
    try {
      const client = getOllamaClient();
      const results = await client.verifyAllModels();
      for (const r of results) {
        // backend 連線本身（用 llm verify 的結果代表）
        const backendOk = r.llm.ok || (r.embedding?.ok ?? false);
        if (!backendOk && r.llm.error?.includes("失敗")) {
          items.push({ name: `ollama:${r.backend}`, ok: false, detail: `host ${r.host} 無法連線（${r.llm.error}）` });
          continue;
        }
        items.push({
          name: `ollama:${r.backend}:llm`,
          ok: r.llm.ok,
          detail: r.llm.ok ? `model ${r.llm.model} @ ${r.host}` : (r.llm.error ?? "unknown"),
        });
        if (r.embedding) {
          items.push({
            name: `ollama:${r.backend}:embedding`,
            ok: r.embedding.ok,
            detail: r.embedding.ok ? `model ${r.embedding.model} @ ${r.host}` : (r.embedding.error ?? "unknown"),
          });
        }
      }
    } catch (err) {
      items.push({
        name: "ollama",
        ok: false,
        detail: `OllamaClient 未初始化或失敗：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // Embedding provider verify（如果走非 Ollama provider 由 provider 自己決定）
  if (hasEmbeddingProvider()) {
    try {
      const provider = getEmbeddingProvider();
      if (provider.verify) {
        const r = await provider.verify();
        items.push({
          name: `embedding-provider:${provider.providerName}`,
          ok: r.ok,
          detail: r.ok ? `${provider.modelName}（verify 通過）` : (r.error ?? "verify 失敗"),
        });
      } else {
        items.push({
          name: `embedding-provider:${provider.providerName}`,
          ok: true,
          detail: `${provider.modelName}（無 verify 實作，假設 ok）`,
        });
      }
    } catch (err) {
      items.push({
        name: "embedding-provider",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Extraction provider verify
  if (hasExtractionProvider()) {
    try {
      const provider = getExtractionProvider();
      if (provider.verify) {
        const r = await provider.verify();
        items.push({
          name: `extraction-provider:${provider.providerName}`,
          ok: r.ok,
          detail: r.ok ? `${provider.modelName}（verify 通過）` : (r.error ?? "verify 失敗"),
        });
      } else {
        items.push({
          name: `extraction-provider:${provider.providerName}`,
          ok: true,
          detail: `${provider.modelName}（無 verify 實作，假設 ok）`,
        });
      }
    } catch (err) {
      items.push({
        name: "extraction-provider",
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 對話 LLM provider verify — 遍歷 ProviderRegistry 內所有實作 verify() 的 provider
  // 走 LLMProvider.verify? 介面（base.ts），目前 OllamaProvider 有實作；其他 provider 可漸進補
  try {
    const { getProviderRegistry } = await import("../providers/registry.js");
    const reg = getProviderRegistry();
    const providers = reg.listProviders();
    for (const p of providers) {
      if (typeof p.verify !== "function") continue;
      try {
        const r = await p.verify();
        const model = p.modelId ?? "(no model)";
        items.push({
          name: `llm:${p.id}/${model}`,
          ok: r.ok,
          detail: r.ok ? `${p.name}：reachable` : (r.error ?? "verify 失敗"),
        });
      } catch (err) {
        items.push({
          name: `llm:${p.id}`,
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.debug(`[startup-health] LLM provider verify 跳過：${err instanceof Error ? err.message : String(err)}`);
  }

  reportStartupSummary(items);
}

// ── 子系統存取 ────────────────────────────────────────────────────────────────

export function isPlatformReady(): boolean {
  return _ready;
}

export function getAccountRegistry(): AccountRegistry {
  if (!_accountRegistry) throw new Error("[platform] AccountRegistry 尚未初始化");
  return _accountRegistry;
}

export function getPlatformToolRegistry(): ToolRegistry {
  if (!_toolRegistry) throw new Error("[platform] ToolRegistry 尚未初始化");
  return _toolRegistry;
}

export function getPlatformPermissionGate(): PermissionGate {
  if (!_permissionGate) throw new Error("[platform] PermissionGate 尚未初始化");
  return _permissionGate;
}

export function getPlatformSafetyGuard(): SafetyGuard {
  if (!_safetyGuard) throw new Error("[platform] SafetyGuard 尚未初始化");
  return _safetyGuard;
}

export function getPlatformProjectManager(): ProjectManager {
  if (!_projectManager) throw new Error("[platform] ProjectManager 尚未初始化");
  return _projectManager;
}

/** 記憶引擎（可選，未初始化時回傳 null） */
export function getPlatformMemoryEngine(): MemoryEngine | null {
  return _memoryEngine;
}

export function getPlatformRateLimiter(): RateLimiter | null {
  return _rateLimiter;
}

export function getPlatformSessionManager(): SessionManager {
  if (!_sessionManager) throw new Error("[platform] SessionManager 尚未初始化");
  return _sessionManager;
}

export function getPlatformMemoryRoot(): string | null {
  return _memoryRoot;
}

// ── 身份解析（S6 暫時版）─────────────────────────────────────────────────────

/**
 * 從 Discord userId 解析 accountId。
 *
 * S6 策略：
 *   1. AccountRegistry 有記錄 → 用已知帳號
 *   2. admin.allowedUserIds 內 → 視為 platform-owner（自動建立帳號）
 *   3. 其餘 → guest 角色（accountId = `guest:{userId}`）
 */
export function resolveDiscordIdentity(
  discordUserId: string,
  adminUserIds: string[],
): { accountId: string; isGuest: boolean } {
  if (!_accountRegistry) return { accountId: `guest:${discordUserId}`, isGuest: true };

  // 查 registry
  const accountId = _accountRegistry.resolveIdentity("discord", discordUserId);
  if (accountId) return { accountId, isGuest: false };

  // admin → 有帳號但 resolveIdentity 找不到（可能 registry 剛建立）
  if (adminUserIds.includes(discordUserId)) {
    const fallbackId = `discord-owner-${discordUserId}`;
    const acc = _accountRegistry.get(fallbackId);
    if (acc) return { accountId: fallbackId, isGuest: false };
  }

  // guest
  return { accountId: `guest:${discordUserId}`, isGuest: true };
}

/**
 * 確保 guest accountId 已在 AccountRegistry 中存在（lazy 建立）
 */
export function ensureGuestAccount(accountId: string): void {
  if (!_accountRegistry) return;
  if (accountId.startsWith("guest:") && !_accountRegistry.get(accountId)) {
    const discordId = accountId.slice(6);
    try {
      _accountRegistry.create({
        accountId,
        displayName: `Guest(${discordId})`,
        role: "guest",
        identities: [{ platform: "discord", platformId: discordId, linkedAt: new Date().toISOString() }],
      });
    } catch {
      // 已存在
    }
  }
}

// ── Ollama Stack 熱重載 ───────────────────────────────────────────────────────
//
// 設計：reloadConfig() 偵測 ollama / memoryPipeline 變動時觸發；dashboard PUT 寫檔後
// 靠 watcher 統一觸發（不自己呼叫，避免雙觸發 race）。
//
// 互斥：與 memory resync 互斥 — 避免換 embedding 模型時 seed 跑到一半 mid-stream
// 維度錯亂（vector DB 前半寫舊維度、後半寫新維度，meta 卻標新 model）。
let _ollamaReinitInProgress = false;
let _memoryResyncInProgress = false;

export function isOllamaReinitInProgress(): boolean {
  return _ollamaReinitInProgress;
}

export function isMemoryResyncInProgress(): boolean {
  return _memoryResyncInProgress;
}

/** Dashboard resync endpoint 用：包住 resync 流程，期間拒絕 ollama reinit */
export async function withMemoryResyncLock<T>(fn: () => Promise<T>): Promise<T> {
  if (_memoryResyncInProgress) throw new Error("另一個 memory resync 進行中");
  _memoryResyncInProgress = true;
  try {
    return await fn();
  } finally {
    _memoryResyncInProgress = false;
  }
}

export async function reinitOllamaStack(newCfg: BridgeConfig): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];
  if (!newCfg.ollama) {
    return { ok: false, errors: ["config.ollama 不存在"] };
  }
  const { validateOllamaConfig } = await import("./config.js");
  const v = validateOllamaConfig(newCfg.ollama);
  if (!v.ok) {
    log.warn(`[platform] reinitOllamaStack 拒絕：validator 失敗 — ${v.errors.join("; ")}`);
    return v;
  }

  if (_memoryResyncInProgress) {
    return { ok: false, errors: ["memory resync 進行中，請稍後再試（避免 mid-stream 維度錯亂）"] };
  }
  if (_ollamaReinitInProgress) {
    return { ok: false, errors: ["另一個 Ollama reinit 進行中"] };
  }
  _ollamaReinitInProgress = true;
  try {
    // 1. 建新 OllamaClient → swap（不經過 _instance===null 窗口）
    try {
      const newClient = new OllamaClient(
        buildBackendsFromConfig(newCfg.ollama),
        { embedTimeoutMs: newCfg.ollama.timeout },
      );
      swapOllamaClient(newClient);
      log.info(`[platform] OllamaClient swap 完成（host=${newCfg.ollama.primary.host}, model=${newCfg.ollama.primary.model}）`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`OllamaClient swap 失敗：${msg}`);
      log.warn(`[platform] ${errors[errors.length - 1]}`);
      // OllamaClient swap 失敗就不要動 embedding/extraction（它們依賴 getOllamaClient）
      return { ok: false, errors };
    }

    // 2. EmbeddingProvider 重 init（內部已是 swap pattern：_provider = createEmbeddingProvider(...)）
    if (newCfg.memoryPipeline?.embedding) {
      try {
        initEmbeddingProvider(newCfg.memoryPipeline.embedding);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`EmbeddingProvider 重 init 失敗：${msg}`);
        log.warn(`[platform] ${errors[errors.length - 1]}`);
      }
    }

    // 3. ExtractionProvider 重 init
    if (newCfg.memoryPipeline?.extraction) {
      try {
        initExtractionProvider(newCfg.memoryPipeline.extraction);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`ExtractionProvider 重 init 失敗：${msg}`);
        log.warn(`[platform] ${errors[errors.length - 1]}`);
      }
    }

    if (errors.length === 0) {
      log.info("[platform] Ollama stack 熱重載完成（注意：in-flight 請求仍走舊 backend，下次呼叫起套用新設定）");
    }
    return { ok: errors.length === 0, errors };
  } finally {
    _ollamaReinitInProgress = false;
  }
}
