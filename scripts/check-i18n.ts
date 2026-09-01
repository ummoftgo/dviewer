/**
 * Checks the message dictionaries against each other.
 *
 *   node scripts/check-i18n.ts
 *
 * Key parity is already a compile error — every locale but Korean is typed
 * `Messages`, so a missing or extra key fails `npm run check`. What the type
 * system cannot see is inside the strings, which is what this covers:
 *
 * - the same `{placeholders}` in every locale, so a translation cannot
 *   silently drop the number it was supposed to show;
 * - no empty messages, which type-check fine and render as nothing.
 *
 * Run by `npm run check`, so CI covers it too.
 */
import { en } from "../src/lib/i18n/messages/en.ts";
import { ja } from "../src/lib/i18n/messages/ja.ts";
import { ko } from "../src/lib/i18n/messages/ko.ts";
import { zhHans } from "../src/lib/i18n/messages/zh-Hans.ts";

const LOCALES: Record<string, Record<string, string>> = { ko, en, ja, "zh-Hans": zhHans };
const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(message: string): string[] {
  return [...message.matchAll(PLACEHOLDER)].map((match) => match[1]).sort();
}

const problems: string[] = [];
const keys = Object.keys(ko);

for (const [name, messages] of Object.entries(LOCALES)) {
  const extra = Object.keys(messages).filter((key) => !(key in ko));
  const missing = keys.filter((key) => !(key in messages));
  for (const key of missing) problems.push(`${name}: 없는 키 ${key}`);
  for (const key of extra) problems.push(`${name}: 한국어에 없는 키 ${key}`);

  for (const key of keys) {
    const message = messages[key];
    if (message === undefined) continue;
    if (message.trim() === "") {
      problems.push(`${name}: 빈 메시지 ${key}`);
      continue;
    }
    const here = placeholders(message);
    const there = placeholders(ko[key as keyof typeof ko]);
    if (here.join(",") !== there.join(",")) {
      problems.push(
        `${name}: ${key} 의 자리표시자가 다릅니다 — 한국어 {${there}} 대 {${here}}`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(`i18n 검사 실패 (${problems.length}건)`);
  for (const problem of problems) console.error("  " + problem);
  process.exit(1);
}

console.log(`i18n 검사 통과 — ${Object.keys(LOCALES).length}개 로케일 × ${keys.length}개 키`);

// --- no text left outside the dictionaries ---------------------------------
//
// Type checking cannot see a Korean string sitting in a component; only a scan
// can. Anything genuinely meant to be literal — the font preview, which exists
// to show several scripts at once — says so with an `i18n-ignore` comment on
// the same line.
//
// Tests are skipped. What this looks for is text a reader would see, and a
// `*.test.ts` shows nobody anything: the Korean in one is a fixture under
// test — a CP949 archive name, a column measured in Hangul — and demanding a
// dictionary key for it would mean testing the encoding paths in English.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CJK = /[가-힣぀-ヿ一-鿿]/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "i18n") continue;
      out.push(...sources(path));
    } else if (name.endsWith(".test.ts")) {
      continue;
    } else if (name.endsWith(".svelte") || name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

const stray: string[] = [];
for (const path of sources("src")) {
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, index) => {
      const code = line.trim();
      if (!CJK.test(code)) return;
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("<!--")) return;
      if (line.includes("i18n-ignore")) return;
      stray.push(`${path}:${index + 1}: ${code.slice(0, 80)}`);
    });
}

if (stray.length > 0) {
  console.error(`사전 밖에 남은 문자열 (${stray.length}건)`);
  for (const line of stray) console.error("  " + line);
  process.exit(1);
}

console.log(`사전 밖 문자열 검사 통과 — ${sources("src").length}개 파일`);
