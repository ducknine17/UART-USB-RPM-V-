"use strict";

const FLASH_READ_ADDR = [
  0xe2, 0xe8, 0xee, 0x00, 0x06, 0x0c, 0x12,
  0xe2, 0xe8, 0xee, 0x18, 0x1e, 0x24, 0x2a,
  0xe2, 0xe8, 0xee, 0x30, 0x5d, 0x63, 0x69,
  0xe2, 0xe8, 0xee, 0x7c, 0x82, 0x88, 0x8e,
  0xe2, 0xe8, 0xee, 0x94, 0x9a, 0xa0, 0xa6,
  0xe2, 0xe8, 0xee, 0xac, 0xb2, 0xb8, 0xbe,
  0xe2, 0xe8, 0xee, 0xc4, 0xca, 0xd0,
  0xe2, 0xe8, 0xee, 0xd6, 0xdc, 0xf4, 0xfa,
];

const MAX_RAW_ROWS = 1600;
const MAX_PARSED_ROWS = 5000;
const MAX_TABLE_ROWS = 80;
const MAX_PARSED_TABLE_ROWS = 8;
const MAX_GRAPH_POINTS = 220;

const state = {
  port: null,
  reader: null,
  readActive: false,
  recording: true,
  rxBuffer: [],
  rawRows: [],
  parsedRows: [],
  graphRows: [],
  byteCount: 0,
  frameCount: 0,
  latest: {
    voltage: null,
    rpmCandidate: null,
    lineCurrent: null,
    mosTemp: null,
    motorTemp: null,
  },
  pendingRender: false,
  diagnostics: newDiagnostics(),
  readTask: null,
  connecting: false,
};

const ui = {};

document.addEventListener("DOMContentLoaded", () => {
  bindUi();
  bindEvents();
  updateSupportNotice();
  updateConnectionUi("idle", "대기 중");
  renderAll();
  updateSourceUi();
  setInterval(renderDiagnostics, 500);
  window.addEventListener("resize", () => renderCharts());
});

function bindUi() {
  [
    "baudSelect",
    "baudLabel",
    "sourceSelect",
    "usbCard", "usbDiagnosis", "usbDetail", "usbStageLabel",
    "uartCard", "uartDiagnosis", "uartDetail",
    "frameCard", "frameDiagnosis", "frameDetail",
    "nextCheck", "deviceStats", "diagnosticMode", "exportDiagnosticBtn",
    "connectBtn",
    "disconnectBtn",
    "recordBtn",
    "clearBtn",
    "sampleBtn",
    "exportRawBtn",
    "exportParsedBtn",
    "serialStatus",
    "supportNotice",
    "voltageValue",
    "rpmValue",
    "currentValue",
    "mosTempValue",
    "motorTempValue",
    "voltageChart",
    "rpmChart",
    "voltageRange",
    "rpmRange",
    "parserStatus",
    "byteCount",
    "packetCount",
    "frameAddress",
    "crcState",
    "lastPacket",
    "bufferSize",
    "parsedTableBody",
    "rawTableBody",
  ].forEach((id) => {
    ui[id] = document.getElementById(id);
  });
}

function bindEvents() {
  ui.connectBtn.addEventListener("click", connectSerial);
  ui.disconnectBtn.addEventListener("click", disconnectSerial);
  ui.recordBtn.addEventListener("click", toggleRecording);
  ui.clearBtn.addEventListener("click", clearData);
  ui.sampleBtn.addEventListener("click", injectSampleData);
  ui.exportRawBtn.addEventListener("click", exportRawWorkbook);
  ui.exportParsedBtn.addEventListener("click", exportParsedWorkbook);
  ui.exportDiagnosticBtn.addEventListener("click", exportDiagnosticReport);
  ui.sourceSelect.addEventListener("change", () => {
    state.diagnostics = newDiagnostics();
    clearData();
    updateSourceUi();
  });
  ui.baudSelect.addEventListener("change", renderDiagnostics);
}

