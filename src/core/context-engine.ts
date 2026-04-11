/**
 * @file core/context-engine.ts
 * @description Context Engineering — Strategy Pattern 架構
 *
 * 設計：
 * - ContextEngine 持有 Strategy Map，build() 依序套用啟用的 strategies
 * - 各 strategy 可獨立開關（A/B 比較），不動核心
 * - CompactionStrategy：turn 數超閾值時用 LLM 摘要壓縮舊訊息
 * - OverflowHardStopStrategy：context 超硬上限時緊急截斷
 */

import { log } from "../logger.js";
import type { Message, ContentBlock } from "../providers/base.js";
import type { LLMProvider } from "../providers/base.js";
import type { DecayStrategyConfig, DecayLevel } from "./config.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export interface LevelChange {
  messageIndex: number;
  fromLevel: number;
  toLevel: number;
  tokensBefore: number;
  tokensAfter: number;
}

export interface StrategyDetail {
  name: string;
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved?: number;
  messagesDecayed?: number;
  levelChanges?: LevelChange[];
}

export interface OriginalMessageDigest {
  index: number;
  role: string;
  turnIndex: number;
  originalTokens: number;
  currentTokens: number;
  compressionLevel: number;
  toolName?: string;
}

export interface ContextBreakdown {
  totalMessages: number;
  estimatedTokens: number;
  strategiesApplied: string[];
  tokensBeforeCE?: number;
  tokensAfterCE?: number;
  /** 三段 failover 的第三段觸發：截斷後仍超硬上限，需要停止執行 */
  overflowSignaled?: boolean;
  strategyDetails?: StrategyDetail[];
  originalMessageDigest?: OriginalMessageDigest[];
}

export interface ContextBuildContext {
  messages: Message[];
  sessionKey: string;
  turnIndex: number;
  estimatedTokens: number;
}

export interface ContextStrategy {
  name: string;
  enabled: boolean;
  shouldApply(ctx: ContextBuildContext): boolean;
  apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext>;
}

export interface BuildOpts {
  sessionKey: string;
  turnIndex: number;
  ceProvider?: LLMProvider;  // CE 用 LLM（壓縮/摘要）
}

// ── Tool Pairing Repair ───────────────────────────────────────────────────────

/**
 * 修補截斷後的 tool_use / tool_result 孤立問題
 * - 移除沒有對應 tool_use 的 tool_result block
 * - 移除沒有對應 tool_result 的 tool_use block
 * - 移除因此變空的 user/assistant messages
 */
export function repairToolPairing(messages: Message[]): Message[] {
  // 1. 收集所有 tool_use id
  const toolUseIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_use") toolUseIds.add(b.id);
      }
    }
  }

  // 2. 收集有 tool_result 的 tool_use_id
  const toolResultIds = new Set<string>();
  for (const m of messages) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_result") toolResultIds.add(b.tool_use_id);
      }
    }
  }

  // 3. 移除孤立 blocks，過濾空 messages
  return messages
    .map(m => {
      if (typeof m.content === "string") return m;
      const cleaned = m.content.filter(b => {
        if (b.type === "tool_use") return toolResultIds.has(b.id);    // 有對應 result 才保留
        if (b.type === "tool_result") return toolUseIds.has(b.tool_use_id);  // 有對應 use 才保留
        return true;
      });
      if (cleaned.length === 0) return null;
      return { ...m, content: cleaned };
    })
    .filter((m): m is Message => m !== null);
}

// ── Token 估算（~4 chars/token 粗估） ────────────────────────────────────────

export function estimateTokens(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    // 優先使用 per-message 精確 token 數
    if (m.tokens != null) {
      total += m.tokens;
      continue;
    }
    let chars = 0;
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else {
      for (const b of m.content) {
        if (b.type === "text") chars += b.text.length;
        else if (b.type === "tool_result") chars += b.content.length;
        else if (b.type === "tool_use") chars += JSON.stringify(b.input).length;
      }
    }
    total += Math.ceil(chars / 4);
  }
  return total;
}

