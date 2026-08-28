/**
 * Generates the test documents used to verify the viewer by hand.
 *
 *   node scripts/gen-fixtures.mjs [--huge]
 *
 * `--huge` additionally writes a ~600MB JSON file, which is the case the whole
 * indexing design exists for. It is opt-in because it takes a while and eats
 * disk. Everything lands in ./fixtures, which is git-ignored.
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

console.log("완료");
