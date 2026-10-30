# (주)데모 업무관리

고객·묘지·작업 자료를 관리하는 Electron 데스크톱 프로그램과 Android·iPhone 현장 업무 앱입니다. Mac에서 개발하며 Windows 데스크톱 사용을 목표로 합니다. iPhone 네이티브 프로젝트의 Xcode 빌드는 확인했으며, 개인 개발 계정으로 실제 iPhone 설치까지 확인했습니다. 최초 실행에는 기기의 개발자 신뢰 확인이 필요하며 업무 기능의 실기기 검증은 남아 있습니다.

## 실행

```sh
npm run dev
```

처음 설치하는 개발 환경은 Node.js 24 이상에서 `npm ci`와 `npm --prefix mobile ci`를 먼저 실행합니다. 실제 DB는 운영체제의 앱 전용 `Demo/data/company.db`를 사용하며 개발 폴더에서는 읽지 않습니다. 저장 위치와 기존 자료 이전은 [자료 보관 안내](docs/data.md)를 참고하세요.

API 키·회사 연결·Android 서명 설정은 루트 `.env` 한 파일에서 관리합니다. 새 환경은 `.env.example`을 복사하고 [환경 설정 안내](docs/environment.md)를 따릅니다. PC 실행과 모바일 빌드가 자동으로 읽으며 실제 `.env`는 Git에 포함되지 않습니다.

## 폴더 안내

```text
데모 자동화/
├── src/                  # PC 실행 코드와 공용 업무 로직
│   ├── desktop/          # Electron·DB·Excel·로컬 저장
│   ├── ui/               # PC 화면과 공용 지도 화면
│   ├── shared/           # 검색·청구·입금·동기화 로직
│   ├── backend/          # 서버 공급자 연결 어댑터
│   └── server/           # 호스팅과 분리한 HTTP·업무 처리
├── mobile/
│   ├── src/              # 휴대폰 화면과 로컬 저장
│   ├── android/          # 갤럭시 등 Android 네이티브 프로젝트
│   └── ios/              # iPhone Xcode 프로젝트
├── database/
│   ├── local/            # 고객 DB 스키마·ERD·최초 가져오기
│   └── cloud/            # Supabase 설정 SQL
├── supabase/
│   ├── functions/        # 직원 계정·작업 보고 서버 함수
│   └── local/            # Docker 로컬 테스트 서버 설정
├── build/windows/        # Windows 설치본 아이콘·NSIS 스크립트
├── .env                  # 로컬 키·회사 연결·서명 설정 (Git 제외)
├── .env.example          # 값이 없는 공용 설정 양식
├── config/               # 사진 저장소 CORS 등 비밀값이 없는 설정
├── data/                 # 이전 과정에서 남은 로컬 자료 (Git 제외)
├── artifacts/            # 최신 APK·채널 이미지·빌드/로컬 테스트 산출물
├── scripts/              # 빌드·미리보기·데이터 생성 도구
├── tests/                # 기능별 자동 테스트
└── docs/                 # 현재 사용·설정·개발 안내
```

`data/`에 이전 자료가 남아 있다면 확인 없이 삭제하지 않습니다. 현재 업무 DB는 프로젝트 밖의 앱 전용 폴더를 사용합니다. `node_modules/`와 `mobile/dist/`는 설치/빌드 결과입니다. 폴더를 찾을 때는 위 역할을 기준으로 보면 됩니다.

## 현재 기능

