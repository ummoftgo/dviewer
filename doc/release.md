# 빌드와 배포

← [README](../README.md)

`.github/workflows/build.yml` 하나가 두 가지 일을 합니다.

| 계기 | 하는 일 |
| --- | --- |
| main 푸시 · PR | 테스트만. Linux·macOS·Windows 세 러너에서 `cargo test`, 타입 체크와 프런트엔드 빌드는 Linux에서 한 번 |
| `v*` 태그 | 테스트 후 세 OS 번들을 만들고 **초안 릴리스**에 붙임 |
| 수동 실행 | 기본은 테스트만. `bundle` 입력을 켜면 릴리스 없이 번들만 만들어 아티팩트로 남김 |

main에서 번들을 만들지 않는 대신 테스트는 세 OS 모두에서 돌립니다. Linux에서만 돌리면 Windows나 macOS에서만 깨지는 변경을 태그를 밀 때까지 모릅니다.

### 산출물

OS마다 설치본과 포터블을 함께 냅니다.

| | 설치본 | 포터블 |
| --- | --- | --- |
| Windows x64 | `_setup.exe` (NSIS), `.msi` | `_portable.zip` — 푼 뒤 `dviewer.exe` 실행 |
| macOS universal | `.dmg` | `_portable.zip` — 푼 뒤 `dviewer.app` 실행 |
| Linux x86_64 | `.deb`, `.rpm` | `.AppImage` — `chmod +x` 후 실행 |

macOS는 `universal-apple-darwin` 하나로 Apple Silicon과 Intel을 모두 덮습니다. Linux는 `ubuntu-22.04` 에서 빌드합니다 — glibc는 위로만 호환되므로 빌드에 쓴 배포판이 실행 가능한 가장 낮은 배포판을 정합니다.

포터블 압축은 OS마다 다른 도구를 씁니다. macOS는 `zip` 이 아니라 `ditto` 인데, `.app` 은 심볼릭 링크와 실행 권한을 가진 디렉터리라 일반 zip으로 감으면 푼 쪽이 실행되지 않습니다. Windows 포터블은 파일 하나입니다 — 프런트엔드가 실행 파일 안에 들어가 있고 옆에 딸려 나가는 것이 없습니다.

포터블은 "설치가 필요 없다"는 뜻이지 "흔적을 남기지 않는다"는 뜻은 아닙니다. 설정은 `tauri-plugin-store` 를 통해 OS의 설정 디렉터리에 그대로 저장됩니다.

### 제약

**서명은 하지 않습니다.** macOS는 처음 열 때 우클릭 → 열기, Windows는 SmartScreen에서 추가 정보 → 실행이 필요합니다. macOS를 제대로 배포하려면 Apple Developer ID를 받아 `APPLE_CERTIFICATE`·`APPLE_SIGNING_IDENTITY`·`APPLE_ID`·`APPLE_PASSWORD`·`APPLE_TEAM_ID` 시크릿을 넣으면 공증까지 처리됩니다.

Windows 포터블은 WebView2 런타임이 시스템에 있어야 합니다. Windows 11에는 기본 포함이고 Windows 10도 대부분 Edge와 함께 들어와 있지만, 없는 환경이 걱정되면 설치본을 쓰거나 `webviewInstallMode` 를 `fixedRuntime` 으로 바꿔 런타임을 동봉하면 됩니다.

Linux ARM(aarch64)은 아직 없습니다. 크로스 컴파일보다 ARM 러너를 한 줄 추가하는 편이 낫습니다.

이식성 면에서 이 코드에는 플랫폼 분기가 없습니다. 경로 구분자는 양쪽을 모두 받고, CSP는 asset 프로토콜의 두 형태(`asset:` 와 `http://asset.localhost`)를 모두 허용하며, 글꼴 열거는 `fontdb` 가 OS별 디렉터리를 알아서 찾습니다.


## 저장소에 들어가는 것

코드와 문서(README와 `doc/`)만 넣습니다. `.gitignore` 가 빼는 것들:

- `node_modules/`, `dist/`, `src-tauri/target/` — 설치·빌드 산출물
- `fixtures/` — `scripts/gen-fixtures.mjs` 가 만드는 검증용 데이터. `huge.json` 하나가 500MB 남짓이라 커밋하지 않고 필요할 때 다시 만듭니다
- `.claude/`, `.agent-works/`, `plans/` — 에이전트·계획 문서
- `.vscode/` — 편집기 설정

`.gitattributes` 는 줄바꿈을 LF로 고정합니다. 없으면 Windows에서 체크아웃할 때 전부 CRLF로 바뀌어, 다음 커밋에 트리 전체가 변경된 것으로 잡힙니다.

`package-lock.json` 과 `src-tauri/Cargo.lock` 은 **넣습니다**. 애플리케이션이라 빌드가 재현돼야 합니다.

