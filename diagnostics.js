"use strict";

function newDiagnostics() {
  return {
    connectedAt: 0, lastUsbAt: 0, lastStatusAt: 0, lastUartAt: 0, lastValidAt: 0,
    validFrames: 0, crcErrors: 0, protocolErrors: 0, streamGaps: 0,
    status: null, nextOffset: null, textBuffer: "", decoder: new TextDecoder(),
    error: "", sample: false,
  };
}

function updateSourceUi() {
  const teensy = ui.sourceSelect.value === "teensy";
  ui.usbStageLabel.textContent = teensy ? "1 · 틴시 → 컴퓨터" : "1 · USB-UART → 컴퓨터";
  ui.baudLabel.textContent = teensy ? "USB 포트 속도 (UART와 별개)" : "컨트롤러 UART 속도";
  ui.baudSelect.disabled = teensy || state.readActive;
  renderDiagnostics();
}

function handleSerialBytes(value) {
  const d = state.diagnostics;
  d.lastUsbAt = Date.now();
  if (ui.sourceSelect.value !== "teensy") {
    handleIncomingBytes(value);
    return;
  }
  d.textBuffer += d.decoder.decode(value, { stream: true });
  let newline;
  while ((newline = d.textBuffer.indexOf("\n")) !== -1) {
    const line = d.textBuffer.slice(0, newline).trim();
    d.textBuffer = d.textBuffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (!acceptDiagnosticMessage(message)) d.protocolErrors += 1;
    } catch {
      d.protocolErrors += 1;
    }
  }
  // Recover from an old sketch or a raw UART port selected in diagnostic mode.
  if (d.textBuffer.length > 8192) {
    d.textBuffer = "";
    d.protocolErrors += 1;
  }
  scheduleRender();
}

function acceptDiagnosticMessage(message) {
  if (!message || message.v !== 1) return false;
  const d = state.diagnostics;
  const uint = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
  if (message.type === "status") {
    if (![message.uptimeMs, message.rxTotal, message.rxRecent, message.usbDropped].every(uint) ||
        !Number.isInteger(message.baud) || message.baud <= 0 || message.baud > 10000000) return false;
    // A reboot or millis() rollover breaks continuity; do not join old/new bytes.
    if (d.status && message.uptimeMs < d.status.uptimeMs) {
      state.rxBuffer = [];
      state.latest = { voltage: null, rpmCandidate: null, lineCurrent: null, mosTemp: null, motorTemp: null };
      d.nextOffset = null;
      d.lastValidAt = 0;
      d.lastUartAt = 0;
      d.streamGaps += 1;
    }
    d.status = message;
    d.lastStatusAt = Date.now();
    if (message.rxRecent > 0) d.lastUartAt = Date.now();
    return true;
  }
  if (message.type === "data") {
    if (!uint(message.offset) || typeof message.hex !== "string" ||
        !/^(?:[0-9a-fA-F]{2}){1,64}$/.test(message.hex)) return false;
    const bytes = Uint8Array.from(message.hex.match(/../g), (hex) => parseInt(hex, 16));
    if (d.nextOffset !== null && d.nextOffset !== message.offset) {
      state.rxBuffer = [];
      d.streamGaps += 1;
    }
    d.nextOffset = (message.offset + bytes.length) >>> 0;
    handleIncomingBytes(bytes);
    return true;
  }
  return false;
}

