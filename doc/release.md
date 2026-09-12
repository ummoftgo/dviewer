# 빌드와 배포

← [README](../README.md)

`.github/workflows/build.yml`이 테스트·캐시 예열·번들·초안 릴리스를 맡습니다.

| 계기 | 하는 일 |
| --- | --- |
| main 푸시 | 세 OS 테스트와 `warm`을 병렬 실행. warm은 번들 없이 release 앱·Parquet 예제를 빌드해 캐시를 예열하고, Linux에서 release 스모크도 실행 |
| PR | 테스트만. 세 러너에서 픽스처를 만든 뒤 `cargo test`(부재를 실패로 치는 `DVIEWER_FIXTURES=required` 로), 타입 체크와 프런트엔드 빌드는 Linux에서 한 번 |
| `v*` 태그 | 테스트와 세 OS 번들을 병렬 실행하고, 둘 다 성공하면 산출물을 **초안 릴리스**에 붙임 |
| 수동 실행 | 기본은 테스트만. `bundle` 입력을 켜면 릴리스 없이 번들만 만들어 아티팩트로 남김 |

잡 그래프는 main에서 `test ∥ warm`, 태그에서 `test ∥ bundle → release`입니다. warm을 기다리는 잡은 없습니다. 서로 다른 태그의 캐시는 직접 공유되지 않지만 태그 빌드는 기본 브랜치 main의 캐시를 복원할 수 있습니다. warm과 bundle은 같은 `shared-key: bundle-<slug>`를 사용해 Rust 의존성 빌드를 재사용합니다. warm Linux는 이미 만든 release 바이너리를 Xvfb·D-Bus 세션에서 실행해 WebKit 검사를 태그 전에 확인하는 자리입니다. `cache-on-failure: true`는 스모크 실패 때도 캐시 저장 후처리를 실행하도록 하지만, concurrency 취소나 저장 실패까지 캐시 보존을 보장하지는 않습니다.

main에서 번들을 만들지 않는 대신 테스트는 세 OS 모두에서 돌립니다. Linux에서만 돌리면 Windows나 macOS에서만 깨지는 변경을 태그를 밀 때까지 모릅니다. 픽스처를 거기서 만드는 이유는 [검증](verification.md) 의 CI 절에 있습니다 — 그것 없이는 열한 개가 무언가를 단언하지 않은 채 초록이었습니다.

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

업데이트용 minisign 서명과 OS 코드 서명은 별개입니다. Windows Authenticode·macOS Developer ID 공증은 하지 않으며 macOS는 애드혹 서명입니다. macOS는 처음 열 때 우클릭 → 열기, Windows는 SmartScreen에서 추가 정보 → 실행이 필요할 수 있습니다. macOS를 공증하려면 Apple Developer ID를 받아 `APPLE_CERTIFICATE`·`APPLE_SIGNING_IDENTITY`·`APPLE_ID`·`APPLE_PASSWORD`·`APPLE_TEAM_ID` 시크릿을 설정합니다.

Windows 포터블은 WebView2 런타임이 시스템에 있어야 합니다. Windows 11에는 기본 포함이고 Windows 10도 대부분 Edge와 함께 들어와 있지만, 없는 환경이 걱정되면 설치본을 쓰거나 `webviewInstallMode` 를 `fixedRuntime` 으로 바꿔 런타임을 동봉하면 됩니다.

Linux ARM(aarch64)은 아직 없습니다. 크로스 컴파일보다 ARM 러너를 한 줄 추가하는 편이 낫습니다.

문서 경로 구분자는 양쪽을 모두 받고, CSP는 asset 프로토콜의 두 형태(`asset:` 와 `http://asset.localhost`)를 모두 허용하며, 글꼴 열거는 `fontdb`가 OS별 디렉터리를 알아서 찾습니다. 자기 갱신 설치 코드는 실제 시험한 Windows x64 포터블·NSIS에만 있습니다. MSI·macOS·AppImage·deb/rpm은 알림과 릴리스 링크만 제공합니다.

