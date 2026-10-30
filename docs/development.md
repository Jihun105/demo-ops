# 개발·검증 안내

## Windows 설치본

`npm run desktop:prepare`는 공개 설정·현장 화면·운영 의존성을 별도 준비 폴더에 만들고,
`npm run desktop:build:win`은 Windows x64 NSIS 설치본 생성과 실제 내부 검사까지 실행한다.
NSIS 검사에는 `DEMO_7ZIP`으로 지정한 정식 7-Zip 콘솔 도구가 필요하다.
기존 `mobile/dist`·APK·사용자 자료는 빌드 대상에서 분리한다.
첫 산출물은 서명 없는 시험본이며 실제 Windows 인수 시험은 별도다.
빌드 환경과 설치·갱신·제거 절차는 [Windows 납품 안내](windows-delivery.md)를 따른다.

## 기준 DB를 공동 서버로 이전하는 도구

scripts/shared-desktop-migrate.cjs는 inspect/prepare/apply/verify를 제공합니다. inspect와 prepare는 업로드하지 않으며 화면 출력에는 건수/해시/버전/상태만 포함합니다. 준비 파일에는 고객 내용과 복구 사본이 있으므로 소스 저장소 밖의 개인 폴더에 보관합니다. prepare는 확인한 원본 checksum·사장님 ID·서버 기존 버전이 필요합니다. apply는 그 원본과 서버 기준을 다시 명시해야 하며, 보호된 배포가 valid 상태인지 검사합니다. 원본 고객/field/지도 DB는 이전 동안 쓰기 잠금을 잡아 선택한 내용이 바뀌지 않게 합니다. 서버 이전은 실패 시 전체 롤백하고 같은 요청 ID의 완료 결과를 재확인합니다.

```sh
node scripts/shared-desktop-migrate.cjs inspect --source /절대/경로/company.db --work-root /절대/경로/업무자료
node scripts/shared-desktop-migrate.cjs prepare --source /절대/경로/company.db --work-root /절대/경로/업무자료 --output /개인/이전폴더 --owner <사장님-ID> --reviewed-source-sha <확인한-SHA> --server-revision <확인한-서버버전>
node scripts/shared-desktop-migrate.cjs apply --prepared /개인/이전폴더/prepared.json --confirm-source-sha <확인한-SHA> --confirm-server-revision <확인한-서버버전>
node scripts/shared-desktop-migrate.cjs verify --prepared /개인/이전폴더/prepared.json
```

apply/verify 연결에는 DEMO_SUPABASE_URL, DEMO_SUPABASE_KEY, 사장님이 로그인한 짧은 유효기간의 DEMO_MIGRATION_ACCESS_TOKEN 환경값을 사용합니다. 토큰을 코드/준비 파일/명령 기록에 저장하지 않습니다. DB가 여러 개라면 어느 파일이 최신 기준인지 먼저 확인합니다. 이전 중 기존 PC 앱의 입력과 파일 이동을 멈춥니다. 완료 후 새 앱에 사장님·마스터로 로그인하고 서로 다른 PC에서 다른 고객 수정/동시 영업 배정/연결 끊김을 확인합니다. apply 응답이 끊기면 새 준비 파일을 만들지 말고 기존 prepared.json으로 verify합니다. 이전 이후 옛 원본이 달라졌다면 apply 대신 verify로 기존 완료를 확인합니다.

## 실행 환경

- Node.js 24 이상, npm. 잠금 파일 기준으로 설치합니다.
- 데스크톱: Electron. Mac에서 개발하며 Windows에서도 실행하도록 구현했습니다.
- 모바일: Capacitor 8 Android·iOS. Android 빌드에는 JDK 21, Android SDK 36 및 Gradle 의존성이 필요합니다. iOS 빌드에는 macOS와 Xcode 26 이상이 필요합니다.
- Python 도구는 선택 사항입니다. 최초 Excel 변환에는 openpyxl, 경계 재생성에는 출처 문서에 명시한 Shapely를 사용합니다.

```sh
npm ci
npm --prefix mobile ci
npm run dev
```

