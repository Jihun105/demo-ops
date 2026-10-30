# 지도 행정경계 데이터

`src/ui/map-frame/boundaries.js`는 **2026-07-01 버전**의 공개 행정동 경계를 시군 단위로 병합한 표시용 데이터입니다. 경기도 31개 시군과 서울특별시·인천광역시, 총 33개 지역을 포함합니다. 최신 공식 경계를 실시간 조회하는 기능은 아닙니다.

## 출처와 재현 정보

- 원자료: [통계청 통계지리정보서비스(SGIS)](https://sgis.kostat.go.kr), 공공누리 제1유형(출처표시).
- 변경 이력 반영 및 경계 보정: [vuski/admdongkor](https://github.com/vuski/admdongkor), 데이터 라이선스 CC BY 4.0. 이 저장소의 코드 라이선스 MIT와 데이터 라이선스는 별개입니다.
- 파일: `ver20260701/HangJeongDong_ver20260701.geojson`.
- [고정 커밋 원본 다운로드](https://raw.githubusercontent.com/vuski/admdongkor/7360288277dfd12d74e54b959c59bdd66f852e3a/ver20260701/HangJeongDong_ver20260701.geojson).
- 원본 파일의 마지막 변경 커밋: `7360288277dfd12d74e54b959c59bdd66f852e3a` (2026-08-26).
- 취득일: 2026-09-21.
- SHA-256: `c01ef44a0eb00978662ba7a6240ccb1da287fb52abd85104a1758969d391132f`.
- [데이터 이용 조건](https://github.com/vuski/admdongkor/blob/master/LICENSE-DATA), [CC BY 4.0 전문](https://creativecommons.org/licenses/by/4.0/), [공공누리 제1유형](https://www.kogl.or.kr/info/licenseType1.do).

공식 자료를 먼저 확인했습니다. [경기데이터드림 시군구 위치정보](https://data.gg.go.kr/portal/data/service/selectServicePage.do?infId=5F1NWHBFEUWN3MHBWOY138146127&infSeq=3)는 이번 취득 과정에서 공개 페이지의 직접 다운로드 파일을 확인하지 못했습니다. [SGIS 자료제공 목록](https://link.mods.go.kr/view/pss/openDataIntrcn)은 공식 SHP 경계 자료를 안내하지만 자료신청 절차가 있습니다. 계정·키를 새로 발급하지 않고 재현 가능한 좌표 파일을 포함하기 위해 SGIS 파생 공개 데이터를 사용했습니다.

## 가공과 한계

1. WGS84 / EPSG:4326 원본에서 경기도·서울·인천의 행정동을 선택했습니다.
2. 경기도의 일반구(예: 수원시장안구, 부천시원미구)는 시 단위로 합치고 서울·인천은 시도 단위로 합쳤습니다.
   업무 현황 지도용으로 서울의 구를 업무 구역(북부·서부·동부, `src/ui/model.js`의 `SEOUL`과 같은 표)별로 합친 세 조각을
   `seoulZones`에 따로 둡니다. `regions`의 33개 지역 도형은 이 추가 전과 같습니다.
3. Shapely 2.1.2로 도형 유효성을 보정하고 0.000001도 격자에서 병합했습니다.
4. 각 지역 도형에 `simplify(0.00015, preserve_topology=True)`를 적용했습니다. 표시용 단순화 허용값은 위도 기준 약 17m이며, 경위도 좌표는 소수점 6자리로 저장했습니다. 섬 및 구멍을 임의로 제거하지 않았습니다.
5. 단순화 전후 도형 면적의 최대 상대 변화는 약 **0.049%**입니다. 경위도 평면에서 계산한 상대 비교이며 측량 면적이 아닙니다.

읍면동 내부 경계는 병합됩니다. 원본의 미세한 경계 불일치 및 지역별 단순화로 인한 작은 틈·겹침이 있을 수 있습니다. 데이터 제공자는 정확성과 완전성을 보증하지 않습니다. 지도에서 지역 범위를 이해하기 위한 표시용 경계이며 필지·법적 관할 판정에 사용하지 않습니다.

## 출처 표기

데스크톱은 설정 맨 아래의 **라이선스 및 출처**를 누르면 출처·라이선스·가공 내용을 펼쳐 보여줍니다. 출처 및 라이선스 주소는 이 문서와 배포 데이터의 메타데이터에 보존합니다. 전체 출처 문구는 JS의 `attribution`에도 보존되어 있습니다.

> 본 데이터는 통계청 통계지리정보서비스(SGIS, https://sgis.kostat.go.kr)에서 공공누리 제1유형으로 개방한 행정동 경계를 가공한 것이며(가공: vuski/admdongkor, https://github.com/vuski/admdongkor), CC BY 4.0으로 배포됩니다. 이 앱에서 시군 병합·경계 단순화를 적용했습니다.

## 데이터 인터페이스와 재생성

`window.DemoBoundaries.regions['부천']` 등은 항상 GeoJSON MultiPolygon 좌표 배열입니다. 구조는 `polygons → rings → [경도, 위도]`이며 각 polygon의 첫 ring은 외곽, 나머지는 구멍입니다. 지도 프레임(`src/ui/map-frame/frame.js`)은 각 좌표를 `kakao.maps.LatLng(위도, 경도)`로 바꾸고, polygon 하나의 ring 배열 전체를 `kakao.maps.Polygon`의 `path`로 전달하여 섬과 구멍을 보존합니다.

```sh
python3 -m venv /tmp/demo-boundary-venv
/tmp/demo-boundary-venv/bin/pip install shapely==2.1.2
curl -L 'https://raw.githubusercontent.com/vuski/admdongkor/7360288277dfd12d74e54b959c59bdd66f852e3a/ver20260701/HangJeongDong_ver20260701.geojson' -o /tmp/demo-source-boundaries.geojson
/tmp/demo-boundary-venv/bin/python scripts/build-map-boundaries.py /tmp/demo-source-boundaries.geojson
```

생성기는 지역 33개 집합 일치, 도형 유효성, 폐곡선, 좌표 범위를 검사합니다. 결과는 345,059바이트이며 15,052개 좌표점을 포함합니다. 런타임 추가 라이브러리나 외부 데이터 호출은 필요하지 않습니다.
