# 문서 작업 흐름 확장 설계

기준: 2026-10-04 공식 main `d5b54a865c7bd2f8a68bfb466b9e966a7c693b98` (v0.24.2). 새 clone, `feature/document-workflows` 브랜치. 원격 게시·판올림 제외.

## 소스 대조와 공통 원칙

이미 있는 `DocTab` 열 구성, `GridOrderState` 취소 가능한 정렬/문자열 필터, grid 전체 셀 IPC, 위치 복원, 라벨 책갈피, Markdown 이미지 재작성/Mermaid 렌더링을 확장한다. 표시 미리보기는 복사·비교·필터에 쓰지 않는다. 문서는 읽기 전용이다. 자유 SQL·편집 기능을 추가하지 않는다. 파일 식별은 기존 DocSource, 컬렉션은 테이블 이름/트리 경로를 사용하고 런타임 docId를 영구 식별자로 쓰지 않는다. 문서 갱신과 요청 세대 변화 뒤의 비동기 결과는 폐기한다.

## 1. 문서별 표 상태

별도 버전 있는 store에 source + 컬렉션 식별자별 상태를 저장한다. 열 이름/수의 schema signature에 맞는 구성만 복원하고 불일치 시 안전하게 초기화한다. 너비, 표시 순서, 숨김, 고정, 헤더/로그 모드, 필터와 정렬을 저장한다. 숨김은 최소 한 열을 남기고 순서·폭·열 번호·고정 수를 검증한다. 일반 열 구성은 schema 준비 후 즉시 복원, 정렬/필터 스캔은 활성 표가 준비된 뒤 실행한다. 복원된 필터를 화면에서 확인하고 해제할 수 있게 한다. 재읽기 전 capture, 재시작/닫고 재열기 때 동일 source로 복원한다. 쓰기는 debounce/직렬화하고 실패는 기존 toast 방식으로 알린다.

수용: 같은 파일의 다시 열기·재읽기·세션 복원에서 상태 유지; 다른 테이블로 누출 없음; 변경 schema와 손상 store 안전; 복원 스캔 취소/오래된 결과 무시.
테스트: 순수 역직렬화/identity/schema, 상태 round trip, 기존 세션/열 구성 회귀 및 실제 표 조작.

## 2. 범위 선택과 내보내기

표시 행 좌표와 표시 열 순서의 anchor/focus 직사각형을 사용한다. 마우스 드래그/Shift 클릭, Shift 방향키로 확장, Esc로 해제한다. Ctrl/Cmd+C와 보이는 메뉴에서 TSV 복사/헤더 포함 복사를 제공한다. 숨긴 열은 제외하고 표시 순서대로 전체 cell_text를 읽는다. 클립보드는 문서화한 바이트/셀 상한을 적용하며 초과 시 파일 내보내기를 안내한다. 필터/정렬된 결과 CSV/JSONL은 Rust에서 행 단위로 파일에 쓰고 취소/실패 시 불완전 파일을 처리한다. NULL·missing·빈 문자열과 JSONL 표현을 명시한다. 저장 경로는 대화상자로 선택한다.

수용: 재정렬/숨김/필터 뒤 정확한 범위; 탭/개행/따옴표와 긴 값 보존; 대용량 export는 전체 결과 적재 없음; 취소 가능; 원본 덮어쓰기 방지.
테스트: 범위 정규화/이동, TSV/CSV escaping, full scalar/NULL/missing, 필터 순서, 취소 및 export 중 세대 변화.

## 3. 일반 위치 책갈피

기존 heading anchor를 호환 유지하면서 typed target(JSON path, table row + collection, log line, PDF page)을 추가한다. 표 행/로그 줄은 원본 위치로 저장하며 정렬된 화면 행 번호를 영구 위치로 쓰지 않는다. source fingerprint와 대상의 제한된 검증 정보로 변경을 감지한다. 같은 source라도 파일 변화/대상 소실이면 성공을 주장하지 않고 위치 불일치 표시와 현재 위치로 재지정을 제공한다. 기존 JSON position resolver, 표 pendingCell, PDF page bridge를 재사용한다. 전체 문서를 책갈피를 위해 읽지 않는다.

수용: 기존 heading 데이터 유지; 네 새 위치로 다시 열어 이동; 변경 파일 불일치 표시; 라벨 수정/삭제/재지정 유지.
테스트: 구형/신형 store 검증, 잘못된 target, 원본과 표시 행 좌표 구분, 변경 fingerprint, 기존 bookmark tests + native PDF 회귀.

## 4. 좌우 비교

별도 비교 패널에서 열린 두 문서를 선택하며 닫기/변경 버튼을 제공한다. 텍스트·Markdown 원문은 줄 단위 변경 이동과 양쪽 스크롤 연동을 제공한다. JSON 비교는 객체 키 집합을 기준으로 값 변경과 순서만 달라진 경우를 구분한다. 배열은 최초 범위에서 index 대응이며 이동 추론은 하지 않는다. 비교는 안전한 파일/줄/노드 상한 안에서만 준비하고 초과는 명시한다. 기존 raw/line/tree IPC를 활용하고 비교 때문에 거대 문서 전문을 무제한 적재하지 않는다.

