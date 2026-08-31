/**
 * Generates the test documents used to verify the viewer by hand.
 *
 *   node scripts/gen-fixtures.mjs [--huge]
 *
 * `--huge` additionally writes a ~600MB JSON file and a ~400MB CSV, which are
 * the cases the indexing design exists for. They are opt-in because they take a
 * while and eat disk. Everything lands in ./fixtures, which is git-ignored.
 */
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";

const OUT = path.join(process.cwd(), "fixtures");
const wantHuge = process.argv.includes("--huge");

await mkdir(OUT, { recursive: true });

/** Write chunks with backpressure so a 600MB file does not buffer in memory. */
async function writeStream(name, chunks) {
  const stream = createWriteStream(path.join(OUT, name));
  for (const chunk of chunks) {
    if (!stream.write(chunk)) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "finish");
  console.log(`  ${name}`);
}

function record(i) {
  return JSON.stringify({
    id: i,
    name: `항목 ${i}`,
    slug: `item-${i}`,
    active: i % 3 !== 0,
    score: Math.round(Math.sin(i) * 10000) / 100,
    tags: ["alpha", "beta", i % 2 ? "odd" : "even"],
    meta: {
      created: `2026-0${(i % 9) + 1}-15T09:30:00Z`,
      owner: { team: `team-${i % 12}`, email: `owner${i % 12}@example.com` },
      notes: i % 50 === 0 ? "needle: 이 항목은 검색 테스트용입니다" : null,
    },
  });
}

function* arrayOf(count, item) {
  yield '{"generated":true,"count":' + count + ',"items":[';
  for (let i = 0; i < count; i++) {
    yield (i === 0 ? "" : ",") + item(i);
  }
  yield "]}\n";
}

console.log("fixtures →", OUT);

// ~1MB: the everyday case.
await writeStream("small.json", arrayOf(1_500, record));

// Deep nesting, to exercise the depth limit and the indent rendering.
{
  const depth = 500;
  let json = '{"leaf":"바닥에 도달","marker":"needle-deep"}';
  for (let i = depth; i > 0; i--) json = `{"level${i}":${json}}`;
  await writeFile(path.join(OUT, "deep.json"), json);
  console.log("  deep.json");
}

// One million siblings: the case that breaks naive tree viewers.
await writeStream("wide.json", arrayOf(1_000_000, (i) => `{"i":${i},"v":"item-${i}"}`));

// NDJSON, which the scanner wraps in a synthetic root.
await writeStream(
  "stream.jsonl",
  (function* () {
    for (let i = 0; i < 5_000; i++) yield record(i) + "\n";
  })(),
);

// Truncated mid-value: the error path must name a line and column.
await writeFile(
  path.join(OUT, "broken.json"),
  '{\n  "ok": [1, 2, 3],\n  "bad": {"unterminated": "값이 끝나지\n',
);


if (wantHuge) {
  // ~600MB. Indexing time and resident memory are the numbers to watch.
  await writeStream("huge.json", arrayOf(2_400_000, record));
} else {
  console.log("  (huge.json 생략 — --huge 옵션으로 생성)");
}


// --- gzip ---------------------------------------------------------------

// 안쪽 이름이 형식을 정한다: report.json.gz 는 JSON, 맨 .gz 는 내용으로.
{
  const { gzipSync } = await import("node:zlib");
  const json = await readFile(path.join(OUT, "small.json"));
  await writeFile(path.join(OUT, "report.json.gz"), gzipSync(json));
  console.log("  report.json.gz");

  const log = await readFile(path.join(OUT, "sample.log"));
  await writeFile(path.join(OUT, "sample.log.gz"), gzipSync(log));
  console.log("  sample.log.gz");

  // 확장자가 형식을 말하지 않는 경우 — 내용으로 판별해야 한다.
  await writeFile(path.join(OUT, "dump.gz"), gzipSync(json));
  console.log("  dump.gz (안쪽 이름 없음)");
}

// --- 텍스트와 로그 -----------------------------------------------------------

