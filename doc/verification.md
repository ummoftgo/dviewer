# 검증과 성능

← [README](../README.md)

```bash
cd src-tauri && cargo test          # 184개: 스캐너 둘, 가시성, 검색, 변환, 표, 인코딩, 판별, 표시/복사, 정화
```

성능은 창 없이 직접 잽니다:

```bash
node scripts/gen-fixtures.mjs --huge
cd src-tauri
cargo run --release --example scan  -- ../fixtures/huge.json "needle:"
cargo run --release --example scan  -- ../fixtures/huge.xml  "항목 1499999"
cargo run --release --example table -- ../fixtures/huge.csv  "항목 3999999"
```

이 저장소를 만든 기계(Windows 11)에서:

| 항목 | JSON 526MB | XML 184MB | CSV 298MB |
|---|---|---|---|
| 규모 | 3,840만 노드 | 1,050만 노드 | 400만 행 × 12열 |
| 인덱싱 | 1.26초 (418 MB/s) | 0.97초 (190 MB/s) | 0.36초 (818 MB/s) |
| 인덱스 메모리 | 1.3 GB | 360 MB | 16 MB |
| 전체 펼치기 | 29ms | 7ms | — |
| 100행 조회 | 0.0ms | 0.0ms | 0.1ms |
| 본문 검색 | 1.16초 (48,000건) | 0.02초 | 0.05초 |
| 경로 검색 | 1.68초 | 0.51초 | — |

세 숫자가 서로 다른 이유가 설계를 설명합니다. CSV가 가장 빠르고 가벼운 건 레코드 시작 위치만 기록하기 때문이고(행당 4바이트), XML이 바이트당 가장 느린 건 같은 바이트 수에 노드가 훨씬 빽빽하기 때문입니다(마크업 18바이트당 노드 하나 대 JSON의 14바이트). 트리 인덱스 메모리는 파일 크기가 아니라 **노드 수**에 비례합니다(노드당 36바이트).

YAML과 TOML은 이 표에 없습니다. 파서가 값을 메모리에 만들기 때문에 64MB에서 막아 두었고, 설정 파일이 사는 크기와는 자릿수가 다릅니다.

렌더링 결과를 눈으로 확인하려면:

```bash
cd src-tauri && cargo run --release --example render -- ../fixtures/sample.md out.html
```

인코딩은 실제 바이트로 확인합니다 — `cp949.csv`, `utf16.csv`, `utf8bom.csv` 를 열면 도구 모음이 각각 EUC-KR / UTF-16 LE / UTF-8 을 표시하고 세 파일 모두 `id | 이름 | 메모` 로 읽힙니다.

`fixtures/` 에는 형식마다 까다로운 부분을 담은 표본이 있습니다 — `sample.csv`(값 안의 쉼표·따옴표·개행, 짧은 행), `semicolon.csv`(확장자와 다른 구분자), `sample.xml`(속성·CDATA·주석·이름공간·혼합 내용·빈 요소), `sample.yaml`(앵커·여러 문서·문자열 아닌 키), `sample.toml`(날짜·배열 테이블), `wide.json`(루트 배열 100만), `deep.json`(깊이 500), `stream.jsonl`, `broken.json`(중간 절단), 그리고 렌더링 기능을 한 번에 훑는 `sample.md`.

