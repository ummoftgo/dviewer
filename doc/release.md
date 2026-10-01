# 빌드와 배포

← [README](../README.md)

`.github/workflows/build.yml`이 테스트·캐시 예열·번들·초안 릴리스를 맡습니다.

| 계기 | 하는 일 |
| --- | --- |
| main 푸시 | 세 OS 테스트와 `warm`을 병렬 실행. warm은 번들 없이 release 앱을 빌드해 캐시를 예열하고, 세 OS 모두 release 스모크도 실행 |
| PR | 테스트만. 세 러너에서 픽스처를 만든 뒤 `cargo test`(부재를 실패로 치는 `DVIEWER_FIXTURES=required` 로), 타입 체크와 프런트엔드 빌드는 Linux에서 한 번 |
| `v*` 태그 | 동일 SHA의 성공한 서명 리허설 산출물을 재사용해 **초안 릴리스**를 만듦. 후보가 없으면 기존처럼 세 OS test·bundle을 실행 |
| 수동 실행 | 기본은 테스트만. main에서 `bundle=true`면 세 OS 테스트·서명 번들·release 스모크를 수행하고 아티팩트로 남김. 다른 브랜치는 기존 비서명 번들 |

잡 그래프는 main에서 `test ∥ warm`, 수동 리허설에서 `test ∥ bundle`입니다. 태그는 먼저 `reuse`가 후보를 고르고, 있으면 `reuse → release`(test·bundle 생략), 없으면 `reuse → (test ∥ bundle) → release`로 진행합니다. push와 workflow_dispatch는 동시성 그룹이 달라 서로 취소하지 않습니다. 판올림 커밋을 푸시한 직후 warm을 기다리지 않고 번들 리허설(`gh workflow run build.yml --ref main -f bundle=true`)을 시작합니다. 같은 SHA의 리허설에서 세 OS test·bundle·release 스모크가 모두 성공해야 태그를 만듭니다. 같은 이벤트·ref 안에서는 이전 실행을 계속 취소합니다. 서로 다른 태그의 캐시는 직접 공유되지 않지만 태그 빌드는 기본 브랜치 main의 캐시를 복원할 수 있습니다. warm과 bundle은 같은 `shared-key: bundle-<slug>`를 사용해 Rust 의존성 빌드를 재사용합니다. warm Linux는 이미 만든 release 바이너리를 Xvfb·D-Bus 세션에서 실행하고 macOS는 universal 바이너리를 디스플레이 래퍼 없이 실행해 WebKit 검사를 태그 전에 확인합니다. warm Windows도 같은 release 바이너리로 스모크를 돕니다(약 1분). CI 러너에는 GPU가 없어 WebView2가 소프트웨어로 그리는데, v0.23.0 리허설을 멈춘 PDF 워커 경쟁은 이 환경에서만 졌습니다. 번들 잡만 Windows 스모크를 돌면 태그 직전에야 드러나므로 main 푸시마다 봅니다. `cache-on-failure: true`는 스모크 실패 때도 캐시 저장 후처리를 실행하도록 하지만, concurrency 취소나 저장 실패까지 캐시 보존을 보장하지는 않습니다.

어느 잡도 Parquet 예제를 컴파일하지 않습니다. 스모크와 `cargo test`가 읽는 `sample.parquet`·`columnar.zip`은 생성기가 `scripts/golden/`의 기준 파일을 복사합니다. 예전에는 test·warm·bundle 잡마다 이 단계가 26~133초였고, 그 재컴파일을 줄이려고 기능·`MACOSX_DEPLOYMENT_TARGET`을 tauri build와 맞추던 설정도 함께 없어졌습니다.

main에서 번들을 만들지 않는 대신 테스트는 세 OS 모두에서 돌립니다. Linux에서만 돌리면 Windows나 macOS에서만 깨지는 변경을 태그를 밀 때까지 모릅니다. 픽스처를 거기서 만드는 이유는 [검증](verification.md) 의 CI 절에 있습니다 — 그것 없이는 열한 개가 무언가를 단언하지 않은 채 초록이었습니다.

### 같은 커밋의 리허설 산출물 재사용