await writeFile(
  path.join(OUT, "sample.log"),
  [
    "2026-08-30T01:02:03.123Z INFO  [server] 시작됨 port=8080",
    "2026-08-30T01:02:04.001Z WARN  [db] 연결이 느립니다 elapsed=1520ms",
    "",
    "2026-08-30T01:02:05.900Z ERROR [db] 연결 실패",
    "\tat Connection.open(Connection.java:117)",
    "\tat Pool.acquire(Pool.java:42)",
    '2026-08-30T01:02:06.010Z INFO  [server] 요청 path="/a/b" status=200',
    "",
  ].join("\n"),
);
console.log("  sample.log");

// 줄 인덱스가 견뎌야 하는 것들: 아주 긴 줄, 빈 줄, CRLF 와 LF 혼합,
// 마지막 개행 없음, 그리고 따옴표로 시작하는 줄 (CSV 라면 다음 줄을 삼킨다).
await writeFile(
  path.join(OUT, "edge.log"),
  [
    "짧은 줄",
    "",
    '"따옴표로 시작하는 줄 — CSV 였다면 여기서 레코드가 이어진다',
    "그 다음 줄",
    "긴 줄: " + "가".repeat(20_000),
    "탭\t가 든\t줄",
  ].join("\r\n") + "\n마지막 줄에는 개행이 없다",
);
console.log("  edge.log (CRLF·빈 줄·2만자 줄·따옴표 시작)");

await writeFile(
  path.join(OUT, "cp949.log"),
  // Node 는 CP949 를 인코딩하지 못하므로 바이트를 직접 쓴다.
  // "2026-08-30 01:02:03 정보 한국 윈도우가 남긴 로그\n두 번째 줄\n"
  Buffer.from(
    "323032362d30382d33302030313a30323a303320c1a4baba20c7d1b1b520bfa9bcbfbfecb0a120b3b2b1e620b7ceb1d70ad4de20b9f8c2b02020c1d40a",
    "hex",
  ),
);
console.log("  cp949.log (참고: 바이트를 직접 씀)");

if (wantHuge) {
  // ~250MB. 줄 인덱스는 행당 4바이트라 huge.csv 와 같은 급으로 두면
  // 성능 표에 나란히 적을 수 있다.
  await writeStream(
    "huge.log",
    (function* () {
      const levels = ["INFO ", "WARN ", "ERROR", "DEBUG"];
      for (let i = 0; i < 2_000_000; i++) {
        const level = levels[i % levels.length];
        yield `2026-08-30T01:${String((i / 60) % 60 | 0).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z ${level} [worker-${i % 8}] 처리 완료 id=${i} elapsed=${i % 1000}ms path="/api/v1/items/${i}"\n`;
      }
    })(),
  );
} else {
  console.log("  (huge.log 생략 — --huge 옵션으로 생성)");
}

