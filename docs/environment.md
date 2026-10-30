# 키와 환경 설정

개발과 빌드에서 직접 관리하는 키·연결 설정은 **프로젝트 루트 `.env`**에 저장합니다. 새 개발 환경에서는 `.env.example`을 `.env`로 복사하고 값을 입력합니다. 개발용 PC 실행, 모바일 빌드, Android release 빌드와 공동 서버 이전 CLI가 읽습니다. 현재 작업 폴더가 달라도 프로젝트 루트를 기준으로 읽으며 셸에 이미 지정한 값이 우선합니다. 이 파일을 직원 설치본에 포함하지 않습니다.

## PC 설치본의 공개 실행 설정

`npm run desktop:config`는 허용한 공개 값만 검증해 `artifacts/desktop/desktop-config.json`을 만듭니다. 회사 URL·publishable/anon 키·회사 ID, 카카오 지도 JavaScript 키, Google 지도 공개 키·지도 ID만 포함합니다. REST 키·Android 서명 설정·개발 도구 경로·서버 비밀 키는 추출하지 않습니다. 선택 출력 위치는 `npm run desktop:config -- <출력폴더>/desktop-config.json`으로 지정합니다. 설정 검증 실패 시 기존 파일을 덮어쓰지 않습니다.

설치본은 Electron의 `resources` 폴더 안 `desktop-config.json`을 읽습니다. `.env`나 환경변수로 회사 연결을 대신하지 않으며 파일 누락·형식 오류·비밀 서버 키가 있으면 연결 오류를 안내하고 시작을 중단합니다. 기존에 다른 회사에 연결된 PC의 설정은 새 기본값으로 덮어쓰지 않습니다. 공개 키는 추출할 수 있는 정보이므로 실제 자료 접근은 로그인·서버 권한으로 제한합니다.

설치본의 이동시간 조회는 운영에 배포된 로그인 `work-routing` 서버 함수를 사용합니다(2026-10-19 배포, 서버 적용 기록). 함수 미배포·설정 부족이면 오류를 안내하고 개발용 REST 키로 우회하지 않습니다. 개발 실행은 기존 직접 REST 호출을 유지합니다. 설치본 만들기는 [Windows 설치본 안내](windows-delivery.md)를 참고합니다.

## 이동시간 서버 설정

`work-routing` 함수의 서버 환경에 `KAKAO_MOBILITY_REST_API_KEY`를 설정합니다. 기존 서버의 `SUPABASE_URL`·`SUPABASE_ANON_KEY`로 실제 로그인과 회사 접근 RPC를 확인하며 서버 관리자 키는 필요하지 않습니다. REST 키는 PC 공개 JSON이나 APK에 넣지 않습니다. 소스의 서버 변수 이름을 추가한 것은 실제 운영 Secrets에 값을 등록했다는 뜻이 아닙니다.

사용 중지 계정·회사 접근 거절은 일시적인 연결 오류와 구분합니다. PC 요청 제한은 120초로, 상류의 최대 15초 요청 3회와 최대 30초 재시도 대기 2회를 포함합니다. 사용자의 취소·로그아웃은 이 대기 중에도 결과 사용과 저장을 차단합니다. 이 시간은 회사 전체의 호출량 보장을 의미하지 않습니다.

여러 PC에서 시작한 요청은 같은 지도 서비스 계정의 호출량에 합산됩니다. 배포 전에 해당 계정의 한도와 예상 작업 건수를 확인합니다. PC의 200ms 요청 시작 간격과 공급자 오류 재시도는 여러 서버 인스턴스 전체의 정확한 호출량 할당을 보장하지 않습니다.

## 개발 환경 값 입력

```dotenv
KAKAO_MAPS_JAVASCRIPT_KEY='발급받은 JavaScript 키'
KAKAO_MOBILITY_REST_API_KEY='발급받은 REST API 키'
```