개발 중인 코드를 저장하는 즉시 PC 앱과 휴대폰 화면에서 보려면 개발 전용 서버를 쓰는 `npm run dev:live`를 사용합니다. 운영 서버와 실제 고객 자료는 쓰지 않습니다. 자세한 내용은 [실시간 개발 화면](dev-live.md)을 참고하세요.

서버 기능을 수정할 때는 Docker Desktop을 켜고 `npm run local:start`, `npm run local:test`로 가짜 자료의 실제 로그인·권한·입금 처리·Realtime을 검증합니다. 사용 명령과 Docker의 역할은 [로컬 테스트 안내](local-testing.md)를 참고하세요. 기존 앱의 운영 연결은 바꾸지 않으며, 이 도구가 실제 회사 DB를 사용하는 `npm run dev`를 대신하지는 않습니다.

새 개발 환경에서는 루트 `.env.example`을 `.env`로 복사하고 [환경 설정](environment.md)에 따라 키·연결 정보를 입력합니다. 개발용 PC와 모바일 빌드는 실행 위치에 관계없이 루트 `.env`를 읽고 셸 환경변수를 우선합니다. 모바일 회사 연결에는 공개 URL·publishable/anon key·작업공간 ID만 사용하고 빌드는 비밀 키와 잘못된 ID를 거절합니다. 고객 자료는 버전 관리에서 제외됩니다. 기존 로컬 방식에서 기본 DB가 없으면 앱에서 **DB 파일 선택**으로 연결합니다. 공동 모드 회사는 로그인 뒤 서버에서 조회 사본을 받습니다.

PC 설치본의 공개 설정은 `npm run desktop:config`로 생성합니다. `artifacts/desktop/desktop-config.json`에는 회사 공개 연결·지도 값만 들어가며, 나중에 패키징할 때 Electron `resources` 폴더에 배치합니다. 설치본은 개발 `.env`를 읽지 않습니다. 잘못된 설정은 시작 단계에서 중단하고, 이동시간은 인증된 `work-routing` 함수를 통해 받습니다. 이 함수는 2026-10-19 운영에 배포했습니다(서버 적용 기록). 설치본 만들기는 [Windows 설치본 안내](windows-delivery.md)를 참고하세요.

이동시간 함수 번들은 `node scripts/build-server-function.cjs work-routing`으로 `artifacts/server/work-routing/index.ts`에 생성합니다. 이 명령은 실제 서버에 접속하거나 배포하지 않습니다. 실제 적용 시 대상 프로젝트와 기존 `demo_access` 권한을 확인하고 서버 환경에 REST 키를 준비한 뒤 해당 함수만 배포합니다. 프로젝트 설정은 핸들러가 실제 사용자·회사·사장님/마스터 권한을 매번 검증하는 경로입니다. 배포 후 전용 시험 계정·공개 좌표로 허용/거절 동작과 호출량을 확인하고 기존 회사자료는 시험 대상으로 변경하지 않습니다.

## 신규 등록 주소 입력과 Google Earth

`src/ui/address-regions.js`의 지역 목록으로 시·도와 시·군·구를 선택하고 상세주소를 직접 입력합니다. 목록은 앱에 포함하며 런타임 외부 조회가 없습니다. 출처·기준일은 [주소 지역 목록](reference/address-regions.md)에 기록합니다. `src/ui/registration-address.js`가 선택값과 상세주소를 합쳐 기존 `address` 필드로 제출합니다. 별도 지역 컬럼이나 DB 마이그레이션은 필요하지 않습니다.

주소를 모두 비워 둔 등록은 허용하지만 주소의 일부를 입력했다면 필요한 지역과 상세주소를 확인한 후 제출합니다. 시·도 변경 시 이전 시·군·구 선택을 제거하고 등록 폼 초기화 시 합쳐진 주소도 비웁니다. DB 저장은 기존 등록 버튼에서만 수행합니다.