수용: 두 문서 선택/교체/닫기; 변경 이전/다음 이동; 스크롤 연동 해제; 키 순서만 변경 시 값 변경 없음; 큰 파일 제한 안내; 원문 변화 후 다시 비교.
테스트: 삽입/삭제/빈 파일/CRLF, 키 순서와 값 타입, 배열 index 규칙, 상한, stale load.
후속: 배열 identity 기반 대응, 대형 파일의 창 기반 diff와 구조 비교 lazy traversal.

## 5. Markdown 시각 자료 확대

기존 렌더된 img/SVG를 재사용하는 overlay를 제공한다. 클릭/키보드로 열고 화면 맞춤·실제 크기·확대/축소·pointer pan, Esc/닫기 복귀를 제공한다. 확대가 기사 DOM/자료를 다시 로드하지 않으며 닫을 때 원래 focus와 읽던 scroll 위치를 유지한다. 화면/테마/문서 갱신 시 stale overlay를 닫고 listener를 해제한다.

수용: 로컬/URL image와 Mermaid 확대; fit/100% 전환; 이동/확대/반복 닫기; Esc; 읽던 위치 유지; 깨진 이미지 안전.
테스트: 확대 수치/fit clamp/transform 순수 테스트, enhancement cleanup, native 클릭 반복.

## 6. 표 AND 조건 필터

기존 order scan에 typed predicate 배열을 추가한다. 열별 equals, contains, numeric comparison, empty, NULL 조건을 보이는 builder로 설정한다. 모두 AND다. 비교는 전체 scalar에 적용한다. contains/equals는 텍스트, numeric은 완전한 유한 숫자 해석만 허용하며 빈 값·NULL·missing과 구별한다. empty는 실제 빈 문자열, NULL은 명시적 NULL, missing은 별도 의미로 문서화한다. 기존 문자열 필터와 함께 AND로 적용한다. 기존 4096 단위 취소/진행과 자원 Budget를 재사용하고 조건/열 번호를 backend에서 검증한다.

수용: 두 조건 AND; 긴 값 비교; 음수/소수/비숫자/NULL/빈/누락 판정; 취소 뒤 안전; 상태 복원에 조건 포함.
테스트: 실제 grid scalar 타입별 tests, CSV/SQLite/JSONL 교차 적용, invalid predicate, 취소.

## 의존성과 단계

1. 설계/공통 계약 확정 → 표 상태와 확대를 독립 구현.
2. 범위 선택/stream export와 typed predicates는 grid IPC 계약을 공유하므로 소유자를 나누되 상호 전달한다.
3. 책갈피는 기존 위치 복원에 통합, 비교는 독립 패널로 App 변경만 통합 담당자가 수행한다.
4. 전체 통합 후 README 양 언어·architecture·verification 갱신 → 최종 check/test/build → 직렬 Rust test/clippy/debug smoke → release smoke.

공통 `docs.svelte.ts`, `ipc.ts`, `App.svelte`, i18n은 동시 편집 충돌을 피하도록 담당 영역을 전달하고 개별 변경 후 합친다. 각 기능은 독립 modules/tests 중심으로 분리한다.

## 종합 검증과 보고

생성기만으로 fixtures 준비. `npm test`, `npm run check`, `DVIEWER_FIXTURES=required cargo test --locked`, fmt/clippy, 최신 frontend/custom-protocol build 후 debug/release smoke를 실행한다. 의미 있는 변형 3개(잘못된 schema 수용, 표시 미리보기 복사, 키 순서=값 변경 또는 NULL=empty)를 단위 검사에서 실제 실패로 확인하고 원복한다. UI는 지원되는 실제 macOS 앱 경로로 반복 클릭/취소/닫기/재열기/갱신 확인한다. PDF 간헐 정체는 범위 밖이며 새 bridge 사용에 대한 회귀만 확인한다. Windows/Linux native 검사 미실행은 명시하고 세 OS 녹색 전 마일스톤 완료로 주장하지 않는다. 결과·제한·후속 범위를 보고서에 남기고 dev 찌꺼기 정리 후 `.done` 신호를 만든다.

## 구현 후 경계 검토의 확정 범위

저장 조건과 실행 조건은 UTF-8 8MiB 한계를 공유한다. 최근200항목 외에 직렬화64MiB 쓰기 예산을 적용하고 단일 초과 항목은 열 구성만 저장했다는 안내와 함께 조건을 제거한다. 플러그인의 기존 파일 초기 읽기는 이 예산의 강제 적용 범위 밖이다. 숫자 비교는 유한 문법 확인 뒤 정확한 십진 mantissa/지수 비교로 보강한다. Parquet 중첩 source serializer는8MiB/depth128, decimal 변환 계산은 예상4096자리까지이며 map은 키·중복·순서를 보존하는 쌍 배열이다. JSONC 구조 내보내기는 주석·끝 쉼표만 제거하고 숫자 토큰은 유지한다.

책갈피의 클릭 당시 선택 capture, 닫기·재읽기·재지정 중 늦은 응답 폐기, 없어진 table/page의 명시적 불일치를 검증한다. 로그 책갈피는 여러 줄 레코드와 물리적 원본 줄의 좌표를 구분한다. 비교의 취소는 IPC 결과 폐기·후속 읽기 중단이며 상한 내 동기 계산의 선점은 후속이다. locked Mac의 스모크 정체는 실행 단계·타이머·실제 rAF 횟수를 관찰한다. 관찰은 테스트 대기를 대신 진행하지 않으며 잠금 우회·사용자 설정 변경을 하지 않는다.
