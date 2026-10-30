# SQL 적용과 검증

현재 운영 버전은 `20261022-schema-cleanup`이다(다음 배포 대기: `20261026-role-permissions` → `20261027-billing-claims`, 서버 적용 기록)(2026-10-22 적용, 직전판 `20261020-sales-assignment-safety`). 적용 내용과 증빙은 서버 적용 기록에 있다. 서버 상태 확인에는 해당 버전의 verify를 사용하고, 예전 문서의 미적용 설명만으로 SQL을 다시 적용하지 않는다.

기존 동결 JSON은 수정하지 않는다. 전체 업그레이드 순서는 core → `20261014-multi-desktop` → `20261015-data-privacy` → `20261017-grave-management` → `20261017-work-region-filter` → `20261018-work-routes` → `20261018-work-sales-search` → `20261018-work-sheets` → `20261018-work-task-reports` → `20261019-work-progress` → `20261019-work-progress-safety` → `20261019-work-registration-origin` → `20261020-privacy-registration-origin` → `20261020-sales-assignment-safety` → `20261022-schema-cleanup`다. `desktop-upgrade` 한 파일은 직전판에서 최신판으로 가는 단계만 포함한다. 새 빈 시험 서버용 `desktop-install`은 기본층과 최신 동결판을 한 번만 적용하며, 전체 순서를 재실행한 결과와 같은 스키마임을 `tests/server/schema-cleanup-sql.test.cjs`로 검사한다.

운영 순서는 검토한 SQL → 변경된 bank-deposits·earth-assets·work-reports 함수 → 최신 PC·휴대폰 설치 확인 → 실제 회사별 전환 검토다. SQL 설치만으로 회사의 개인정보 처리 세대가 활성화되지는 않는다. 실제 사장님 세션으로 회사 revision·항목 개수·금액·원본/전송 확인값·설치 기기를 검토한 뒤에만 비공개 `demo_desktop.activate_privacy` 절차를 사용한다. 관리자 SQL 연결에 임의 사용자 ID를 넣어 사장님 세션을 대신하지 않는다. 최신 SQL 적용 기록만으로 회사별 전환 완료를 판단하지 않는다.

R2의 `earth-staging/`·`report-staging/` 임시 업로드 만료 정책을 실제로 확인한 뒤 전환한다. 이전 서명 URL은 발급 후 5분 동안 유효할 수 있으며 진행 중 업로드를 즉시 회수했다고 표시하지 않는다. 전환 전후 금융 합계·이벤트 ID·원문 해시를 대조한다.

이번 범위에는 회계 보존기간 자동 파기·고급 백업·격리 복원 기능이 없다. 파일은 사장님·마스터가 업무 사본/증빙/판단 보류로 확인한다. 미분류·증빙·공용 참조·미확정 업로드는 보존한다. 서버/기기/백업 대기는 따로 기록하며 모든 사본의 완전 파기나 법 준수 완료를 표시하지 않는다.

## 공동 데스크톱 추가 배포

공동 데스크톱은 기존 동결 기준 20261014-schema-control을 수정하지 않는 추가 배포 20261014-multi-desktop입니다. 원본/동결 파일/보호 대상의 일치를 검사하고 비공개 업무 테이블, 버전/요청 기록, 영업 점유와 구형 쓰기 차단을 함께 설치합니다. 기존 SQL을 다시 붙여넣거나 운영 서버에 새 서버 install을 실행하지 않습니다.

```sh
npm run cloud:build -- desktop-upgrade
npm run cloud:build -- desktop-verify
# 새 빈 시험 서버만:
npm run cloud:build -- desktop-install
```

검토와 최종 수정 후 만든 동결 manifest만 사용합니다. upgrade 전체 실행과 verify의 valid=true·버전·소스 SHA·미완료 0건을 확인하고 Earth 함수도 해당 소스로 배포합니다. 함수는 실제 auth 세션과 준비 후보를 확인하고 업로드 완료와 현재 연결을 구분합니다. SQL/함수 설치만으로 회사 기준 DB를 자동 선택하거나 전환하지 않습니다. 이전 CLI는 별도의 확인한 checksum/서버 버전을 요구합니다. apply는 준비한 DB와 현재 연결 원본을 잠근 기준에서 백업/확인하고, 현재 KML/KMZ의 기존 ID 업로드를 완료한 뒤 회사 이전을 요청합니다. 원본 DB의 업로드 상태는 쓰지 않으므로 source checksum이 바뀌지 않습니다. 서버의 기존 최신 원본이 선택한 기준과 다르거나 이미 폐기됐다면 자동 덮어쓰지 않고 이전을 중단하므로 기준 DB와 서버 catalog를 다시 확인해야 합니다.