function updateSupportNotice() {
  if (!("serial" in navigator)) {
    ui.supportNotice.textContent =
      "이 브라우저는 Web Serial API를 지원하지 않습니다. Chrome 또는 Edge에서 localhost 주소로 열어주세요.";
    ui.connectBtn.disabled = true;
    return;
  }

  if (!window.isSecureContext) {
    ui.supportNotice.textContent =
      "COM 포트 접근은 HTTPS 또는 localhost에서만 열립니다. 아래 로컬 서버 주소로 접속해야 합니다.";
    return;
  }

  ui.supportNotice.textContent =
    "기본 파서는 jackhumbert/fardriver-controllers의 16바이트 상태 프레임 구조를 사용합니다.";
}

async function connectSerial() {
  if (state.connecting || state.readActive) return;
  state.connecting = true;
  ui.connectBtn.disabled = true;
  ui.sourceSelect.disabled = true;
  ui.sampleBtn.disabled = true;
  state.diagnostics = newDiagnostics();
  clearData();
  try {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API 미지원");
    }

    const baudRate = Number(ui.baudSelect.value);
    state.port = await navigator.serial.requestPort();
    await state.port.open({
      baudRate,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
      flowControl: "none",
      bufferSize: 4096,
    });

    state.readActive = true;
    state.diagnostics.connectedAt = Date.now();
    ui.connectBtn.disabled = true;
    ui.disconnectBtn.disabled = false;
    ui.baudSelect.disabled = true;
    updateConnectionUi("live", "COM 포트 열림");
    state.readTask = readLoop(state.port);
  } catch (error) {
    state.port = null;
    state.diagnostics.error = toUserError(error);
    updateConnectionUi("error", "연결 실패");
    ui.supportNotice.textContent = toUserError(error);
    ui.connectBtn.disabled = !("serial" in navigator);
    ui.sourceSelect.disabled = false;
    ui.sampleBtn.disabled = false;
  } finally {
    state.connecting = false;
    updateSourceUi();
  }
}

async function readLoop(port) {
  try {
    state.reader = port.readable.getReader();
    while (state.readActive) {
      const { value, done } = await state.reader.read();
      if (done) {
        if (state.readActive) state.diagnostics.error = "장치의 데이터 스트림이 종료되었습니다.";
        break;
      }
      if (value) handleSerialBytes(value);
    }
  } catch (error) {
    if (state.readActive) {
      state.diagnostics.error = toUserError(error);
      ui.supportNotice.textContent = toUserError(error);
    }
  } finally {
    if (state.reader) {
      state.reader.releaseLock();
      state.reader = null;
    }
    state.readActive = false;
    try { await port.close(); } catch { /* The device may already be unplugged. */ }
    state.port = null;
    ui.connectBtn.disabled = !("serial" in navigator);
    ui.disconnectBtn.disabled = true;
    ui.sourceSelect.disabled = false;
    ui.sampleBtn.disabled = false;
    updateConnectionUi(state.diagnostics.error ? "error" : "idle", state.diagnostics.error ? "연결 / 읽기 오류" : "연결 해제됨");
    updateSourceUi();
  }
}

async function disconnectSerial() {
  state.readActive = false;

  try {
    if (state.reader) {
      await state.reader.cancel();
    }
    if (state.readTask) await state.readTask;
  } catch (error) {
    ui.supportNotice.textContent = toUserError(error);
  } finally {
    state.readTask = null;
  }
}

function toggleRecording() {
  state.recording = !state.recording;
  ui.recordBtn.textContent = state.recording ? "기록 중" : "기록 정지";
  ui.recordBtn.setAttribute("aria-pressed", String(state.recording));
}

function clearData() {
  state.rxBuffer = [];
  state.rawRows = [];
  state.parsedRows = [];
  state.graphRows = [];
  state.byteCount = 0;
  state.frameCount = 0;
  state.diagnostics.sample = false;
  state.diagnostics.validFrames = 0;
  state.diagnostics.crcErrors = 0;
  state.diagnostics.lastValidAt = 0;
  ui.frameAddress.textContent = "--";
  ui.crcState.textContent = "--";
  ui.parserStatus.textContent = "RAW 대기";
  ui.lastPacket.textContent = "--";
  state.latest = {
    voltage: null,
    rpmCandidate: null,
    lineCurrent: null,
    mosTemp: null,
    motorTemp: null,
  };
  renderAll();
}

