/**
 * @file tools/builtin/subagents.ts
 * @description subagents — 管理子 agent（list / kill / steer / wait）
 *
 * LLM 可用此 tool 查詢、終止、轉向、等待子 agent。
 */

import { randomUUID } from "node:crypto";
import type { Tool, ToolContext } from "../types.js";
import { getSubagentRegistry } from "../../core/subagent-registry.js";
import { getPlatformSessionManager, getPlatformPermissionGate, getPlatformToolRegistry, getPlatformSafetyGuard } from "../../core/platform.js";
import { log } from "../../logger.js";
import { MessageTrace } from "../../core/message-trace.js";

// 防 LLM 瘋狂輪詢 running subagent：對同一 runId 連續 status 查詢計數，第 2 次起在 result 注 warning。
// 觀察到的真實 case：async spawn 後 LLM 每輪 `subagents(status)` + 「還在跑、繼續等、還沒」，吃光 turn 額度。
// status 變動或 5 min 無查詢自動清掉。
const POLL_WARN_THRESHOLD = 2;
const POLL_TTL_MS = 5 * 60_000;
const _statusPollCount = new Map<string, { count: number; lastTs: number }>();

export const tool: Tool = {
  name: "subagents",
  description: "管理子 agent：list / kill / steer（轉向 running agent）/ wait / status / resume（喚醒 keepSession agent）/ send_message（續接已完成的 agent，注入後續指令並背景執行）",
  tier: "standard",
  deferred: true,
  resultTokenCap: 500,
  parameters: {
    type: "object",
    properties: {
      action:       { type: "string",  description: "list | kill | steer | wait | status | resume | send_message" },
      runId:        { type: "string",  description: "目標 runId（kill/steer/wait 用；kill 省略 = kill all）" },
      message:      { type: "string",  description: "steer 時注入的訊息" },
      timeoutMs:    { type: "number",  description: "wait 最長等待毫秒（預設 60000）" },
      recentMinutes:{ type: "number",  description: "list 只顯示最近 N 分鐘（預設全部）" },
    },
    required: ["action"],
  },

  async execute(params, ctx: ToolContext) {
    const registry = getSubagentRegistry();
    if (!registry) return { error: "SubagentRegistry 尚未初始化" };

    const action = String(params["action"] ?? "").trim();
    const runId  = params["runId"] ? String(params["runId"]) : undefined;

    switch (action) {
      case "list": {
        const recent = typeof params["recentMinutes"] === "number" ? params["recentMinutes"] : undefined;
        const records = registry.listByParent(ctx.sessionId, recent);
        if (records.length === 0) return { result: "（目前無子 agent 記錄）" };
        const lines = records.map(r => {
          const dur = r.endedAt ? `${Math.round((r.endedAt - r.createdAt) / 1000)}s` : `${Math.round((Date.now() - r.createdAt) / 1000)}s+`;
          return `• [${r.status}] ${r.label ?? r.runId.slice(0, 8)} | ${r.runtime} | ${dur} | runId:${r.runId}`;
        });
        return { result: lines.join("\n") };
      }

      case "kill": {
        if (runId) {
          const ok = registry.kill(runId);
          return { result: ok ? `✅ killed ${runId}` : `❌ 找不到或已結束：${runId}` };
        } else {
          const count = registry.killAll(ctx.sessionId);
          return { result: `✅ killed ${count} 個子 agent` };
        }
      }

      case "steer": {
        if (!runId) return { error: "steer 需要指定 runId" };
        const message = params["message"] ? String(params["message"]) : undefined;
        if (!message) return { error: "steer 需要指定 message" };

        const record = registry.get(runId);
        if (!record) return { error: `找不到 runId：${runId}` };
        if (record.status !== "running") return { error: `子 agent 已結束（status=${record.status}）` };

        // 注入訊息到子 session（子 loop 下一輪自然讀到）
        try {
          const sessionManager = getPlatformSessionManager();
          sessionManager.addMessages(record.childSessionKey, [
            { role: "user", content: `[父 agent 轉向指令]\n${message}` },
          ]);
          log.info(`[subagents:steer] 注入至 ${record.childSessionKey}`);
          return { result: `✅ 轉向訊息已注入子 agent ${runId.slice(0, 8)}` };
        } catch (err) {
          return { error: `steer 失敗：${err instanceof Error ? err.message : String(err)}` };
        }
      }

      case "wait": {
        if (!runId) return { error: "wait 需要指定 runId" };
        // wait 預設 timeout 從 60s 縮到 5s — 「polling 是反模式」，end_turn 後平台會自動 wake。
        // 保留 wait action 是給「本 turn 還有極短工作必須等子結果」的場景，不是給長時間等待用。
        const timeoutMs = typeof params["timeoutMs"] === "number" ? Math.min(params["timeoutMs"], 30_000) : 5_000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
          const record = registry.get(runId);
          if (!record) return { error: `找不到 runId：${runId}` };
          if (record.status !== "running") {
            if (record.status === "completed") {
              return { result: { status: "completed", result: record.result ?? "", sessionKey: record.childSessionKey, turns: record.turns ?? 0 } };
            } else if (record.status === "timeout") {
              return { result: { status: "timeout", result: null } };
            } else {
              return { result: { status: record.status, error: record.error ?? "" } };
            }
          }
          await new Promise(r => setTimeout(r, 500));
        }

        // wait timeout：明確告訴 LLM「停止 polling，end_turn 等 wake」
        return { result: {
          status: "still-running",
          hint: "子 agent 仍在執行中。**請 end_turn**——平台會在子完成時自動 wake 你進入新 turn。不要再呼叫 wait/status/list polling，會浪費 token。",
        } };
      }

      case "resume": {
        // 喚醒 keepSession:true 的已完成子 agent；keepSession=false → 邏輯 fallback 自動 spawn 新子
        if (!runId) return { error: "resume 需要指定 runId" };
        const message = params["message"] ? String(params["message"]) : undefined;
        if (!message) return { error: "resume 需要指定 message（注入訊息）" };

        const record = registry.get(runId);
        if (!record) return { error: `找不到 runId：${runId}` };
        // 邏輯規則驅動 fallback：runId record 上的 keepSession bit 決定路徑，不靠 prompt 教育
        // keepSession=false → 子 session 已銷毀，自動 spawn 新子接替（task = 原 task + 追問）
        // 用 async=true：立即回 spawned 訊息不阻塞，平台 wake 機制負責子完成後通知
        if (!record.keepSession) {
          log.info(`[subagents:resume] keepSession=false runId=${runId} → async fallback spawn 新子接替`);
          const newTask = `[續問前次子任務（原子 ${runId.slice(0, 8)} 已銷毀，自動接替）]\n\n原任務：\n${record.task}\n\n追問：\n${message}`;
          const spawnTool = (await import("./spawn-subagent.js")).tool;
          return await spawnTool.execute({
            task: newTask,
            ...(record.label ? { label: `${record.label}-續` } : {}),
            async: true,
          }, ctx);
        }
        if (record.status === "running") return { error: `子 agent 仍在執行中，請用 steer` };
        if (record.status === "killed") return { error: `子 agent 已 killed，無法喚醒` };
        // 已 timeout / failed / interrupted 的子：直接重啟會撞同 task 同 timeout，邏輯規則擋下要求換 spawn 新子
        if (record.status === "timeout" || record.status === "failed" || record.status === "interrupted") {
          return { error: `子 agent 之前已 ${record.status}（同 task 重啟仍會撞同樣失敗）。請改用 spawn_subagent 重新 spawn 新子，task 拆更小或加大 timeoutMs。原 task 前 100 字：${record.task.slice(0, 100)}` };
        }

        // 注入喚醒訊息到子 session
        const sessionManager = getPlatformSessionManager();
        sessionManager.addMessages(record.childSessionKey, [
          { role: "user", content: `[喚醒]\n${message}` },
        ]);

        // 重置 registry 狀態
        record.status = "running";
        record.endedAt = undefined;
        record.result = undefined;
        record.error = undefined;
        record.abortController = new AbortController();

        log.info(`[subagents:resume] 喚醒 runId=${runId} childSession=${record.childSessionKey}`);

        // 背景重跑 agentLoop（動態 import 避免循環依賴）
        import("../../core/agent-loop.js").then(async ({ agentLoop }) => {
          const permissionGate = getPlatformPermissionGate();
          const toolRegistry = getPlatformToolRegistry();
          const safetyGuard = getPlatformSafetyGuard();
          const { getProviderRegistry } = await import("../../providers/registry.js");
          const { eventBus } = await import("../../core/event-bus.js");
          const provider = getProviderRegistry()?.resolve();
          if (!provider) { registry.fail(runId!, "找不到 provider"); return; }

          // Trace 建立（resume subagent）
          const resumeTrace = MessageTrace.create(randomUUID(), record!.childSessionKey, record!.accountId, "subagent");
          resumeTrace.recordInbound({ text: message, attachments: 0 });

          let fullText = ""; let turns = 0;
          const loopGen = agentLoop(message, {
            platform: "subagent",
            channelId: record!.childSessionKey,
            accountId: record!.accountId,
            provider,
            allowSpawn: false,
            _sessionKeyOverride: record!.childSessionKey,
            signal: record!.abortController.signal,
            trace: resumeTrace,
          }, { sessionManager, permissionGate, toolRegistry, safetyGuard, eventBus });

          try {
            for await (const evt of loopGen) {
              if (evt.type === "text_delta") fullText += evt.text;
              if (evt.type === "done") { turns = evt.turnCount; break; }
              if (evt.type === "error") throw new Error(evt.message);
            }
            registry.complete(runId!, fullText, turns);
            log.info(`[subagents:resume] 完成 runId=${runId}`);
            // EventBus 通知 parent
            eventBus.emit("subagent:completed", record!.parentSessionKey, record!.runId, record!.label ?? record!.task.slice(0, 60), fullText);
            const { sendSubagentNotification } = await import("../../core/subagent-discord-bridge.js");
            await sendSubagentNotification(record!);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            registry.fail(runId!, msg);
            log.warn(`[subagents:resume] 失敗 runId=${runId} err=${msg}`);
            eventBus.emit("subagent:failed", record!.parentSessionKey, record!.runId, record!.label ?? record!.task.slice(0, 60), msg);
          }
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[subagents:resume] 動態 import 失敗：${msg}`);
        });

        return { result: { status: "resuming", runId: record.runId, childSessionKey: record.childSessionKey } };
      }

      case "send_message": {
        // SendMessage 續接：對已完成（keepSession）的 child agent 發後續指令
        // 與 resume 相同邏輯，但語意更直覺（Claude Code 的 SendMessage 概念）
        if (!runId) return { error: "send_message 需要指定 runId" };
        const msg = params["message"] ? String(params["message"]) : undefined;
        if (!msg) return { error: "send_message 需要指定 message" };

        const rec = registry.get(runId);
        if (!rec) return { error: `找不到 runId：${runId}` };

        // running → 用 steer 注入
        if (rec.status === "running") {
          const sessionManager = getPlatformSessionManager();
          sessionManager.addMessages(rec.childSessionKey, [
            { role: "user", content: `[續接指令]\n${msg}` },
          ]);
          return { result: `✅ 訊息已注入 running agent ${runId.slice(0, 8)}` };
        }

        // completed/failed
        if (rec.status === "killed") return { error: `子 agent 已 killed，無法續接` };
        // keepSession=false → 統一交給 resume case 的 fallback 邏輯（auto-spawn 新子）
        // keepSession=true → 走原本 resume 喚醒流程
        // 兩個 case 都重用 resume，由 resume 內判斷分流
        params["action"] = "resume";
        return this.execute(params, ctx);
      }

      case "status": {
        if (!runId) return { error: "status 需要指定 runId" };
        const record = registry.get(runId);
        if (!record) return { error: `找不到 runId：${runId}` };
        const durationMs = record.endedAt
          ? record.endedAt - record.createdAt
          : Date.now() - record.createdAt;

        let pollWarning: string | undefined;
        if (record.status === "running") {
          const now = Date.now();
          const prev = _statusPollCount.get(runId);
          const stale = prev && (now - prev.lastTs > POLL_TTL_MS);
          const nextCount = (prev && !stale ? prev.count : 0) + 1;
          _statusPollCount.set(runId, { count: nextCount, lastTs: now });
          if (nextCount >= POLL_WARN_THRESHOLD) {
            pollWarning = `已是第 ${nextCount} 次查詢同一 runId 的 running 狀態。${record.async ? "async " : ""}subagent 完成時平台會自動 wake parent agent 並注入結果到下一輪 — 請**停止輪詢**，end_turn 或處理其他事，背景任務不會丟失。`;
            log.info(`[subagents:status] 偵測到輪詢 runId=${runId} count=${nextCount} → 注入 pollWarning`);
          }
        } else {
          _statusPollCount.delete(runId);
        }

        return {
          result: {
            runId: record.runId,
            status: record.status,
            label: record.label,
            task: record.task,
            runtime: record.runtime,
            turns: record.turns,
            createdAt: record.createdAt,
            endedAt: record.endedAt,
            durationMs,
            childSessionKey: record.childSessionKey,
            ...(pollWarning ? { warning: pollWarning } : {}),
          },
        };
      }

      default:
        return { error: `未知 action：${action}。可用：list / kill / steer / wait / status` };
    }
  },
};
