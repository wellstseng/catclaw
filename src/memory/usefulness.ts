/**
 * @file memory/usefulness.ts
 * @description 記憶卡效用帳 — 送出去的卡有沒有被 AI 用上、用上之後那回合成不成功
 *
 * 為什麼要有：catclaw 的晉升只看「被撈幾次」（confirmations），撈得多不代表有用。
 * 這本帳記「用上」與「用上之後的結果」，報表分出真正有用的卡、常被撈卻沒用上的卡（token 稅）。
 *
 * 對拍 ~/.claude 的效用歸因（hooks/handlers/stop.py _attribute_usefulness、hooks/wg_atoms.py detect_atom_use_v2），
 * 依 catclaw 的情境改三處：
 *   - 判用：卡片識別詞先扣掉使用者這句話也有的詞——卡是因為這些詞才被撈出來，AI 複述題目不算用上
 *   - 結果訊號：沒有「測試綠不綠」，改看使用者下一句是糾正還是肯定、Discord reaction、
 *     回合內的卡住偵測（workflow:rut）與 skill 連續失敗升級（workflow:retry_escalation）
 *   - 送卡單位：開場凍結的卡整場有效（session-snapshot memoryAtoms），加上本回合即時撈的卡（noteTurnAtoms）
 *
 * 一回合的流程：
 *   turn:before  記回合開始時間（reaction 只認這之後送出的 bot 回覆）
 *   turn:after   每張送出的卡判用 → 用上的 used_count +1、帳本記 turn 一筆；
 *                回合內已有失敗訊號 → 直接結算失敗；否則掛「待結算」（每個 session 只留最新一回合）
 *   使用者下一句（discord.ts → noteUserMessage）：糾正＝失敗、肯定＝成功、其他＝不入帳
 *   reaction（discord.ts → noteReaction）：👍 類＝成功、👎 類＝失敗
 *   結算：成功 useful_hits +1、失敗 used_fail +1（兩欄先驗 1，同 ~/.claude），帳本記 outcome 一筆
 *
 * 帳本：<workflow dataDir>/memory-usefulness.ndjson（一行一筆，append-only）
 * 報表：buildEffectReport()（dashboard GET /api/memory/effect-report）
 * 晉升條件目前不吃這本帳；累積兩週數據後再決定要不要把 consolidate 換成看有用率。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { userInfo } from "node:os";
import { log } from "../logger.js";
import type { CatClawEvents } from "../core/event-bus.js";
import { readAccess, recordUse, recordUsefulness, USEFULNESS_PRIOR } from "./atom-access.js";
import { readAllAtoms } from "./atom.js";

type EventBus = {
  on<K extends keyof CatClawEvents>(event: K, listener: (...args: CatClawEvents[K]) => void): unknown;
};

export interface InjectedAtom {
  name: string;
  path: string;
}

export type Outcome = "success" | "fail";

// ── 判用：識別詞比對 ─────────────────────────────────────────────────────────

const CODE_RE = /[A-Za-z_][A-Za-z0-9_./:\-]*[A-Za-z0-9_]/g;
const CJK_RE = /[一-鿿]{2,}/g;
const EXT_RE = /\.(py|js|json|md|txt|java|ts|tsx|jsx|cjs|mjs|sh|ya?ml)$/;
const PIECE_SPLIT_RE = /[/\s:,;()[\]<>"'`、，。]+/;

/** 沒有鑑別力的詞：英文功能詞、記憶系統語境的泛詞、中文最常見的雙字 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "into", "when",
  "then", "not", "but", "are", "was", "were", "will", "your", "you", "use",
  "used", "using", "uses", "via", "per", "all", "any", "one", "two", "out",
  "get", "set", "add", "new", "old", "see", "may", "can", "其中", "以下",
  "atom", "atoms", "memory", "hook", "hooks", "code", "file", "files", "test",
  "tests", "line", "lines", "state", "config", "data", "true", "false", "none",
  "記憶", "注入", "系統", "原子", "如果", "因為", "所以", "可以", "需要", "問題",
  "功能", "這個", "那個", "沒有", "規則", "處理",
  "我們", "你們", "他們", "一個", "什麼", "怎麼", "這樣", "那樣", "這些", "那些",
  "現在", "目前", "時候", "已經", "還是", "就是", "不是", "但是", "而且", "或者",
  "然後", "以及", "可能", "應該", "使用", "透過", "其他", "相關", "部分", "方式",
  "內容", "情況", "建議", "主要", "例如", "包括", "確認", "直接", "之後", "之前",
  "user", "users", "prefers", "prefer",
]);

/** 路徑段常見字：每輪工具參數都有，不是採用證據 */
const PATH_NOISE = new Set([
  "users", "catclaw", "workspace", "agents", "memory", "atom", "atoms", "data", "tools",
  "skills", "home", "json", "jsonl", "config", "session", "prompt", "accounts", "projects",
  safeUsername(),
]);