function handleIncomingBytes(value) {
  const bytes = Array.from(value);
  const timestamp = new Date();
  if (bytes.length) state.diagnostics.lastUartAt = timestamp.getTime();

  state.byteCount += bytes.length;
  state.rxBuffer.push(...bytes);

  if (state.recording) {
    pushRawRow({
      timestamp,
      kind: "chunk",
      address: "",
      byteLength: bytes.length,
      rawHex: toHex(bytes),
      frameNo: "",
      id: "",
      flags: "",
      crc: "",
    });
  }

  extractFrames();
  scheduleRender();
}

function extractFrames() {
  while (state.rxBuffer.length >= 16) {
    const startIndex = state.rxBuffer.indexOf(0xaa);

    if (startIndex === -1) {
      const dropped = state.rxBuffer.splice(0);
      pushRawRow({
        timestamp: new Date(),
        kind: "discard",
        address: "",
        byteLength: dropped.length,
        rawHex: toHex(dropped),
        frameNo: "",
        id: "",
        flags: "",
        crc: "",
      });
      break;
    }

    if (startIndex > 0) {
      const dropped = state.rxBuffer.splice(0, startIndex);
      pushRawRow({
        timestamp: new Date(),
        kind: "discard",
        address: "",
        byteLength: dropped.length,
        rawHex: toHex(dropped),
        frameNo: "",
        id: "",
        flags: "",
        crc: "",
      });
    }

    if (state.rxBuffer.length < 16) break;

    const frame = state.rxBuffer.slice(0, 16);
    if (!hasValidCrc(frame)) {
      state.diagnostics.crcErrors += 1;
      ui.crcState.textContent = "CHECK";
      ui.parserStatus.textContent = "CRC 불일치 · 다음 시작점 탐색";
      // Shift by one, so a dropped/corrupt byte cannot hide the next valid frame.
      state.rxBuffer.shift();
      continue;
    }
    state.rxBuffer.splice(0, 16);
    processFrame(frame);
  }
}

function processFrame(frame) {
  if (!hasValidCrc(frame)) return;
  const timestamp = new Date();
  state.diagnostics.validFrames += 1;
  state.diagnostics.lastValidAt = timestamp.getTime();
  const frameNo = ++state.frameCount;
  const id = frame[1] & 0x3f;
  const flags = frame[1] >> 6;
  const address = id < FLASH_READ_ADDR.length ? FLASH_READ_ADDR[id] : null;
  const crcOk = hasValidCrc(frame);
  const parsed = parseKnownFardriverFrame(frame, address);

  pushRawRow({
    timestamp,
    kind: "frame",
    address: formatAddress(address),
    byteLength: frame.length,
    rawHex: toHex(frame),
    frameNo,
    id,
    flags,
    crc: crcOk ? "OK" : "CHECK",
  });

  ui.frameAddress.textContent = formatAddress(address);
  ui.crcState.textContent = crcOk ? "OK" : "CHECK";
  ui.parserStatus.textContent = parsed.keys.length
    ? `${parsed.keys.join(", ")} 업데이트`
    : "프레임 수신";
  ui.lastPacket.textContent = formatTime(timestamp);

  if (!parsed.keys.length) return;

  Object.assign(state.latest, parsed.values);

  const snapshot = {
    timestamp,
    frameNo,
    address: formatAddress(address),
    voltage: state.latest.voltage,
    rpmCandidate: state.latest.rpmCandidate,
    lineCurrent: state.latest.lineCurrent,
    mosTemp: state.latest.mosTemp,
    motorTemp: state.latest.motorTemp,
    source: parsed.keys.join(", "),
    crc: crcOk ? "OK" : "CHECK",
  };

  state.parsedRows.push(snapshot);
  trimArray(state.parsedRows, MAX_PARSED_ROWS);

  if (snapshot.voltage !== null || snapshot.rpmCandidate !== null) {
    state.graphRows.push(snapshot);
    trimArray(state.graphRows, MAX_GRAPH_POINTS);
  }
}