## 업데이트 릴리스 절차

배포 키 생성·시크릿 등록·공개키 커밋·태그·공개는 사용자가 맡는다. 다음은 PowerShell 명령이며 구현 검증에서 실행한 것은 격리 시험키 생성뿐이다.

```powershell
New-Item -ItemType Directory -Force "$HOME/.tauri" | Out-Null
npm run tauri -- signer generate -w "$HOME/.tauri/dviewer.key"
Get-Content -Raw "$HOME/.tauri/dviewer.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY -R ummoftgo/dviewer
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R ummoftgo/dviewer
Get-Content -Raw "$HOME/.tauri/dviewer.key.pub"
```

마지막 명령의 공개키 **내용**을 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다. 개인키는 저장소에 넣지 않고 별도로 백업한다. v0.14.0 부터 이 필드에 공개키가 들어 있다(키 ID `3AF6FA7C02D64C69`). 이 필드가 비어 있으면 앱은 업데이트 확인을 시작하지 않는다. 태그 빌드는 공개키·비밀키 누락 또는 태그/앱 버전 불일치 때 실패한다. 암호가 없는 키는 암호 시크릿을 비워 둔다.

일반 개발·PR·수동 번들은 서명 자산 생성을 끈다. 태그 빌드만 별도 설정을 합쳐 `createUpdaterArtifacts: true`와 시크릿을 전달한다. NSIS·MSI·AppImage와 macOS `.app.tar.gz`의 `.sig`를 수집하고, Windows 포터블 exe 자체를 별도 자산으로 복사해 서명한다. 포터블 ZIP은 기존 배포용으로 유지한다.

`scripts/updater-manifest.mjs`가 형태별 자산의 존재·크기·서명 형식을 검사해 `latest.json`을 만들고 CI가 이 파일에도 서명해 `latest.json.sig`를 올린다. 플랫폼 키는 Windows 형태별 3개, macOS 두 아키텍처, Linux x86_64다. macOS 두 키는 같은 universal 아카이브를 가리킨다. `notes`는 비워 두므로 앱은 릴리스 페이지 링크를 제공한다. 나중에 노트를 매니페스트에 넣으면 매니페스트를 다시 서명해야 한다.

릴리스 전에 [Windows 끝까지 시험](verification.md#업데이트-끝까지-시험)을 반복한다. 초안 자산은 고정 개수로 판정하지 않고, 매니페스트가 참조하는 모든 파일과 서명 및 `latest.json.sig`가 있는지 검사한다. 내려받은 자산 폴더에 `node scripts/updater-manifest.mjs <폴더> <태그>`를 실행하면 참조 검사를 반복할 수 있다(로컬 매니페스트를 재생성하므로 공개할 때는 다시 서명한다). 릴리스 공개 시 `gh release edit <태그> --draft=false --latest -R ummoftgo/dviewer`로 최신 릴리스임을 명시한다. `releases/latest/download/latest.json`과 `.sig`가 그 릴리스의 자산을 반환하는지 확인한다.


## 저장소에 들어가는 것

코드와 문서(README와 `doc/`)만 넣습니다. `.gitignore` 가 빼는 것들:

- `node_modules/`, `dist/`, `src-tauri/target/` — 설치·빌드 산출물
- `fixtures/` — `scripts/gen-fixtures.mjs` 가 만드는 검증용 데이터. `huge.json` 하나가 500MB 남짓이라 커밋하지 않고 필요할 때 다시 만듭니다
- `.claude/`, `.agent-works/`, `plans/` — 에이전트·계획 문서
- `.vscode/` — 편집기 설정

`.gitattributes` 는 줄바꿈을 LF로 고정합니다. 없으면 Windows에서 체크아웃할 때 전부 CRLF로 바뀌어, 다음 커밋에 트리 전체가 변경된 것으로 잡힙니다.

`package-lock.json` 과 `src-tauri/Cargo.lock` 은 **넣습니다**. 애플리케이션이라 빌드가 재현돼야 합니다.