const markdown = `---
title: dviewer 샘플 문서
author: 검증용
---

# dviewer 샘플 문서

이 문서는 렌더링 파이프라인을 한 번에 확인하기 위한 것입니다. **굵게**, *기울임*,
~~취소선~~, \`인라인 코드\`, 그리고 [외부 링크](https://tauri.app)가 들어 있습니다.

## 표

| 항목 | 설명 | 크기 | 비고 |
|---|---|---:|---|
| 마크다운 | comrak + syntect | 16MB | 원문/렌더 토글 |
| JSON | 바이트 스캐너 + 오프셋 인덱스 | 4GB | 500MB 실측 대상 |
| 검색 | aho-corasick | — | 키/값 범위 지정 |

## 체크리스트

- [x] 표가 읽히는가
- [x] 체크박스가 그려지는가
- [ ] 아직 안 한 일
  - [ ] 중첩된 항목

## 코드

\`\`\`rust
fn main() {
    let nodes: Vec<Node> = Vec::new();
    println!("{} nodes", nodes.len());
}
\`\`\`

\`\`\`typescript
const rows = await jsonRows(docId, start, count);
rows.forEach((row) => console.log(row.key, row.value));
\`\`\`

\`\`\`python
def scan(path: str) -> int:
    return sum(1 for _ in open(path, encoding="utf-8"))
\`\`\`

\`\`\`json
{ "kind": "json", "nodes": 10485760, "bytes": 524288000 }
\`\`\`

\`\`\`sql
SELECT count(*) FROM documents WHERE kind = 'markdown';
\`\`\`

## 다이어그램

\`\`\`mermaid
graph LR
  A[파일 선택] --> B{종류 판별}
  B -->|markdown| C[comrak 렌더]
  B -->|json| D[바이트 스캐너]
  D --> E[오프셋 인덱스]
  E --> F[가상 스크롤]
\`\`\`

## 수식

인라인 수식 $E = mc^2$ 과 블록 수식:

$$\\sum_{i=0}^{n} \\frac{1}{2^i} = 2 - \\frac{1}{2^n}$$

## 이미지

로컬 이미지(상대 경로): ![아이콘](./icon.png)

없는 이미지: ![없음](./does-not-exist.png)

## 인용과 알림

> 인용문입니다.
> 두 번째 줄.

> [!NOTE]
> GFM 알림 블록입니다.

> [!WARNING]
> 경고 블록입니다.

## 접기

<details>
<summary>자세히 보기</summary>

접혀 있던 내용입니다. 표도 들어갈 수 있습니다.

| a | b |
|---|---|
| 1 | 2 |

</details>

## 각주

각주가 붙은 문장입니다[^1].

[^1]: 각주 내용입니다.

## 원시 HTML

<script>alert("이 스크립트는 실행되면 안 됩니다")</script>
<img src=x onerror="alert('이것도 안 됩니다')">

## 긴 코드 (가로 스크롤)

\`\`\`text
${"가로로 아주 긴 줄 ".repeat(30)}
\`\`\`
`;

await writeFile(path.join(OUT, "sample.md"), markdown);
console.log("  sample.md");

// --- the other formats ----------------------------------------------------
//
// Small on purpose: these exercise the awkward parts of each format, not its
// size. Only JSON and CSV have a streaming indexer worth stress-testing.

await writeFile(
  path.join(OUT, "sample.yaml"),
  `# 주석은 트리에 나타나지 않습니다
service:
  name: dviewer
  ports: [80, 443]
  env:
    LOG_LEVEL: debug
    EMPTY:
anchors:
  base: &base
    retries: 3
  derived:
    <<: *base
    retries: 5
multiline: |
  첫째 줄
  둘째 줄
quoted: "탭\t과 줄바꿈\n이 든 값"
---
second: 이 파일은 문서가 둘입니다
`,
);
console.log("  sample.yaml");

await writeFile(
  path.join(OUT, "sample.toml"),
  `title = "dviewer"
updated = 2026-08-29T01:00:00Z

[server]
host = "127.0.0.1"
port = 8080
tags = ["a", "b"]

[[user]]
name = "가"

[[user]]
name = "나"
`,
);
console.log("  sample.toml");