// ── DecayStrategy（漸進式衰減）─────────────────────────────────────────────────

const DEFAULT_DECAY_LEVELS: DecayLevel[] = [
  { minAge: 1,  maxTokens: 2000 },  // L1: 精簡
  { minAge: 3,  maxTokens: 500 },   // L2: 核心
  { minAge: 6,  maxTokens: 80 },    // L3: stub
  { minAge: 10, action: "remove" },  // L4: 移除
];

const RETAIN_RATIO_THRESHOLDS: [number, number][] = [
  [0.80, 0],  // > 80% → L0 (原始)
  [0.40, 1],  // > 40% → L1
  [0.10, 2],  // > 10% → L2
  [0.05, 3],  // > 5%  → L3
];

function discreteLevel(age: number, levels: DecayLevel[]): number {
  let level = 0;
  for (let i = 0; i < levels.length; i++) {
    if (age >= levels[i].minAge) level = i + 1;
  }
  return level;
}

function continuousLevel(age: number, baseDecay: number, tempoMultiplier: number): number {
  const retainRatio = Math.exp(-baseDecay * tempoMultiplier * age);
  for (const [threshold, level] of RETAIN_RATIO_THRESHOLDS) {
    if (retainRatio > threshold) return level;
  }
  return 4; // remove
}

function truncateContent(content: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "\n…[truncated]";
}

function truncateBlocks(blocks: ContentBlock[], maxTokens: number): ContentBlock[] {
  const maxChars = maxTokens * 4;
  let totalChars = 0;
  const result: ContentBlock[] = [];

  for (const b of blocks) {
    if (b.type === "tool_result") {
      const remaining = Math.max(0, maxChars - totalChars);
      if (remaining <= 0) {
        result.push({ ...b, content: "[truncated]" });
      } else if (b.content.length > remaining) {
        result.push({ ...b, content: b.content.slice(0, remaining) + "\n…[truncated]" });
        totalChars += remaining;
      } else {
        result.push(b);
        totalChars += b.content.length;
      }
    } else if (b.type === "tool_use") {
      const input = JSON.stringify(b.input);
      totalChars += input.length;
      result.push(b);
    } else if (b.type === "text") {
      const remaining = Math.max(0, maxChars - totalChars);
      if (b.text.length > remaining) {
        result.push({ ...b, text: b.text.slice(0, remaining) + "\n…[truncated]" });
        totalChars += remaining;
      } else {
        result.push(b);
        totalChars += b.text.length;
      }
    } else {
      result.push(b);
    }
  }
  return result;
}

function stubMessage(m: Message): Message {
  const role = m.role;
  if (typeof m.content === "string") {
    return { ...m, content: `[${role} stub]`, compressionLevel: 3, originalTokens: m.originalTokens ?? m.tokens };
  }
  const stubBlocks: ContentBlock[] = m.content.map(b => {
    if (b.type === "tool_use") return { ...b, input: {} };
    if (b.type === "tool_result") return { ...b, content: "[stub]" };
    if (b.type === "text") return { ...b, text: `[${role} stub]` };
    return b;
  });
  return { ...m, content: stubBlocks, compressionLevel: 3, originalTokens: m.originalTokens ?? m.tokens };
}

export class DecayStrategy implements ContextStrategy {
  name = "decay";
  enabled: boolean;
  lastLevelChanges: LevelChange[] = [];
  private cfg: Required<Pick<DecayStrategyConfig, "mode" | "baseDecay" | "minRetainRatio" | "referenceIntervalSec">> & { levels: DecayLevel[]; tempoRange: [number, number] };

