# 의존성

← [README](../README.md)

프런트엔드와 Rust 모두 각 패키지의 **최신 버전**을 씁니다. 다만 하나는 최신이 아닙니다:

- **TypeScript는 6.x** 입니다. 7.x가 나와 있지만 `svelte-check` 최신판(4.7.6)이 `typescript: ^5 || ^6` 만 지원해서, 7로 올리면 `npm run check` 가 동작하지 않습니다. svelte-check이 7을 지원하면 함께 올리면 됩니다.

Vite 8은 번들러가 rollup에서 rolldown으로 바뀌었고 esbuild를 더 이상 동봉하지 않습니다. 그래서 `vite.config.ts` 는 미니파이어를 이름으로 지정하지 않고 불리언만 넘깁니다 — 이름을 박아 두면 릴리스마다 따라가야 합니다.

형식과 인코딩 지원이 늘면서 들어온 크레이트입니다.

| 크레이트 | 쓰임 | 고른 이유 |
| --- | --- | --- |
| `quick-xml` | XML 토크나이저 | 스트리밍 풀 파서라 DOM을 만들지 않고, 입력 슬라이스에서 직접 빌려 주므로 이름과 값의 바이트 위치를 그대로 얻습니다 |
| `serde_yaml_ng` | YAML 파싱 | `serde_yaml` 의 유지보수 포크. 매핑이 삽입 순서를 지킵니다 |
| `encoding_rs` | 인코딩 변환 | Gecko의 구현. Encoding Standard를 그대로 따르므로 브라우저가 읽는 것과 같게 읽습니다 |
| `chardetng` | 인코딩 추측 | Firefox가 레거시 웹 콘텐츠에 쓰는 판별기 |
| `toml` | TOML 파싱 | `preserve_order` 를 켜서 테이블 키 순서를 파일 그대로 유지합니다 |
| `rusqlite` | SQLite 읽기 | `bundled` 로 SQLite 자체를 동봉합니다 — 기계마다 다른 버전을 읽는 뷰어는 뜻이 없습니다. `serialize` 는 압축 파일 안과 주소의 데이터베이스를 열려고 켜습니다. `Connection::deserialize_bytes` 하나를 쓰기 위해서이고, 그것이 `SQLITE_DESERIALIZE_READONLY` 로 버퍼를 제자리에서 읽게 해 사본을 없액니다. 기능 플래그뿐이라 `Cargo.lock` 은 한 줄도 바뀌지 않습니다 |
| `calamine` | xlsx 읽기 | 순수 Rust 이고 시트를 이름만 먼저 훑을 수 있습니다. `dates` 기능을 켜서 Excel 의 일련번호를 날짜로 옮기는 일을 맡깁니다 — 1900년을 윤년으로 치는 Excel 의 오래된 버릇까지 포함해서, 직접 짜면 미묘하게 틀리기 쉬운 계산입니다 |
| `parquet` | Parquet 읽기·쓰기 | **arrow 없이** 씁니다(`default-features = false`). arrow 리더는 컬럼 배치를 만드는 모양이라 백 행을 보여주는 일과 맞지 않고, 그걸 얻자고 의존이 두 배가 됩니다. 코덱은 실무에서 쓰이는 것 전부 — `flate2-rust_backend` 는 숨은 기능인데 이미 여기 있는 백엔드라 GZIP 이 공짜이고(기본값 `flate2-zlib-rs` 는 zlib-rs 를 새로 끌어옵니다), brotli 도 이미 트리에 있습니다 |
| `zip` | 압축 파일 읽기 | **이미 트리에 있습니다** — `calamine` 이 xlsx 를 풀려고 씁니다. 직접 의존으로 적은 뒤 `Cargo.lock` 의 diff 는 `zip` 한 줄뿐이고 새 crate 는 0개입니다. 값이 0이라서 빌립니다 — 넓고 미묘한 표면(zip64, 데이터 디스크립터, CP437 이름, 암호 플래그)을 직접 쓸 이유가 없습니다. 코덱은 deflate 만: 실제 압축 파일이 쓰는 것이고, 나머지는 형식마다 압축기를 하나씩 더 끌어옵니다. (참고: `parquet` 항목의 zlib-rs 회피는 여기에 해당하지 않습니다. `calamine` 쪽 zip 이 이미 켜서 들어와 있습니다) |
| `bytes` | `ChunkReader` 구현 | 새로 들어오는 것이 아니라 `parquet` 이 이미 끌어오는 크레이트입니다. `parquet` 이 재수출하지 않아서, `get_bytes` 가 돌려줘야 하는 타입의 **이름을 적으려고** 직접 의존으로 적었습니다. `Cargo.lock` 의 새 crate 는 0개입니다 |
| `chrono` | 그 날짜를 읽기 | 새로 들어오는 것이 아니라 `calamine` 이 이미 끌어오는 크레이트입니다. 접근자를 쓰려고 직접 의존으로 적었고, 기본 기능을 끄고 `std` 만 켜서 시간대 데이터는 들어오지 않습니다 |

`calamine` 이 요구하는 Rust 하한이 1.88 이라, 저장소 전체의 하한도 거기에 맞춰졌습니다. `parquet` 은 1.85 를 요구하므로 이 하한을 올리지 않습니다.

`parquet` 을 기본 기능으로 켰을 때와 비교하면 의존 크레이트가 54개에서 41개로, 정리 후 릴리스 빌드가 24초에서 절반 아래로 줄어듭니다. 이 저장소의 트리(312개)에 **실제로 새로 들어오는 것은 16개**입니다.

CSV·TSV는 크레이트를 쓰지 않습니다. 필요한 것이 레코드의 **바이트 위치**인데 그건 파서가 내주는 값이 아니고, 따옴표를 다루는 상태 기계는 JSON 스캐너와 같은 방식으로 60줄이면 끝납니다.

취약점 점검:

```bash
npm audit
cd src-tauri && cargo audit     # cargo install cargo-audit
```

작성 시점 기준 양쪽 모두 **취약점 0건**입니다. `cargo audit` 이 남기는 19건은 전부 "미관리(unmaintained)" 또는 unsound 경고이고, 대부분 Tauri의 리눅스 백엔드가 쓰는 GTK3 바인딩이라 Windows 빌드에는 아예 컴파일되지 않습니다. 나머지(`unic-*`, `bincode`, `proc-macro-error`)도 전이 의존성이라 직접 손댈 수 없습니다.

직접 줄인 것은 하나입니다. syntect의 `yaml-load`·`plist-load` 기능을 껐습니다 — 내장 문법·테마 덤프만 쓰고 런타임에 `.sublime-syntax` 를 읽지 않으므로 필요 없고, 그 결과 미관리 크레이트 `yaml-rust` 가 컴파일 대상에서 빠집니다. `cargo audit` 은 Cargo.lock 을 훑기 때문에 경고 수는 그대로지만, 바이너리에는 들어가지 않습니다.

