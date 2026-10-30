---
name: 데모 업무관리
description: 중성색 Haulix/Apple 시안을 적용한 PC·현장 업무 인터페이스
colors:
  primary: '#0a84ff'
  accent-label: '#68b4ff'
  accent-ink: '#101013'
  background: '#171719'
  desktop-panel: '#2a2a2e'
  header: '#303034'
  control: '#343438'
  text: '#f5f5f7'
  desktop-muted: '#aaaab3'
  desktop-silver: '#e5e5ea'
  desktop-line: 'rgb(255 255 255 / 8%)'
  selection: 'rgb(10 132 255 / 12%)'
  mobile-panel: '#28282c'
  mobile-muted: '#b4b4bd'
  mobile-silver: '#e7e7ed'
  mobile-ink: '#242428'
typography:
  desktop-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', 'Malgun Gothic', 'Segoe UI', sans-serif"
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.5
  desktop-heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Pretendard', 'Malgun Gothic', 'Segoe UI', sans-serif"
    fontSize: '25px'
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: '-0.025em'
  mobile-body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', sans-serif"
    fontSize: '16px'
    fontWeight: 400
    lineHeight: 1.55
  mobile-heading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', 'Segoe UI', sans-serif"
    fontSize: '26px'
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: '-0.025em'
rounded:
  desktop-control: '10px'
  mobile-control: '12px'
  desktop-panel: '22px'
  mobile-panel: '24px'
  desktop-segment: '18px'
  mobile-segment: '10px'
spacing:
  compact-gap: '4px'
  workspace-gap: '12px'
  content-gap: '20px'
  mobile-panel-block: '24px'
  mobile-panel-inline: '20px'
components:
  desktop-button-primary:
    backgroundColor: '{colors.primary}'
    textColor: '{colors.accent-ink}'
    rounded: '{rounded.desktop-control}'
    padding: '0 20px'
    height: '38px'
  desktop-button-secondary:
    backgroundColor: '{colors.control}'
    textColor: '{colors.text}'
    rounded: '{rounded.desktop-control}'
    padding: '8px 14px'
  mobile-button-primary:
    backgroundColor: '{colors.mobile-silver}'
    textColor: '{colors.mobile-ink}'
    rounded: '{rounded.mobile-control}'
    padding: '11px 16px'
  desktop-segment-selected:
    backgroundColor: '{colors.desktop-silver}'
    textColor: '{colors.mobile-ink}'
    rounded: '{rounded.desktop-segment}'
    padding: '8px 16px'
  mobile-segment-selected:
    backgroundColor: '{colors.mobile-silver}'
    textColor: '{colors.mobile-ink}'
    rounded: '{rounded.mobile-segment}'
    padding: '10px 8px'
---

# Design System: 데모 업무관리

## Overview

**Creative North Star: "중성색 Haulix/Apple"**

사용자가 승인한 시안을 기준으로 짙은 회색 바탕, 은색 선택 상태, 둥근 연속 표면을 사용한다. PC는 밀도 있는 표와 작은 도구 모음, 모바일은 넓은 터치 영역과 하단 탐색을 유지한다. 기존 데모 로고의 형태는 보존하고 색만 은색으로 바꾼다.

**Key Characteristics:**

- 차콜 바탕과 은색 선택 상태.
- 제한된 파란색 강조와 별도의 밝은 파란색 텍스트.
- 떠 있는 탐색 영역과 둥근 연속 업무 표면.

근거: `src/ui/styles.css`, `src/ui/map.css`, `mobile/src/styles.css`와 승인된 시안. 토큰은 현재 구현값이며, PC와 모바일의 명시된 차이를 유지한다.

## Colors

### Primary

파란색 강조는 PC 주요 버튼, 모바일 검색 버튼, 포커스·선택 테두리에 사용한다. 작은 파란색 글자는 밝은 `accent-label`을 사용하며, 파란색 버튼에는 어두운 글자를 배치한다.

### Neutral

공통 바탕과 글자색 위에 PC의 얕은 회색 그라데이션 표면과 모바일의 단색 표면을 배치한다. 보조 글자와 선택 상태의 은색은 기기별 토큰을 따른다. 행 구분선은 표면에 묻히는 얇은 선이며, 색상으로 금액이나 업무 상태의 의미를 대체하지 않는다.

## Typography