  constructor(cfg: Partial<DecayStrategyConfig> = {}) {
    this.enabled = cfg.enabled ?? true;
    this.cfg = {
      mode: cfg.mode ?? "auto",
      levels: cfg.levels ?? DEFAULT_DECAY_LEVELS,
      baseDecay: cfg.baseDecay ?? 0.3,
      minRetainRatio: cfg.minRetainRatio ?? 0.05,
      referenceIntervalSec: cfg.referenceIntervalSec ?? 60,
      tempoRange: cfg.tempoRange ?? [0.5, 2.0],
    };
  }

  shouldApply(_ctx: ContextBuildContext): boolean {
    return this.enabled;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    const { messages, turnIndex } = ctx;
    const tempoMultiplier = this._calcTempoMultiplier(messages);

    const result: Message[] = [];
    const changes: LevelChange[] = [];
    let removed = 0;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const age = (m.turnIndex != null) ? turnIndex - m.turnIndex : 0;
      if (age <= 0) { result.push(m); continue; }

      const currentLevel = m.compressionLevel ?? 0;
      const targetLevel = this._calcTargetLevel(age, tempoMultiplier);

      if (targetLevel >= 4) {
        const tokBefore = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
        changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: 4, tokensBefore: tokBefore, tokensAfter: 0 });
        removed++;
        continue;
      }

      if (targetLevel <= currentLevel) { result.push(m); continue; }

      const levelCfg = this.cfg.levels[targetLevel - 1];
      if (!levelCfg) { result.push(m); continue; }

      if (levelCfg.action === "remove") {
        const tokBefore = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
        changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: 4, tokensBefore: tokBefore, tokensAfter: 0 });
        removed++;
        continue;
      }

      const maxTokens = levelCfg.maxTokens ?? Infinity;
      const tokBefore = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
      const decayed = this._compressMessage(m, maxTokens, targetLevel);
      const tokAfter = estimateTokens([decayed]);
      if (targetLevel !== currentLevel) {
        changes.push({ messageIndex: i, fromLevel: currentLevel, toLevel: targetLevel, tokensBefore: tokBefore, tokensAfter: tokAfter });
      }
      result.push(decayed);
    }

    this.lastLevelChanges = changes;

    if (removed > 0) {
      log.info(`[context-engine:decay] removed ${removed} messages, ${messages.length} → ${result.length}`);
    }

    const repaired = repairToolPairing(result);
    return { ...ctx, messages: repaired, estimatedTokens: estimateTokens(repaired) };
  }

  private _calcTargetLevel(age: number, tempoMultiplier: number): number {
    const mode = this.cfg.mode;

    if (mode === "discrete") {
      return discreteLevel(age, this.cfg.levels);
    }
    if (mode === "continuous") {
      return continuousLevel(age, this.cfg.baseDecay, 1.0);
    }
    if (mode === "time-aware") {
      return continuousLevel(age, this.cfg.baseDecay, tempoMultiplier);
    }
    // auto: max(discrete, continuous with tempo)
    const d = discreteLevel(age, this.cfg.levels);
    const c = continuousLevel(age, this.cfg.baseDecay, tempoMultiplier);
    return Math.max(d, c);
  }

  private _calcTempoMultiplier(messages: Message[]): number {
    const timestamps = messages.filter(m => m.timestamp != null).map(m => m.timestamp!);
    if (timestamps.length < 2) return 1.0;

    const sorted = [...timestamps].sort((a, b) => a - b);
    let totalInterval = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalInterval += sorted[i] - sorted[i - 1];
    }
    const avgIntervalMs = totalInterval / (sorted.length - 1);
    const avgIntervalSec = avgIntervalMs / 1000;

    const raw = avgIntervalSec / this.cfg.referenceIntervalSec;
    const [min, max] = this.cfg.tempoRange;
    return Math.max(min, Math.min(max, raw));
  }

  private _compressMessage(m: Message, maxTokens: number, targetLevel: number): Message {
    if (targetLevel === 3) return stubMessage(m);

    const originalTokens = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
    if (typeof m.content === "string") {
      return {
        ...m,
        content: truncateContent(m.content, maxTokens),
        compressionLevel: targetLevel,
        compressedBy: "decay",
        originalTokens,
      };
    }

    const compressed = truncateBlocks(m.content, maxTokens);
    return {
      ...m,
      content: compressed,
      compressionLevel: targetLevel,
      compressedBy: "decay",
      originalTokens,
    };
  }
}