현재 원본은 `database/cloud/functions/`에서 관리하고 적용 순서는 `scripts/cloud-sql/sources.cjs`에 있습니다. 서버에 전달하는 파일은 검토 후 동결한 `database/cloud/releases/`의 버전별 소스로 만듭니다. 과거 SQL 파일을 순서대로 다시 붙여넣는 방식은 사용하지 않습니다.

## 기존 서버 기준 등록

```sh
npm run cloud:build -- baseline
npm run cloud:build -- verify
```

명령은 `artifacts/server/schema/baseline.sql`, `verify.sql`을 생성할 뿐 서버에 접속하거나 실행하지 않습니다. 관리자 SQL Editor에서 전체 baseline을 한 트랜잭션으로 실행한 뒤 verify를 실행합니다. 현재 버전은 `20261014-schema-control`입니다. 실제 적용 결과는 서버 적용 기록에 보관합니다.

첫 baseline은 기존 업무 함수·고객·청구·입금·사진·지도 자료를 수정하지 않습니다. 다음 다섯 대상의 실제 정의가 동결한 소스와 정확히 일치할 때만 비공개 버전 기록과 보호 장치를 설치합니다. 다른 정의가 있으면 원인을 확인하고 별도 검토하며 자동으로 덮어쓰지 않습니다.

- `public.demo_worker_data(uuid)`
- `public.demo_location_grave(uuid,uuid,bigint)`
- `public.demo_sync_status(uuid)`
- `public.demo_validate_event()`
- `public.demo_events`의 `demo_events_kind_check`

이 기록은 다섯 대상의 검증 기준입니다. 이전 SQL 20개 전체를 검증하거나 모두 적용했다는 의미는 아닙니다. 기존 서버의 버전을 보려면 생성된 verify SQL만 실행합니다. 버전·소스 SHA-256·정의 일치·보호 장치 활성·미완료 적용 0건·valid=true가 모두 확인되어야 합니다. 검사 실패도 정상 상태로 취급하지 않습니다.

## 새 빈 서버

```sh
npm run cloud:build -- install
```

생성된 `install.sql` 전체는 새 빈 프로젝트에만 실행합니다. 기존 운영 서버에는 실행하지 않습니다. 설치와 로컬 준비는 같은 동결 버전을 사용합니다. 회사 계정 생성·서버 함수 배포·비공개 R2 설정은 각 기능 안내에 따라 별도로 진행합니다.

Google 좌표 만료 예약(`mobile-map-cleanup.sql`)은 `20261022-schema-cleanup`에서 함수와 함께 제거했습니다.

## 다음 버전 적용

1. 현재 원본을 수정하고 임시 DB에서 기능·권한·삭제/거절 제외를 검사합니다.
2. Node API `freezeRelease(새버전, {previous: 기존버전})`로 새 소스를 동결합니다. 기존 파일은 덮어쓸 수 없습니다. 보호 대상 밖의 helper·설치 의존성 또는 관리 코드가 달라지면 동결을 거부하므로 별도 검토된 전환이 필요합니다. SHA-256과 대상 정의는 가짜 빈 DB에서 컴파일하며 운영 고객 행은 읽지 않습니다.
3. 전체 테스트·별도 PostgreSQL 두 연결 시험·독립 검토를 통과한 뒤 `buildRelease('baseline', {version: 새버전})`과 `buildRelease('verify', {version: 새버전})`를 파일로 보관합니다. CLI는 현재 기본 버전을 생성하므로 다른 버전은 이 API를 사용합니다.
4. 변경 전 정의를 보관하고 기존 버전과 비교한 뒤 새 baseline 전체를 실행합니다. 이전 기대 정의→승인한 새 정의→최종 검증→버전 기록을 하나의 트랜잭션으로 처리합니다. 동시에 두 적용이 시작되면 잠금으로 순서를 정하고 두 번째가 다시 기준을 검사합니다.
5. verify 성공과 소스 커밋·원격 보관을 확인한 뒤 적용 기록을 남깁니다.

위 순서는 기본층(core)의 보호 대상 다섯 개를 바꿀 때입니다. 지금 대부분의 변경이 들어가는 공동 데스크톱 후속판은 다음 순서로 동결합니다.

