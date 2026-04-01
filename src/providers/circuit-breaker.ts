/**
 * @file providers/circuit-breaker.ts
 * @description Circuit Breaker — provider 健康狀態追蹤
 *
 * 狀態機：
 *   closed  → 正常，允許呼叫
 *   open    → 短路，拒絕呼叫（冷卻中）
 *   half-open → 試探，允許一次呼叫，成功→closed，失敗→open
 *
 * 觸發條件：
 *   在 windowMs 時間窗口內，失敗次數 >= errorThreshold → open
 *   open 後超過 cooldownMs → half-open
 */

import { log } from "../logger.js";

// ── 型別 ─────────────────────────────────────────────────────────────────────

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerConfig {
  /** 觸發開路的錯誤次數門檻（預設 3） */
  errorThreshold: number;
  /** 計算錯誤次數的時間窗口毫秒（預設 60000） */
  windowMs: number;
  /** 開路後的冷卻毫秒，過後進入 half-open（預設 30000） */
  cooldownMs: number;
}

export interface BreakerStatus {
  state: BreakerState;
  errorCount: number;
  lastFailureAt: number | null;
  openedAt: number | null;
}

// ── CircuitBreaker ────────────────────────────────────────────────────────────

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private errorTimestamps: number[] = [];
  private openedAt: number | null = null;
  private readonly cfg: CircuitBreakerConfig;
  readonly providerId: string;

  constructor(providerId: string, cfg?: Partial<CircuitBreakerConfig>) {
    this.providerId = providerId;
    this.cfg = {
      errorThreshold: cfg?.errorThreshold ?? 3,
      windowMs:       cfg?.windowMs       ?? 60_000,
      cooldownMs:     cfg?.cooldownMs     ?? 30_000,
    };
  }

  // ── 狀態查詢 ────────────────────────────────────────────────────────────────

  /**
   * 是否允許此次呼叫。
   * - closed → true
   * - open + 冷卻未過 → false
   * - open + 冷卻已過 → 轉 half-open，返回 true（試探）
   */
  isAvailable(): boolean {
    switch (this.state) {
      case "closed":
        return true;

      case "open": {
        const elapsed = Date.now() - (this.openedAt ?? 0);
        if (elapsed >= this.cfg.cooldownMs) {
          this.state = "half-open";
          log.info(`[circuit-breaker] ${this.providerId} → half-open（冷卻結束，試探中）`);
          return true;
        }
        return false;
      }

      case "half-open":
        return true;
    }
  }

  getState(): BreakerState { return this.state; }

  getStatus(): BreakerStatus {
    return {
      state:         this.state,
      errorCount:    this.recentErrors(),
      lastFailureAt: this.errorTimestamps[this.errorTimestamps.length - 1] ?? null,
      openedAt:      this.openedAt,
    };
  }

  // ── 結果記錄 ────────────────────────────────────────────────────────────────

  recordSuccess(): void {
    if (this.state === "half-open") {
      this.state = "closed";
      this.errorTimestamps = [];
      this.openedAt = null;
      log.info(`[circuit-breaker] ${this.providerId} → closed（試探成功）`);
    }
    // closed 狀態不需要操作
  }

  recordFailure(): void {
    const now = Date.now();
    this.errorTimestamps.push(now);
    // 清掉 windowMs 之前的舊記錄
    this.pruneOldErrors(now);

    const count = this.recentErrors();
    log.warn(`[circuit-breaker] ${this.providerId} 失敗（${count}/${this.cfg.errorThreshold}）`);

    if (this.state === "half-open" || count >= this.cfg.errorThreshold) {
      this.state = "open";
      this.openedAt = now;
      log.error(`[circuit-breaker] ${this.providerId} → open（冷卻 ${this.cfg.cooldownMs}ms）`);
    }
  }

  /** 強制重置到 closed（維運用） */
  reset(): void {
    this.state = "closed";
    this.errorTimestamps = [];
    this.openedAt = null;
    log.info(`[circuit-breaker] ${this.providerId} 強制 reset → closed`);
  }

  // ── 內部工具 ─────────────────────────────────────────────────────────────────

  private pruneOldErrors(now: number): void {
    const cutoff = now - this.cfg.windowMs;
    this.errorTimestamps = this.errorTimestamps.filter(t => t > cutoff);
  }

  private recentErrors(): number {
    this.pruneOldErrors(Date.now());
    return this.errorTimestamps.length;
  }
}