await writeFile(
  path.join(OUT, "sample.xml"),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE catalog>
<catalog xmlns:x="urn:example">
  <!-- 주석도 노드입니다 -->
  <book id="b1" lang="ko">
    <title>제목 &amp; 부제</title>
    <author>글쓴이</author>
    <price currency="KRW">12000</price>
  </book>
  <book id="b2">
    <title>Emma</title>
    <summary><![CDATA[원시 <태그> 그대로]]></summary>
  </book>
  <x:note>이름공간이 붙은 요소</x:note>
  <empty/>
  <mixed>앞<b>굵게</b>뒤</mixed>
</catalog>
`,
);
console.log("  sample.xml");

await writeFile(
  path.join(OUT, "sample.csv"),
  `id,이름,메모,점수
1,가나다,"쉼표, 가 든 값",10
2,라마바,"따옴표 ""가"" 든 값",20
3,사아자,"줄바꿈이
든 값",30
4,차카타,,40
5,파하,짧은 행
`,
);
console.log("  sample.csv");

// Encodings a spreadsheet actually produces. Written as bytes rather than
// strings because the point is what lands on disk, not what Node holds.
await writeFile(
  path.join(OUT, "utf8bom.csv"),
  Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("id,이름,메모\n1,가나다,BOM이 붙은 UTF-8\n", "utf8")]),
);
console.log("  utf8bom.csv");

await writeFile(
  path.join(OUT, "cp949.csv"),
  // Node cannot encode CP949, so the bytes are given directly:
  // "id,이름,메모\n1,가나다,한국 윈도우 엑셀의 기본\n"
  Buffer.from(
    "69642cc0ccb8a72cb8deb8f00a312cb0a1b3aab4d92cc7d1b1b920c0a9b5b5bfec20bfa2bcbfc0c720b1e2babb0a",
    "hex",
  ),
);
console.log("  cp949.csv (참고: 바이트를 직접 씀)");

await writeFile(
  path.join(OUT, "utf16.csv"),
  Buffer.from("\ufeffid\t이름\t메모\n1\t가나다\tUTF-16 LE\n", "utf16le"),
);
console.log("  utf16.csv");

await writeFile(
  path.join(OUT, "semicolon.csv"),
  `id;이름;점수
1;가나다;10
2;라마바;20
`,
);
console.log("  semicolon.csv");

await writeFile(
  path.join(OUT, "sample.tsv"),
  ["id\t이름\t점수", "1\t가나다\t10", "2\t라마바\t20", ""].join("\n"),
);
console.log("  sample.tsv");

// --- SQLite ----------------------------------------------------------------
// Written with node's own SQLite so the generator keeps its no-dependency rule.
// It prints an experimental-feature warning; that is node's, not a problem here.
// Shapes worth having: a plain table with a rowid, a table without one, a view,
// a BLOB column, and text that is not ASCII.
{
  const { DatabaseSync } = await import("node:sqlite");
  const file = path.join(OUT, "sample.sqlite");
  await rm(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      joined TEXT
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER REFERENCES customers(id),
      total REAL,
      placed TEXT,
      receipt BLOB
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
    CREATE VIEW recent_orders AS
      SELECT o.id, c.name, o.total FROM orders o JOIN customers c ON c.id = o.customer_id;
  `);
  const names = ["김하늘", "Alice Nguyen", "佐藤 健", "Björn Öst", "O'Brien"];
  const customer = db.prepare("INSERT INTO customers VALUES (?, ?, ?, ?)");
  for (let i = 1; i <= 50; i += 1) {
    // Every seventh has no email. A viewer that cannot tell NULL from an empty
    // string has nothing here to catch it, so the fixture carries both.
    customer.run(
      i,
      `${names[i % 5]} ${i}`,
      i % 7 === 0 ? null : i % 11 === 0 ? "" : `user${i}@example.com`,
      `2026-0${(i % 9) + 1}-1${i % 9}`,
    );
  }
  const order = db.prepare("INSERT INTO orders VALUES (?, ?, ?, ?, ?)");
  for (let i = 1; i <= 200; i += 1) {
    order.run(i, (i % 50) + 1, Math.round(i * 1370) / 100, `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      new Uint8Array(16).fill(i % 256));
  }
  const setting = db.prepare("INSERT INTO settings VALUES (?, ?)");
  setting.run("theme", "dark");
  setting.run("locale", "ko");
  db.close();
  console.log("  sample.sqlite");
}

// A JSONC file with every shape the lenient reading has to walk past, and a
// strict twin that differs only in having none of them — open the two side by
// side and the tree should be identical.
const jsoncBody = `{
  // 어느 포트로 열지
  "port": 8080,

  /* 여러 줄 주석도
     당연히 지나간다 */
  "hosts": [
    "a.example.com", // 뒤에 붙는 주석
    "b.example.com",  // 그리고 다음 줄에 후행 쉼표
  ],

  "nested": { "deep": { "value": 1, }, },
  "url": "https://example.com/not/a/comment",
  "text": "/* 이건 문자열 안이라 주석이 아니다 */",
  "number": 1, // 주석이 값의 끝이기도 하다
}`;
await writeFile(path.join(OUT, "sample.jsonc"), jsoncBody + "\n");
console.log("  sample.jsonc");

await writeFile(
  path.join(OUT, "strict.json"),
  JSON.stringify(
    {
      port: 8080,
      hosts: ["a.example.com", "b.example.com"],
      nested: { deep: { value: 1 } },
      url: "https://example.com/not/a/comment",
      text: "/* 이건 문자열 안이라 주석이 아니다 */",
      number: 1,
    },
    null,
    2,
  ) + "\n",
);
console.log("  strict.json");

// The one that has to fail with an offer rather than a dead end: a .json name
// over JSONC content, which is what every editor settings file looks like.
await writeFile(path.join(OUT, "settings.json"), jsoncBody + "\n");
console.log("  settings.json");

// --- xlsx --------------------------------------------------------------------
// An xlsx is a zip of XML, and a zip whose entries are stored uncompressed is a
// header, the bytes, and a table of contents. That is small enough to write
// here, which keeps this script's no-dependency rule — and it lets the fixture
// carry exactly the shapes the reader has to get right, which a library's
// defaults would not.

const { deflateRawSync } = await import("node:zlib");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip file from `{name: text}`.
 *
 * Deflated, not stored. A real xlsx is compressed, and the difference is not
 * cosmetic: the format's whole memory story is that a modest file expands on
 * the way in, so a fixture written uncompressed would hold a tenth of the rows
 * for the same megabytes and measure the wrong thing.
 */
function zipOf(entries) {
  const files = [];
  const locals = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.from(text, "utf8");
    const body = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(0, 10); // time
    header.writeUInt16LE(0x21, 12); // date: 1980-01-01, so the file is stable
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, body);
    files.push({ nameBytes, body, raw, crc, offset });
    offset += header.length + nameBytes.length + body.length;
  }

  const central = [];
  let centralSize = 0;
  for (const file of files) {
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10); // deflate
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(file.crc, 16);
    entry.writeUInt32LE(file.body.length, 20);
    entry.writeUInt32LE(file.raw.length, 24);
    entry.writeUInt16LE(file.nameBytes.length, 28);
    entry.writeUInt32LE(file.offset, 42);
    central.push(entry, file.nameBytes);
    centralSize += entry.length + file.nameBytes.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, ...central, end]);
}

const xmlEscape = (text) =>
  String(text).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

/**
 * One cell. `kind` picks how the value is written:
 *   n  number (and the serial behind a date, with `style` naming the format)
 *   s  index into the shared strings
 *   b  boolean
 *   f  formula, with the cached result Excel last computed
 */
function cellXml(ref, kind, value, style, formula) {
  const s = style ? ` s="${style}"` : "";
  if (kind === "s") return `<c r="${ref}"${s} t="s"><v>${value}</v></c>`;
  if (kind === "b") return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (kind === "f") return `<c r="${ref}"${s}><f>${xmlEscape(formula)}</f><v>${value}</v></c>`;
  if (kind === "e") return `<c r="${ref}"${s}/>`;
  return `<c r="${ref}"${s}><v>${value}</v></c>`;
}

function sheetXml(rows) {
  const body = rows
    .map((cells, r) => (cells.length ? `<row r="${r + 1}">${cells.join("")}</row>` : ""))
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

{
  // Shared strings, which is what makes a small xlsx expand when it is read:
  // every repeat of a word is one index here and a whole string in memory.
  const strings = [
    "이름",
    "수량",
    "단가",
    "합계",
    "등록일",
    "마감",
    "비고",
    "가나다 상사",
    "라마바 유통",
    "사아자 물산",
    "줄바꿈\n이 든 값",
    "",
  ];
  const sharedStrings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
    .map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`)
    .join("")}</sst>`;

  // cellXfs: 0 general, 1 date (numFmt 14), 2 date+time (22), 3 time (21).
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" xfId="0" applyNumberFormat="1"/><xf numFmtId="21" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

  // 46265 is 2026-08-30; .3958333 of a day is 09:30.
  const sales = [
    [0, 1, 2, 3, 4, 5, 6].map((i, c) => cellXml(`${"ABCDEFG"[c]}1`, "s", i)),
    [
      cellXml("A2", "s", 7),
      cellXml("B2", "n", 3),
      cellXml("C2", "n", 12500),
      cellXml("D2", "f", 37500, 0, "B2*C2"),
      cellXml("E2", "n", 46265, 1),
      cellXml("F2", "n", 46265.3958333333, 2),
      cellXml("G2", "b", true),
    ],
    [
      cellXml("A3", "s", 8),
      cellXml("B3", "n", 10),
      cellXml("C3", "n", 990.5),
      cellXml("D3", "f", 9905, 0, "B3*C3"),
      cellXml("E3", "n", 46266, 1),
      cellXml("F3", "n", 0.5, 3),
      cellXml("G3", "b", false),
    ],
    [
      cellXml("A4", "s", 9),
      cellXml("B4", "e"),
      cellXml("C4", "n", -1250),
      cellXml("D4", "f", 0, 0, "B4*C4"),
      cellXml("E4", "n", 1, 1),
      cellXml("F4", "e"),
      cellXml("G4", "s", 10),
    ],
  ];

  // Deliberately not starting at A1. A range holds only the cells that were
  // used, so a sheet like this is where a viewer that reads the matrix as if it
  // began at the top left puts everything in the wrong place.
  const notes = [
    [],
    [],
    [],
    [cellXml("C4", "s", 6)],
    [cellXml("C5", "s", 11), cellXml("D5", "n", 42)],
  ];

  await writeFile(
    path.join(OUT, "sample.xlsx"),
    zipOf({
      "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="매출" sheetId="1" r:id="rId1"/><sheet name="비고" sheetId="2" r:id="rId2"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
      "xl/sharedStrings.xml": sharedStrings,
      "xl/styles.xml": styles,
      "xl/worksheets/sheet1.xml": sheetXml(sales),
      "xl/worksheets/sheet2.xml": sheetXml(notes),
    }),
  );
  console.log("  sample.xlsx");
}

if (wantHuge) {
  // The same records the small stream has, at the size the row window exists
  // for: splitting a row means running the JSON scanner over that line, so the
  // cost of the table view is paid per screenful and has to be measured.
  await writeStream(
    "huge.jsonl",
    (function* () {
      for (let i = 0; i < 2_000_000; i++) yield record(i) + "\n";
    })(),
  );

  // Same shape as a real export: wide enough that columns matter, long enough
  // that nothing but a windowed grid can show it.
  const COLUMNS = 12;
  const ROWS = 4_000_000;
  await writeStream("huge.csv", (function* () {
    yield Array.from({ length: COLUMNS }, (_, c) => `col_${c}`).join(",") + "\n";
    let buffer = "";
    for (let i = 0; i < ROWS; i++) {
      buffer += `${i},항목 ${i},item-${i},${i % 7},${(i * 37) % 1000},"쉼표, 포함",${i % 2},x,y,z,${i * 3},끝\n`;
      if (buffer.length > 1 << 20) {
        yield buffer;
        buffer = "";
      }
    }
    if (buffer) yield buffer;
  })());

  // The XML scanner has its own throughput to answer for, and markup costs far
  // more nodes per byte than JSON does.
  await writeStream("huge.xml", (function* () {
    yield '<?xml version="1.0" encoding="UTF-8"?>\n<catalog>\n';
    let buffer = "";
    for (let i = 0; i < 1_500_000; i++) {
      buffer +=
        `  <item id="i${i}" kind="${i % 5}">` +
        `<name>항목 ${i}</name><slug>item-${i}</slug>` +
        `<score>${(i * 37) % 1000}</score><note>a &amp; b</note>` +
        `</item>\n`;
      if (buffer.length > 1 << 20) {
        yield buffer;
        buffer = "";
      }
    }
    if (buffer) yield buffer;
    yield "</catalog>\n";
  })());

  // The one the checkpoint index exists for. Written in a single recursive
  // INSERT: three million round trips through the prepared-statement API would
  // take minutes, and the whole point of this file is that it finishes.
  {
    const { DatabaseSync } = await import("node:sqlite");
    const file = path.join(OUT, "huge.sqlite");
    await rm(file, { force: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = OFF");
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        at TEXT,
        level TEXT,
        source TEXT,
        message TEXT,
        payload BLOB
      );
      INSERT INTO events
        WITH RECURSIVE counter(i) AS (
          SELECT 1 UNION ALL SELECT i + 1 FROM counter WHERE i < 3000000
        )
        SELECT i,
               '2026-08-30T01:02:' || printf('%02d', i % 60) || 'Z',
               CASE i % 7 WHEN 0 THEN 'ERROR' WHEN 3 THEN 'WARN' ELSE 'INFO' END,
               'service-' || (i % 20),
               'event number ' || i || ' with some words after it',
               randomblob(24)
        FROM counter;
    `);
    db.close();
    console.log("  huge.sqlite");
  }

  // A workbook at the size the 64MB ceiling exists for. Shared strings are the
  // point: every repeat of a name is one index on disk and a whole string in
  // memory, which is why a modest file is not modest once open.
  {
    const ROWS = 250_000;
    const names = ["가나다 상사", "라마바 유통", "사아자 물산", "O'Brien & Co", "Björn Handels"];
    const strings = ["거래처", "수량", "단가", "합계", "등록일", "비고", ...names, "정상", "보류"];
    const index = new Map(strings.map((s, i) => [s, i]));

    const head = [0, 1, 2, 3, 4, 5]
      .map((i, c) => cellXml(`${"ABCDEF"[c]}1`, "s", i))
      .join("");
    const body = [];
    for (let r = 0; r < ROWS; r += 1) {
      const row = r + 2;
      const name = names[r % names.length];
      body.push(
        `<row r="${row}">` +
          cellXml(`A${row}`, "s", index.get(name)) +
          cellXml(`B${row}`, "n", (r % 97) + 1) +
          cellXml(`C${row}`, "n", Math.round(r * 13.7) / 10) +
          cellXml(`D${row}`, "f", Math.round(r * 13.7 * ((r % 97) + 1)) / 10, 0, `B${row}*C${row}`) +
          cellXml(`E${row}`, "n", 46265 + (r % 365), 1) +
          cellXml(`F${row}`, "s", index.get(r % 3 === 0 ? "보류" : "정상")) +
          "</row>",
      );
    }

    const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${head}</row>${body.join("")}</sheetData></worksheet>`;

    const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings
      .map((s) => `<si><t xml:space="preserve">${xmlEscape(s)}</t></si>`)
      .join("")}</sst>`;

    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" xfId="0"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`;

    await writeFile(
      path.join(OUT, "huge.xlsx"),
      zipOf({
        "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
        "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="거래" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        "xl/sharedStrings.xml": shared,
        "xl/styles.xml": styles,
        "xl/worksheets/sheet1.xml": sheet,
      }),
    );
    const size = (await import("node:fs")).statSync(path.join(OUT, "huge.xlsx")).size;
    console.log(`  huge.xlsx  ${(size / 1048576).toFixed(1)}MB, ${ROWS} rows`);
  }
}