1. `scripts/cloud-sql/desktop-upgrades.cjs`의 `DESKTOP_RELEASES` 맨 끝에 새 버전 이름을 추가합니다. 마지막 항목이 기본 버전이 되고, 바로 앞 항목이 기본 직전판이 됩니다.
2. `npm run cloud:build -- desktop-freeze --version <새버전> --previous <직전버전>`으로 현재 `desktop-collaboration` 원본을 `database/cloud/releases/<새버전>.json`에 동결합니다. 가짜 빈 DB에 기본층과 직전판까지의 체인을 적용한 뒤 새 원본의 대상 지문을 계산합니다. 같은 이름의 파일이 이미 있거나 기본층 해시가 직전판과 다르면 멈추고 덮어쓰지 않습니다.
3. `npm run cloud:build -- desktop-upgrade`, `desktop-verify`로 운영 적용 파일을 만들고 업그레이드 테스트를 확인합니다. 로컬 테스트 서버는 새 판을 그날의 다음 마이그레이션 번호로 자동 추가합니다.

동일 버전·해시 재실행은 무결성 검사 후 건너뜁니다. 같은 버전의 다른 해시, 이전 버전 적용, 예상과 다른 함수·권한, 미완료 트랜잭션은 실패합니다. 이번 체계의 다음 버전은 같은 비공개 관리 코드와 다섯 대상 안의 변경을 지원합니다. 관리 코드 자체나 보호 대상 범위를 바꾸려면 별도의 검토된 전환이 필요합니다.

## 보호와 복구

이전 SQL이 보호 함수의 본문·인자·반환형·실행 권한·실행 역할·검색 경로 또는 이벤트 제약을 바꾸려 하면 DDL 검사에서 오류가 나고 해당 트랜잭션은 되돌아갑니다. 이벤트 검증 트리거의 연결·실행 시점·행 단위·활성 상태도 이벤트 제약 지문에 포함합니다. 무관한 정상 DDL은 허용합니다. 모든 DDL 완료 시 다섯 메타데이터를 검사하며 고객 저장 때 이 검사를 실행하지 않습니다.

관리 기록은 RLS가 켜진 비공개 `demo_schema` 테이블에 있고 PUBLIC·anon·authenticated·service_role에 접근 권한을 주지 않습니다. 관리 테이블 RLS, 두 보호 이벤트 트리거, 관리 함수 지문, 적용 완료 제약 트리거까지 검사합니다. 의도적으로 보호 장치를 해제할 수 있는 DB 관리자에 대한 절대적 보안 경계는 아닙니다. 해제·변경 상태는 다음 적용·verify에서 실패합니다.

실패한 적용은 같은 트랜잭션에서 롤백됩니다. 복구도 삭제·거절 고객 제외를 유지한 새 버전으로 검토·검증합니다. 보호 장치만 끄거나 이전 SQL을 강제로 실행하는 방법은 정상 업그레이드 절차가 아닙니다. 기준 등록 전 함수·권한 메타데이터와 검증 화면은 Git 제외 `artifacts/server/schema/`에 보관합니다. 이 파일에는 고객 행이나 인증 키를 넣지 않습니다.

## 현재 기능 SQL과 로컬 환경

`access.sql`, `conditional-sync.sql`, `earth-sharing.sql`, `customer-archive.sql`, `location-requests.sql`, `completion-messages.sql`의 공통 정의는 `-- @include`로 현재 원본을 참조합니다. 이 소스를 SQL Editor에 직접 복사하지 않습니다. `readCloudSql`은 포함 파일을 해석하고 경로 이탈·순환·심볼릭 링크를 거부합니다. 이전 정의는 테스트 전용 fixture와 Git 이력으로 보관합니다.

현재 기본 install·baseline과 `desktop-install`·`desktop-upgrade`는 현재 원본과 동결 소스가 다르면 실패합니다. 로컬 준비는 기본층이 다르면 실패하고, 데스크톱층만 다르면 동결판으로 만들고 안내만 띄웁니다(작업 중인 SQL은 `npm run dev:live`로 확인). 역사적 버전의 verify는 원본 수정 후에도 사용할 수 있습니다.

로컬 준비는 기본층 설치 파일 `20261014000000_schema-control.sql`과, 그 뒤 데스크톱 동결판 체인을 판마다 마이그레이션 파일 하나씩 만듭니다. 기존 생성 디렉터리에 과거 마이그레이션이나 다른 내용이 있으면 중단하고 보존합니다. 자동으로 다시 쓰거나 기존 로컬 DB를 초기화하지 않습니다. 기존 환경은 검토된 업그레이드 또는 별도 새 테스트 환경에서 전환해야 합니다. 관련 검사는 [로컬 테스트 안내](local-testing.md)를 참고합니다.