function safeUsername(): string {
  try { return userInfo().username.toLowerCase(); } catch { return ""; }
}

function usePieces(span: string): string[] {
  const out: string[] = [];
  for (const raw of span.trim().toLowerCase().split(PIECE_SPLIT_RE)) {
    const p = raw.replace(/^[._-]+|[._-]+$/g, "").replace(EXT_RE, "");
    if (!p) continue;
    out.push(p);
    for (const sub of p.split(/[._]+/)) {
      if (sub.length >= 5) out.push(sub);
    }
  }
  return out;
}

/** 抽識別性詞：程式識別碼／路徑片段（≥5 字或含 _ . 數字 / -）＋中文雙字，去停用詞。兩側用同一支，比對才一致。 */
export function extractDistinctiveTokens(text: string): Set<string> {
  const toks = new Set<string>();
  if (!text) return toks;
  for (const span of text.match(CODE_RE) ?? []) {
    for (const p of usePieces(span)) {
      if (p.length < 4 || STOPWORDS.has(p)) continue;
      if (/[_.\d/-]/.test(p) || p.length >= 5) toks.add(p);
    }
  }
  for (const run of text.match(CJK_RE) ?? []) {
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2);
      if (!STOPWORDS.has(bigram)) toks.add(bigram);
    }
  }
  return toks;
}

function cleanTokens(tokens: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (PATH_NOISE.has(t)) continue;
    if (t.includes("/") || t.includes("\\") || t.startsWith("~")) continue;
    out.add(t);
  }
  return out;
}