운영체제 글꼴과 한국어 폴백을 사용한다. PC 기본 글자는 작고 조밀하며 제목은 중간 굵기다. 모바일 입력은 기본 글자 크기를 유지해 iPhone 입력 시 자동 확대를 방지한다. 모바일 제목은 작은 화면에서 26px, 720px 이상에서 30px이다. 금액·좌표에는 `tabular-nums`를 적용한다.

## Layout

PC는 34px 제목 표시줄 아래에 탐색 레일과 유동적인 콘텐츠를 배치한다. 레일 기본 너비는 72px이며 기존 드래그·키보드 조절과 저장된 너비를 유지한다. 고객 표는 업무 표면을 채우고 가로·세로 스크롤을 사용한다. 960px 이하에서는 고객 도구 모음이 줄바꿈된다.

모바일 콘텐츠의 최대 너비는 860px이다. 기본 화면 여백은 좌우 12px, 표면 내부는 24px 20px이며 380px 이하에서 좌우 내부 여백을 16px로 줄인다. 하단 탐색은 최대 680px이며 바닥·좌우 12px와 안전 영역을 확보한다. 버튼은 기본 48px, 보조 조작은 최소 44px, 하단 메뉴는 60px 높이를 사용한다.

## Elevation & Depth

깊이는 회색 표면 차이와 얕은 안쪽 하이라이트·아래쪽 그림자로 표현한다. PC 업무 표면은 `linear-gradient(145deg, #303034, #28282c)`와 `inset 0 1px rgb(255 255 255 / 4.5%), 0 3px 12px rgb(0 0 0 / 12%)`를 사용한다. 모바일 업무 표면은 단색과 `inset 0 1px #ffffff0b, 0 4px 16px #0000001f`를 사용한다. 대화상자와 하단 탐색에는 더 큰 아래쪽 그림자를 적용한다.

## Shapes

업무 표면은 PC 22px, 모바일 24px의 둥근 모서리를 사용한다. PC 레일은 26px, 접힌 메뉴 버튼은 원형이다. 기본 조작은 PC 10px·모바일 12px이며, 선택 세그먼트는 각 기기의 토큰을 따른다. 표와 결과 목록의 행은 개별 카드로 나누지 않고 같은 표면 안에서 구분한다.

## Components

- **Buttons:** PC 주요 조작은 파란색 바탕과 어두운 글자, 모바일 주요 조작은 은색 바탕과 어두운 글자다. 보조 조작은 회색이며 비활성 상태는 투명도를 낮춘다.
- **Inputs:** 회색 입력 표면과 파란 포커스 표시를 사용한다. 조회·편집을 같은 자리에서 수행하는 기존 상세 입력 방식은 유지한다.
- **Navigation:** PC는 원형 레일 버튼, 모바일은 둥근 하단 탐색을 사용한다. 선택 상태는 은색 바탕이다. 접힌 PC 메뉴도 이름과 툴팁을 유지한다.
- **Segments / chips:** 탭과 상태 필터는 회색 묶음 안에서 선택 항목을 은색으로 표시한다. 지역 선택 칩의 파란 글자는 밝은 텍스트 토큰을 사용한다.
- **Tables / lists:** 표 제목과 보조 정보는 작은 회색 글자, 본문은 밝은 글자, 금액은 우측 정렬과 일정한 숫자 폭을 사용한다.
- **Dialogs / feedback:** 확인·사진·위치·편집 대화상자는 같은 중성색 표면을 사용한다. 오류·삭제 조작은 기존 붉은 색 계열로 구분하고 설명과 복구 조작을 유지한다.

버튼의 짧은 색상 전환은 움직임을 줄이는 설정에서 제거한다. 현재 화면에 별도의 진입 애니메이션은 없다.

## Do's and Don'ts

- **Do** 공통 차콜 바탕, 은색 선택 상태와 기기별 토큰을 이어 사용한다.
- **Do** 작은 파란색 글자에는 밝은 텍스트 토큰을 사용한다.
- **Do** 한국어 글꼴 폴백, 숫자 정렬, 키보드 포커스와 모바일 안전 영역을 유지한다.
- **Don't** 초록색 기운이나 새로운 강조색을 UI에 추가한다.
- **Don't** 연속 표·목록을 개별 장식 카드로 나눈다.
- **Don't** 디자인 변경으로 기존 업무 동작·권한·데이터 표시의 의미를 바꾼다.
