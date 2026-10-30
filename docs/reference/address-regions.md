# 주소 선택 지역 데이터

`src/ui/address-regions.js`는 신규 등록의 시도 → 시·군·구 선택에 사용하는 오프라인 목록입니다. **2026-07-01 기준** 16개 시도와 229개 하위 선택지를 포함합니다. 세종은 별도 하위 선택지가 없으며, 제주의 두 행정시는 선택지에 포함합니다. 이 수는 기초자치단체 수가 아니라 이 화면의 주소 선택지 수입니다.

읍·면·동, 일반구, 도로명, 번지 등은 상세주소에 직접 입력합니다. 주소 검증·검색·자동 완성 자료가 아니며 기존에 저장된 주소를 변경하지 않습니다. 실행 중 외부 조회나 추가 라이브러리는 필요하지 않습니다.

## 출처와 재현 정보

- 원자료: [통계청 통계지리정보서비스(SGIS)](https://sgis.kostat.go.kr), 공공누리 제1유형(출처표시).
- 변경 이력 반영 및 경계 보정: [vuski/admdongkor](https://github.com/vuski/admdongkor), 데이터 라이선스 CC BY 4.0.
- 파일: `ver20260701/HangJeongDong_ver20260701.geojson`.
- [고정 커밋 원본](https://raw.githubusercontent.com/vuski/admdongkor/7360288277dfd12d74e54b959c59bdd66f852e3a/ver20260701/HangJeongDong_ver20260701.geojson).
- 원본 파일의 마지막 변경 커밋: `7360288277dfd12d74e54b959c59bdd66f852e3a` (2026-08-26).
- 취득·확인일: 2026-10-13.
- SHA-256: `c01ef44a0eb00978662ba7a6240ccb1da287fb52abd85104a1758969d391132f`.
- [데이터 이용 조건](https://github.com/vuski/admdongkor/blob/master/LICENSE-DATA), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [공공누리 제1유형](https://www.kogl.or.kr/info/licenseType1.do).

기존 [지도 행정경계 데이터](map-boundaries.md)와 동일한 고정 원본 및 SHA-256을 사용합니다. 좌표는 포함하지 않고 `properties.sidonm`, `properties.sggnm`의 지역 이름만 추출했습니다. 원본의 데이터 라이선스는 저장소 코드의 MIT 라이선스와 별개입니다.

## 선택 목록으로 가공한 규칙

1. `sidonm`을 시도 이름으로 사용합니다.
2. `sggnm`의 일반구를 시로 병합합니다. 예를 들어 `부천시원미구`, `부천시소사구`, `부천시오정구`는 모두 `부천시` 하나가 됩니다. `원미구`는 상세주소에 입력합니다. 화성·청주·천안·전주·포항·창원 등에도 같은 규칙을 적용합니다.
3. 특별·광역시의 자치구·군은 그대로 제공합니다. 전남광주통합특별시의 시·군·구도 원본대로 제공합니다.
4. 세종특별자치시의 원본 하위 이름 `세종시`는 중복 입력이므로 빈 배열로 만듭니다. 제주특별자치도에는 `서귀포시`, `제주시`를 유지합니다.
5. 시도별 하위 이름은 중복을 제거하고 가나다순으로 정렬합니다.

다음 명칭과 개편은 2026-10-13에 공식 안내로 교차 확인했습니다.

- 인천: 제물포구·영종구·서해구·검단구를 포함한 2군·9구. 예전 `중구`, `동구`, `서구`는 신규 선택지에 포함하지 않습니다. [인천시 행정체제 개편 개요](https://www.incheon.go.kr/IC01070101), [인천시 자치군·구 목록](https://www.incheon.go.kr/IC040218).
- 광주·전남: 2026-07-01 출범한 `전남광주통합특별시`에 27개 시·군·구를 포함합니다. 따라서 이 원본의 시도 수는 17개가 아닌 16개입니다. [통합특별시 누리집](https://www.jeonnam-gwangju.go.kr/main.do), [(구)전라남도 공식 누리집의 출범 안내](https://www.jeonnam.go.kr/), [(구)광주광역시 공식 누리집](https://www.gwangju.go.kr/main.do).
- `강원특별자치도`, `전북특별자치도`의 현행 명칭을 사용합니다. [강원특별자치도의회](https://council.gangwon.kr/), [전북특별자치도](https://www.jeonbuk.go.kr/index.do).

## 갱신 및 검증

고정 원본을 내려받아 SHA-256을 확인한 뒤, 아래와 같이 이름 목록을 추출할 수 있습니다. 원본 버전을 변경할 때에는 공식 행정구역 안내도 다시 확인하고 JS의 `source`, 이 문서, 테스트의 지역 수를 함께 갱신합니다.

```sh
curl --fail --location 'https://raw.githubusercontent.com/vuski/admdongkor/7360288277dfd12d74e54b959c59bdd66f852e3a/ver20260701/HangJeongDong_ver20260701.geojson' --output /tmp/demo-address-source-boundaries.geojson
shasum -a 256 /tmp/demo-address-source-boundaries.geojson
python3 - <<'PY'
import json
import re

regions = {}
with open('/tmp/demo-address-source-boundaries.geojson') as source:
    for feature in json.load(source)['features']:
        properties = feature['properties']
        province = properties['sidonm']
        regions.setdefault(province, set())
        if province != '세종특별자치시':
            city = re.sub(r'시.+구$', '시', properties['sggnm'])
            regions[province].add(city)
print(json.dumps({name: sorted(cities) for name, cities in regions.items()},
                 ensure_ascii=False, indent=2))
PY
node --test tests/registration/address-regions.test.cjs
```

테스트는 브라우저 전역 제공, 시도별 지역 수, 이름 누락·중복, 일반구 병합, 세종·제주 예외와 최근 개편 지역을 확인합니다. `window.DemoAddressRegions.regions[시도명]`은 문자열 배열이며, `source`에 출처·버전·라이선스·가공 내역을 보존합니다.
