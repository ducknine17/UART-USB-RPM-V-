"use strict";

const logic = globalThis.UartDiagnosticLogic;
const state = {
  port: null,
  reader: null,
  readActive: false,
  readTask: null,
  lineBuffer: "",
  status: null,
  signal: null,
  scans: [],
  events: [],
  busy: false,
  autoKeepAlive: false,
  connectedAt: null,
};

const ui = {};

window.addEventListener("DOMContentLoaded", init);

function init() {
  for (const id of [
    "connectionStatus", "usbBaud", "connectBtn", "disconnectBtn", "clearBtn", "exportBtn",
    "supportNotice", "signalBtn", "scanBtn", "scanProgressBar", "scanProgressText",
    "scanTableBody", "openBtn", "keepAliveBtn", "autoKeepAliveBtn", "stopKeepAliveBtn",
    "idleLevel", "edgeCount", "minPulse", "avgPulse", "resultLevel", "resultTitle",
    "resultDetail", "recommendation", "currentMode", "currentUart", "rxRecent", "ffRatio",
    "aaCount", "validFrames", "crcRejects", "eventLog",
  ]) ui[id] = document.getElementById(id);

  ui.connectBtn.addEventListener("click", connect);
  ui.disconnectBtn.addEventListener("click", disconnect);
  ui.clearBtn.addEventListener("click", () => {
    clearResults();
    if (state.readActive) sendCommand("clear");
  });
  ui.exportBtn.addEventListener("click", exportReport);
  ui.signalBtn.addEventListener("click", () => sendCommand("signal"));
  ui.scanBtn.addEventListener("click", () => sendCommand("scan"));
  ui.openBtn.addEventListener("click", () => sendCommand("open"));
  ui.keepAliveBtn.addEventListener("click", () => sendCommand("keepalive"));
  ui.autoKeepAliveBtn.addEventListener("click", () => sendCommand("auto_on"));
  ui.stopKeepAliveBtn.addEventListener("click", () => sendCommand("auto_off"));

  if (!("serial" in navigator)) {
    ui.supportNotice.textContent = "이 브라우저는 Web Serial API를 지원하지 않습니다. 최신 Chrome 또는 Edge에서 localhost로 여세요.";
    ui.connectBtn.disabled = true;
  } else if (!window.isSecureContext) {
    ui.supportNotice.textContent = "COM 포트 접근에는 localhost 또는 HTTPS가 필요합니다.";
    ui.connectBtn.disabled = true;
  }
  renderAll();
}

async function connect() {
  if (state.readActive) return;
  try {
    state.port = await navigator.serial.requestPort();
    await state.port.open({ baudRate: Number(ui.usbBaud.value), bufferSize: 8192 });
    state.readActive = true;
    state.connectedAt = new Date().toISOString();
    state.lineBuffer = "";
    updateConnection("live", "Teensy 연결됨");
    logEvent("USB 연결 완료 · 전용 스케치 응답을 기다립니다.", "ok");
    state.readTask = readLoop();
  } catch (error) {
    state.port = null;
    updateConnection("error", "연결 실패");
    ui.supportNotice.textContent = userError(error);
    logEvent(`연결 실패 · ${userError(error)}`, "error");
  }
  renderControls();
}

async function readLoop() {
  const decoder = new TextDecoder();
  try {
    state.reader = state.port.readable.getReader();
    while (state.readActive) {
      const { value, done } = await state.reader.read();
      if (done) break;
      if (!value) continue;
      state.lineBuffer += decoder.decode(value, { stream: true });
      const lines = state.lineBuffer.split(/\r?\n/);
      state.lineBuffer = lines.pop() || "";
      for (const line of lines) handleLine(line.trim());
    }
  } catch (error) {
    if (state.readActive) logEvent(`읽기 오류 · ${userError(error)}`, "error");
  } finally {
    if (state.reader) {
      state.reader.releaseLock();
      state.reader = null;
    }
    state.readActive = false;
    try { await state.port?.close(); } catch { /* Device may already be gone. */ }
    state.port = null;
    state.busy = false;
    state.autoKeepAlive = false;
    updateConnection("idle", "연결 대기");
    renderControls();
  }
}