`openGoogleEarth({ address })` IPC는 데스크톱의 권한·호출자 확인 후 고정 Google Earth HTTPS 검색 URL을 Chrome으로 엽니다. `chrome-browser.cjs`는 Windows의 사용자별/64비트/32비트 기본 설치 위치와 App Paths 등록을 읽어 실제 Chrome 파일을 찾고, 셸 없이 고정 인자 목록으로 실행합니다. macOS는 `open -b com.google.Chrome`으로 실행합니다. Chrome이 없거나 실행에 실패하면 안내를 반환하며 기본 브라우저로 대체하지 않습니다. 외부 프로그램 실행 인자나 임의 URL을 받지 않으며 주소만 전달합니다. 고객명·전화번호·금액·DB 전체를 전달하지 않습니다. API 키·Kakao SDK·지오코딩 호출 없이 외부 웹 검색으로 연결하며, 설치된 Google Earth Pro의 실행을 보장하지는 않습니다. 검색 결과·좌표·측정값·이미지를 앱으로 자동 회수하지 않습니다.

## 폴더와 읽는 순서

| 경로                                                                        | 역할                                                             |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/desktop/main.cjs`                                                      | Electron 시작점, 창·IPC·DB 연결                                  |
| `src/desktop/preload.cjs`, `field-preload.cjs`                              | 화면에 허용하는 로컬 기능                                        |
| `src/desktop/customer/database.cjs`, `registration.cjs`                     | 고객 조회/신규 등록                                              |
| `src/desktop/work/annual-work.cjs`, `work-check.cjs`                        | 연간 영업 저장, 전체 등록 결과·현장 진행 목록·금융 표시          |
| `src/desktop/customer/excel.cjs`, `excel-editor.cjs`                        | 고객 Excel 미리보기·편집·다운로드                                |
| `src/desktop/customer/database-preparation.cjs`                             | 읽기 전용 DB 검사, 변환 확인, 회사 ID·구조 정리의 원자적 적용    |
| `src/desktop/field-store.cjs`                                               | 데스크톱의 작업공간·청구·입금 이력                               |
| `src/desktop/map/map-*.cjs`, `google-map-cache.cjs`, `mobile-map-store.cjs` | 지도 제공, 현장 좌표·임시 좌표·모바일 좌표 추출                  |
| `src/ui/`                                                                   | PC 화면, 고객/작업/지도/사이드바                                 |
| `src/ui/map-frame/`                                                         | PC·모바일 카카오 지도 `frame.js`, 시작점 Google 지도, 경계       |
| `src/shared/field-model.cjs`                                                | 검색, 위치 추정, 청구·입금 계산                                  |
| `src/shared/sync.cjs`                                                       | 서버 중립 변경분 동기화                                          |
| `src/shared/delivery.cjs`, `mobile-map.cjs`                                 | 발송 결과 처리, 지도 좌표 검증·동기화                            |
| `mobile/src/`                                                               | 휴대폰 화면과 IndexedDB 저장                                     |
| `mobile/android/app/src/main/java/kr/demo/field/`                           | SMS/MMS, 전송 결과, 앱 사진 사본, 네이버 외부 지도 연결          |
| `mobile/ios/App/App/`                                                       | iPhone Keychain, 문자 작성 화면, 지도·네이버 외부 지도 연결      |
| `database/local/`                                                           | 고객 DB 스키마, ERD, 최초 Excel 변환 도구                        |
| `database/cloud/`                                                           | Supabase SQL. 적용 순서는 지도/동기화 문서 참고                  |
| `scripts/`                                                                  | 모바일·서버 함수 빌드, 미리보기, 로컬 테스트·자료 이전·경계 생성 |
| `tests/`                                                                    | 기능별 Node/JSDOM/PostgreSQL 테스트                              |

데스크톱은 로컬 DB를 기준으로 하며 `src/desktop/automatic-sync.cjs`에서 업무 기록 수신·연간 금액 반영 후 고객·작업·지도 자료를 게시합니다. `src/shared/company-sync.cjs`는 작은 종류별 변경 신호의 구독과 실행·제한 재시도를 관리합니다. 모바일 `company-sync.js`는 화면 복귀·온라인 전환을 연결하고 `app.js`의 기존 권한별 동기화를 실행합니다. 내부 휴대폰 창은 IPC로 PC의 자동 처리를 공유합니다. `database/cloud/automatic-sync.sql` 적용이 필요합니다. 이전 개별 동기화 모듈은 제거했으며 모든 알림은 하나의 회사 신호 연결을 사용합니다.

PC 자동 처리를 비활성화해 조사하려면 `DEMO_AUTO_SYNC=0 npm run dev`로 실행합니다. 설정의 최신 자료 확인은 수동으로 유지됩니다. 서버 변경 신호 표를 삭제하는 방식으로 되돌리지 않습니다.

서버 연결·이전 시 교체 범위는 [서버 구조](backend.md)를 참고하세요. `src/backend`는 SDK와 원격 호출, `src/server`는 호스팅과 분리된 HTTP·업무 처리 코드입니다. 루트에서 공용 SDK·빌드·테스트 도구를 설치하고, `mobile`에서는 Capacitor 도구를 설치합니다. `npm test`는 회사 설정 없이 가짜 공개 설정으로 별도 테스트 번들을 만듭니다.

### 기능별 폴더 구성

코드와 테스트는 기능별 하위 폴더로 나눠 두었습니다. 새 파일은 같은 기능의 폴더에 넣습니다.

`src/desktop/` 바로 아래에는 앱 전체가 쓰는 파일(`main.cjs`, preload, 로그인 `auth.cjs`, 자동 공유 `automatic-sync.cjs`, 청구·입금 이력 `field-store.cjs` 등)만 두고, 기능별 코드는 하위 폴더에 둡니다.

| 폴더                          | 내용                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `src/desktop/customer/`       | 고객 DB·신규 등록·고객 상세·Excel·백업·DB 구조 정리       |
| `src/desktop/work/`           | 연간 영업 전화·작업 관리·작업 확인·작업 분배              |
| `src/desktop/work-route/`     | 카카오 이동시간과 작업 순서 계산·저장                     |
| `src/desktop/map/`            | 지도 서버·별도 지도 창·좌표 저장                          |
| `src/desktop/earth/`          | Google Earth KML·KMZ 가져오기·원본 보관·업로드·정리       |
| `src/desktop/report/`         | 작업 보고 목록 읽기·보관·문자 발송 기록 연결              |
| `src/desktop/privacy/`        | 개인정보 보존 모드의 요청과 기기 정리                     |
| `src/desktop/shared-desktop/` | 공동 모드의 서버 조회 사본·초안·요청 기록·Earth·작업 순서 |

테스트도 같은 이름의 기능 폴더(`tests/customer/`, `tests/work/`, `tests/work-route/`, `tests/map/`, `tests/earth/`, `tests/report/`, `tests/privacy/`, `tests/shared-desktop/`, `tests/server/`, `tests/ui/`, `tests/mobile/`, `tests/windows/` 등)에 `*.test.cjs`로 둡니다. `npm test`는 `tests/` 아래 모든 폴더의 `*.test.cjs`를 실행하되 `tests/integration/`만 빼며, 그 폴더는 `npm run test:integration`으로 따로 실행합니다. 여러 테스트가 같이 쓰는 도우미는 `tests/helpers/`, 고정 자료는 `tests/fixtures/`에 있습니다. 포장된 설치본을 Electron에서 검사하는 도우미 `tests/helpers/check-packaged-desktop.cjs`도 여기에 있습니다.

`scripts/`는 도구 종류별로 나눴습니다. `scripts/android/`는 Android 개발용·정식 APK 빌드와 서명 설정 확인(`npm --prefix mobile run android:build`, `android:release`), `scripts/windows/`는 PC 공개 설정 생성과 Windows 설치본 준비·빌드·검사(`npm run desktop:config`, `desktop:prepare`, `desktop:build:win`)입니다. 그 밖에 `scripts/cloud-sql/`(서버 SQL 동결·생성), `scripts/local-test/`(Docker 로컬 테스트), `scripts/dev-live/`(실시간 개발 화면), `scripts/workflow-test/`(과천 테스트), `scripts/lib/`(루프백 서버 공용 코드)가 있습니다.

## Git 변경 이력

`main` 브랜치에서 소스·테스트·설정 예시·문서의 변경 이력을 관리합니다. 고객 DB와 작업 파일, 로컬 설정, 로그인 상태, 백업, 서명 키, 생성된 앱 파일은 `.gitignore`로 제외합니다. Git은 업무 데이터 백업을 대신하지 않습니다.

```sh
git status --short
git diff
git add <확인한 파일 경로>
git diff --cached
git commit -m "변경한 내용"
git log --oneline -5
```

커밋 전 실제 고객 자료나 키가 추가되지 않았는지 확인합니다. 제외 파일을 `git add -f`로 강제 추가하지 않습니다. 원격 저장소를 연결할 때는 비공개 저장소를 사용합니다. 다른 컴퓨터에서 소스를 받아도 로컬 설정·고객 자료·서명 키는 별도 복구가 필요하며, DB 이름과 작업공간 정보를 임의로 바꾸지 않습니다.

새 PC에서 소스를 복구하는 순서:

1. 비공개 GitHub 저장소 `your-account/demo-business`를 복제하고 위의 작업 브랜치를 선택합니다.
2. Node.js 24 이상을 준비하고 프로젝트 루트와 `mobile/`에서 각각 `npm ci`를 실행합니다.
3. `.env.example`을 `.env`로 복사하고 [환경 설정](environment.md)에 따라 실제 연결값을 입력합니다.
4. 따로 보관한 고객 DB·업무 DB·KML 원본·사진·서명 키를 복구합니다. 이 자료는 Git에서 복구할 수 없습니다. 앱을 시작하기 전에 [데이터 관리](data.md)를 확인합니다.
5. `npm test`로 소스를 확인합니다. 운영 자료를 대상으로 테스트 등록·삭제·문자 발송을 하지 않습니다.

서버 SQL은 Git 이력의 예전 함수를 골라 붙여넣지 않고 [SQL 적용과 검증](sql-application.md)으로 서버 상태를 먼저 확인합니다.

## 수정과 서식

- `src/ui/` 수정: 데스크톱 창에서 Cmd+R / Ctrl+R로 다시 읽습니다.
- `src/desktop/` 수정: 앱을 종료하고 `npm run dev`로 다시 실행합니다.
- `mobile/src/`, `src/shared/`, 지도 설정 수정: `npm run mobile:build` 후 모바일 화면을 다시 읽습니다. Android·iOS에는 별도 동기화/빌드가 필요합니다.
- `mobile/dist/`, Android·iOS 생성 assets, `src/ui/map-frame/boundaries.js`는 직접 편집하지 않습니다.

```sh
npm run format
npm run format:check
npm test
```

Prettier가 JavaScript/CJS/HTML/CSS/JSON/Markdown 및 자체 Android Java 코드의 서식을 통일합니다. 원본 데이터, 로컬 키 설정, 외부 라이선스 코드, 생성 결과는 서식 대상에서 제외합니다. 테스트는 포트를 여는 지도 서버 검증도 포함합니다.

자동 테스트는 임시 폴더에서 가짜 고객 DB와 Excel 파일을 만들어 사용합니다. 실제 고객 자료나 앱 전용 폴더는 읽지 않습니다. `npm run dev`는 개발 메뉴가 있는 실제 앱 실행이므로 운영 자료와 회사 연결을 사용합니다. 자동 테스트와 혼동하지 마세요. 운영 자료를 대상으로 임의의 테스트 등록·발송을 하지 않습니다.

## Android 정식 APK 배포

직원에게 전달할 APK는 `release`로 빌드합니다. 기존 `android:build` 명령은 개발용 debug APK이며 정식 배포 파일과 구분합니다.

```sh
# JAVA_HOME: JDK 21 경로, ANDROID_HOME: Android SDK 경로를 먼저 설정합니다.
npm --prefix mobile run android:release
```

이 명령은 최신 웹 화면 생성 → Android assets 동기화 → release 단위 테스트 → release 빌드 → 서명/디버깅 검사 순으로 실행합니다. APK는 `artifacts/android/demo-field-<버전>-release.apk`, 서명 지문·파일 해시·버전 정보는 `release-build-info.json`에 기록합니다. APK는 Git에 올리지 않습니다. 업데이트 때는 `mobile/android/app/build.gradle`의 `versionCode`를 증가시키고 `versionName`을 갱신합니다.

현재 정식 APK의 버전은 `mobile/android/app/build.gradle`의 `versionName`과 `versionCode`로 확인합니다. 이전 APK의 보관 기준은 [데이터 관리](data.md)의 '재생성 가능한 파일'을 따릅니다. 휴대폰에 설치된 버전은 각 기기에서 확인합니다.

빌드용 JDK 21과 Android SDK는 `artifacts/android-toolchain`에 보관하고 경로는 `.env`의 `JAVA_HOME`·`ANDROID_HOME`으로 관리합니다. 공식 배포본의 체크섬을 확인했으며, 압축 설치 파일은 도구 설치 후 제거했습니다.

서명 키 파일은 프로젝트 밖의 기존 위치에 보관합니다. 경로·비밀번호·별칭·인증서 지문은 루트 `.env`의 `DEMO_ANDROID_KEYSTORE`, `DEMO_ANDROID_STORE_PASSWORD`, `DEMO_ANDROID_KEY_ALIAS`, `DEMO_ANDROID_KEY_PASSWORD`, `DEMO_ANDROID_CERTIFICATE_SHA256`에서 관리합니다. `DEMO_ANDROID_SIGNING_CONFIG`와 외부 `android-signing.json`은 빌드에서 더 이상 읽지 않습니다. 비밀번호를 코드·명령행 인자·Git·채팅에 붙여넣지 않습니다. POSIX에서는 `.env`·키 파일 권한을 600으로 유지합니다.

빌드는 설정이 없거나 프로젝트 안에 키를 놓은 경우 실패합니다. Gradle도 release 서명이 없으면 중단하며 debug 키로 대체하지 않습니다. 완성된 APK의 인증서 SHA-256 지문이 보관한 정식 키와 같은지 확인하고 개발용 인증서와 디버깅 활성 APK를 거절합니다. 항상 같은 키로 이후 업데이트를 서명합니다. [Android 서명 공식 안내](https://developer.android.com/studio/publish/app-signing)

2026-10-10 생성한 서명 키의 로컬 복구 사본은 `~/Library/Application Support/Demo Backups/android-signing-20261010`에 있습니다. 키와 비밀번호 설정이 함께 있으므로 해당 폴더를 공유하지 않습니다. 다른 빌드 PC로 옮길 때 키를 재생성하지 않고 복구 사본을 사용하며 `storeFile` 경로만 맞춥니다. 같은 맥 안의 사본이므로 외부 백업은 별도로 필요합니다.

기존 `kr.demo.field` debug 설치본과 새 release APK는 서명이 다릅니다. 일반적인 덮어 설치로 전환할 수 없으므로 기존 앱을 먼저 삭제하지 않습니다. 미동기화 기록·전송 대기·로컬 사진과 초안이 있는지 확인하고 필요한 자료를 보존한 뒤 전환해야 합니다. Supabase/R2에 올라가지 않은 로컬 자료는 로그인만으로 복구되지 않습니다. 이 빌드 명령은 휴대폰 앱을 설치·삭제하지 않습니다. Android의 키 회전이나 별도 데이터 이전 도구는 이번 작업 범위에 포함하지 않습니다.

## 모바일 미리보기와 Android 빌드

```sh
npm run mobile:build
npm run mobile:preview
```

미리보기는 `http://127.0.0.1:8091/`입니다. 화면 파일만 제공하며 고객 DB를 HTTP로 공개하지 않습니다. 브라우저 미리보기에는 데스크톱에서 내보낸 자료를 **고객 자료 가져오기**로 넣거나 클라우드로 로그인해 받습니다. 가져오기는 사장님 계정에서만 됩니다. 내보낸 JSON 파일에는 고객 개인정보가 들어 있으므로 회사 기기에서만 씁니다. 데스크톱의 **설정 → 휴대폰 연동** 창은 같은 화면을 실제 DB와 연결해 보여줍니다. 지도 프레임 서버는 PC 앱이 8092 포트로 열고 `demo://desktop` 화면에서만 사용합니다.

