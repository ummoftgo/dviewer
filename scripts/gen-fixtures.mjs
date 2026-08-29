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
import { mkdir, writeFile } from "node:fs/promises";
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

if (wantHuge) {
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
}

console.log("완료");