// Pure diagnosis: observations only. Never claim that a particular wire is broken.
function diagnose(d, { active, source, byteCount }, now = Date.now()) {
  const card = (level, title, detail) => ({ level, title, detail });
  const result = {
    usb: card("idle", "연결 대기", "아직 수신 장치와 연결하지 않았습니다."),
    uart: card("idle", "수신 대기", "UART에서 들어온 바이트를 확인합니다."),
    frame: card("idle", "검사 대기", "알려진 16바이트 상태 프레임의 CRC를 검사합니다."),
    next: "Teensy 진단 코드를 업로드하고 시리얼 모니터를 닫은 뒤, 장치 연결을 누르세요.",
  };
  if (source === "adapter") result.next = "USB-UART 어댑터를 연결하고, 이전에 성공한 UART 속도를 선택한 뒤 장치 연결을 누르세요.";
  if (d.sample) {
    result.usb = card("warn", "샘플 표시 중", "실제 장치 연결이나 수신 성공을 의미하지 않습니다.");
    result.uart = card("warn", "가상 바이트", "샘플은 사이트 내부에서 만든 데이터입니다.");
    result.frame = card("warn", "가상 프레임", "실험 결과로 사용하지 마세요.");
    result.next = "실제 장치에 연결하면 샘플을 지우고 새로 진단합니다.";
    return result;
  }
  if (d.error) {
    result.usb = card("error", "연결 / 읽기 오류", d.error);
    result.next = "다른 시리얼 모니터와 사이트의 포트 사용을 종료하고, USB 케이블·포트·업로드를 확인한 뒤 다시 연결하세요.";
    return result;
  }
  if (!active) {
    if (d.connectedAt) {
      result.usb = card("idle", "연결 해제됨", "아래 로그와 값은 이전 수신 기록입니다.");
      result.next = "장치를 다시 연결해 현재 상태를 확인하세요.";
    }
    return result;
  }
  if (source === "teensy") {
    if (!d.lastStatusAt || now - d.lastStatusAt > 3500) {
      const waiting = !d.lastStatusAt && now - d.connectedAt < 3500;
      result.usb = card(waiting ? "idle" : "warn", waiting ? "틴시 상태 기다리는 중" : "틴시 상태 보고 없음",
        d.lastUsbAt ? "USB 바이트는 도착했지만 새 진단 상태를 확인하지 못했습니다." : "COM 포트는 열렸지만 틴시의 상태 보고가 도착하지 않았습니다.");
      result.next = waiting ? "컨트롤러 없이도 틴시는 약 1초마다 상태를 보냅니다. 잠시 기다리세요." :
        "새 teensy_uart_web_diagnostic 코드를 업로드했는지, Teensy 포트와 연결 장치 선택이 맞는지 확인하세요. USB 바이트만으로 틴시 진단 프로그램 실행을 확정할 수는 없습니다.";
      return result;
    }
    result.usb = card("ok", "틴시 실행 · USB 수신 확인", `${((now - d.lastStatusAt) / 1000).toFixed(1)}초 전 상태 보고 도착`);
  } else {
    result.usb = card("ok", "COM 포트 열림", "직접 연결 모드에서는 어댑터 자체 상태 보고가 없습니다. 컨트롤러 연결 확인과는 다릅니다.");
  }
  const receiving = d.lastUartAt && now - d.lastUartAt < 5000;
  if (!receiving) {
    result.uart = card("warn", "최근 UART 수신 없음", byteCount || d.status?.rxTotal ? "이전 수신 기록은 있지만 최근 약 5초간 새 바이트가 확인되지 않았습니다." : "아직 UART 바이트가 확인되지 않았습니다.");
    result.next = "컨트롤러 정상 전원 → 실제 출력선과 틴시 0번(RX1) → 통신 GND → 신호 전압·UART 속도를 확인하세요. 모두 맞으면 컨트롤러 송신 상태나 시작 요청 필요 여부를 조사합니다.";
  } else {
    result.uart = card("ok", "UART 바이트 수신 중", `사이트에 전달된 원본 ${byteCount.toLocaleString()}바이트 · 수신만으로 올바른 값인지는 알 수 없습니다.`);
    result.next = "바이트는 도착합니다. 정상 프레임과 CRC가 확인되는지 확인하세요.";
  }
  if (d.lastValidAt && now - d.lastValidAt < 5000) {
    result.frame = card("ok", "CRC 정상 프레임 수신", `누적 ${d.validFrames}개 · 전압/RPM 해석은 실제 값과 비교해야 합니다.`);
    if (receiving) result.next = "알려진 형식의 정상 프레임을 받았습니다. 전압을 먼저 실제 값과 비교하고, RPM 후보를 검증하세요.";
  } else if (byteCount > 0 || receiving) {
    result.frame = card("warn", "최근 정상 프레임 미확인", `CRC 정상 누적 ${d.validFrames}개 / CRC 불일치 후보 ${d.crcErrors}개. 속도·노이즈·다른 형식 또는 짧은 데이터일 수 있습니다.`);
    if (receiving) result.next = "수신 바이트는 있지만 최근 정상 프레임이 없습니다. UART 속도를 이전 성공 조건과 비교하고, 원본 로그를 확인하세요. CRC가 맞지 않는 값은 계기판에 반영하지 않습니다.";
  }
  if (d.status?.usbDropped > 0 || d.streamGaps > 0 || d.protocolErrors > 0) {
    result.next += ` 참고: USB 중계 누락 누적 ${d.status?.usbDropped || 0}바이트(사이트 연결 전 포함), 바이트 연속성 변경 ${d.streamGaps}회, 진단 형식 오류 ${d.protocolErrors}회. 진단 결과를 저장해 확인하세요.`;
  }
  return result;
}

