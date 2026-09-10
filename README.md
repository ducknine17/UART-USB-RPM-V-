# Fardriver UART Monitor

Fardriver ND72680 컨트롤러를 USB-UART 케이블로 노트북에 연결했을 때, 브라우저에서 COM 포트를 직접 열어 RAW HEX 로그와 전압/RPM 후보 값을 보는 웹사이트입니다.

## 실행

PowerShell에서 이 폴더로 들어온 뒤 실행합니다.

```powershell
node server.js
```

그다음 Chrome 또는 Edge에서 엽니다.

```text
http://localhost:5173
```

`file://`로 `index.html`을 직접 열면 Web Serial API가 막힐 수 있습니다. 반드시 `localhost` 주소로 여는 쪽이 좋습니다.

## 사용 흐름

1. USB-UART 케이블을 노트북에 꽂습니다.
2. 장치 관리자에서 COM 포트가 잡혔는지 확인합니다.
3. 웹사이트에서 통신 속도는 기본값 `19200`으로 둡니다.
4. `컨트롤러 연결`을 누르고 해당 COM 포트를 선택합니다.
5. 원본 로그가 들어오면 `원본 Excel`, 해석 값이 잡히면 `RPM/전압 Excel`로 저장합니다.

## 현재 파서 기준

이 앱은 `jackhumbert/fardriver-controllers`의 역분석 자료를 기준으로 시작합니다.

- 상태 프레임은 보통 16바이트
- 시작 바이트는 `0xAA`
- 주소는 프레임의 `id`를 `flash_read_addr` 테이블로 변환
- `Addr E8`: 전압 `int16le(bytes 2-3) / 10`, 라인 전류 `int16le(bytes 6-7) / 4`
- `Addr E2`: RPM 후보 `uint16le(bytes 8-9)`

RPM은 실제 ND72680 로그와 공식 프로그램 값을 맞춰보면서 확정해야 합니다. 그래서 화면에도 `RPM 후보`라고 표시했습니다.