function parseKnownFardriverFrame(frame, address) {
  const values = {};
  const keys = [];

  if (address === 0xe8) {
    values.voltage = int16le(frame, 2) / 10;
    values.lineCurrent = int16le(frame, 6) / 4;
    keys.push("전압", "전류");
  }

  if (address === 0xe2) {
    values.rpmCandidate = uint16le(frame, 8);
    keys.push("RPM 후보");
  }

  if (address === 0xd6) {
    values.mosTemp = int16le(frame, 12);
    keys.push("MOS 온도");
  }

  if (address === 0xf4) {
    values.motorTemp = int16le(frame, 2);
    keys.push("모터 온도");
  }

  return { values, keys };
}

function int16le(bytes, offset) {
  const value = bytes[offset] | (bytes[offset + 1] << 8);
  return value & 0x8000 ? value - 0x10000 : value;
}

function uint16le(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function hasValidCrc(frame) {
  const [hi, lo] = computeFardriverCrc(frame.slice(0, -2));
  return hi === frame[14] && lo === frame[15];
}

function computeFardriverCrc(bytes) {
  const { hiTable, loTable } = getCrcTables();
  let hi = 0x3c;
  let lo = 0x7f;

  bytes.forEach((byte) => {
    const index = hi ^ byte;
    hi = lo ^ hiTable[index];
    lo = loTable[index];
  });

  return [hi & 0xff, lo & 0xff];
}

function getCrcTables() {
  if (getCrcTables.cache) return getCrcTables.cache;

  const hiTable = [];
  const loTable = [];

  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
    hiTable[i] = crc & 0xff;
    loTable[i] = (crc >> 8) & 0xff;
  }

  getCrcTables.cache = { hiTable, loTable };
  return getCrcTables.cache;
}

function pushRawRow(row) {
  if (!state.recording) return;
  state.rawRows.push(row);
  trimArray(state.rawRows, MAX_RAW_ROWS);
}

function trimArray(array, maxLength) {
  if (array.length > maxLength) {
    array.splice(0, array.length - maxLength);
  }
}

function scheduleRender() {
  if (state.pendingRender) return;
  state.pendingRender = true;
  requestAnimationFrame(() => {
    state.pendingRender = false;
    renderAll();
  });
}

function renderAll() {
  renderDiagnostics();
  renderMetrics();
  renderStats();
  renderRawTable();
  renderParsedTable();
  renderCharts();
}

function renderMetrics() {
  ui.voltageValue.textContent = formatNumber(state.latest.voltage, " V", 1);
  ui.rpmValue.textContent = formatInteger(state.latest.rpmCandidate, " rpm");
  ui.currentValue.textContent = formatNumber(state.latest.lineCurrent, " A", 1);
  ui.mosTempValue.textContent = formatNumber(state.latest.mosTemp, " °C", 0);
  ui.motorTempValue.textContent = formatNumber(state.latest.motorTemp, " °C", 0);
}

function renderStats() {
  ui.byteCount.textContent = String(state.byteCount);
  ui.packetCount.textContent = String(state.frameCount);
  ui.bufferSize.textContent = `${state.rxBuffer.length} B`;
}