async function disconnect() {
  state.readActive = false;
  try {
    if (state.reader) await state.reader.cancel();
    if (state.readTask) await state.readTask;
  } catch (error) {
    logEvent(`연결 해제 오류 · ${userError(error)}`, "error");
  } finally {
    state.readTask = null;
  }
}

async function sendCommand(command) {
  if (!state.port?.writable || !state.readActive) return;
  const writer = state.port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`${command}\n`));
    logEvent(`명령 요청 · ${command}`);
  } catch (error) {
    logEvent(`명령 전송 실패 · ${userError(error)}`, "error");
  } finally {
    writer.releaseLock();
  }
}

function handleLine(line) {
  if (!line) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    logEvent(`비JSON 응답 · ${line.slice(0, 240)}`, "warn");
    return;
  }

  switch (message.type) {
    case "hello":
      logEvent(`진단 펌웨어 확인 · v${message.v} · ${message.board || "Teensy"}`, "ok");
      ui.supportNotice.textContent = "전용 진단 펌웨어가 확인되었습니다. ① 신호 측정부터 시작하세요.";
      break;
    case "status":
      state.status = message;
      break;
    case "raw":
      logEvent(`RX ${message.offset ?? "?"} · ${message.hex || ""}`);
      break;
    case "signal_start":
      state.busy = true;
      logEvent("수동 신호 측정 시작");
      break;
    case "signal":
      state.signal = message;
      state.busy = false;
      logEvent(`신호 측정 완료 · edges=${message.edges} · idle=${message.idleHigh ? "HIGH" : "LOW"}`, message.edges ? "ok" : "warn");
      break;
    case "scan_start":
      state.scans = [];
      state.busy = true;
      ui.scanProgressText.textContent = "전체 스캔을 시작했습니다.";
      logEvent("보레이트·극성 전체 스캔 시작");
      break;
    case "scan":
      state.scans.push(message);
      ui.scanProgressText.textContent = `${state.scans.length}/${logic.TOTAL_SCAN_STEPS} · ${message.baud}bps · ${message.inverted ? "반전" : "일반"}`;
      break;
    case "scan_done":
      state.busy = false;
      ui.scanProgressText.textContent = `스캔 완료 · 추천 ${message.baud}bps · ${message.inverted ? "반전" : "일반"}`;
      logEvent(`전체 스캔 완료 · 추천 ${message.baud}bps ${message.inverted ? "반전" : "일반"}`, message.valid > 0 ? "ok" : "warn");
      break;
    case "tx":
      logEvent(`TX ${message.name} · accepted=${message.accepted}/${message.requested} · ${message.hex}`, message.accepted === message.requested ? "ok" : "error");
      break;
    case "auto_keepalive":
      state.autoKeepAlive = Boolean(message.enabled);
      logEvent(`자동 KeepAlive ${state.autoKeepAlive ? "시작" : "중지"}`, state.autoKeepAlive ? "warn" : "ok");
      break;
    case "event":
      logEvent(message.message || "펌웨어 이벤트", message.level || "");
      break;
    default:
      logEvent(`알 수 없는 응답 · ${line.slice(0, 240)}`, "warn");
  }
  renderAll();
}

function clearResults() {
  state.status = null;
  state.signal = null;
  state.scans = [];
  state.events = [];
  ui.scanProgressText.textContent = "아직 실행하지 않았습니다.";
  renderAll();
}

function renderAll() {
  renderControls();
  renderSignal();
  renderScan();
  renderStatus();
  renderDiagnosis();
  renderEvents();
}

function renderControls() {
  const connected = state.readActive;
  ui.connectBtn.disabled = connected || !("serial" in navigator);
  ui.disconnectBtn.disabled = !connected;
  ui.signalBtn.disabled = !connected || state.busy;
  ui.scanBtn.disabled = !connected || state.busy;
  ui.openBtn.disabled = !connected || state.busy;
  ui.keepAliveBtn.disabled = !connected || state.busy;
  ui.autoKeepAliveBtn.disabled = !connected || state.busy || state.autoKeepAlive;
  ui.stopKeepAliveBtn.disabled = !connected || !state.autoKeepAlive;
  ui.usbBaud.disabled = connected;
}