// ── CompactionStrategy ────────────────────────────────────────────────────────

export interface CompactionConfig {
  enabled: boolean;
  model?: string;              // CE 壓縮用 LLM model（不填則用 platform 傳入的 ceProvider）
  /** 超過此 token 數才觸發（預設 4000）。取代舊的 triggerTurns。 */
  triggerTokens: number;
  preserveRecentTurns: number; // 保留最近 N 輪不壓縮（預設 5）
}

export class CompactionStrategy implements ContextStrategy {
  name = "compaction";
  enabled: boolean;
  private cfg: CompactionConfig;

  constructor(cfg: Partial<CompactionConfig> & { triggerTurns?: number } = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      triggerTokens: cfg.triggerTokens ?? 20_000,
      preserveRecentTurns: cfg.preserveRecentTurns ?? 5,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    return this.enabled && ctx.estimatedTokens > this.cfg.triggerTokens;
  }

  async apply(ctx: ContextBuildContext, ceProvider?: LLMProvider): Promise<ContextBuildContext> {
    if (!ceProvider) {
      log.debug("[context-engine:compaction] 無 ceProvider，改用 sliding-window 回退");
      return this._fallbackSlide(ctx);
    }

    const { messages } = ctx;
    const preserveCount = this.cfg.preserveRecentTurns * 2;  // 每 turn ≈ 2 messages
    if (messages.length <= preserveCount) return ctx;

    const toCompress = messages.slice(0, messages.length - preserveCount);
    const toKeep = messages.slice(messages.length - preserveCount);

    // system messages 不壓縮
    const sysMessages = toCompress.filter(m => (m as unknown as { role: string }).role === "system");
    const convMessages = toCompress.filter(m => (m as unknown as { role: string }).role !== "system");

    if (convMessages.length === 0) return ctx;

    try {
      const summaryPrompt = `以下是對話歷史，請用繁體中文精簡摘要（保留關鍵事實、決策、錯誤）：\n\n${
        convMessages.map(m => {
          let content: string;
          if (typeof m.content === "string") {
            content = m.content;
          } else {
            // 從 tool blocks 提取有意義的摘要文字（而非棄用 "[tool interaction]"）
            content = (m.content as Array<{ type: string; name?: string; input?: unknown; tool_use_id?: string; content?: string }>)
              .map(b => {
                if (b.type === "tool_use") {
                  const params = b.input ? JSON.stringify(b.input).slice(0, 120) : "";
                  return `[工具:${b.name}] ${params}`;
                }
                if (b.type === "tool_result") {
                  const result = typeof b.content === "string" ? b.content.slice(0, 200) : "";
                  return `[結果] ${result}`;
                }
                if (b.type === "text") return (b as unknown as { text: string }).text;
                return "";
              })
              .filter(Boolean)
              .join(" ");
          }
          return `[${m.role}]: ${content.slice(0, 500)}`;
        }).join("\n")
      }`;

      const result = await ceProvider.stream(
        [{ role: "user", content: summaryPrompt }],
        { systemPrompt: "你是摘要助手，只輸出摘要文字，不加說明。" },
      );

      let summaryText = "";
      for await (const evt of result.events as AsyncIterable<{ type: string; text?: string }>) {
        if (evt.type === "text_delta" && evt.text) summaryText += evt.text;
      }

      const summaryMessage: Message = {
        role: "user",
        content: `[對話摘要]\n${summaryText.trim()}`,
      };

      const compressed = [...sysMessages, summaryMessage, ...toKeep];
      log.info(`[context-engine:compaction] 壓縮 ${messages.length} → ${compressed.length} messages`);

      return {
        ...ctx,
        messages: compressed,
        estimatedTokens: estimateTokens(compressed),
      };
    } catch (err) {
      log.warn(`[context-engine:compaction] LLM 壓縮失敗，回退：${err instanceof Error ? err.message : String(err)}`);
      return this._fallbackSlide(ctx);
    }
  }