// --- archives ----------------------------------------------------------------
// The three shapes an archive reader has to get right, and none of them is what
// a zip library's defaults produce: names in a code page with nothing saying
// which, the zip64 end record, and the flag that says an entry is locked. The
// writer below is `zipOf` with those three things exposed.

/**
 * A zip from a list of `{ name, body, flags, utf8 }`.
 *
 * `name` may be a Buffer, which is the whole point: a name written by a Korean
 * Windows machine is CP949 bytes, and a string would be UTF-8 before it ever
 * reached here. `zip64` writes the end record in its 64-bit form — the values
 * still fit in the classic one, which is exactly what makes it a test of the
 * parser rather than of the arithmetic.
 */
const { gzipSync } = await import("node:zlib");

function archiveOf(entries, { zip64 = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  let centralSize = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body ?? "", "utf8");
    const body = deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    // Bit 11 says the name is UTF-8. Left off by default here, because the
    // archives worth testing are the ones that do not set it.
    const flags = (entry.flags ?? 0) | (entry.utf8 ? 0x800 : 0);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    locals.push(header, nameBytes, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(0, 12);
    record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    centralSize += record.length + nameBytes.length;
    offset += header.length + nameBytes.length + body.length;
  }

  const parts = [...locals, ...central];

  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4); // size of the rest of this record
    record.writeUInt16LE(45, 12); // made by
    record.writeUInt16LE(45, 14); // needed
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(centralSize), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);

    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + centralSize), 8);
    locator.writeUInt32LE(1, 16); // total disks
    parts.push(record, locator);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  // The classic record's fields are the escape values when a zip64 one is
  // present: the real numbers are only in the record above.
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : centralSize, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  parts.push(end);

  return Buffer.concat(parts);
}