function currentDiagnosis() {
  return diagnose(state.diagnostics, {
    active: state.readActive, source: ui.sourceSelect.value, byteCount: state.byteCount,
  });
}

function renderDiagnostics() {
  const result = currentDiagnosis();
  for (const key of ["usb", "uart", "frame"]) {
    ui[`${key}Card`].dataset.level = result[key].level;
    ui[`${key}Diagnosis`].textContent = result[key].title;
    ui[`${key}Detail`].textContent = result[key].detail;
  }
  ui.nextCheck.textContent = result.next;
  ui.diagnosticMode.textContent = state.diagnostics.sample ? "샘플 · 실측 아님" :
    ui.sourceSelect.value === "teensy" ? "Teensy 수신 진단" : "USB-UART 직접 수신";
  const status = state.diagnostics.status;
  ui.deviceStats.textContent = status ?
    `틴시 보고: UART ${status.baud}bps · 누적 수신 ${status.rxTotal}바이트 · 직전 보고 구간 ${status.rxRecent}바이트 · 실행 ${(status.uptimeMs / 1000).toFixed(0)}초. 틴시 누적은 부팅부터, 사이트 누적은 연결/비우기 이후입니다.` :
    ui.sourceSelect.value === "teensy" ? "틴시 UART 속도는 스케치의 UART_BAUD(기본 19200)입니다. USB 포트 속도와 별개입니다." :
    `어댑터 UART 설정: ${ui.baudSelect.value}bps, 8N1`;
}

function exportDiagnosticReport() {
  const d = state.diagnostics;
  const report = {
    generatedAt: new Date().toISOString(), source: ui.sourceSelect.value, sample: d.sample,
    connected: state.readActive, diagnosis: currentDiagnosis(),
    connectionStartedAt: d.connectedAt ? new Date(d.connectedAt).toISOString() : null,
    lastStatusAt: d.lastStatusAt ? new Date(d.lastStatusAt).toISOString() : null,
    lastUartAt: d.lastUartAt ? new Date(d.lastUartAt).toISOString() : null,
    baudRate: ui.sourceSelect.value === "teensy" ? d.status?.baud ?? null : Number(ui.baudSelect.value),
    bytes: state.byteCount, validFrames: d.validFrames, crcErrors: d.crcErrors,
    protocolErrors: d.protocolErrors, streamGaps: d.streamGaps, deviceStatus: d.status,
    recording: state.recording, rawLog: state.rawRows.slice(-200),
    limitations: "배선·전압·요청 필요 여부는 이 보고서만으로 확정할 수 없습니다. CRC와 항목 해석은 역분석 자료 기준입니다.",
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fardriver_diagnostic_${fileTimestamp()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