function renderRawTable() {
  const rows = state.rawRows.slice(-MAX_TABLE_ROWS).reverse();
  if (!rows.length) {
    ui.rawTableBody.innerHTML =
      '<tr><td colspan="5" class="empty">컨트롤러를 연결하면 원본 바이트가 여기에 쌓입니다.</td></tr>';
    return;
  }

  ui.rawTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${formatTime(row.timestamp)}</td>
          <td>${escapeHtml(row.kind)}</td>
          <td>${escapeHtml(row.address)}</td>
          <td>${escapeHtml(String(row.byteLength))}</td>
          <td class="hex">${escapeHtml(row.rawHex)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderParsedTable() {
  const rows = state.parsedRows.slice(-MAX_PARSED_TABLE_ROWS).reverse();
  if (!rows.length) {
    ui.parsedTableBody.innerHTML =
      '<tr><td colspan="5" class="empty">아직 해석된 값이 없습니다.</td></tr>';
    return;
  }

  ui.parsedTableBody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${formatTime(row.timestamp)}</td>
          <td>${formatNumber(row.voltage, " V", 1)}</td>
          <td>${formatInteger(row.rpmCandidate, " rpm")}</td>
          <td>${formatNumber(row.lineCurrent, " A", 1)}</td>
          <td>${escapeHtml(row.address)}</td>
        </tr>
      `,
    )
    .join("");
}

function renderCharts() {
  drawChart({
    canvas: ui.voltageChart,
    data: state.graphRows.map((row) => row.voltage),
    color: "#39c6a1",
    unit: "V",
    rangeEl: ui.voltageRange,
  });

  drawChart({
    canvas: ui.rpmChart,
    data: state.graphRows.map((row) => row.rpmCandidate),
    color: "#f2b84b",
    unit: "rpm",
    rangeEl: ui.rpmRange,
  });
}

function drawChart({ canvas, data, color, unit, rangeEl }) {
  const points = data.filter((value) => Number.isFinite(value));
  const rect = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * scale));
  canvas.height = Math.max(1, Math.floor(rect.height * scale));

  const ctx = canvas.getContext("2d");
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const pad = { left: 48, right: 18, top: 20, bottom: 34 };
  const w = rect.width - pad.left - pad.right;
  const h = rect.height - pad.top - pad.bottom;

  ctx.fillStyle = "#111619";
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.strokeStyle = "#263138";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 4; i += 1) {
    const y = pad.top + (h / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + w, y);
    ctx.stroke();
  }

  if (!points.length) {
    ctx.fillStyle = "#748086";
    ctx.font = "14px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("수신 대기", rect.width / 2, rect.height / 2);
    rangeEl.textContent = "--";
    return;
  }

  let min = Math.min(...points);
  let max = Math.max(...points);
  if (min === max) {
    min -= 1;
    max += 1;
  }

  const yFor = (value) => pad.top + h - ((value - min) / (max - min)) * h;
  const xFor = (index) =>
    pad.left + (points.length === 1 ? w : (w / (points.length - 1)) * index);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((value, index) => {
    const x = xFor(index);
    const y = yFor(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = points[points.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(xFor(points.length - 1), yFor(last), 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#98a6aa";
  ctx.font = "12px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(`${max.toFixed(unit === "V" ? 1 : 0)} ${unit}`, pad.left - 8, pad.top + 6);
  ctx.fillText(`${min.toFixed(unit === "V" ? 1 : 0)} ${unit}`, pad.left - 8, pad.top + h);

  rangeEl.textContent = `${min.toFixed(unit === "V" ? 1 : 0)}-${max.toFixed(unit === "V" ? 1 : 0)} ${unit}`;
}

function exportRawWorkbook() {
  const rows = state.rawRows.map((row) => ({
    timestamp: row.timestamp.toISOString(),
    kind: row.kind,
    frameNo: row.frameNo,
    id: row.id,
    flags: row.flags,
    address: row.address,
    crc: row.crc,
    byteLength: row.byteLength,
    rawHex: row.rawHex,
  }));

  downloadWorkbook("fardriver_raw_log", [
    {
      name: "RAW_LOG",
      rows,
    },
    sessionSheet(),
  ]);
}

function exportParsedWorkbook() {
  const rows = state.parsedRows.map((row) => ({
    timestamp: row.timestamp.toISOString(),
    frameNo: row.frameNo,
    address: row.address,
    voltageV: row.voltage,
    rpmCandidate: row.rpmCandidate,
    lineCurrentA: row.lineCurrent,
    mosTempC: row.mosTemp,
    motorTempC: row.motorTemp,
    source: row.source,
    crc: row.crc,
  }));

  downloadWorkbook("fardriver_voltage_rpm", [
    {
      name: "PARSED_DATA",
      rows,
    },
    sessionSheet(),
  ]);
}

function sessionSheet() {
  return {
    name: "SESSION_INFO",
    rows: [
      { key: "generatedAt", value: new Date().toISOString() },
      { key: "baudRate", value: ui.baudSelect.value },
      { key: "source", value: ui.sourceSelect.value },
      { key: "sample", value: state.diagnostics.sample },
      { key: "controllerUartBaud", value: ui.sourceSelect.value === "teensy" ? state.diagnostics.status?.baud ?? "unknown" : ui.baudSelect.value },
      { key: "frames", value: state.frameCount },
      { key: "bytes", value: state.byteCount },
      { key: "parser", value: "Fardriver 16-byte status frame draft" },
      { key: "voltageRule", value: "Addr E8 int16le(bytes 2-3) / 10" },
      { key: "rpmRule", value: "Addr E2 uint16le(bytes 8-9), verify on real logs" },
    ],
  };
}

function downloadWorkbook(baseName, sheets) {
  const xml = buildSpreadsheetXml(sheets);
  const blob = new Blob([xml], {
    type: "application/vnd.ms-excel;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}_${fileTimestamp()}.xls`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function buildSpreadsheetXml(sheets) {
  const worksheets = sheets.map((sheet) => {
    const headers = collectHeaders(sheet.rows);
    const headerRow = buildRow(headers, true);
    const dataRows = sheet.rows.map((row) =>
      buildRow(headers.map((header) => row[header] ?? ""), false),
    );

    return `
      <Worksheet ss:Name="${escapeXml(sheet.name.slice(0, 31))}">
        <Table>
          ${headerRow}
          ${dataRows.join("")}
        </Table>
      </Worksheet>
    `;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  ${worksheets.join("")}
</Workbook>`;
}

function collectHeaders(rows) {
  const headers = [];
  rows.forEach((row) => {
    Object.keys(row).forEach((key) => {
      if (!headers.includes(key)) headers.push(key);
    });
  });
  return headers.length ? headers : ["empty"];
}

function buildRow(values, forceText) {
  const cells = values
    .map((value) => {
      const isNumber = typeof value === "number" && Number.isFinite(value) && !forceText;
      const type = isNumber ? "Number" : "String";
      return `<Cell><Data ss:Type="${type}">${escapeXml(String(value))}</Data></Cell>`;
    })
    .join("");
  return `<Row>${cells}</Row>`;
}

function injectSampleData() {
  if (state.readActive || state.connecting) return;
  state.diagnostics = newDiagnostics();
  clearData();
  state.diagnostics.sample = true;
  const now = Date.now();
  const voltage = 720 + Math.round(Math.random() * 24);
  const rpm = 900 + Math.round(Math.random() * 2600);
  const current = 80 + Math.round(Math.random() * 160);

  const e8 = makeSampleFrame(1, [voltage & 0xff, voltage >> 8, 0, 0, current & 0xff, current >> 8, 0, 0, 0, 0, 0, 0]);
  const e2 = makeSampleFrame(0, [0, 0, 0, 0, 0, 0, rpm & 0xff, rpm >> 8, 0, 0, 0, 0]);

  handleIncomingBytes(new Uint8Array(e8));
  handleIncomingBytes(new Uint8Array(e2));
  ui.lastPacket.textContent = formatTime(new Date(now));
}

function makeSampleFrame(id, data) {
  const frame = [0xaa, (2 << 6) | id, ...data.slice(0, 12), 0, 0];
  const [hi, lo] = computeFardriverCrc(frame.slice(0, 14));
  frame[14] = hi;
  frame[15] = lo;
  return frame;
}

function updateConnectionUi(kind, text) {
  const dotClass = kind === "live" ? "live" : kind === "error" ? "error" : "idle";
  ui.serialStatus.innerHTML = `<span class="status-dot ${dotClass}"></span><span>${escapeHtml(text)}</span>`;
}

function toHex(bytes) {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(" ");
}

function formatAddress(address) {
  return address === null || address === undefined
    ? "--"
    : `0x${address.toString(16).toUpperCase().padStart(2, "0")}`;
}

function formatNumber(value, suffix, digits) {
  return Number.isFinite(value) ? `${value.toFixed(digits)}${suffix}` : "--";
}

function formatInteger(value, suffix) {
  return Number.isFinite(value) ? `${Math.round(value)}${suffix}` : "--";
}

function formatTime(date) {
  if (!(date instanceof Date)) return "--";
  return date.toLocaleTimeString("ko-KR", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function fileTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function toUserError(error) {
  if (!error) return "알 수 없는 오류가 발생했습니다.";
  if (error.name === "NotFoundError") return "COM 포트를 선택하지 않았습니다.";
  if (error.name === "SecurityError") return "브라우저가 COM 포트 접근을 차단했습니다.";
  return error.message || String(error);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