```sh
npm --prefix mobile run android:sync
npm --prefix mobile run android:open
```

Android Studio에서 SDK를 준비하거나, 터미널에서 JDK/SDK 경로를 설정한 후 실행합니다.

```sh
cd mobile/android
./gradlew :app:testDebugUnitTest :app:assembleDebug
```

Windows에서는 `gradlew.bat`을 사용합니다. 산출물은 `mobile/android/app/build/outputs/apk/debug/app-debug.apk`입니다. 직원에게 전달하는 파일은 위의 정식 APK입니다.

`android:sync`는 소스 복사 단계이며 APK 생성은 별도 빌드가 필요합니다. 테스트 갤럭시는 USB 디버깅을 허용해 연결한 뒤 Android Studio에서 Run으로 실행합니다. 회사 연결은 앱에 포함되어 있으므로 발급받은 아이디 또는 이메일과 비밀번호만 입력합니다.

## iPhone 빌드와 설치

공통 화면은 `mobile/src/`에서 수정합니다. `mobile/ios/App/App.xcodeproj`에는 세션 Keychain, 문자 작성 화면과 영구 전송 기록, 네이버 외부 지도 링크, 지도 프레임 서버가 연결되어 있습니다. 두 앱은 기존 Supabase 회사와 R2를 공유하며 별도 서버를 추가하지 않습니다.