- 고객 지역별 조회·통합 검색·신규 등록, 지역별 엑셀 편집 팝업·DB 저장·선택 다운로드.
- 전체·지역별 고객 전화 확인, 전년도 금액 조회, 올해 금액·특이사항·자유 입력 기한 기록. 저장한 고객은 영업 확인에서 제외하고 작업 관리에서 검색·상세 수정하며 문자·입금 작업 확인에도 즉시 반영합니다.
- 카카오 지도 지역 다중 선택·상세 조회, 휴대폰 지도와 네이버 위성지도 연결.
- **공동 모드**: 고객·작업 원본은 서버에 두고 여러 PC가 같은 자료를 씁니다. 저장한 변경과 휴대폰 업무 기록을 자동 전송하고, 실행 중인 앱은 변경 알림으로 갱신합니다. 앱 실행·복귀 때 누락분을 확인하며 설정에 수동 재확인을 유지합니다.
- 시작 로그인 화면, 휴대폰 로그인 유지, 사장님·마스터·부마스터·관리자·영업·일반 작업자 6개 역할의 권한과 직원 계정 관리([계정 관리](docs/access.md), 새 역할은 운영 반영 대기).
- 배정 작업의 사진 보고·R2 사진 즉시 공유, 열린 보고 화면의 목록 자동 갱신, 보고 사진의 문자 초안 연결.
- Android 문자 초안 검토·SMS/MMS 발송, 청구·입금 기록과 앱 내부 발송용 사본 정리 (사진첩 원본 보존).
- iPhone은 같은 화면·계정·동기화 기능을 사용하며, 문자 작성 화면에서 사용자가 전송합니다. 원본 사진은 보존합니다.

Android 은행 입금 문자는 등록한 기기에서 수신해 확실한 이름·미입금액 일치만 자동 반영하며, 모호한 내역은 보류합니다. 실제 갤럭시 수신 검증은 남아 있습니다. 카카오톡 자동 접수와 감사 문자 자동 발송은 아직 구현하지 않았습니다. Windows 설치본은 `npm run desktop:build:win`으로 만들며 [Windows 설치본 안내](docs/windows-delivery.md)를 따릅니다.

## 필요한 문서

| 목적                                    | 문서                                          |
| --------------------------------------- | --------------------------------------------- |
| 고객·작업·Excel 기능 사용               | [사용 안내](docs/usage.md)                    |
| 휴대폰 설치·Supabase·문자·자동 공유     | [휴대폰 연결](docs/sync.md)                   |
| 작업 보고·공유 사진·R2 설정             | [사진 저장소](docs/work-reports.md)           |
| 로그인·직원 계정·권한 서버 적용         | [계정 관리](docs/access.md)                   |
| 지도 키·좌표 보관·모바일 지도           | [지도 연결](docs/maps.md)                     |
| 코드 위치·실행·서식·테스트·Android 빌드 | [개발 안내](docs/development.md)              |
| 개발 중 PC·휴대폰 화면 바로 확인        | [실시간 개발 화면](docs/dev-live.md)          |
| Windows 설치본 빌드·설치·인수 시험      | [Windows 설치본](docs/windows-delivery.md)    |
| 서버 SQL 버전 적용과 검증               | [SQL 적용](docs/sql-application.md)           |
| 운영 서버 적용 기록·배포 대기           | 서버 적용 기록                                |
| Docker 가짜 DB·로그인·입금 통합 검증    | [로컬 테스트](docs/local-testing.md)          |
| 과천 20건 작업 순서·배정 연습           | [과천 테스트](docs/workflow-testing.md)       |
| 운영 복사본으로 배포 전 리허설          | 리허설 서버                                   |
| 서버 교체 경계·연결 계약                | [서버 구조](docs/backend.md)                  |
| 은행 문자 자동 입금 처리                | [입금 문자](docs/bank-deposits.md)            |
| DB 위치·백업·이동·원본 보존             | [데이터 관리](docs/data.md)                   |
| 지도 경계의 라이선스·재생성             | [경계 출처](docs/reference/map-boundaries.md) |

## 검증과 서식

```sh
npm test
npm run format:check
npm run mobile:build
```

코드 서식을 적용하려면 `npm run format`을 실행합니다. Google/Supabase 계정 설정, 실제 휴대폰 문자 발송과 Windows 실행은 로컬 자동 테스트와 별도로 확인합니다.