  private _fallbackSlide(ctx: ContextBuildContext): ContextBuildContext {
    const preserve = this.cfg.preserveRecentTurns * 2;
    const sliced = repairToolPairing(ctx.messages.slice(-preserve));
    return { ...ctx, messages: sliced, estimatedTokens: estimateTokens(sliced) };
  }
}

// ── OverflowHardStopStrategy（第三段 failover）────────────────────────────────

export interface OverflowHardStopConfig {
  enabled: boolean;
  /** 超過此比例 context window → 觸發（預設 0.95） */
  hardLimitUtilization: number;
  contextWindowTokens: number;
}

export class OverflowHardStopStrategy implements ContextStrategy {
  name = "overflow-hard-stop";
  enabled: boolean;
  private cfg: OverflowHardStopConfig;
  /** 最後一次 apply 是否觸發了 hard stop */
  lastOverflowSignaled = false;

  constructor(cfg: Partial<OverflowHardStopConfig> = {}) {
    this.cfg = {
      enabled: cfg.enabled ?? true,
      hardLimitUtilization: cfg.hardLimitUtilization ?? 0.95,
      contextWindowTokens: cfg.contextWindowTokens ?? 100_000,
    };
    this.enabled = this.cfg.enabled;
  }

  shouldApply(ctx: ContextBuildContext): boolean {
    if (!this.enabled) return false;
    const hard = this.cfg.contextWindowTokens * this.cfg.hardLimitUtilization;
    return ctx.estimatedTokens > hard;
  }

  async apply(ctx: ContextBuildContext): Promise<ContextBuildContext> {
    // 緊急截斷：只保留最後 4 條 messages（system + 最近 2 輪）
    const minMessages = ctx.messages.slice(-4);
    this.lastOverflowSignaled = true;
    log.warn(`[context-engine:overflow-hard-stop] context 超硬上限 ${ctx.estimatedTokens} tokens，截斷至 ${minMessages.length} messages`);
    return { ...ctx, messages: minMessages, estimatedTokens: estimateTokens(minMessages) };
  }
}

// ── ContextEngine ─────────────────────────────────────────────────────────────

export class ContextEngine {
  private strategies = new Map<string, ContextStrategy>();
  private _ceProvider?: LLMProvider;

  setCeProvider(p: LLMProvider): void { this._ceProvider = p; }

  /** 最後一次 build 的 breakdown */
  lastBuildBreakdown: ContextBreakdown = {
    totalMessages: 0,
    estimatedTokens: 0,
    strategiesApplied: [],
  };
  lastAppliedStrategy: string | undefined;

  constructor() {
    this.register(new DecayStrategy());
    this.register(new CompactionStrategy());
    this.register(new OverflowHardStopStrategy());
  }

