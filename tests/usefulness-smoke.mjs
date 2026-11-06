/**
 * 記憶卡效用帳 smoke test（src/memory/usefulness.ts + atom-access 效用三欄）
 *
 * 測試項目：
 *   1. 識別詞抽取：中文雙字、程式識別碼、停用詞
 *   2. 判用：AI 回覆用到卡片內容才算；只複述使用者原句、只撞到觸發詞、卡片太短都不算
 *   3. 使用者下一句分類：糾正／肯定／判不出、提問句不誤判、否定前綴不誤判
 *   4. reaction 分類：膚色變體、❤️ 變體選擇字元
 *   5. 一回合的完整流程（暫存目錄、真檔案）：判用記帳 → 下一句結算成功／失敗 → reaction 結算
 *      → bot 訊息與舊訊息 reaction 不算 → 判不出時關閉待結算 → 回合內失敗訊號直接結算
 *      → 沒用上卡的回合作廢前一筆待結算 → 即時撈的卡與開場凍結的卡合併、回合後清掉
 *   6. access.json：效用三欄在曝光計數寫回後仍保留、舊檔補預設
 *   7. 報表：有用的卡、記帳後常被撈卻沒用上、沒被撈過
 *   8. Wilson 下界
 *
 * 用法：node tests/usefulness-smoke.mjs   （先 tsc 編到 dist/）
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractDistinctiveTokens, detectAtomUse, atomBody, classifyFeedbackText, classifyReaction,
  handleTurnAfter, noteUserMessage, noteReaction, noteTurnAtoms, noteFailSignal, noteTurnStart,
  buildEffectReport, wilsonLowerBound, _resetUsefulnessForTest,
} from "../dist/memory/usefulness.js";
import { readAccess, incrementReadHits, writeAccess, USEFULNESS_PRIOR } from "../dist/memory/atom-access.js";

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}
function assertEq(a, b, name) {
  assert(JSON.stringify(a) === JSON.stringify(b), `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

const root = join(tmpdir(), `catclaw-usefulness-${process.pid}-${Date.now()}`);
mkdirSync(root, { recursive: true });
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });

function writeAtomFile(name, triggers, body) {
  const p = join(root, `${name}.md`);
  writeFileSync(p, `# ${name}\n\n- Scope: global\n- Confidence: [臨]\n- Trigger: ${triggers}\n- Created-at: 1791814475034\n\n## 知識\n\n${body}\n`, "utf-8");
  return { name, path: p };
}

// ── 1. 識別詞 ────────────────────────────────────────────────────────────────
console.log("\n[1] 識別詞抽取");
{
  const t = extractDistinctiveTokens("夜咳常見原因 checkWriteGate src/memory/write-gate.ts the and");
  assert(t.has("夜咳") && t.has("常見") && t.has("原因"), "中文切雙字");
  assert(t.has("checkwritegate"), "程式識別碼小寫化");
  assert(t.has("write-gate"), "路徑片段去副檔名");
  assert(!t.has("the") && !t.has("and"), "英文功能詞不收");
  const s = extractDistinctiveTokens("我們可以使用這個");
  assert(!s.has("我們") && !s.has("可以") && !s.has("使用"), "中文常見雙字不收");
}

// ── 2. 判用 ──────────────────────────────────────────────────────────────────
console.log("\n[2] 判用");
const doctorRaw = readFileSync(writeAtomFile("ext_doctor", "黃富源, 夜咳, 氣喘", "黃富源醫師的專長包括氣喘及肺炎，門診時間是週二下午與週四晚上，需要先在官網預約掛號。").path, "utf-8");
{
  const prompt = "小孩夜咳很嚴重，黃富源醫師適合嗎？";
  const used = detectAtomUse(doctorRaw, "可以考慮黃富源醫師，他專長氣喘及肺炎。門診在週二下午和週四晚上，記得先上官網預約掛號。", prompt);
  assert(used.used, `回覆用到卡片內容 → 用上（shared=${used.shared} need=${used.need}）`);
  const echo = detectAtomUse(doctorRaw, "小孩夜咳很嚴重的話，黃富源醫師可以考慮看看，夜咳要注意。", prompt);
  assert(!echo.used, `只複述使用者原句 → 不算（shared=${echo.shared} need=${echo.need}）`);
  const body = atomBody(doctorRaw);
  assert(!body.includes("Trigger") && !body.includes("Confidence") && body.includes("專長"), "atomBody 去掉欄位行、留本文");
  const triggerOnly = detectAtomUse(doctorRaw, "黃富源、夜咳、氣喘這三個詞我知道了", "");
  assert(!triggerOnly.used, "只撞到觸發詞 → 不算");
  const tiny = detectAtomUse("# x\n\n- Trigger: a\n\n## 知識\n\nok fine\n", "ok fine", "");
  assert(!tiny.used && tiny.distinct < 3, "卡片識別詞不到 3 個 → 永遠不判用上");
  const longCard = "# career\n\n## 知識\n\n" + "Wells 對職涯的想法：主管要懂得判斷方向、做關鍵決策、知道哪些事不要做；" +
    "遊戲業中高齡的樣子沒有參考樣本，天花板大約五十歲，六十幾歲還在寫程式的前輩幾乎看不到，" +
    "因此想找業界導師聊聊轉型路線、技術深度與管理廣度的取捨、家庭與工作時間的分配、退休前的收入曲線。";
  const generic = detectAtomUse(longCard, "我的判斷是方向對了，關鍵決策要先想清楚哪些事不要做，主管的價值在這裡。", "AI 時代工程師的角色是什麼？");
  assert(!generic.used, `長卡只撞到泛用詞 → 不算（shared=${generic.shared} need=${generic.need} distinct=${generic.distinct}）`);
  assert(generic.need > 6, `長卡門檻跟著識別詞數變高（need=${generic.need}）`);
  const eng = detectAtomUse("# e\n\n## 知識\n\nRun pnpm build before pm2 restart; restart uses ecosystem.config.cjs\n",
    "Do `pnpm build` first, then `pm2 restart` with ecosystem.config.cjs.", "how do I deploy?");
  assert(eng.used, `英文程式卡：回覆照做 → 用上（shared=${eng.shared} need=${eng.need}）`);
}

// ── 3. 下一句分類 ────────────────────────────────────────────────────────────
console.log("\n[3] 使用者下一句分類");
for (const [text, want] of [
  ["不對，我說的是晚上的門診", "fail"], ["還是不行", "fail"], ["你答非所問", "fail"], ["這不正確", "fail"],
  ["That's not what I asked", "fail"], ["謝謝！很有幫助", "success"], ["完美", "success"], ["可以了，搞定", "success"],
  ["thanks!", "success"], ["好", null], ["那明天呢？", null], ["這樣對不對？", null], ["有沒有用？", null],
  ["這樣正確嗎？", null], ["能不能用", null], ["", null], ["謝謝，但不對", "fail"], ["還是沒解決", "fail"],
  ["我沒有用過AI，想建立一個專屬秘書", null], ["我還沒解決這個問題，我要怎麼回", null], ["對了，補充一點", null],
  ["字體和排版可以了 可是第一段的字型大小也要比照原文", null],
  ["我的規則是翻譯只翻內容、樣式維持、狀聲詞不翻，然後為了確認你目前的腳本正確，再翻一次 page_1 給我看", null],
  ["你現在追蹤技能或是任何要抓股票市場盤中價格，是從哪裡拿的，有哪些技能有用到", null],
  ["凱聖還有一個狀況，就是我之前要請他彙整 C 端目前的執行狀況，他就一直叫我去看他做的規格地圖，可是那個不是我要的", null],
  ["紅圈的部分有幾個問題 1.標題不需要翻譯 2.文字沒有對位 3.翻譯的內容不正確", "fail"],
  ["你有用subagent嗎", null], ["確認一下晚上的排程有正確執行嗎", null],
  ["你為什麼要全部做完 我只說先把page_1搞定而已", null],
  ["正確 所以預算也有了 可以先進行環境佈署", "success"], ["沒錯，就這樣做", "success"],
  // 第二意見審查（Fable）實測的誤判
  ["這不正確嗎？", null], ["重來一次比較快嗎？", null], ["不對稱加密是什麼", null], ["不對外公開的設定", null],
  ["我搞錯了，不是你的問題", null], ["我說過的那本書叫什麼名字", null], ["I said hello to him yesterday", null],
  ["讚數怎麼算", null], ["感謝函要怎麼寫", null], ["完美主義有什麼缺點", null], ["it works on my machine but not in prod", null],
  ["還是一樣的問題 沒有比照原始的樣式", "fail"], ["你是不是搞錯什麼", "fail"], ["不對勁，結果跟上次一樣", "fail"],
  // 新舊版逐則比對 2525 則歷史訊息時抓到的回歸
  ["不要再給我搞錯", "fail"], ["我沒要你自動買賣 現在可以抓趨勢了嗎", "fail"], ["That's not what I asked for", "fail"],
]) {
  assertEq(classifyFeedbackText(text), want, `「${text}」→ ${want}`);
}

// ── 4. reaction ──────────────────────────────────────────────────────────────
console.log("\n[4] reaction 分類");
for (const [e, want] of [["👍", "success"], ["👍🏽", "success"], ["❤️", "success"], ["✅", "success"], ["👎", "fail"], ["❌", "fail"], ["🤔", null], ["", null]]) {
  assertEq(classifyReaction(e), want, `${e || "(空)"} → ${want}`);
}

// ── 5. 一回合的完整流程 ──────────────────────────────────────────────────────
console.log("\n[5] 一回合流程（真檔案）");
const doctor = { name: "ext_doctor", path: join(root, "ext_doctor.md") };
const weather = writeAtomFile("ext_weather", "天氣", "颱風來襲時捷運高架段會停駛，地下段照常營運。");
const deploy = writeAtomFile("deploy_steps", "部署", "上線前先跑 pnpm build，再用 pm2 restart catclaw，最後看 pm2 logs 確認沒有錯誤。");
const ledgerPath = join(root, "data", "memory-usefulness.ndjson");
const sk = "discord:ch:test";
let sessionAtoms = [doctor, weather];
_resetUsefulnessForTest(ledgerPath, (key) => (key === sk ? sessionAtoms : []));

const prompt = "小孩夜咳很嚴重，黃富源醫師適合嗎？";
const goodReply = "可以考慮黃富源醫師，他專長氣喘及肺炎。門診在週二下午和週四晚上，記得先上官網預約掛號。";
function parseJsonLine(line) {
  return JSON.parse(line);
}
function ledgerLines() {
  if (!existsSync(ledgerPath)) return [];
  return readFileSync(ledgerPath, "utf-8").trim().split("\n").map(parseJsonLine);
}

{
  noteTurnStart(sk);
  const r = handleTurnAfter(sk, prompt, goodReply);
  assertEq(r.used, ["ext_doctor"], "只有相關的卡判用上");
  assertEq(r.candidates, 2, "候選＝開場凍結的 2 張");
  assertEq(readAccess(doctor.path).used_count, 1, "用上 → used_count 1");
  assertEq(readAccess(weather.path), null, "沒用上的卡不動 access.json");
  assertEq(ledgerLines().at(-1).kind, "turn", "帳本記一筆 turn");
  assertEq(noteUserMessage(sk, "謝謝！這正是我要的", false), "success", "下一句肯定 → 結算成功");
  assertEq(readAccess(doctor.path).useful_hits, USEFULNESS_PRIOR + 1, "useful_hits = 先驗 + 1");
  assertEq(ledgerLines().at(-1).outcome, "success", "帳本記 outcome success");
  assertEq(noteUserMessage(sk, "不對", false), null, "已結算 → 再來一句沒有待結算");
}
{
  handleTurnAfter(sk, prompt, goodReply);
  assertEq(noteUserMessage(sk, "不對，你搞錯了，我問的是晚上", false), "fail", "下一句糾正 → 結算失敗");
  assertEq(readAccess(doctor.path).used_fail, USEFULNESS_PRIOR + 1, "used_fail = 先驗 + 1");
}
{
  noteTurnStart(sk, Date.now() - 1000);
  handleTurnAfter(sk, prompt, goodReply);
  assertEq(noteUserMessage(sk, "不對", true), null, "bot 的訊息不算回饋");
  assertEq(noteReaction(sk, "👎", Date.now() - 60_000, false), null, "回合開始前的舊訊息 reaction 不算");
  assertEq(noteReaction(sk, "👍", Date.now(), true), null, "bot 按的 reaction 不算");
  assertEq(noteReaction(sk, "🤔", Date.now(), false), null, "判不出的 emoji 不結算");
  assertEq(noteReaction(sk, "👎", Date.now(), false), "fail", "使用者對新回覆按 👎 → 失敗");
  assertEq(readAccess(doctor.path).used_fail, USEFULNESS_PRIOR + 2, "used_fail 再 +1");
}
{
  handleTurnAfter(sk, prompt, goodReply);
  assertEq(noteUserMessage(sk, "那週末有開嗎", false), "unknown", "中性下一句 → 判不出");
  assertEq(ledgerLines().at(-1).outcome, "unknown", "帳本記 unknown");
  assertEq(noteReaction(sk, "👍", Date.now(), false), null, "判不出後待結算已關，reaction 不再結算");
  assertEq(readAccess(doctor.path).useful_hits, USEFULNESS_PRIOR + 1, "判不出不動 useful_hits");
}
{
  noteFailSignal(sk, "retry_escalation");
  const r = handleTurnAfter(sk, prompt, goodReply);
  assertEq(r.settled, "fail", "回合內有連續失敗升級 → 直接結算失敗");
  assertEq(readAccess(doctor.path).used_fail, USEFULNESS_PRIOR + 3, "used_fail 再 +1");
  assertEq(noteUserMessage(sk, "謝謝", false), null, "已直接結算 → 沒有待結算");
}
{
  handleTurnAfter(sk, prompt, goodReply);
  handleTurnAfter(sk, "今天天氣？", "今天晴天。");
  assertEq(noteUserMessage(sk, "謝謝", false), null, "最新回合沒用上卡 → 前一筆待結算作廢");
}
{
  sessionAtoms = [];
  noteTurnAtoms(sk, [deploy]);
  const reply = "上線前先跑 pnpm build，再用 pm2 restart，最後看 pm2 logs 確認有沒有錯誤。";
  const r = handleTurnAfter(sk, "怎麼上線？", reply);
  assertEq(r.used, ["deploy_steps"], "本回合即時撈的卡也會判用");
  const r2 = handleTurnAfter(sk, "怎麼上線？", reply);
  assertEq(r2.candidates, 0, "即時撈的卡只算那一回合");
  sessionAtoms = [doctor, weather];
}
{
  noteTurnAtoms(sk, [deploy], true);
  const r = handleTurnAfter(sk, "怎麼上線？", "上線前先跑 pnpm build。");
  assertEq(r.candidates, 1, "呼叫端注入（exclusive）→ 只認呼叫端名單，不併本 session 凍結卡");
  assertEq(ledgerLines().at(-1).candidates, ["deploy_steps"], "帳本 candidates 記卡名名單");
  noteTurnAtoms(sk, [deploy]);
  noteTurnAtoms(sk, []);
  const r2 = handleTurnAfter(sk, "今天天氣？", "今天晴天。");
  assertEq(r2.candidates, 2, "同一回合後登記的整份取代前一份（殘留的即時撈卡不混進來）");
}
{
  handleTurnAfter(sk, prompt, goodReply, "acct-A");
  assertEq(noteUserMessage(sk, "不對", false, "acct-B"), null, "群組：別人說「不對」→ 不結算 A 的回合");
  assertEq(noteReaction(sk, "👎", Date.now(), false, "acct-B"), null, "群組：別人按 👎 → 不結算");
  assertEq(noteUserMessage(sk, "謝謝", false, "acct-A"), "success", "本人的下一句照常結算（別人說話沒關掉待結算）");
}

// ── 6. access.json 效用三欄 ──────────────────────────────────────────────────
console.log("\n[6] access.json 效用三欄");
{
  const before = readAccess(doctor.path);
  incrementReadHits(doctor.path, "recall");
  const after = readAccess(doctor.path);
  assertEq([after.used_count, after.useful_hits, after.used_fail], [before.used_count, before.useful_hits, before.used_fail], "曝光計數寫回後效用三欄保留");
  const legacy = join(root, "legacy.md");
  writeFileSync(legacy, "# legacy\n", "utf-8");
  writeFileSync(`${legacy}.access.json`, JSON.stringify({ schema: "atom-access-v2-catclaw", read_hits: 3, confirmations: 3, timestamps: [] }), "utf-8");
  const acc = readAccess(legacy);
  assertEq([acc.used_count, acc.useful_hits, acc.used_fail], [0, USEFULNESS_PRIOR, USEFULNESS_PRIOR], "舊檔沒有三欄 → 補預設 0／1／1");
}

// ── 7. 報表 ──────────────────────────────────────────────────────────────────
console.log("\n[7] 報表");
{
  for (let i = 0; i < 6; i++) incrementReadHits(weather.path, "recall");   // recall 的曝光計數不影響「在 prompt 裡幾回合」
  const weatherInPrompt = ledgerLines().filter(l => l.kind === "turn" && l.candidates.includes("ext_weather")).length;
  const quiet = writeAtomFile("ext_quiet", "冷門", "這張卡從來沒被撈過，內容不重要。");
  const old = join(root, "ext_old.md");
  writeFileSync(old, "# ext_old\n\n- Confidence: [觀]\n\n## 知識\n\n很久以前被撈過\n", "utf-8");
  writeAccess(old, { ...readAccess(weather.path), timestamps: [Date.now() - 90 * 86_400_000], used_count: 0, useful_hits: 1, used_fail: 1 });
  const r = buildEffectReport([root], { ledgerPath });
  assert(r.trackingSince !== null, "帳本有資料 → 有記帳起點");
  assert(r.ledger.turns >= 10, `帳本 turn 筆數（${r.ledger.turns}）`);
  assertEq([r.ledger.outcomes.success, r.ledger.outcomes.fail, r.ledger.outcomes.unknown], [2, 3, 1], "帳本結果統計 成功2 失敗3 判不出1");
  assertEq(r.topUseful[0]?.name, "ext_doctor", "有用的卡排第一");
  assertEq([r.topUseful[0].success, r.topUseful[0].fail], [2, 3], "成功／失敗次數去掉先驗");
  assert(weatherInPrompt >= 5, `天氣卡在 prompt 裡 ${weatherInPrompt} 回合`);
  assert(r.exposedNeverUsed.some(x => x.name === "ext_weather" && x.exposures === weatherInPrompt), "被撈次數＝帳本裡在 prompt 的回合數（不是 recall 計數）、0 次用上 → 列入 token 稅");
  assert(!r.exposedNeverUsed.some(x => x.name === "ext_doctor"), "用上過的卡不列入 token 稅");
  assert(r.neverExposed.sample.some(x => x.name === "ext_quiet"), "沒被撈過的卡列入");
  assert(r.neverExposed.sample.some(x => x.name === "ext_old"), "90 天前才被撈過 → 窗內沒被撈");
  const before = buildEffectReport([root], { ledgerPath: join(root, "nope.ndjson") });
  assertEq([before.trackingSince, before.exposedNeverUsed.length], [null, 0], "還沒記帳 → 不判 token 稅（避免全部誤列）");
}

// ── 8. Wilson ────────────────────────────────────────────────────────────────
console.log("\n[8] Wilson 下界");
assertEq(wilsonLowerBound(0, 0), 0, "沒樣本 → 0");
assert(wilsonLowerBound(10, 0) > wilsonLowerBound(1, 0), "10 成功 > 1 成功");
assert(wilsonLowerBound(5, 5) < wilsonLowerBound(10, 0), "5:5 < 10:0");
assert(wilsonLowerBound(1, 0) < 1 && wilsonLowerBound(1, 0) > 0, "1 成功 → 介於 0 與 1");

console.log(`\n${failed === 0 ? "✅" : "❌"} ${passed} 通過 / ${failed} 失敗`);
console.log(failed === 0 ? "USEFULNESS_CHECK PASS" : "USEFULNESS_CHECK FAIL");
process.exit(failed === 0 ? 0 : 1);
