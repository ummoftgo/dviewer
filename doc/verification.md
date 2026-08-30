# 검증과 성능

← [README](../README.md)

```bash
cd src-tauri && cargo test          # 266개: 스캐너 둘, 가시성, 검색, 변환, 표, 인코딩, 판별, 표시/복사, 정화
```

성능은 창 없이 직접 잽니다:

```bash
node scripts/gen-fixtures.mjs --huge
cd src-tauri
cargo run --release --example scan  -- ../fixtures/huge.json "needle:"
cargo run --release --example scan  -- ../fixtures/huge.xml  "항목 1499999"
cargo run --release --example table -- ../fixtures/huge.csv  "항목 3999999"
cargo run --release --example table -- ../fixtures/huge.log  "id=1999999"
cargo run --release --example table -- ../fixtures/huge.jsonl "항목 1999999"
cargo run --release --example sqlite -- ../fixtures/huge.sqlite events
```

이 저장소를 만든 기계(Windows 11)에서:

| 항목 | JSON 526MB | XML 184MB | CSV 298MB | 로그 208MB | JSONL 438MB |
|---|---|---|---|---|---|
| 규모 | 3,840만 노드 | 1,050만 노드 | 400만 행 × 12열 | 200만 행 × 4열 | 200만 행 × 7열 |
| 인덱싱 | 1.26초 (418 MB/s) | 0.97초 (190 MB/s) | 0.36초 (818 MB/s) | 0.21초 (1,004 MB/s) | 0.36초 (1,234 MB/s) |
| 인덱스 메모리 | 1.3 GB | 360 MB | 16 MB | 8 MB | 8 MB |
| 전체 펼치기 | 29ms | 7ms | — | — | — |
| 100행 조회 | 0.0ms | 0.0ms | 0.1ms | 0.0ms | 0.1ms |
| 본문 검색 | 1.16초 (48,000건) | 0.02초 | 0.05초 | 0.09초 | 0.02초 |
| 경로 검색 | 1.68초 | 0.51초 | — | — | — |

숫자들이 서로 다른 이유가 설계를 설명합니다. 로그와 CSV가 가장 빠르고 가벼운 건 레코드 시작 위치만 기록하기 때문이고(행당 4바이트), 로그가 그중에서도 빠른 건 따옴표 상태를 따라갈 필요가 없어 개행만 세면 되기 때문입니다. 로그의 열은 색인을 키우지 않습니다 — 배치는 앞부분 표본에서 한 번 정해지고, 칸 나누기는 화면에 보이는 행에서만 일어납니다, XML이 바이트당 가장 느린 건 같은 바이트 수에 노드가 훨씬 빽빽하기 때문입니다(마크업 18바이트당 노드 하나 대 JSON의 14바이트). 트리 인덱스 메모리는 파일 크기가 아니라 **노드 수**에 비례합니다(노드당 36바이트).

SQLite 는 이 표에 들어가지 않습니다. 바이트를 훑지 않으니 인덱싱 속도라는 항목 자체가 없고, 재는 것이 다릅니다 — 336MB·300만 행 `events` 테이블에서:

| 항목 | 값 |
|---|---|
| 연결 | 0.7ms |
| 컬렉션 훑기 (300만 행) | 0.33초 |
| 체크포인트 색인 | 22 KB |
| 60행 조회 (0행 / 150만 / 300만) | 0.16 / 0.16 / 0.15ms |
| 같은 조회, 색인 없이 `OFFSET` | 271ms |

마지막 두 줄이 체크포인트가 산 것입니다. SQLite 는 rowid 로는 즉시 찾아가지만 "300만 번째 행"이라는 개념이 없어서, 색인이 없으면 `OFFSET 2999940` 이 앞의 300만 행을 전부 밟고 지나갑니다 — **1,800배**. 1,024행마다 rowid 하나를 적어 두면 그것이 탐색 한 번과 1,023걸음 이내로 바뀌고, 300만 행에 22KB 를 씁니다.

rowid 가 없는 것 — 뷰와 WITHOUT ROWID 테이블 — 은 적어 둘 것이 없어 저 271ms 쪽 경로를 탑니다. 앞쪽은 똑같이 빠르고 뒤로 갈수록 느려집니다.

JSONL 이 바이트당 가장 빠른 이유가 이 설계의 요약입니다. 색인은 개행만 세므로 로그와 같고, 값을 JSON 으로 읽는 일은 **화면에 있는 행에서만** 일어납니다. 100행에 0.1ms — 한 행당 1마이크로초 남짓이니, 행마다 스캐너를 도는 비용은 파일 크기와 무관하게 한 화면치입니다. 열을 알아내는 데는 앞 1MB 만 봅니다.

YAML과 TOML은 이 표에 없습니다. 파서가 값을 메모리에 만들기 때문에 64MB에서 막아 두었고, 설정 파일이 사는 크기와는 자릿수가 다릅니다.

렌더링 결과를 눈으로 확인하려면:

```bash
cd src-tauri && cargo run --release --example render -- ../fixtures/sample.md out.html
```

인코딩은 실제 바이트로 확인합니다 — `cp949.csv`, `utf16.csv`, `utf8bom.csv` 를 열면 도구 모음이 각각 EUC-KR / UTF-16 LE / UTF-8 을 표시하고 세 파일 모두 `id | 이름 | 메모` 로 읽힙니다.

`fixtures/` 에는 형식마다 까다로운 부분을 담은 표본이 있습니다 — `sample.csv`(값 안의 쉼표·따옴표·개행, 짧은 행), `semicolon.csv`(확장자와 다른 구분자), `sample.xml`(속성·CDATA·주석·이름공간·혼합 내용·빈 요소), `sample.yaml`(앵커·여러 문서·문자열 아닌 키), `sample.toml`(날짜·배열 테이블), `wide.json`(루트 배열 100만), `deep.json`(깊이 500), `stream.jsonl`(중첩 객체·배열·null 이 섞인 레코드), `broken.json`(중간 절단), `sample.jsonc`(주석·후행 쉼표·문자열 안의 주석 표시)와 그 엄격한 쌍둥이 `strict.json`, 확장자만 `.json` 인 `settings.json`, `sample.sqlite`(rowid 테이블·WITHOUT ROWID·뷰·BLOB·NULL 과 빈 문자열이 나란히), 그리고 렌더링 기능을 한 번에 훑는 `sample.md`.