  register(strategy: ContextStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  getStrategy(name: string): ContextStrategy | undefined {
    return this.strategies.get(name);
  }

  /** 取得 context window 大小（供 nudge 計算用） */
  getContextWindowTokens(): number {
    const oh = this.strategies.get("overflow-hard-stop") as OverflowHardStopStrategy | undefined;
    return oh?.["cfg"]?.contextWindowTokens ?? 100_000;
  }

  async build(messages: Message[], opts: BuildOpts): Promise<Message[]> {
    const tokensBeforeCE = estimateTokens(messages);

    // originalMessageDigest: 壓縮前的 message 摘要
    const originalMessageDigest = messages.map((m, i) => {
      const tokens = m.originalTokens ?? m.tokens ?? estimateTokens([m]);
      let toolName: string | undefined;
      if (typeof m.content !== "string") {
        for (const b of m.content) {
          if (b.type === "tool_use") { toolName = b.name; break; }
          if (b.type === "tool_result") { toolName = `result:${b.tool_use_id?.slice(-6) ?? "?"}`; break; }
        }
      }
      return {
        index: i,
        role: m.role,
        turnIndex: m.turnIndex ?? 0,
        originalTokens: tokens,
        currentTokens: tokens,
        compressionLevel: m.compressionLevel ?? 0,
        toolName,
      };
    });

    let ctx: ContextBuildContext = {
      messages,
      sessionKey: opts.sessionKey,
      turnIndex: opts.turnIndex,
      estimatedTokens: tokensBeforeCE,
    };

    const applied: string[] = [];
    const details: StrategyDetail[] = [];

    const order = ["decay", "compaction", "overflow-hard-stop"];
    const effectiveCeProvider = opts.ceProvider ?? this._ceProvider;

    for (const name of order) {
      const strategy = this.strategies.get(name);
      if (!strategy?.enabled) continue;
      if (strategy.shouldApply(ctx)) {
        const tokensBefore = ctx.estimatedTokens;
        const msgsBefore = ctx.messages.length;
        ctx = await strategy.apply(ctx, effectiveCeProvider);
        applied.push(name);
        const detail: StrategyDetail = {
          name,
          tokensBefore,
          tokensAfter: ctx.estimatedTokens,
        };
        if (ctx.messages.length < msgsBefore) {
          detail.messagesRemoved = msgsBefore - ctx.messages.length;
        }
        // decay 專屬：附加 levelChanges
        if (name === "decay") {
          const decayStrategy = strategy as DecayStrategy;
          if (decayStrategy.lastLevelChanges.length > 0) {
            detail.levelChanges = decayStrategy.lastLevelChanges;
            detail.messagesDecayed = decayStrategy.lastLevelChanges.filter(c => c.toLevel < 4).length;
          }
        }
        details.push(detail);
        log.debug(`[context-engine] strategy=${name} applied, tokens ${tokensBefore}→${ctx.estimatedTokens}`);
      }
    }

    const overflowStrategy = this.strategies.get("overflow-hard-stop") as OverflowHardStopStrategy | undefined;
    this.lastBuildBreakdown = {
      totalMessages: ctx.messages.length,
      estimatedTokens: ctx.estimatedTokens,
      strategiesApplied: applied,
      tokensBeforeCE,
      tokensAfterCE: applied.length > 0 ? ctx.estimatedTokens : undefined,
      overflowSignaled: overflowStrategy?.lastOverflowSignaled ?? false,
      strategyDetails: details.length > 0 ? details : undefined,
      originalMessageDigest: applied.length > 0 ? originalMessageDigest : undefined,
    };
    if (overflowStrategy) overflowStrategy.lastOverflowSignaled = false;
    this.lastAppliedStrategy = applied.at(-1);

    return ctx.messages;
  }

  estimateTokens(messages: Message[]): number {
    return estimateTokens(messages);
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _contextEngine: ContextEngine | null = null;

export function initContextEngine(cfg?: {
  compaction?: Partial<CompactionConfig> & { model?: string };
  decay?: Partial<DecayStrategyConfig>;
  overflowHardStop?: Partial<OverflowHardStopConfig>;
}): ContextEngine {
  _contextEngine = new ContextEngine();

  if (cfg?.decay) {
    _contextEngine.register(new DecayStrategy(cfg.decay));
  }
  if (cfg?.compaction) {
    _contextEngine.register(new CompactionStrategy(cfg.compaction));
  }
  if (cfg?.overflowHardStop) {
    _contextEngine.register(new OverflowHardStopStrategy(cfg.overflowHardStop));
  }

  return _contextEngine;
}

export function getContextEngine(): ContextEngine | null {
  return _contextEngine;
}
