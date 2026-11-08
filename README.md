# NOTAM · 항적 확인 웹앱 (iPhone)

지정한 지역(공항 ICAO 코드 또는 위경도 + 반경 NM)과 시간창(KST)에 대해

- **NOTAM**: 시간창과 유효기간이 겹치고, 지역 반경 안에 걸치는 것만 추려서 목록·지도에 표시
  (E항목 좌표로 다각형·원 구역을 그리고, 기준점 포함 여부와 거리, D항목 일일 시간대 겹침까지 판정)
- **항공기**: 반경 안의 ADS-B 항공기를 실시간 표시(10초 갱신), 앱을 켜둔 동안 항적 선을 누적, 근접 경보(거리·고도)

> ⚠︎ 참고용 도구입니다. 비행 전 공식 브리핑(AIM Korea, 관할 관제기관)으로 반드시 확인하세요.
> ADS-B 미장착/미송출 항공기(군용기, 다수 소형기·무인기)는 보이지 않습니다.
> 항공기는 **현재 시각 기준**이며, 미래 시각의 항적은 원리상 알 수 없습니다.

## 구성

| 파일 | 역할 |
|---|---|
| `index.html`, `notam.js`, `sw.js`, `manifest.webmanifest`, `icon*` | GitHub Pages에 올리는 앱 |
| `worker/worker.js`, `worker/wrangler.toml` | Cloudflare Worker 중계 서버 (API 키 보관 + CORS 해결) |

중계 서버가 필요한 이유: FAA NOTAM API는 비밀키가 필요해 웹페이지에 넣을 수 없고, 대부분의 ADS-B API는 브라우저 직접 호출(CORS)을 막습니다.

## 1. 앱 배포 (GitHub Pages)

1. 새 저장소(예: `notam-traffic`)를 만들고 `worker/` 폴더를 뺀 파일을 루트에 올림
2. Settings → Pages → Branch `main` / root → Save
3. iPhone Safari에서 `https://<계정>.github.io/notam-traffic/` 열기 → 공유 → **홈 화면에 추가**

## 2. 중계 서버 배포 (Cloudflare Workers, 무료)

```bash
npm i -g wrangler
cd worker
wrangler login
wrangler deploy                      # → https://notam-relay.<계정>.workers.dev
wrangler secret put FAA_CLIENT_ID    # NOTAM 자동 조회를 쓰려면
wrangler secret put FAA_CLIENT_SECRET
# (선택) OpenSky 백업 소스용
wrangler secret put OPENSKY_CLIENT_ID
wrangler secret put OPENSKY_CLIENT_SECRET
```

`wrangler.toml`의 `ALLOWED_ORIGIN`을 본인 GitHub Pages 주소로 맞추세요.
앱의 ⚙︎ 설정에 Worker URL을 입력하면 끝.

### FAA NMS API 키 받기
FAA는 2026년 4월부터 NOTAM 배포를 NMS(NOTAM Management Service)로 전환했습니다.
`NOTAMS@faa.gov`로 NMS-API 접근을 요청하면 client ID/secret을 받습니다.
FAA가 국제 NOTAM(RKRR FIR, RK** 비행장)을 함께 배포하지만, 누락이 있을 수 있습니다.

키가 없어도: **NOTAM 붙여넣기** 버튼에 AIM Korea 등에서 복사한 원문을 붙이면
같은 필터·지도 표시가 됩니다(오프라인에서도 동작). 항적은 키 없이 동작합니다.

## 동작 확인

브라우저에서 `https://notam-relay.<계정>.workers.dev/traffic?lat=37.46&lon=126.44&r=20` 를 열어
`aircraft` 배열이 나오면 항적 중계가 정상입니다. `/notam?lat=..&lon=..&r=..&loc=RKRR,RKSI` 의
`errors`에 NMS 오류 메시지가 보이면 키/권한을 확인하세요.

## 데이터 소스 순서

- 항적: airplanes.live → adsb.fi → adsb.lol → OpenSky (앞 소스가 실패하면 다음으로)
- NOTAM: FAA NMS (지역 비행장 코드 + RKRR + 위경도·반경 질의 병합, 엣지 캐시 5분), 붙여넣은 원문
- 마지막 NOTAM 조회 결과는 기기에 저장되어, 통신이 끊기면 그 결과를 보여줍니다.

## 알려진 한계

- 내장 비행장 좌표는 근사값입니다. 시험장 정확 좌표는 '좌표' 모드로 입력하세요.
- NMS GeoJSON의 세부 필드 구조는 공개 문서가 부족해, 응답 안에서 ICAO 원문(Q)…E))을 찾아 쓰는 방식으로 구현했습니다. 키 발급 후 첫 조회에서 `errors`나 빈 결과가 나오면 응답 예시를 알려주세요. 맞춰 수정하겠습니다.
- D항목은 단순 일일 시간대(`0000-0900`, `DAILY 2300-0600`)만 자동 판정하고, 요일·날짜가 섞인 형식은 경고만 표시합니다.
