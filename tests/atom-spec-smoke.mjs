/**
 * atom-spec smoke test — V5 P5
 *
 * 測試項目：
 *   1. slugify 邊界：valid kebab / 中文 / 空格底線轉 dash / leading-trailing dash
 *   2. buildAtomContent round-trip：產出 .md 不含 Last-used / Confirmations
 *   3. validateAtomContent：empty / missing-required / unknown-meta / invalid-confidence /
 *      invalid-scope / over-max-lines / missing-section / too-many-triggers
 *   4. shouldSkip：_staging / failures / SPEC_ / MEMORY.md / _atom_index.json
 *
 * 用法：node tests/atom-spec-smoke.mjs
 */

import {
  slugify,
  buildAtomContent,
  validateAtomContent,
  shouldSkip,
  ATOM_MAX_LINES,
} from "../dist/memory/atom-spec.js";

let passed = 0;
let failed = 0;

function assert(cond, name) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}`); failed++; }
}

function assertEq(a, b, name) {
  assert(a === b, `${name} (expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`);
}

// ── Test 1: slugify ────────────────────────────────────────────────────────

console.log("\n═══ Test 1: slugify ═══");

assertEq(slugify("my-atom"), "my-atom", "valid kebab passes through");
assertEq(slugify("foo bar"), "foo-bar", "space → dash");
assertEq(slugify("foo_bar"), "foo-bar", "underscore → dash");
assertEq(slugify("Foo-Bar"), "foo-bar", "uppercase → lowercase");
assertEq(slugify("  foo--bar  "), "foo-bar", "trim + collapse dashes");
assertEq(slugify("-foo-"), "foo", "strip leading/trailing dash");
assertEq(slugify(""), null, "empty → null");
assertEq(slugify("中文"), null, "non-ASCII → null（caller 該 error）");
assertEq(slugify("hello!"), null, "punctuation → null");

// ── Test 2: buildAtomContent round-trip ───────────────────────────────────

console.log("\n═══ Test 2: buildAtomContent round-trip ═══");

{
  const md = buildAtomContent(
    { name: "foo", scope: "global", confidence: "[固]", triggers: ["a", "b"] },
    "hello world",
  );
  assert(md.includes("# foo"), "含 # foo 標題");
  assert(md.includes("- Scope: global"), "含 Scope");
  assert(md.includes("- Confidence: [固]"), "含 Confidence");
  assert(md.includes("- Trigger: a, b"), "含 Trigger");
  assert(md.includes("- Created-at:"), "含 Created-at");
  assert(md.includes("## 知識"), "含 ## 知識 章節");
  assert(md.includes("hello world"), "含 content");
  // 新規定：不再寫 Last-used / Confirmations 到 .md
  assert(!md.includes("- Last-used:"), "不寫 Last-used");
  assert(!md.includes("- Confirmations:"), "不寫 Confirmations");
}

// 無 triggers / related 時不出對應欄位
{
  const md = buildAtomContent({ name: "min", confidence: "[臨]" }, "x");
  assert(!md.includes("- Trigger:"), "無 trigger 時不出 Trigger 欄");
  assert(!md.includes("- Related:"), "無 related 時不出 Related 欄");
}

// ── Test 3: validateAtomContent ───────────────────────────────────────────

console.log("\n═══ Test 3: validateAtomContent ═══");

{
  // 3a: 正常 ok
  const ok = buildAtomContent(
    { name: "ok", confidence: "[固]", triggers: ["x"] },
    "content",
  );
  const errs = validateAtomContent(ok);
  // 注意 buildAtomContent 預設不寫 Scope，這沒事（Scope 是 optional 不在 required 裡）
  assertEq(errs.length, 0, `正常 atom 0 errors（actual: ${JSON.stringify(errs)}）`);
}

{
  // 3b: empty
  const errs = validateAtomContent("");
  assert(errs.some(e => e.kind === "empty-content"), "empty 偵測");
}

{
  // 3c: missing required Confidence
  const md = ["# foo", "", "- Trigger: x", "", "## 知識", "", "x", ""].join("\n");
  const errs = validateAtomContent(md);
  assert(errs.some(e => e.kind === "missing-required-meta" && e.detail === "Confidence"),
    "missing Confidence 偵測");
}

{
  // 3d: invalid confidence
  const md = ["# foo", "", "- Confidence: [???]", "- Trigger: x", "", "## 知識", "", "x"].join("\n");
  const errs = validateAtomContent(md);
  assert(errs.some(e => e.kind === "invalid-confidence"), "invalid confidence 偵測");
}

{
  // 3e: invalid scope
  const md = ["# foo", "", "- Scope: invalid", "- Confidence: [固]", "- Trigger: x", "", "## 知識", "", "x"].join("\n");
  const errs = validateAtomContent(md);
  assert(errs.some(e => e.kind === "invalid-scope"), "invalid scope 偵測");
}

{
  // 3f: unknown meta
  const md = ["# foo", "", "- Confidence: [固]", "- Trigger: x", "- Bogus: yes", "", "## 知識", "", "x"].join("\n");
  const errs = validateAtomContent(md);
  assert(errs.some(e => e.kind === "unknown-meta" && e.detail === "Bogus"), "unknown meta 偵測");
}

{
  // 3g: missing section
  const md = ["# foo", "", "- Confidence: [固]", "- Trigger: x", "", "## 其他", "", "x"].join("\n");
  const errs = validateAtomContent(md);
  assert(errs.some(e => e.kind === "missing-section"), "missing required section 偵測");
}

{
  // 3h: over max lines
  const big = ["# big", "", "- Confidence: [固]", "- Trigger: x", "", "## 知識", ""];
  for (let i = 0; i < ATOM_MAX_LINES + 10; i++) big.push(`line ${i}`);
  const errs = validateAtomContent(big.join("\n"));
  assert(errs.some(e => e.kind === "over-max-lines"), "over max lines 偵測");
}

{
  // 3i: too many triggers
  const md = ["# many", "", "- Confidence: [固]",
    "- Trigger: a, b, c, d, e, f, g, h, i, j, k, l, m, n, o",
    "", "## 知識", "", "x"].join("\n");
  const errs = validateAtomContent(md);
  assert(errs.some(e => e.kind === "too-many-triggers"), "too many triggers 偵測");
}

// ── Test 4: shouldSkip ─────────────────────────────────────────────────────

console.log("\n═══ Test 4: shouldSkip ═══");

assert(shouldSkip("_staging"), "_staging 跳過");
assert(shouldSkip("_meta"), "_meta 跳過");
assert(shouldSkip("failures"), "failures 跳過");
assert(shouldSkip("episodic"), "episodic 跳過");
assert(shouldSkip("MEMORY.md"), "MEMORY.md 跳過");
assert(shouldSkip("_atom_index.json"), "_atom_index.json 跳過");
assert(shouldSkip("SPEC_ATOM_V5.md"), "SPEC_ 前綴跳過");
assert(!shouldSkip("preferences.md"), "正常 atom 不跳");
assert(!shouldSkip("decisions"), "正常 dir name 不跳");

// ── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n═══ 結果：${passed} passed, ${failed} failed ═══`);
process.exit(failed > 0 ? 1 : 0);