```sh
npm --prefix mobile run ios:sync
npm --prefix mobile run ios:open
```

Xcode 26 이상에서 App 타깃 → Signing & Capabilities → Team에 본인의 Apple Account를 선택합니다. 아이폰을 USB로 연결하고 기기의 **이 컴퓨터를 신뢰**를 허용합니다. 필요하면 아이폰 설정 → 개인정보 보호 및 보안 → 개발자 모드를 켭니다. 연결한 iPhone을 실행 대상으로 선택하고 Run으로 설치합니다. 최초 실행 때 설정 → 일반 → VPN 및 기기 관리에서 본인 개발자 계정을 신뢰해야 할 수 있습니다. 무료 Personal Team으로 본인 기기에 테스트할 수 있지만 서명이 7일 후 만료되므로 다시 설치해야 합니다. 직원 배포용 TestFlight/App Store는 Apple Developer Program이 필요합니다. [Apple 계정 비교](https://developer.apple.com/support/compare-memberships/)

`npm --prefix mobile run ios:build`는 **서명 없는 빌드 검증** 명령입니다. 설치 가능한 IPA를 생성하거나 직원에게 배포하는 명령이 아닙니다. `native:sync`는 두 프로젝트에 웹 결과를 복사합니다. 이 명령의 성공만으로 네이티브 빌드 성공을 판단하지 않습니다.

iPhone 지도는 앱 내부에서 `127.0.0.1:8092`에 지도용 정적 파일만 제공합니다. 외부 서버를 설치하지 않으며 고객 DB·사진·로그인 토큰은 제공하지 않습니다. 카카오 JavaScript 키의 사이트 도메인에 `http://127.0.0.1:8092`가 등록되어 있어야 합니다. 휴대폰은 동기화한 좌표만 표시하며 주소를 다시 지오코딩하지 않습니다. WKWebView·카카오 지도·네이버 외부 지도 앱 연결은 실제 iPhone에서 확인해야 합니다.

문자 작성 화면의 `sent` 결과는 iOS 메시지 앱이 발송 요청을 수락했다는 뜻이며 수신자에게 배달됐다는 보장이 아닙니다. 작성 중 앱 종료는 `unknown`으로 복구하고 중복 전송을 막습니다. 취소/실패는 사용자가 다시 시도할 수 있습니다. iPhone은 사진첩 원본을 삭제하지 않습니다.

Xcode 없이도 macOS Command Line Tools로 공통 Swift 상태·지도 서버를 검증할 수 있습니다. 테스트 서버는 임시 포트를 사용합니다.

```sh
swiftc -module-cache-path /tmp/demo-swift-cache mobile/ios/App/App/DemoOutbox.swift mobile/ios/App/App/DemoMapServer.swift tests/ios-native/main.swift -o /tmp/demo-ios-native-tests
/tmp/demo-ios-native-tests
```

현재 개발 맥의 Xcode는 `/Applications/AI/Xcode.app`에 있습니다. 기본 명령줄 개발 경로는 Command Line Tools이므로 이 맥에서는 다음처럼 해당 명령에만 Xcode 경로를 지정합니다. 시스템 전체 개발 경로를 바꿀 필요는 없습니다.

```sh
DEVELOPER_DIR=/Applications/AI/Xcode.app/Contents/Developer npm --prefix mobile run ios:build
```

화면을 수정한 뒤에는 `ios:sync` 후 다시 빌드·설치해야 합니다. TestFlight/배포용 IPA와 실제 문자 발송 검증은 별도입니다.

## 검증 범위

Node 테스트는 검색, 등록, 파일 보존, 자동 공유·수동 재확인, 변경 알림 중복 억제, 동시 저장·DB 전환, SQL 권한·권한 회수, 지도 만료/선택, 초안 보존과 문자 재발송 상태 확인 등을 검증합니다. 이번 서버 설정은 실제 Supabase에 적용했고 알림 행·RLS·Realtime 등록·트리거를 조회해 확인했습니다. 여러 실제 휴대폰 사이의 지연 시간과 사용량은 측정하지 않았습니다. Android 단위 테스트는 발송 결과 저장과 MMS·네이버 외부 지도 처리를 확인합니다. 실제 통신사 문자 전송, 기기 권한, 네이버 외부 지도 앱 및 Windows 실행은 별도 실기기 확인이 필요합니다.

정리 전후 검증 결과는 작업 완료 메시지에 기록합니다. README에 고정된 테스트 개수나 계정 설정 완료 여부를 적어 오래된 상태가 사실처럼 남지 않게 합니다.

## DB 변환 검증

구형 고객 DB의 구조·회사 ID 변환은 앱에서 `database-preparation.cjs`의 `prepareCustomerDatabaseWithDialog` 경로로만 합니다. 이 함수는 읽기 전용 검사 후 명시적인 확인을 받아 쓰기 잠금·변경 전 검증 백업·현재 상태 재검사·변환·변환 후 검사·같은 연결의 snapshot 검증·위치 설정 저장·COMMIT을 수행합니다. 위치 저장 실패도 변환을 롤백하고, 위치 저장 후 확정 전에 실패하면 설정을 복원합니다. 최신/구형 여부와 관계없이 핵심 필수 항목을 검사합니다. 별도의 변환 API는 두지 않으며, 테스트 픽스처의 회사 ID 준비는 `tests/helpers/workspace-identity.cjs`가 같은 검증 백업 함수로 수행합니다.

`tests/customer/database-preparation.test.cjs`는 실제 임시 SQLite DB로 취소·회사 불일치·알 수 없는 구조·확인 중 변경·백업 실패·중간 실패·로그인 상실·복구 후 쓰기를 검사합니다. `tests/helpers/desktop-main.cjs`는 OS 창과 인증/지도 경계만 대체하고 실제 main 시작 및 DB 선택 IPC와 실제 DB 모듈을 실행합니다. 운영 고객 DB와 기기 설정은 읽지 않습니다.

```sh
node --test tests/customer/database-preparation.test.cjs tests/customer/customer-backup.test.cjs tests/customer/customer-schema.test.cjs tests/customer/workspace-identity.test.cjs
```

Electron에 포함된 Node/SQLite 런타임에서도 같은 검사를 수행할 수 있습니다.

```sh
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron --test tests/customer/database-preparation.test.cjs tests/customer/customer-backup.test.cjs tests/customer/customer-schema.test.cjs tests/customer/workspace-identity.test.cjs
```

이 명령은 앱 창이나 실제 고객 DB를 열지 않습니다. 실제 OS의 버튼 클릭·기기별 파일 권한 확인은 자동 시험과 구분합니다. 변경한 시작 코드는 앱을 다시 실행하면 적용됩니다.
