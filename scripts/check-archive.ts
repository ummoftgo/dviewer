/**
 * Checks the archive list's pure logic.
 *
 *   node scripts/check-archive.ts
 *
 * Two pieces of frontend logic in M7 fail quietly rather than loudly, which is
 * why they are checked here and the rest of the app is not:
 *
 * - `sameSource` decides whether a tab already shows an entry. When it stops
 *   matching, nothing breaks — every click just opens one more copy of what is
 *   already open, and no error says so.
 * - the tree's filter decides which rows exist. When it is wrong, the list is
 *   simply missing rows, which reads as an archive that does not contain them.
 *
 * Run by `npm run check`, so CI covers it too. Written against `node` directly
 * for the reason `check-i18n.ts` is: this repository has no test runner on the
 * JavaScript side, and adding one to cover two functions would be a larger
 * decision than the two functions are.
 */
import { buildTree, flatten } from "../src/lib/components/archive/tree.ts";
import { chainOf, opensAs, sameSource } from "../src/lib/source.ts";
import type { ArchiveEntry, DocSource } from "../src/lib/ipc.ts";

const problems: string[] = [];

function check(what: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) problems.push(`${what}: ${a} — 기대한 값 ${b}`);
}

function entry(index: number, name: string, extra: Partial<ArchiveEntry> = {}): ArchiveEntry {
  return { index, name, size: 1, encrypted: false, kind: "text", ...extra };
}

const file: DocSource = { type: "file", path: "C:/docs/bundle.zip" };
const url: DocSource = { type: "url", url: "https://example.test/bundle.zip" };

// --- the way in -------------------------------------------------------------

const first = chainOf(file, entry(2, "inner.zip"))!;
const second = chainOf(first, entry(7, "logs/app.log"))!;

check("한 걸음", first, {
  type: "archiveEntry",
  root: file,
  entries: [{ index: 2, name: "inner.zip" }],
});
check("두 걸음의 뿌리", second.type === "archiveEntry" && second.root, file);
check(
  "두 걸음의 경로",
  second.type === "archiveEntry" && second.entries.map((step) => step.index),
  [2, 7],
);
check("붙여넣은 글은 압축 파일이 아니다", chainOf({ type: "text" }, entry(0, "a.txt")), null);

// --- the same document, twice -----------------------------------------------

check("같은 사슬", sameSource(second, chainOf(chainOf(file, entry(2, "inner.zip"))!, entry(7, "logs/app.log"))!), true);
// The name is display text and is frozen when the list was read, so a different
// guess at the archive's name encoding must not make this a different document.
check(
  "이름이 달라도 번호가 같으면 같은 문서",
  sameSource(second, chainOf(chainOf(file, entry(2, "▒▒.zip"))!, entry(7, "▒▒▒/app.log"))!),
  true,
);
check("번호가 다르면 다른 문서", sameSource(second, chainOf(first, entry(8, "logs/app.log"))!), false);
check("뿌리가 다르면 다른 문서", sameSource(second, chainOf(chainOf(url, entry(2, "inner.zip"))!, entry(7, "logs/app.log"))!), false);
check("깊이가 다르면 다른 문서", sameSource(first, second), false);
check("같은 파일", sameSource(file, { type: "file", path: "C:/docs/bundle.zip" }), true);
check("파일과 사슬은 다르다", sameSource(file, first), false);

// --- what opening a path produces -------------------------------------------

check("파일 탭", opensAs(file, "C:/docs/bundle.zip"), true);
// The transparent unwrap: opening `bundle.zip` produced a tab whose source is
// its single entry, and opening it again has to find that tab.
check("투명 해제된 탭", opensAs(first, "C:/docs/bundle.zip"), true);
check("두 걸음 깊은 탭은 아니다", opensAs(second, "C:/docs/bundle.zip"), false);
check("다른 파일의 항목은 아니다", opensAs(first, "C:/docs/other.zip"), false);

// --- the tree ---------------------------------------------------------------

const entries = [
  entry(0, "readme.md"),
  entry(1, "src/lib/a.ts"),
  entry(2, "src/lib/b.ts"),
  entry(3, "src/main.ts"),
  entry(4, "docs/guide.md"),
  // A zip stores directories as zero-byte entries; the backend drops those, so
  // every directory here is one the names implied.
];
const tree = buildTree(entries);
const paths = (rows: ReturnType<typeof flatten>) => rows.map((row) => row.node.path);

check(
  "디렉터리가 먼저, 그다음 이름순",
  paths(flatten(tree, new Set(), "")),
  [
    "docs",
    "docs/guide.md",
    "src",
    "src/lib",
    "src/lib/a.ts",
    "src/lib/b.ts",
    "src/main.ts",
    "readme.md",
  ],
);

check("접은 디렉터리는 자식을 감춘다", paths(flatten(tree, new Set(["src"]), "")), [
  "docs",
  "docs/guide.md",
  "src",
  "readme.md",
]);

// A filter reaches into closed directories: a match nobody is shown is a match
// that may as well not have been found.
check("거르면 접힌 것도 열린다", paths(flatten(tree, new Set(["src"]), "b.ts")), [
  "src",
  "src/lib",
  "src/lib/b.ts",
]);

// A directory's path is a prefix of everything under it, so typing a folder
// name finds its contents without any special case for ancestors.
check("디렉터리 이름으로 거르면 그 안이 전부 나온다", paths(flatten(tree, new Set(), "lib/")), [
  "src",
  "src/lib",
  "src/lib/a.ts",
  "src/lib/b.ts",
]);

check("맞는 것이 없으면 빈 목록", paths(flatten(tree, new Set(), "nothing")), []);
check("거르기는 대소문자를 가리지 않는다", paths(flatten(tree, new Set(), "README")), ["readme.md"]);
check("디렉터리가 든 문서 수", tree.children.find((node) => node.path === "src")?.count, 3);

// --- report -----------------------------------------------------------------

if (problems.length > 0) {
  console.error("아카이브 목록 검사 실패:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("아카이브 목록 검사 통과 — 사슬 동등 11건, 트리와 거르기 7건");
