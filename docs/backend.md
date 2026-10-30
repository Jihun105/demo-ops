# 서버 연결 구조와 이전 안내

앱의 서버 연결은 Supabase, 사진·KML/KMZ 원본 저장은 Cloudflare R2를 사용합니다. 인증·데이터·실시간 연결은 `src/backend`, HTTP·업무 처리는 `src/server`로 분리해 서버 이전 시 교체할 범위를 정합니다.

## 코드 경계

| 위치                                  | 책임                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/backend/index.cjs`               | 데스크톱·휴대폰이 사용할 연결 구현 선택과 생성                                            |
| `src/backend/supabase/`               | SDK, 공개 키 검증, 테이블·RPC·함수 호출, 실시간 구독, 오류 변환                           |
| `src/shared/`                         | 검색·청구·입금·GPS 검증·변경분 병합·동기화 순서                                           |
| `src/server/*-handler.mjs`            | Request/Response 기반 계정·작업 보고·은행 문자·Earth 원본 HTTP 처리. 인증·저장은 주입받음 |
| `src/server/bank-deposit-service.cjs` | 입금 판정, 재시도, 저장 충돌 처리. 저장소의 `context/commit`만 사용                       |
| `supabase/functions/*/index.ts`       | Supabase에서 실행할 때의 인증·DB·R2 어댑터와 진입점                                       |
| `supabase/functions/_shared/`         | 어댑터 공용 클라이언트·RPC 호출. 함수로 배포되지 않고 각 함수 번들에 포함                 |
| `database/cloud/`                     | 현재 PostgreSQL 스키마, 권한 정책, 원자적 저장 함수                                       |

화면에 SDK 클라이언트를 노출하지 않습니다. `createBackend(url, key, options)`가 아래 작업만 제공합니다. SDK 의존성은 루트 package에 명시하며 `mobile/node_modules` 경로에서 몰래 가져오지 않습니다.

## 새 서버가 구현할 계약

| 작업                                 | 호출자가 기대하는 동작                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                               | 비밀번호 로그인, 세션 복원·사용자 확인·로그아웃·토큰 갱신 중단. 기존 `data.session`의 `user.id`, `access_token`은 앱의 세션 DTO 계약으로 유지                                             |
| `getAccess`, `getDesktopAccess`      | 서버가 확인한 회사·계정·권한. 요청한 역할을 그대로 신뢰하면 안 됨                                                                                                                         |
| `records(ownerId, current)`          | `status/publish/pull/push`. 변경 순번·generation·고정 head와 이벤트 ID 중복 방지 유지                                                                                                     |
| `signals.read/watch`                 | 회사별 종류·revision 목록, 변경 알림, 연결 상태. watch는 해제 함수를 반환. 알림은 힌트이고 실제 자료 저장 후에만 revision을 인정                                                          |
| `map.exchange`                       | revision이 같으면 unchanged, 다르면 좌표 snapshot. 좌표 출처와 만료 시각 보존                                                                                                             |
| `locations`                          | 조회·요청·승인·승인된 좌표 조회. GPS 정확도·주소 일치·권한 검증 보존                                                                                                                      |
| `staff`                              | 계정 관리, 직원 자료 변경분 조회, 수신 확인                                                                                                                                               |
| `reports`                            | 보고 조회/업로드 예약/완료/사진 URL, 목록 보관, 발송 이벤트, 고객 사진 목록                                                                                                               |
| `earth.begin/finish/download/upload` | KML/KMZ 버전 예약·바이트 업로드·완료 검증·원본 접근. `begin(manifest)` / `finish(workspaceId,versionId)` / `download(workspaceId,versionId)` / `upload({url,headers},bytes)`; 실패는 예외 |
| `deposits`                           | 수신 기기 등록/해제, 보류 목록·확정/제외, Android가 사용할 수신 endpoint                                                                                                                  |
| `routing.directions`                 | 회사 ID·두 좌표·AbortSignal을 `work-routing` 함수에 전달하고 시간/거리만 받음. 서버가 실제 로그인·회사·사장님/마스터 역할을 확인하며 REST 키는 서버 환경에만 존재                         |

일반 응답은 `{data, error, status}`입니다. `error`는 `code`, `message`, `setupRequired`, `accessDenied`, `retryable`, 필요하면 `userMessage`를 갖습니다. 원본 공급자의 HTTP Response를 UI가 읽지 않습니다. 좌표 요청과 변경분 전송처럼 실패를 예외로 전달하는 작업은 현재 호출 계약을 유지합니다. 회사/사용자 ID, 날짜 형식, 보고 DTO의 snake_case 필드는 데이터 계약이므로 새 어댑터에서 맞춥니다.

로그인 세션 저장·갱신 방식도 어댑터 책임입니다. 현재 옵션의 저장소 인터페이스와 `accessToken` 공급자는 새 구현에서도 지원하거나 생성 경계에서 변환해야 합니다. 특히 데스크톱의 상속 토큰 연결은 별도의 로그인 세션을 생성하지 않으며 이전 로그인에서 만든 연결로 새 계정 토큰을 얻을 수 없습니다.

## 이전 시 실제로 필요한 일

1. 기존 DB와 사진을 백업하고 잠시 쓰기를 멈춥니다. 회사·고객·보고·이벤트 ID와 순번, 삭제 표시를 포함해 옮깁니다.
2. 새 서버에서 인증, 역할별 기능 권한(`demo_desktop.role_allows`), 회사 격리, 변경 알림, 중복 방지와 입금 원자적 저장을 구현합니다. Supabase의 `auth.uid()`, RLS, Realtime 발행 설정은 일반 PostgreSQL만 설치한다고 대체되지 않습니다.
3. 위 계약을 구현하는 연결 모듈을 추가하고 `src/backend/index.cjs`에서 선택합니다. 공용 업무 로직과 화면은 같은 계약을 사용합니다. Supabase 자체 호스팅은 HTTPS 사용자 도메인과 공개 키도 허용합니다.
4. 사진 저장소는 S3 호환 업로드/서명 URL/HEAD/삭제 구현을 교체합니다. `customer-photos.cjs`의 허용 호스트, 앱 HTML·Electron CSP·네이티브 지도 origin을 새 주소에 맞게 **명시적으로** 갱신합니다. 전체 호스트 허용으로 풀지 않습니다.
5. 로그인 계정의 이전 방식에 따라 재로그인이 필요합니다. Android 은행 수신 기기는 새 서버에 다시 등록하고, 남아 있는 미전송 문자를 먼저 확인합니다. 기기별 대기 기록이 사라지지 않도록 이전 기간의 읽기·쓰기 전환을 계획합니다.
6. 테스트와 실제 Windows/Android/iPhone 확인 후 설정을 포함한 앱을 다시 배포합니다. 다른 서버에서의 운영 검증은 아직 하지 않았습니다.

사진 최신 2회 보존, 메시지 발송 기록, 입금 판정은 서버 업체와 별개인 업무 규칙입니다. HTTP 처리 코드는 다른 Node/Deno 서버에서도 서비스 구현을 주입해 재사용할 수 있습니다. 다만 SQL·인증·실시간 연결까지 URL 하나만 바꿔 이전되는 것은 아닙니다.

## Earth 원본 저장소 이전

`src/shared/earth-asset.cjs`의 `demo-earth-asset` v1 JSON과 원본 KML/KMZ는 공급자와 무관합니다. 앱은 `src/backend`의 `earth` 계약만 호출하며, HTTP 처리기 `src/server/earth-assets-handler.mjs`는 인증·목록 저장·파일 저장 함수를 주입받습니다. 실제 Supabase RPC와 R2 S3 SDK 코드는 `supabase/functions/earth-assets/index.ts`에 한정합니다.

AWS S3/GCP Cloud Storage로 이전할 때 원본과 manifest의 객체 경로·회사/묘지/버전 ID·SHA-256을 그대로 복사합니다. 새 저장 어댑터는 임시 PUT 서명, 제한된 바이트 읽기, 최종 쓰기, GET 서명, 임시 삭제를 구현합니다. SQL 목록의 ready 상태도 함께 이전하고 복사된 바이트의 해시를 대조합니다. 인증/역할/회사 격리는 새 서버에서 같은 수준으로 검증해야 합니다. R2 원본만으로 최신 활성 고객 상태나 청구 DB가 복원되는 것은 아닙니다.

서버 설정 순서:

1. SQL 설치·업그레이드는 [SQL 적용과 검증](sql-application.md)을 따릅니다. 새 서버 설치에는 Earth 원본·공유 정의가 포함되며 기존 서버에 개별 파일을 재실행하지 않습니다.
2. `node scripts/build-server-function.cjs earth-assets`로 번들을 만들고 `earth-assets` 함수로 배포합니다. 기존 R2 환경변수와 비공개 버킷을 사용합니다. 함수 내부에서 사용자 토큰과 회사 권한을 직접 검증하므로 플랫폼 JWT 검증 설정은 저장소 config와 맞춥니다.
3. 중단된 업로드 정리는 R2의 **earth-staging/ 접두사만** 대상으로 1일 이상의 만료를 별도 설정합니다. 영구 `earth/`에는 만료를 설정하지 않습니다.
4. 원본 재가져오기 후 보관·휴대폰 지도/면적 표시를 확인합니다. 기존 설치 앱은 새 빌드로 업데이트합니다.

2026-10-13 배포 기록에는 `earth-assets.sql`, `earth-sharing.sql`과 `earth-assets` 함수 적용이 완료되어 있습니다. 실제 원본의 R2 업로드와 기기 표시는 앱의 정상 저장·동기화 흐름에서 확인합니다. 중단된 `earth-staging/` 업로드의 버킷 만료 규칙은 별도 설정 대상입니다.

## 고객 삭제 목록 공유

직원용 `demo_worker_data`와 GPS 대상 `demo_location_grave`는 삭제 자료를 제외합니다. 현재 정의는 공통 원본에서 관리하며 [SQL 적용과 검증](sql-application.md)의 버전 절차를 사용합니다. 기능별 SQL을 마지막에 재실행하는 순서에 의존하지 않습니다.

사장님·마스터는 업무 이력을 위해 전체 catalog를 받으므로, 휴대폰 앱 업데이트 후 새 고객 검색·지도에서 삭제 표시를 반영합니다. 삭제·복원은 기존 catalog revision과 공유 신호를 재사용하며 별도 서버나 주기적 조회를 추가하지 않습니다.

`registration_status='declined'`인 고객과 연결 묘지는 직원 조회·지도·GPS 요청 대상에서 제외합니다. 일반 고객의 연간 미진행 작업과 미연결 묘지는 유지합니다. PC 거절 목록은 로컬에서 동작하며 PostgreSQL에 새 고객 컬럼은 필요 없습니다.

2026-10-14 운영 서버에 최신 거절 고객 제외 버전을 적용했습니다. 적용 소스, 함수 해시와 검증 범위는 서버 적용 기록에 있습니다. 직원 휴대폰의 이미 저장된 목록은 다음 성공적인 동기화부터 갱신됩니다.

### 묘지별 최신 원본 보존 (2026-10-14)

Earth 원본 SQL 변경은 검토한 버전 적용 절차로 진행하고 `earth-assets` 함수는 별도로 업데이트합니다. SQL은 기존 원본 행을 지우지 않고 `retired_at`, `cleaned_at`과 현재 catalog 연결을 기준으로 한 정리 RPC를 추가합니다. 새 원본이 ready가 된 묘지의 과거 버전만 폐기하며, 과거 버전은 재업로드할 수 없습니다. 앱의 `earth.cleanup(workspaceId)`는 폐기 목록의 검증된 회사/묘지/버전 키만 삭제하고, 삭제 실패는 다음 동기화에서 재시도합니다. 정리 완료 행도 늦은 쓰기에 대비해 최대 100개씩 확인 시각 순으로 재검증합니다. 복구용 로컬 백업은 보존합니다.

2026-10-14 기존 회사 프로젝트에 최신 `earth-assets.sql`과 `earth-assets` 함수 업데이트를 적용했습니다. SQL Editor의 성공 결과와 함수의 갱신 시각을 확인했고, 입력한 코드가 로컬 빌드 번들과 동일한지 대조했습니다. 배포 전 함수 코드는 `artifacts/server/earth-assets/before-latest-policy.ts`에 보관했습니다. 실제 업무 고객의 좌표를 바꿔 교체를 시험하지 않았으며, 교체·공유·실패·늦은 쓰기는 SQLite/PostgreSQL과 바이트 저장 테스트로 검증했습니다.

## R2 저장소 점검

`earth-assets` 함수의 `check` 동작은 사장님·마스터가 개인정보 보호 모드 회사에서만 실행할 수 있습니다. 서버가 R2의 회사 폴더(`{회사}/`, `staging/{회사}/`, 예전 `{owner}/{회사}/`·`report-staging/`·`earth/`·`earth-staging/`)와 버킷 최상위를 목록 조회하고 `demo_desktop_storage_check` RPC가 돌려준 기대 목록과 대조합니다(`src/server/storage-check.mjs`, `storage-reconcile.mjs`). 결과 개수는 `demo_desktop.storage_checks`에 마지막 1건만 저장하며, 파일 삭제 권한은 쓰지 않습니다. 데스크톱은 `privacy:request`의 `storage-check` 동작으로 요청합니다.