const nested = archiveOf([
  { name: "inner/deep.json", body: JSON.stringify({ depth: 2, note: "안쪽 문서" }, null, 2), utf8: true },
  { name: "inner/notes.md", body: "# 안쪽\n\n압축 안의 압축입니다.\n", utf8: true },
]);

await writeFile(
  path.join(OUT, "archive.zip"),
  archiveOf([
    { name: "report.json", body: JSON.stringify({ ok: true, rows: [1, 2, 3] }, null, 2), utf8: true },
    { name: "logs/app.log", body: Array.from({ length: 40 }, (_, i) => `2026-08-31 12:00:${String(i).padStart(2, "0")} INFO  line ${i}`).join("\n") + "\n", utf8: true },
    { name: "docs/readme.md", body: "# 압축 안의 문서\n\n항목을 고르면 새 탭으로 열립니다.\n", utf8: true },
    { name: "data/sales.csv", body: "지역,매출\n서울,120\n부산,80\n", utf8: true },
    // A `.gz` inside a zip: two layers of compression, which the open pipeline
    // already undoes in the right order without anything new.
    { name: "logs/old.log.gz", body: gzipSync(Buffer.from("2026-08-30 archived line\n")), utf8: true },
    { name: "inner.zip", body: nested, utf8: true },
    // Only the flag, not real encryption — what is under test is that the list
    // marks it and the open refuses it, neither of which reads the body.
    { name: "secret.txt", body: "not actually encrypted", flags: 1, utf8: true },
  ]),
);
console.log("  archive.zip");

