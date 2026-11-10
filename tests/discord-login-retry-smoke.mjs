/**
 * Discord 登入重試 smoke test
 *
 * 測試項目：
 *   1. 探路連不上 → 退避重試，通了才呼叫 login（探路失敗期間不碰 client）
 *   2. 探路通但 login 本身失敗（可重試的錯）→ 重試到成功
 *   3. 設定類錯誤（TokenInvalid／DisallowedIntents／401）→ 不重試，直接 throw
 *   4. 等待間隔：5s、10s、20s、40s，之後固定 60s
 *
 * 用法：node tests/discord-login-retry-smoke.mjs   （先 tsc 編到 dist/）
 */

import { loginWithRetry, retryDelayMs, isFatalLoginError } from "../dist/discord-login.js";
import { setLogLevel } from "../dist/logger.js";

setLogLevel("silent");

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

const timeoutErr = () => Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" });

/** 前 failTimes 次 throw，之後成功；記錄被呼叫幾次 */
function flaky(failTimes, makeErr = timeoutErr) {
  const fn = async () => { fn.calls++; if (fn.calls <= failTimes) throw makeErr(); };
  fn.calls = 0;
  return fn;
}

console.log("1. 探路連不上 → 重試，通了才 login");
{
  const probe = flaky(3);
  const login = flaky(0);
  const waits = [];
  const attempts = await loginWithRetry({ login }, "tok", { probe, sleep: async (ms) => { waits.push(ms); } });
  assert(attempts === 4, "第 4 次才成功");
  assert(probe.calls === 4, "探路打了 4 次");
  assert(login.calls === 1, "探路失敗期間沒碰 login，通了才登一次");
  assert(JSON.stringify(waits) === "[5000,10000,20000]", `等待間隔 5s/10s/20s（實際 ${JSON.stringify(waits)}）`);
}

console.log("2. 探路通但 login 失敗 → 重試到成功");
{
  const probe = flaky(0);
  const login = flaky(2);
  const waits = [];
  const attempts = await loginWithRetry({ login }, "tok", { probe, sleep: async (ms) => { waits.push(ms); } });
  assert(attempts === 3, "第 3 次成功");
  assert(login.calls === 3, "login 呼叫 3 次");
  assert(waits.length === 2, "中間等了 2 次");
}

console.log("3. 設定類錯誤不重試");
for (const [label, makeErr] of [
  ["TokenInvalid", () => Object.assign(new Error("An invalid token was provided."), { code: "TokenInvalid" })],
  ["DisallowedIntents", () => Object.assign(new Error("Privileged intent provided is not enabled or whitelisted."), { code: "DisallowedIntents" })],
  ["HTTP 401", () => Object.assign(new Error("401: Unauthorized"), { status: 401 })],
]) {
  const login = flaky(Infinity, makeErr);
  let slept = 0;
  let thrown = null;
  try { await loginWithRetry({ login }, "tok", { probe: flaky(0), sleep: async () => { slept++; } }); }
  catch (err) { thrown = err; }
  assert(thrown !== null && login.calls === 1 && slept === 0, `${label}：試一次就 throw、沒有等待`);
}
assert(isFatalLoginError(timeoutErr()) === false, "連線逾時不算設定類錯誤");

console.log("4. 等待間隔上限");
assert([1, 2, 3, 4, 5, 6, 20].map((n) => retryDelayMs(n)).join(",") === "5000,10000,20000,40000,60000,60000,60000", "5s→10s→20s→40s→60s 封頂");

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed > 0 ? "DISCORD_LOGIN_RETRY_CHECK FAIL" : "DISCORD_LOGIN_RETRY_CHECK PASS");
process.exit(failed > 0 ? 1 : 0);
