/**
 * @file accounts/identity-linker.ts
 * @description 跨平台身份綁定
 *
 * 兩種模式：
 *   A. Admin 直接綁定：linkDirect(accountId, platform, platformId)
 *   B. 驗證碼流程：requestLink → 在已綁定平台收到驗證碼 → confirmLink
 *
 * 驗證碼流程（B）需由上層呼叫方（例如 discord.ts）
 * 在「已綁定平台」向使用者發送 token，再由使用者在新平台輸入確認。
 */

import { randomBytes } from "node:crypto";
import type { AccountRegistry, Platform } from "./registry.js";
import { log } from "../logger.js";

// ── 常數 ─────────────────────────────────────────────────────────────────────

const LINK_TOKEN_EXPIRE_MS = 10 * 60 * 1000;  // 10min

// ── 驗證碼狀態 ────────────────────────────────────────────────────────────────

interface LinkPendingRecord {
  token: string;
  accountId: string;
  newPlatform: Platform;
  newPlatformId: string;
  createdAt: number;
}

// ── IdentityLinker ────────────────────────────────────────────────────────────

export class IdentityLinker {
  private pending = new Map<string, LinkPendingRecord>();

  constructor(private readonly accountRegistry: AccountRegistry) {}

  // ── A. Admin 直接綁定 ──────────────────────────────────────────────────────

  /**
   * 管理員直接將某平台 identity 綁定到帳號
   */
  linkDirect(
    accountId: string,
    platform: Platform,
    platformId: string,
  ): { ok: boolean; reason?: string } {
    try {
      this.accountRegistry.linkIdentity(accountId, platform, platformId);
      log.info(`[identity-linker] 直接綁定 ${accountId} ← ${platform}:${platformId}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── B. 驗證碼流程 ──────────────────────────────────────────────────────────

  /**
   * 帳號在新平台傳訊 → 產生驗證 token
   * 呼叫方負責將 token 傳送到該帳號「已綁定」的某個平台
   *
   * @returns token（6碼英數）+ 驗證碼需發送到的平台 identities
   */
  requestLink(
    accountId: string,
    newPlatform: Platform,
    newPlatformId: string,
  ): { ok: boolean; token?: string; existingIdentities?: Array<{ platform: Platform; platformId: string }>; reason?: string } {
    const account = this.accountRegistry.get(accountId);
    if (!account) return { ok: false, reason: `帳號 ${accountId} 不存在` };
    if (account.disabled) return { ok: false, reason: "帳號已停用" };

    // 已綁定平台列表（排除新平台）
    const existingIdentities = account.identities
      .filter(i => !(i.platform === newPlatform && i.platformId === newPlatformId))
      .map(i => ({ platform: i.platform, platformId: i.platformId }));

    if (existingIdentities.length === 0) {
      return { ok: false, reason: `帳號 ${accountId} 尚無已綁定平台可發送驗證碼` };
    }

    // 產生 token，覆蓋上次的（if any）
    const token = randomBytes(3).toString("hex").toUpperCase();  // 6-char hex
    this.pending.set(token, {
      token,
      accountId,
      newPlatform,
      newPlatformId,
      createdAt: Date.now(),
    });

    this.cleanupPending();
    log.info(`[identity-linker] 驗證碼 ${token} 建立 accountId=${accountId} new=${newPlatform}:${newPlatformId}`);
    return { ok: true, token, existingIdentities };
  }

  /**
   * 使用者在新平台輸入驗證碼 → 完成綁定
   */
  confirmLink(
    token: string,
    claimingPlatform: Platform,
    claimingPlatformId: string,
  ): { ok: boolean; accountId?: string; reason?: string } {
    const upperToken = token.toUpperCase();
    const rec = this.pending.get(upperToken);
    if (!rec) return { ok: false, reason: "驗證碼無效或已過期" };
    if (Date.now() - rec.createdAt > LINK_TOKEN_EXPIRE_MS) {
      this.pending.delete(upperToken);
      return { ok: false, reason: "驗證碼已過期" };
    }

    // 確認是同一個「新平台」在認證
    if (rec.newPlatform !== claimingPlatform || rec.newPlatformId !== claimingPlatformId) {
      return { ok: false, reason: "驗證來源不符" };
    }

    const result = this.linkDirect(rec.accountId, rec.newPlatform, rec.newPlatformId);
    if (result.ok) this.pending.delete(upperToken);
    return result.ok
      ? { ok: true, accountId: rec.accountId }
      : { ok: false, reason: result.reason };
  }

  private cleanupPending(): void {
    const now = Date.now();
    for (const [token, rec] of this.pending) {
      if (now - rec.createdAt > LINK_TOKEN_EXPIRE_MS) this.pending.delete(token);
    }
  }
}

// ── 全域單例 ──────────────────────────────────────────────────────────────────

let _linker: IdentityLinker | null = null;

export function initIdentityLinker(accountRegistry: AccountRegistry): IdentityLinker {
  _linker = new IdentityLinker(accountRegistry);
  return _linker;
}

export function getIdentityLinker(): IdentityLinker {
  if (!_linker) throw new Error("[identity-linker] 尚未初始化");
  return _linker;
}

export function resetIdentityLinker(): void {
  _linker = null;
}