// Names in CP949 with no flag to say so — a zip from a Korean Windows machine.
// Read as CP437 every one of these comes out as line-drawing characters.
//
// The bytes are written out rather than encoded, because Node has no CP949
// encoder and this script takes no dependencies. Each key says what it spells.
const CP949 = {
  "보고서.json": [0xba, 0xb8, 0xb0, 0xed, 0xbc, 0xad, 0x2e, 0x6a, 0x73, 0x6f, 0x6e],
  "자료/매출.csv": [0xc0, 0xda, 0xb7, 0xe1, 0x2f, 0xb8, 0xc5, 0xc3, 0xe2, 0x2e, 0x63, 0x73, 0x76],
  "읽어보기.txt": [0xc0, 0xd0, 0xbe, 0xee, 0xba, 0xb8, 0xb1, 0xe2, 0x2e, 0x74, 0x78, 0x74],
};
await writeFile(
  path.join(OUT, "korean-names.zip"),
  archiveOf([
    { name: Buffer.from(CP949["보고서.json"]), body: '{"제목":"분기 보고"}' },
    { name: Buffer.from(CP949["자료/매출.csv"]), body: "지역,매출\n서울,120\n" },
    { name: Buffer.from(CP949["읽어보기.txt"]), body: "안녕하세요.\n" },
  ]),
);
console.log("  korean-names.zip");

// One document in an archive is a wrapper rather than a choice, so opening this
// lands straight on the JSON and the list is never drawn.
await writeFile(
  path.join(OUT, "single.zip"),
  archiveOf([
    { name: "only/report.json", body: JSON.stringify({ unwrapped: true }, null, 2), utf8: true },
  ]),
);
console.log("  single.zip");

// And the other side of that: one document, refused. The unwrap cannot happen,
// so the list is what appears — with a banner saying why it is there at all,
// which is the part that would otherwise look like an ordinary one-row archive.
await writeFile(
  path.join(OUT, "single-locked.zip"),
  archiveOf([{ name: "only/secret.txt", body: "not actually encrypted", flags: 1, utf8: true }]),
);
console.log("  single-locked.zip");

// Small, but written with the zip64 end record. A reader that only knows the
// classic one finds 0xFFFF entries where there are two.
await writeFile(
  path.join(OUT, "zip64.zip"),
  archiveOf(
    [
      { name: "first.json", body: '{"a":1}', utf8: true },
      { name: "second.txt", body: "second\n", utf8: true },
    ],
    { zip64: true },
  ),
);
console.log("  zip64.zip");

console.log("완료");
