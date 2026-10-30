# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

(주)데모의 고객·묘지·현장 작업·작업 보고·청구 및 입금 업무를 관리한다. PC는 Electron, 휴대폰은 Capacitor에서 동일한 웹 기술을 사용한다.

## Users

`docs/access.md` 기준으로 사장님·마스터는 PC·모바일 전체 기능을 사용한다. 부마스터·관리자(사무실 직원)는 PC에서 권한에 맞는 업무를, 영업은 PC 신규 등록 화면만, 일반 작업자는 휴대폰에서 배정 작업과 조회를 수행한다.

## Capabilities and Constraints

- 고객 표의 한 행은 묘지 하나를 나타낸다. 비어 있는 금액과 0원은 구분한다.
- 고객 관리, 신규 등록, 삭제 목록과 복원, 지역별 엑셀 편집, 작업 관리, 지도, 직원 계정과 작업 보고 기능이 있다.
- 자료 공유는 자동 동기화를 기본으로 한다. 역할별 금융 자료 접근 제한을 유지한다.
- 문자 최종 검토, 실제 발송 결과, 입금 결과를 구분한다.
- 업무 현황은 현재 비어 있는 화면을 유지한다.

## Brand Commitments

사용자가 승인한 중성색 Haulix/Apple 시안을 전체 프로그램에 적용한다. 초록색 기운을 제거하고 기존 데모 로고의 형태를 유지한다. 고객 목록 아래에 선택한 고객이나 금액 요약을 추가하지 않는다.

## Evidence on Hand

제품 기능의 근거는 `docs/usage.md`, `docs/access.md`, `docs/maps.md`, `docs/work-reports.md`와 기존 구현이다. 이번 시각 검증은 가상 고객 자료를 사용한다.