function renderSignal() {
  const s = state.signal;
  ui.idleLevel.textContent = s ? (s.idleHigh ? "HIGH" : "LOW") : "--";
  ui.edgeCount.textContent = s ? s.edges.toLocaleString() : "--";
  ui.minPulse.textContent = s?.minUs ? `${s.minUs.toLocaleString()} µs` : "--";
  ui.avgPulse.textContent = s?.avgUs ? `${Math.round(s.avgUs).toLocaleString()} µs` : "--";
}

function renderScan() {
  ui.scanProgressBar.style.width = `${Math.min(100, state.scans.length / logic.TOTAL_SCAN_STEPS * 100)}%`;
  if (!state.scans.length) {
    ui.scanTableBody.innerHTML = '<tr><td colspan="9" class="empty">스캔 결과가 여기에 표시됩니다.</td></tr>';
    return;
  }
  const best = logic.bestScan(state.scans);
  ui.scanTableBody.innerHTML = state.scans.map((row) => {
    const result = logic.classifyScan(row);
    const classes = row === best ? "best" : result.level === "warn" ? "suspect" : "";
    return `<tr class="${classes}">
      <td>${row.baud}</td><td>${row.inverted ? "반전" : "일반"}</td>
      <td>${row.bytes}</td><td>${row.unique}</td><td>${formatRatio(row.ff, row.bytes)}</td>
      <td>${row.aa}</td><td>${row.valid}</td><td>${row.crcRejects}</td><td>${result.label}</td>
    </tr>`;
  }).join("");
}

function renderStatus() {
  const s = state.status;
  ui.currentMode.textContent = s?.mode || "--";
  ui.currentUart.textContent = s ? `${s.baud} · ${s.inverted ? "반전" : "일반"}` : "--";
  ui.rxRecent.textContent = `${s?.rxRecent || 0} B/s`;
  ui.ffRatio.textContent = s ? formatRatio(s.ffRecent ?? s.ff ?? 0, s.rxRecent || s.bytes || 0) : "--";
  ui.aaCount.textContent = String(s?.aa || 0);
  ui.validFrames.textContent = String(s?.valid || 0);
  ui.crcRejects.textContent = String(s?.crcRejects || 0);
}

function renderDiagnosis() {
  const result = logic.diagnose({ status: state.status, scans: state.scans, signal: state.signal });
  const panel = ui.resultTitle.closest(".result-panel");
  panel.dataset.level = result.level;
  ui.resultLevel.textContent = result.badge;
  ui.resultTitle.textContent = result.title;
  ui.resultDetail.textContent = result.detail;
  ui.recommendation.textContent = result.next;
}

function renderEvents() {
  if (!state.events.length) {
    ui.eventLog.innerHTML = '<p class="empty">아직 기록된 이벤트가 없습니다.</p>';
    return;
  }
  ui.eventLog.innerHTML = state.events.slice(-200).reverse().map((event) =>
    `<p class="${event.level ? `event-${event.level}` : ""}"><time>${escapeHtml(event.time)}</time> ${escapeHtml(event.text)}</p>`
  ).join("");
}

function logEvent(text, level = "") {
  state.events.push({ time: new Date().toLocaleTimeString("ko-KR", { hour12: false }), text, level });
  if (state.events.length > 500) state.events.splice(0, state.events.length - 500);
  renderEvents();
}

function updateConnection(level, text) {
  ui.connectionStatus.innerHTML = `<span class="status-dot ${level}"></span><span>${escapeHtml(text)}</span>`;
}

function exportReport() {
  const report = {
    generatedAt: new Date().toISOString(),
    connectedAt: state.connectedAt,
    signal: state.signal,
    scans: state.scans,
    status: state.status,
    diagnosis: logic.diagnose({ status: state.status, scans: state.scans, signal: state.signal }),
    events: state.events,
    limitations: "TX accepted는 Teensy UART가 데이터를 수락했다는 뜻이며 컨트롤러 도달을 보장하지 않습니다. 정확한 전압은 멀티미터 또는 오실로스코프로 확인해야 합니다.",
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `fardriver-uart-diagnostic-${fileTimestamp()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatRatio(part, total) {
  return total > 0 ? `${(part / total * 100).toFixed(1)}%` : "--";
}

function fileTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function userError(error) {
  if (error?.name === "NotFoundError") return "장치 선택이 취소되었습니다.";
  if (error?.name === "InvalidStateError") return "다른 프로그램이 이 COM 포트를 사용 중일 수 있습니다.";
  return error?.message || String(error);
}