따옴표 안에 값만 넣고 저장합니다. PC는 재시작하고 모바일에 포함되는 공개 설정을 바꿨다면 빌드·동기화 후 앱을 업데이트합니다. 카카오 발급·도메인 등록은 [지도 안내](maps.md)를 참고하세요. 모바일 별도 JavaScript 키가 필요할 때만 `DEMO_MOBILE_KAKAO_MAPS_JAVASCRIPT_KEY`를 입력합니다.

## 설정 목록

| 항목                     | `.env` 변수                                                                                                                                      | 사용 위치                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| 카카오 지도              | `KAKAO_MAPS_JAVASCRIPT_KEY`                                                                                                                      | PC 지도, 모바일 공개 번들             |
| 카카오 자동차 이동시간   | `KAKAO_MOBILITY_REST_API_KEY`                                                                                                                    | 개발용 PC 메인 프로세스; 설치본 제외  |
| 모바일 지도 키 별도 지정 | `DEMO_MOBILE_KAKAO_MAPS_JAVASCRIPT_KEY`                                                                                                          | 모바일 공개 번들                      |
| 회사 서버                | `DEMO_SUPABASE_URL`, `DEMO_SUPABASE_KEY`, `DEMO_WORKSPACE_ID`                                                                                    | PC 회사 연결 기본값, 모바일 공개 번들 |
| Android 서명             | `DEMO_ANDROID_KEYSTORE`, `DEMO_ANDROID_STORE_PASSWORD`, `DEMO_ANDROID_KEY_ALIAS`, `DEMO_ANDROID_KEY_PASSWORD`, `DEMO_ANDROID_CERTIFICATE_SHA256` | release 빌드 프로세스                 |
| Android SDK 경로         | `ANDROID_HOME` 또는 `ANDROID_SDK_ROOT`                                                                                                           | release 빌드 도구                     |
| Java 빌드 도구 경로      | `JAVA_HOME`                                                                                                                                      | JDK 21·Gradle                         |
| 시작점 선택 Google 지도  | `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAP_ID`                                                                                                           | PC 시작 묘지 선택 지도                |

`DEMO_SUPABASE_KEY`는 publishable/anon 키만 허용합니다. REST 키·서명 비밀번호·서버 비밀값과 `.env` 원본은 모바일 번들에 포함하지 않습니다. PC의 저장된 회사 식별·소유자·로그인 설정은 유지하며 다른 회사에 연결된 DB를 `.env`로 바꾸지 않습니다. 동일한 회사에서는 `.env`의 공개 연결 값을 우선합니다.

## 이전 설정 처리

2026-10-18 기존 `config/google-maps.cjs`, `config/kakao-maps.cjs`, `config/mobile-maps.cjs`, `config/mobile-company.cjs`를 확인해 `.env`에 옮겼습니다. 저장 값의 동일성을 검증한 후 이전 로컬 파일을 제거했고 프로그램은 이 파일을 더 이상 읽지 않습니다. 외부 Android 서명 JSON의 경로·비밀번호·별칭·지문도 옮겼으며 빌드는 `.env`만 읽습니다. 키 파일 자체와 외부 서명 복구본·백업은 보존했습니다.

실제 `.env`는 Git에서 제외하고 POSIX 권한은 600으로 유지합니다. 공용 `.env.example`에는 실제 값을 넣지 않습니다.

## 이미 환경변수로 관리하는 서버 설정

Supabase 함수는 서버 환경변수 `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`를 사용합니다. 서버 비밀값은 로컬에서 새로 발급·조회하지 않았으며 계속 서버의 Secrets에서 관리합니다. [사진 저장소](work-reports.md)와 [서버 구조](backend.md)를 참고하세요.

로그인 암호·갱신되는 세션 토큰은 `.env`로 옮기지 않습니다. 공동 서버 이전 CLI의 단기 `DEMO_MIGRATION_ACCESS_TOKEN`은 실행할 때 셸에서 제공하고 보관하지 않습니다. 로컬 Docker 테스트의 키는 테스트 환경이 생성·제한하므로 운영 `.env`로 대체하지 않습니다.