/** atom 檔去掉標題、`- Key: value` 欄位行與小節標題，只留知識本文 */
export function atomBody(raw: string): string {
  return raw
    .split("\n")
    .filter(line => !/^\s*#/.test(line) && !/^\s*-\s*[A-Za-z][\w-]*\s*:/.test(line))
    .join("\n");
}

const USE_MIN_SHARED = 3;
const USE_MAX_SHARED = 6;
const USE_SHARE_RATIO = 0.5;
/**
 * 共享詞至少佔卡片識別詞 15%。2026-11-06 回放 100 個真實回合（972 次送卡）：低於 15% 的判用，
 * 明確誤判的都是上百個識別詞的長卡（職涯、工作流理念）只撞到「方向／判斷／決策」這類泛用雙字；
 * 15% 以上抽看幾乎都是真的照卡片內容回答。
 */
const USE_MIN_CONTAINMENT = 0.15;

export interface UseVerdict {
  used: boolean;
  /** 卡片識別詞（已扣掉使用者原句的詞）與回覆共享幾個 */
  shared: number;
  /**
   * 判「用上」要共享幾個：卡片識別詞的一半夾在 3～6（~/.claude v2 固定 6；catclaw 萃取卡多半一句話，固定 6 永遠判不到），
   * 且不少於識別詞的 15%（長卡要共享更多）
   */
  need: number;
  /** 卡片可比對的識別詞數 */
  distinct: number;
}

/** 判一張卡這回合有沒有被用上（零模型成本的詞彙比對）。 */
export function detectAtomUse(atomRaw: string, response: string, prompt = ""): UseVerdict {
  const promptTokens = cleanTokens(extractDistinctiveTokens(prompt));
  const rare = new Set([...cleanTokens(extractDistinctiveTokens(atomBody(atomRaw)))].filter(t => !promptTokens.has(t)));
  const need = Math.max(
    USE_MIN_SHARED,
    Math.min(USE_MAX_SHARED, Math.ceil(rare.size * USE_SHARE_RATIO)),
    Math.ceil(rare.size * USE_MIN_CONTAINMENT),
  );
  if (rare.size < USE_MIN_SHARED) return { used: false, shared: 0, need, distinct: rare.size };
  const responseTokens = cleanTokens(extractDistinctiveTokens(response));
  let shared = 0;
  for (const t of rare) if (responseTokens.has(t)) shared++;
  return { used: shared >= need, shared, need, distinct: rare.size };
}

// ── 結果訊號：使用者下一句、reaction ─────────────────────────────────────────

/** 「對不對？」「不對嗎？」「有沒有用」是提問不是糾正，比對前先拿掉（前四個同 ~/.claude hooks/wg_friction.py） */
const QUESTION_FORMS_RE = /對不對|不對嗎|不對\s*[?？]|是不是|有沒有用|能不能用|有沒有效/g;

/**
 * 糾正詞：~/.claude wg_friction 的清單（拿掉中文閒聊太常見的「你又」、英文太泛的「i said」）＋「還是不行」這類答案沒幫上忙的說法。
 * 不收「沒用／沒有用／沒解決」：常是「我沒有用過」「我還沒解決這個問題」，不是在評回覆。
 * 「不對」排除複合詞（不對稱、不對外…）；「我說過」排除「我說過的那本書」這種敘述。
 */
const CORRECTION_RE = new RegExp([
  "不對(?![稱外面等應焦盤味])", "不是這樣", "不是這個意思", "不是我要的", "我說過(?!的)", "我已經說", "我剛說",
  "我沒叫你", "我沒要你", "誰叫你", "重來", "改回來", "回復原本", "還原回去", "退回去",
  "不要這樣", "又來了", "搞錯", "弄錯", "理解錯", "會錯意", "答非所問",
  "還是不行", "還是錯", "還是沒解決", "還是一樣的問題", "不能用", "不正確",
  "not what i asked", "that's not what", "i already said", "i told you",
  "revert that", "undo that", "start over", "wrong file", "wrong direction",
].join("|"));
/** 使用者說自己弄錯，不是在糾正 AI：比對前拿掉。「給我搞錯」「讓我弄錯」的「我」是受詞，不算 */
const SELF_BLAME_RE = /(?<![給讓幫害被叫])我(?:自己)?(?:搞錯|弄錯|理解錯|說錯)/g;
/** 帶「嗎」的問句子句不算糾正（「重來一次比較快嗎」「這不正確嗎」）；反問的「確定是用腳本？」照算 */
const YES_NO_QUESTION_RE = /嗎|吗/;
/** 切子句：標點、換行，以及貼著中文的空白（「我沒要你自動買賣 現在可以…嗎」是兩句）；英文詞間空白不切 */
const CLAUSE_SPLIT_RE = /[。！!？?\n，,；;]+|(?<=[一-鿿])\s+|\s+(?=[一-鿿])/;

/**
 * 肯定詞。「有用」不收（中文多半是「有使用」：你有用 subagent 嗎）；
 * 「正確／沒錯／對」只認句首（句中多半在問「有正確執行嗎」或下指令「確認腳本正確」）；「對了」是「順帶一提」，不收。
 */
const POSITIVE_RE = new RegExp(
  "^(?:正確|沒錯|對的|對啊)|" +
  "謝謝|感謝|多謝|太好了|太棒了|好棒|很棒|讚|完美|就是這樣|搞定|" +
  "(?<![不沒没])(?:可以了|成功了|解決了)|" +
  "thanks|thank you|thx|(?<!not )(?:great|perfect|awesome|nice)|it works|👍|🙏",
  "i",
);
/** 問句與抱怨：整句帶這些就不當肯定（「讚數怎麼算」「感謝函要怎麼寫」） */
const NOT_PRAISE_RE = /嗎|吗|[?？]|為什麼|为什么|怎麼|什麼|\b(?:how|what|why|which)\b/;

/**
 * 糾正詞只看開頭：長訊息後段多半是引述別人的話或貼上的材料。
 * 肯定只認短句、且不帶轉折：長訊息是新指令（裡面的「正確」「有用」不是在評上一則回覆），「可以了，可是…」是部分滿意。
 * 2026-11-06 掃過去 2525 則使用者訊息校出這幾條（肯定的誤判多半是長指令或問句，糾正的誤判多半在長訊息後段）。
 */
const CORRECTION_HEAD_CHARS = 45;
const POSITIVE_MAX_CHARS = 40;
const CONTRAST_RE = /可是|但是|不過|但|\bbut\b|\bhowever\b/;

/** 使用者下一句 → 成功／失敗／判不出（null）。糾正優先於肯定。 */
export function classifyFeedbackText(text: string): Outcome | null {
  const t = (text ?? "").toLowerCase().replace(QUESTION_FORMS_RE, " ").replace(SELF_BLAME_RE, " ").trim();
  if (!t) return null;
  const head = t.slice(0, CORRECTION_HEAD_CHARS);
  if (head.split(CLAUSE_SPLIT_RE).some(c => CORRECTION_RE.test(c) && !YES_NO_QUESTION_RE.test(c))) return "fail";
  const praise = t.length <= POSITIVE_MAX_CHARS && !CONTRAST_RE.test(t) && !NOT_PRAISE_RE.test(t) && POSITIVE_RE.test(t);
  return praise ? "success" : null;
}

function normalizeEmoji(e: string): string {
  return (e ?? "").replace(/[\u{1F3FB}-\u{1F3FF}️]/gu, "");
}
const POSITIVE_EMOJI = new Set(["👍", "✅", "❤", "♥", "💯", "🙏", "🎉", "👏", "👌", "🥰", "😍", "🆗", "✔"].map(normalizeEmoji));
const NEGATIVE_EMOJI = new Set(["👎", "❌", "😡", "🙅", "🚫", "⛔", "💢", "✖"].map(normalizeEmoji));

/** reaction emoji → 成功／失敗／判不出（null） */
export function classifyReaction(emoji: string): Outcome | null {
  const e = normalizeEmoji(emoji);
  if (POSITIVE_EMOJI.has(e)) return "success";
  if (NEGATIVE_EMOJI.has(e)) return "fail";
  return null;
}

// ── 狀態與帳本 ───────────────────────────────────────────────────────────────

interface Pending {
  /** 產生這筆待結算的回合何時開始（reaction 只認這之後送出的 bot 回覆） */
  turnStartTs: number;
  /** 掛上待結算的時間 */
  ts: number;
  atoms: InjectedAtom[];
  /** 那回合是誰問的：群組裡只認同一人的下一句與 reaction */
  accountId?: string;
}

/** 待結算放多久：超過就不算（對話早就換題了） */
const PENDING_TTL_MS = 6 * 60 * 60_000;

const _turnAtoms = new Map<string, { atoms: Map<string, InjectedAtom>; exclusive: boolean }>();
const _turnStart = new Map<string, number>();
const _failSignal = new Map<string, string>();
const _pending = new Map<string, Pending>();
let _ledgerPath: string | null = null;
let _getSessionAtoms: (sessionKey: string) => InjectedAtom[] = () => [];

export function getUsefulnessLedgerPath(): string | null {
  return _ledgerPath;
}

function appendLedger(entry: Record<string, unknown>): void {
  if (!_ledgerPath) return;
  try {
    mkdirSync(dirname(_ledgerPath), { recursive: true });
    appendFileSync(_ledgerPath, JSON.stringify({ ts: Date.now(), ...entry }) + "\n", "utf-8");
  } catch (err) {
    log.warn(`[usefulness] 帳本寫入失敗 ${_ledgerPath}：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 本回合送進 prompt 的卡，由 agent-loop 用它實際的 sessionKey 登記，一回合一次；整份取代，
 * 上一回合沒走到 turn:after 的殘留不會混進來。
 * exclusive=false：效用帳另外合併本 session 開場凍結的卡（getSessionAtoms）。
 * exclusive=true：只認這份名單——呼叫端（pipeline）自己注入記憶時，本 session 的凍結卡其實沒送進 prompt。
 */
export function noteTurnAtoms(sessionKey: string, atoms: InjectedAtom[], exclusive = false): void {
  if (!sessionKey) return;
  _turnAtoms.set(sessionKey, { atoms: new Map(atoms.map(a => [a.path, a])), exclusive });
}

/** 回合內出現的失敗訊號（卡住、連續失敗升級）；回合結束時用上的卡直接結算失敗。 */
export function noteFailSignal(sessionKey: string, signal: string): void {
  if (sessionKey) _failSignal.set(sessionKey, signal);
}

export function noteTurnStart(sessionKey: string, ts = Date.now()): void {
  if (sessionKey) _turnStart.set(sessionKey, ts);
}

function settle(sessionKey: string, atoms: InjectedAtom[], outcome: Outcome, signal: string): void {
  for (const a of atoms) {
    try { recordUsefulness(a.path, outcome === "success"); }
    catch (err) { log.warn(`[usefulness] 結算寫入失敗 ${a.name}：${err instanceof Error ? err.message : String(err)}`); }
  }
  appendLedger({ kind: "outcome", sessionKey, outcome, signal, atoms: atoms.map(a => a.name) });
  log.debug(`[usefulness] ${sessionKey} 結算 ${outcome}（${signal}）：${atoms.map(a => a.name).join(", ")}`);
}

export interface TurnUseResult {
  candidates: number;
  used: string[];
  settled?: Outcome;
}

/** 回合結束：判用、記帳、掛待結算或直接結算失敗。accountId：這回合是誰問的。 */
export function handleTurnAfter(sessionKey: string, prompt: string, response: string, accountId?: string): TurnUseResult {
  const candidates = new Map<string, InjectedAtom>();
  const turn = _turnAtoms.get(sessionKey);
  _turnAtoms.delete(sessionKey);
  if (!turn?.exclusive) for (const a of _getSessionAtoms(sessionKey)) candidates.set(a.path, a);
  for (const a of turn?.atoms.values() ?? []) candidates.set(a.path, a);
  const failSignal = _failSignal.get(sessionKey);
  _failSignal.delete(sessionKey);
  const turnStartTs = _turnStart.get(sessionKey) ?? Date.now();

  if (candidates.size === 0) return { candidates: 0, used: [] };

  const used: Array<InjectedAtom & { shared: number; need: number }> = [];
  for (const a of candidates.values()) {
    let raw: string;
    try { raw = readFileSync(a.path, "utf-8"); } catch { continue; }
    const v = detectAtomUse(raw, response, prompt);
    if (!v.used) continue;
    used.push({ ...a, shared: v.shared, need: v.need });
    try { recordUse(a.path); }
    catch (err) { log.warn(`[usefulness] used_count 寫入失敗 ${a.name}：${err instanceof Error ? err.message : String(err)}`); }
  }
  // candidates 記名單：報表的「被撈次數」用它算（每回合實際在 prompt 裡＝每回合都付 token），
  // 不用 access.json 的 timestamps——那是 recall 階段就記，預算用完沒放進 prompt 的卡也算在內
  appendLedger({
    kind: "turn", sessionKey, candidates: [...candidates.values()].map(a => a.name),
    used: used.map(u => ({ name: u.name, shared: u.shared, need: u.need })),
  });

  // 最新一回合沒用上任何卡 → 前一回合的待結算作廢（使用者接下來的反應針對的是最新回覆）
  if (used.length === 0) {
    _pending.delete(sessionKey);
    return { candidates: candidates.size, used: [] };
  }
  const atoms = used.map(({ name, path }) => ({ name, path }));
  if (failSignal) {
    _pending.delete(sessionKey);
    settle(sessionKey, atoms, "fail", failSignal);
    return { candidates: candidates.size, used: atoms.map(a => a.name), settled: "fail" };
  }
  _pending.set(sessionKey, { turnStartTs, ts: Date.now(), atoms, accountId });
  return { candidates: candidates.size, used: atoms.map(a => a.name) };
}

/** 群組裡別人的話不算對這回合的回饋（兩邊都知道是誰時才比；任一邊不知道就照舊） */
function isOtherSpeaker(p: Pending, speakerAccountId?: string): boolean {
  return Boolean(p.accountId && speakerAccountId && p.accountId !== speakerAccountId);
}

/**
 * 使用者在同一 session 送出下一句：有待結算就判糾正／肯定。
 * 同一人說的：不論判不判得出，待結算都關掉（對話已往下走）；別人說的：不判、待結算留著。
 * 回傳結算結果；判不出回 "unknown"，沒有待結算或不是同一人回 null。
 */
export function noteUserMessage(sessionKey: string, text: string, isBot: boolean, speakerAccountId?: string): Outcome | "unknown" | null {
  if (isBot) return null;
  const p = _pending.get(sessionKey);
  if (!p) return null;
  if (isOtherSpeaker(p, speakerAccountId)) return null;
  _pending.delete(sessionKey);
  if (Date.now() - p.ts > PENDING_TTL_MS) return null;
  const outcome = classifyFeedbackText(text);
  if (!outcome) {
    appendLedger({ kind: "outcome", sessionKey, outcome: "unknown", signal: "next_message", atoms: p.atoms.map(a => a.name) });
    return "unknown";
  }
  settle(sessionKey, p.atoms, outcome, "next_message");
  return outcome;
}

/**
 * 使用者對 bot 回覆按 reaction：只認待結算那回合開始之後送出的 bot 訊息、非 bot 按的、同一人按的、判得出正負的 emoji。
 */
export function noteReaction(
  sessionKey: string, emoji: string, messageCreatedTs: number, reactorIsBot: boolean, reactorAccountId?: string,
): Outcome | null {
  if (reactorIsBot) return null;
  const p = _pending.get(sessionKey);
  if (!p) return null;
  if (messageCreatedTs < p.turnStartTs) return null;
  if (isOtherSpeaker(p, reactorAccountId)) return null;
  if (Date.now() - p.ts > PENDING_TTL_MS) { _pending.delete(sessionKey); return null; }
  const outcome = classifyReaction(emoji);
  if (!outcome) return null;
  _pending.delete(sessionKey);
  settle(sessionKey, p.atoms, outcome, "reaction");
  return outcome;
}

/** 測試用：清掉所有狀態 */
export function _resetUsefulnessForTest(ledgerPath: string | null, getSessionAtoms?: (sessionKey: string) => InjectedAtom[]): void {
  _turnAtoms.clear(); _turnStart.clear(); _failSignal.clear(); _pending.clear();
  _ledgerPath = ledgerPath;
  _getSessionAtoms = getSessionAtoms ?? (() => []);
}

/**
 * 訂閱事件。getSessionAtoms：開場凍結的卡（由呼叫端接 session-snapshot，避免 memory 層反向依賴 core）。
 */
export function initUsefulnessTracker(
  eventBus: EventBus,
  dataDir: string,
  getSessionAtoms: (sessionKey: string) => InjectedAtom[],
): void {
  _ledgerPath = join(dataDir, "memory-usefulness.ndjson");
  _getSessionAtoms = getSessionAtoms;

  eventBus.on("turn:before", (ctx) => noteTurnStart(ctx.sessionKey));
  eventBus.on("turn:after", (ctx, response) => {
    try { handleTurnAfter(ctx.sessionKey, ctx.prompt, response, ctx.accountId); }
    catch (err) { log.warn(`[usefulness] turn:after 判用失敗：${err instanceof Error ? err.message : String(err)}`); }
  });
  eventBus.on("workflow:rut", (_warnings, sessionKey) => noteFailSignal(sessionKey, "rut"));
  eventBus.on("workflow:retry_escalation", (sessionKey) => noteFailSignal(sessionKey, "retry_escalation"));
  eventBus.on("session:end", (sessionKey) => {
    _pending.delete(sessionKey); _turnAtoms.delete(sessionKey);
    _turnStart.delete(sessionKey); _failSignal.delete(sessionKey);
  });
  log.info(`[usefulness] 效用帳啟用，帳本 ${_ledgerPath}`);
}

// ── 報表 ─────────────────────────────────────────────────────────────────────

/** Wilson 下界（z=1.28，80% 單尾）：樣本少時往保守估的有用率；同 ~/.claude lib/atom_access.py */
export function wilsonLowerBound(success: number, fail: number, z = 1.28): number {
  const n = success + fail;
  if (n <= 0) return 0;
  const p = success / n;
  const z2 = z * z;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / (1 + z2 / n));
}

export interface EffectReportRow {
  name: string;
  path: string;
  confidence: string;
  /** 窗內有幾個回合這張卡在 prompt 裡（從帳本算；帳本開始前的回合沒有紀錄） */
  exposures: number;
  usedCount: number;
  success: number;
  fail: number;
  wilson: number;
  lastUsed?: string;
}

export interface EffectReport {
  generatedAt: string;
  windowDays: number;
  /** 帳本第一筆的時間；在這之前沒有送卡與判用紀錄 */
  trackingSince: string | null;
  totalAtoms: number;
  ledger: {
    turns: number;
    turnsWithCandidates: number;
    turnsWithUse: number;
    outcomes: { success: number; fail: number; unknown: number };
  };
  /** 有效用證據的卡，依有用率下界排序 */
  topUseful: EffectReportRow[];
  /** 窗內在 prompt 裡 ≥ minExposure 回合、一次都沒被用上（token 稅） */
  exposedNeverUsed: EffectReportRow[];
  /** 窗內一次都沒被撈出來（recall 都沒命中，看 access.json 的 timestamps） */
  neverExposed: { count: number; sample: EffectReportRow[] };
}

interface LedgerLine {
  ts?: number;
  kind?: string;
  candidates?: string[] | number;
  used?: unknown[];
  outcome?: string;
}

function readLedger(path: string | null): LedgerLine[] {
  if (!path || !existsSync(path)) return [];
  const out: LedgerLine[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as LedgerLine); } catch { /* 壞行略過 */ }
  }
  return out;
}

export function buildEffectReport(
  roots: string[],
  opts: { windowDays?: number; top?: number; minExposure?: number; ledgerPath?: string | null; now?: number } = {},
): EffectReport {
  const now = opts.now ?? Date.now();
  const windowDays = opts.windowDays ?? 30;
  const top = opts.top ?? 15;
  const minExposure = opts.minExposure ?? 5;
  const windowStart = now - windowDays * 86_400_000;

  const ledger = readLedger(opts.ledgerPath === undefined ? _ledgerPath : opts.ledgerPath);
  const firstTs = ledger.find(l => typeof l.ts === "number")?.ts ?? null;
  const ledgerSummary = { turns: 0, turnsWithCandidates: 0, turnsWithUse: 0, outcomes: { success: 0, fail: 0, unknown: 0 } };
  /** 卡名 → 窗內在 prompt 裡的回合數（卡名＝檔名，萃取卡帶時間戳不會撞名） */
  const inPrompt = new Map<string, number>();
  for (const l of ledger) {
    if ((l.ts ?? 0) < windowStart) continue;
    if (l.kind === "turn") {
      ledgerSummary.turns++;
      const names = Array.isArray(l.candidates) ? l.candidates : [];
      if (names.length > 0 || (typeof l.candidates === "number" && l.candidates > 0)) ledgerSummary.turnsWithCandidates++;
      for (const n of names) inPrompt.set(n, (inPrompt.get(n) ?? 0) + 1);
      if (Array.isArray(l.used) && l.used.length > 0) ledgerSummary.turnsWithUse++;
    } else if (l.kind === "outcome") {
      if (l.outcome === "success") ledgerSummary.outcomes.success++;
      else if (l.outcome === "fail") ledgerSummary.outcomes.fail++;
      else ledgerSummary.outcomes.unknown++;
    }
  }

  const seen = new Set<string>();
  const rows: Array<EffectReportRow & { recalled: number }> = [];
  for (const root of roots) {
    for (const atom of readAllAtoms(root)) {
      if (seen.has(atom.path)) continue;
      seen.add(atom.path);
      const acc = readAccess(atom.path);
      const success = Math.max(0, (acc?.useful_hits ?? USEFULNESS_PRIOR) - USEFULNESS_PRIOR);
      const fail = Math.max(0, (acc?.used_fail ?? USEFULNESS_PRIOR) - USEFULNESS_PRIOR);
      rows.push({
        name: atom.name,
        path: atom.path,
        confidence: atom.confidence,
        exposures: inPrompt.get(atom.name) ?? 0,
        recalled: (acc?.timestamps ?? []).filter(ts => ts >= windowStart).length,
        usedCount: acc?.used_count ?? 0,
        success,
        fail,
        wilson: Math.round(wilsonLowerBound(success, fail) * 1000) / 1000,
        lastUsed: acc?.last_used ?? atom.lastUsed,
      });
    }
  }

  const strip = (r: EffectReportRow & { recalled: number }): EffectReportRow => {
    const { recalled: _drop, ...rest } = r;
    return rest;
  };

  const topUseful = rows
    .filter(r => r.success + r.fail > 0 || r.usedCount > 0)
    .sort((a, b) => b.wilson - a.wilson || b.usedCount - a.usedCount || b.exposures - a.exposures)
    .slice(0, top)
    .map(strip);

  const exposedNeverUsed = rows
    .filter(r => r.exposures >= minExposure && r.usedCount === 0)
    .sort((a, b) => b.exposures - a.exposures)
    .slice(0, top)
    .map(strip);

  const never = rows.filter(r => r.recalled === 0 && r.exposures === 0);
  const neverSample = [...never]
    .sort((a, b) => (a.lastUsed ?? "").localeCompare(b.lastUsed ?? ""))
    .slice(0, top)
    .map(strip);

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays,
    trackingSince: firstTs === null ? null : new Date(firstTs).toISOString(),
    totalAtoms: rows.length,
    ledger: ledgerSummary,
    topUseful,
    exposedNeverUsed,
    neverExposed: { count: never.length, sample: neverSample },
  };
}
