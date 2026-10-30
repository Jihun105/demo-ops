# 서버 SQL 구조

운영 서버(Supabase PostgreSQL)는 두 층으로 관리한다. 적용 절차는 [SQL 적용과 검증](../../docs/sql-application.md)을 따른다.

| 위치                                  | 역할                                                                                                       |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `*.sql` (이 폴더 최상위)              | 기본층. `scripts/cloud-sql/sources.cjs`의 `INSTALL_FILES` 순서로 설치하며 `20261014-schema-control`로 동결 |
| `functions/`                          | 기본층의 보호 대상 함수 5개                                                                                |
| `desktop-collaboration.sql`           | 공동 데스크톱층의 진입 파일. 아래 파일을 `-- @include` 순서대로 합친다                                     |
| `desktop/`, `privacy.sql`, `privacy/` | 공동 데스크톱·개인정보 보존 기능. 마지막 `desktop/cleanup.sql`은 미사용 객체 제거와 인덱스                 |
| `releases/*.json`                     | 검토 후 동결한 버전별 전체 소스. 수정하지 않는다                                                           |

- 새 빈 서버 설치(`npm run cloud:build -- desktop-install`)는 기본층과 최신 동결판을 **한 번만** 적용한다. 과거 업그레이드를 차례로 재실행한 결과와 함수·테이블·권한·정책·트리거가 같은지는 `tests/server/schema-cleanup-sql.test.cjs`가 검사한다.
- 기존 운영 서버는 직전판에서 최신판으로 가는 `desktop-upgrade` 한 파일만 실행한다.
- 같은 함수를 여러 파일에서 다시 정의하는 경우 마지막 정의가 최종본이다. `privacy/` 파일은 단계별 시험 구성이 각 파일을 독립 적용하므로 앞선 정의를 유지하고, 사이의 권한·의존 구문이 필요한 공개 함수도 유지한다.