태그 전용 `reuse` 잡은 체크아웃된 태그의 커밋 SHA로 현재 저장소의 build.yml 실행을 조회한다. 성공한 main의 `workflow_dispatch` 실행만 대상으로 하며 세 OS test·bundle 잡 성공과 Windows `Sign portable executable` 단계 성공을 확인한다. 실행 목록 API에 dispatch 입력이 없으므로 실제 번들 잡 성공으로 `bundle=true`를 확인한다. 이전 비서명 리허설은 제외한다.

필요한 아티팩트는 `dviewer-linux-x86_64`, `dviewer-macos-universal`, `dviewer-windows-x64`다. 이름·개수·비어 있지 않은 크기·run id·SHA·만료 여부를 대조한다. 기본 보존 기간은 90일이지만 저장소 정책에 따라 달라질 수 있으므로 API의 `expired`와 `expires_at`을 확인한다. 조회 실패·후보 없음·누락·만료는 기존 test·bundle 경로로 폴백한다.

release는 `needs: [reuse, test, bundle]`를 유지하면서 명시적 조건으로 생략된 의존 잡을 처리한다. 재사용은 test·bundle이 모두 skipped일 때만, 폴백은 둘 다 success일 때만 초안을 허용하며 취소·실패 시에는 공개 작업을 하지 않는다. selector와 release에만 `actions: read`를 추가한다. 다른 실행 다운로드에는 [공식 download-artifact v4 계약](https://github.com/actions/download-artifact/blob/v4/README.md#download-artifacts-from-other-workflow-runs-or-repositories)에 따라 `run-id`와 `github-token`을 함께 전달한다. 폴백은 현재 run-id를 사용한다.

release 잡은 태그/앱 버전·서명 키를 다시 검증한 뒤 내려받은 파일로 기존 `latest.json`을 만들고 서명하여 초안에 올린다. 번들 자산은 다시 빌드하거나 서명하지 않는다. 선택 이후 아티팩트가 삭제·만료되거나 다운로드가 실패하면 초안 생성 전에 실패한다. 그 경우 태그 워크플로를 다시 실행하면 selector가 다시 조회하고 유효한 후보가 없을 때 번들 폴백을 수행한다.

새 workflow를 main에 반영한 뒤 실제 `bundle=true` 리허설을 한 번 실행해 세 OS 서명 자산을 확인한다. 태그의 재사용 경로는 이후 실제 릴리스에서 처음 검증하며 가짜 태그는 만들지 않는다. 로컬 YAML·분기 검사만으로 CI의 권한·스킵 전파·아티팩트 다운로드까지 성공했다고 간주하지 않는다.

절차의 목표는 약 40분에서 약 20분(리허설 15분·태그 2분·로컬 확인과 검증 3분)으로 줄이는 것이다. 이는 계획상의 예상이며 새 경로의 실측은 아니다. 2026-09-15의 성공한 v0.22.0 실행은 main 푸시 7분 2초, 리허설 8분 28초, 태그 8분 31초였다. 실행 대기·캐시·서명 자산 크기에 따라 달라지므로, 반영 후 리허설과 실제 태그 시간을 다시 기록한다.

### 산출물

OS마다 설치본과 포터블을 함께 냅니다.

| | 설치본 | 포터블 |
| --- | --- | --- |
| Windows x64 | `_setup.exe` (NSIS), `.msi` | `_portable.zip` — 푼 뒤 `dviewer.exe` 실행 |
| macOS universal | `.dmg` | `_portable.zip` — 푼 뒤 `dviewer.app` 실행 |
| Linux x86_64 | `.deb`, `.rpm` | `.AppImage` — `chmod +x` 후 실행 |

macOS는 `universal-apple-darwin` 하나로 Apple Silicon과 Intel을 모두 덮습니다. Linux는 `ubuntu-22.04` 에서 빌드합니다 — glibc는 위로만 호환되므로 빌드에 쓴 배포판이 실행 가능한 가장 낮은 배포판을 정합니다.

제3자 고지 `THIRD-PARTY-NOTICES.md` 는 `npm run build` 의 마지막 단계(`scripts/notices.mjs`)가 `dist/` 에 만들어 실행 파일에 싣습니다. 내용은 dviewer 의 MIT LICENSE, 패키지 목록이 설명하지 못하는 구성요소의 정적 표(`notices/static.md`: KaTeX 글꼴 OFL·zstd·SQLite·WebView2 로더), PDF.js 가 싣는 라이선스 파일, cargo-about 이 만든 Rust 크레이트 절, Vite 플러그인이 번들 모듈 그래프에서 찾은 npm 패키지 절입니다. cargo-about 은 별도 도구입니다. CI 의 warm·번들 잡은 `taiki-e/install-action` 으로 0.9.2 를 설치하고 `DVIEWER_NOTICES=required` 로 빌드하므로 도구가 없거나 허용 목록(`notices/about.toml`) 밖의 라이선스가 들어오면 빌드가 실패합니다. 로컬에서는 도구가 없어도 빌드는 되고 Rust 절만 "생성되지 않음"으로 남습니다. 스모크는 Rust 절을 확인하므로 로컬 스모크에는 cargo-about 이 필요합니다(`cargo install --locked cargo-about` 또는 릴리스 바이너리). 고지 단계는 로컬에서 약 7초입니다.

`.rpm` 은 xz 레벨 3으로 압축합니다(`bundle.linux.rpm.compression`). tauri-bundler 2.9.4의 기본은 gzip 6인데, v0.23.0 리허설에서 rpm 한 개에 47초가 걸렸습니다. 같은 43.8MB 바이너리를 gzip 6으로 압축만 하면 로컬에서 1.0초이니, 시간은 압축이 아니라 번들러가 쓰는 `rpm` 0.16.1 크레이트의 `Sha256Writer`에서 나옵니다. 이 writer는 받은 버퍼를 통째로 해시한 뒤 압축기에 넘기는데, 압축기가 일부만 받으면 `write_all`이 나머지로 다시 부르고 그때마다 남은 전체를 또 해시합니다. 출력 버퍼만큼만 받는 gzip·zstd에서는 해시량이 제곱으로 늘고, 입력을 거의 한 번에 받는 xz에서는 늘지 않습니다. 최신 `rpm` 크레이트(0.28)에는 이 writer가 없지만 번들러가 0.16에 묶여 있습니다. 로컬 실측(tauri-cli와 같은 `opt-level="s"` + LTO)은 gzip 6이 23.0초·17.6MB, zstd 10이 14.0초·16.0MB, xz 3이 5.3초·15.0MB, xz 6이 9.9초·14.2MB였습니다. 가지 리허설(run 36292723684)에서 rpm 단계는 47.5초에서 9.1초로, 크기는 17,983,664바이트에서 14,979,733바이트로 줄었습니다. xz 페이로드는 rpm 4.7(2009)부터 읽으므로 호환이 좁아지지 않습니다. zstd는 `rpmlib(PayloadIsZstd)`를 요구해 rpm 4.14 미만을 거절합니다.

AppImage는 linuxdeploy(gtk 플러그인)와 appimagetool(mksquashfs, 기본 zstd)이 만듭니다. 가지 리허설에서 `--verbose`로 linuxdeploy 줄을 받아 나눠 보니 92.9초 가운데 gtk 플러그인이 66.7초로 가장 컸습니다. 그 안에는 저작권 파일 조회(`dpkg-query`) 454건에 약 28초와, rpath 설정 사이에 로그 없이 비는 21.9초가 있었습니다. linuxdeploy 본체의 의존성 배치는 13.1초, mksquashfs를 포함한 출력 플러그인 전체는 9.5초, strip은 라이브러리당 약 2ms였습니다. 그래서 압축 방식(`LDAI_COMP`)과 `NO_STRIP`은 바꾸지 않습니다. 줄일 수 있는 것이 몇 초 안쪽입니다. 저작권 조회를 끄는 `DISABLE_COPYRIGHT_FILES_DEPLOYMENT`도 쓰지 않습니다. AppImage가 glib·gtk 등 LGPL 라이브러리를 함께 배포하므로 고지를 빼는 쪽으로 가지 않습니다.

**알려진 문제:** AppImage의 라이브러리 저작권 고지는 불완전합니다. linuxdeploy가 `/lib/x86_64-linux-gnu`로 찾은 라이브러리를 `dpkg-query`로 조회하면 패키지가 `/usr/lib` 경로로 등록되어 있어 찾지 못합니다. 그래서 webkit2gtk·gtk3 등 419건은 빠지고 약 12개 패키지(glib·pango·gdk-pixbuf·librsvg 등)의 저작권 파일 28개만 들어갑니다. 제3자 고지를 따로 만들어 싣는 것은 별도 후보입니다.

포터블 압축은 OS마다 다른 도구를 씁니다. macOS는 `zip` 이 아니라 `ditto` 인데, `.app` 은 심볼릭 링크와 실행 권한을 가진 디렉터리라 일반 zip으로 감으면 푼 쪽이 실행되지 않습니다. Windows 포터블은 파일 하나입니다 — 프런트엔드가 실행 파일 안에 들어가 있고 옆에 딸려 나가는 것이 없습니다.

포터블은 "설치가 필요 없다"는 뜻이지 "흔적을 남기지 않는다"는 뜻은 아닙니다. 설정은 `tauri-plugin-store` 를 통해 OS의 설정 디렉터리에 그대로 저장됩니다.

### 제약

업데이트용 minisign 서명과 OS 코드 서명은 별개입니다. Windows Authenticode·macOS Developer ID 공증은 하지 않으며 macOS는 애드혹 서명입니다. macOS는 처음 열 때 우클릭 → 열기, Windows는 SmartScreen에서 추가 정보 → 실행이 필요할 수 있습니다. macOS를 공증하려면 Apple Developer ID를 받아 `APPLE_CERTIFICATE`·`APPLE_SIGNING_IDENTITY`·`APPLE_ID`·`APPLE_PASSWORD`·`APPLE_TEAM_ID` 시크릿을 설정합니다.

Windows 포터블은 WebView2 런타임이 시스템에 있어야 합니다. Windows 11에는 기본 포함이고 Windows 10도 대부분 Edge와 함께 들어와 있지만, 없는 환경이 걱정되면 설치본을 쓰거나 `webviewInstallMode` 를 `fixedRuntime` 으로 바꿔 런타임을 동봉하면 됩니다.

Linux ARM(aarch64)은 아직 없습니다. 크로스 컴파일보다 ARM 러너를 한 줄 추가하는 편이 낫습니다.

문서 경로 구분자는 양쪽을 모두 받고, CSP는 asset 프로토콜의 두 형태(`asset:` 와 `http://asset.localhost`)를 모두 허용하며, 글꼴 열거는 `fontdb`가 OS별 디렉터리를 알아서 찾습니다. 자기 갱신 설치 코드는 실제 시험한 Windows x64 포터블·NSIS에만 있습니다. MSI·macOS·AppImage·deb/rpm은 알림과 릴리스 링크만 제공합니다.

## 업데이트 릴리스 절차

릴리스 때 로컬 스모크는 최신 프런트·바이너리로 debug 한 번만 실행한다. release 스모크는 같은 대상 SHA의 리허설이 세 OS에서 수행한다. 기능 구현 단계의 필수 검증을 생략한다는 뜻은 아니다.

판올림은 package.json·package-lock.json·src-tauri/tauri.conf.json·src-tauri/Cargo.toml을 맞춘 뒤 src-tauri에서 `cargo update -p dviewer --offline`으로 Cargo.lock의 자기 패키지 버전을 갱신한다. 이 명령은 빌드나 테스트가 아니며 `git diff -- Cargo.lock`으로 의존 패키지 변경 없이 자기 버전만 바뀌었는지 확인한다. 판올림 직후의 중복 cargo test 대신 리허설의 required 테스트를 사용한다.

순서는 **로컬 debug 확인 → 판올림 커밋·푸시 → 즉시 리허설 → 같은 SHA의 세 OS test·bundle·smoke 초록 확인 → 태그 → 태그 실행(유효한 리허설 아티팩트 재사용) → 초안 검증·공개**다. warm 완료를 따로 기다리지 않는다. 리허설 도중 main이 바뀌면 새 대상 SHA로 다시 확인한다. 성공 상태만 보지 말고 번들 잡이 건너뛰지 않았는지와 head SHA도 확인한다.

CI 전용 실패는 관측 커밋을 먼저 넣는다. 두 바퀴의 진단·재현 안에 원인이 잡히지 않으면 그 기능을 릴리스에서 빼고 관문을 다시 검증한다.

PDF 초기 CSS 순서의 두 번째 진단은 수동 실행의 `pdf_startup_repro=true`로만 선택한다. Linux test 잡이 먼저 기존 release full smoke를 그대로 통과한 뒤, 같은 바이너리로 `scripts/pdf-startup-repro.mjs`를 실행한다. 서명·번들·권한·태그 흐름은 바꾸지 않는다. 두 PDF 각각 새 프로세스에서 HTML 대조군→대상 PDF 순서를 유지하고 CSS 무지연 helper·CSS 1초 지연·viewer.mjs 1초 지연을 한 번씩, 합계 여섯 조건만 비교한다. 별도 `pdf-startup-experiment-linux` 아티팩트에 SHA·바이너리 해시·환경·원본 결과/trace·판정을 남긴다. 재현된 앱 오류는 원본 프로세스 종료 코드와 ok:false를 보존하고 실험 runner가 exit1로 보고한다. 잠긴 Linux Tauri 런타임은 실패 종료 요청도 OS exit0이 될 수 있어, 이 불일치를 따로 남기되 완전한 결과 행·summary의 실패를 우선한다. 하네스/주입 불성립은 exit2로 남기며 성공으로 덮지 않는다. exit0의 뜻도 제한된 실험에서 미재현일 뿐 해결이 아니다.

주입은 실제 `SmokeRun`과 명시적 `DVIEWER_PDF_STARTUP_REPRO=css-control|css-delay|module-delay`가 모두 있을 때, 인증된 PDF 경로의 GET/200 고정 자원 한 응답에만 적용한다. 일반 서버의 단일 스레드는 유지하며 실험 helper 하나는 종료 전 join한다. helper는 single-writer 서버 건강 상태를 쓰지 않고 별도 fault trace를 쓴다. 따라서 선택된 응답은 기존 기록에서 response-built에 머물며 실제 응답 경계는 fault trace로 읽어야 한다. 같은 HTTP 연결의 pipelining은 응답 순서를 다시 묶을 수 있어 native trace에서 실제 역전이 성립했는지 확인해야 한다. 초기 오류 뒤 iframe 제거로 지연 CSS가 취소된 경우도 원인과 후속 취소를 구분한다. 첫 PDF의 제한된 성공 초기화 표본도 이 명시적 실험에서만 수집한다.

배포 키 생성·시크릿 등록·공개키 커밋·태그·공개는 사용자가 맡는다. 다음은 PowerShell 명령이며 구현 검증에서 실행한 것은 격리 시험키 생성뿐이다.

```powershell
New-Item -ItemType Directory -Force "$HOME/.tauri" | Out-Null
npm run tauri -- signer generate -w "$HOME/.tauri/dviewer.key"
Get-Content -Raw "$HOME/.tauri/dviewer.key" | gh secret set TAURI_SIGNING_PRIVATE_KEY -R ummoftgo/dviewer
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R ummoftgo/dviewer
Get-Content -Raw "$HOME/.tauri/dviewer.key.pub"
```

마지막 명령의 공개키 **내용**을 `src-tauri/tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다. 개인키는 저장소에 넣지 않고 별도로 백업한다. v0.14.0 부터 이 필드에 공개키가 들어 있다(키 ID `3AF6FA7C02D64C69`). 이 필드가 비어 있으면 앱은 업데이트 확인을 시작하지 않는다. 태그 빌드는 공개키·비밀키 누락 또는 태그/앱 버전 불일치 때 실패한다. 암호가 없는 키는 암호 시크릿을 비워 둔다.

일반 개발·PR·main 이외 브랜치의 수동 번들은 서명 자산 생성을 끈다. 태그와 main의 `bundle=true` 리허설은 별도 설정을 합쳐 `createUpdaterArtifacts: true`와 시크릿을 전달한다. 리허설도 기존 prepare 검증 함수를 사용하되 현재 앱 버전의 예상 태그 문자열을 함수 인자로만 전달한다. Git 태그를 만들거나 실제 GitHub ref를 바꾸지 않으며, 실제 태그 경로의 버전 일치 검사는 유지한다. NSIS·MSI·AppImage와 macOS `.app.tar.gz`의 `.sig`를 수집하고, Windows 포터블 exe 자체를 별도 자산으로 복사해 서명한다. 포터블 ZIP은 기존 배포용으로 유지한다.

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
