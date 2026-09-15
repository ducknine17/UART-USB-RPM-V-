const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function harness() {
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: id === "sourceSelect" ? "teensy" : "19200", textContent: "", innerHTML: "",
      dataset: {}, disabled: false, addEventListener() {}, setAttribute() {},
      getBoundingClientRect: () => ({ width: 700, height: 260 }),
      getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
    });
    return nodes.get(id);
  };
  let clock = 100000;
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const context = vm.createContext({
    document: { addEventListener() {}, getElementById: node },
    window: { isSecureContext: true, addEventListener() {} }, navigator: { serial: {} },
    TextDecoder, Uint8Array, Date: ClockDate, setTimeout: (f) => f(), setInterval() {},
    requestAnimationFrame() {}, console,
  });
  for (const file of ["diagnostics.js", "app.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
  }
  const run = (code) => vm.runInContext(code, context);
  run("bindUi(); state.readActive = true; state.diagnostics.connectedAt = Date.now();");
  return { run, context, node, advance: (ms) => { clock += ms; },
    send: (text) => { context.input = new TextEncoder().encode(text); run("handleSerialBytes(input)"); },
    snapshot: () => JSON.parse(run("JSON.stringify(currentDiagnosis())")),
  };
}
const status = (extra = {}) => JSON.stringify({ v: 1, type: "status", uptimeMs: 1000, baud: 19200, rxTotal: 0, rxRecent: 0, usbDropped: 0, ...extra }) + "\n";
const data = (hex, offset = 0) => JSON.stringify({ v: 1, type: "data", offset, hex }) + "\n";
const frame = (h) => h.run("toHex(makeSampleFrame(1, [0xD0, 0x02, 0, 0, 0x50, 0, 0, 0, 0, 0, 0, 0])).replaceAll(' ', '')");

test("split USB status proves the Teensy runs, not that UART is receiving", () => {
  const h = harness(), line = status();
  for (const ch of line) h.send(ch);
  assert.equal(h.snapshot().usb.level, "ok");
  assert.equal(h.snapshot().uart.level, "warn");
  assert.equal(h.run("state.byteCount"), 0);
});

test("raw bytes split across several diagnostic messages recover a frame", () => {
  const h = harness(), hex = frame(h);
  h.send(status());
  h.send(data(hex.slice(0, 10), 0) + data(hex.slice(10), 5));
  assert.equal(h.run("state.byteCount"), 16);
  assert.equal(h.run("state.latest.voltage"), 72);
  assert.equal(h.run("state.latest.lineCurrent"), 20);
  assert.equal(h.snapshot().frame.level, "ok");
  assert.equal(h.snapshot().uart.level, "ok");
});

test("a bad CRC cannot update values; the next overlapping valid start is found", () => {
  const h = harness(), hex = frame(h);
  h.send(status());
  h.send(data("AA810000000000000000000000000000"));
  assert.equal(h.run("state.latest.voltage"), null);
  assert.equal(h.run("state.parsedRows.length"), 0);
  h.send(data("AA01FF" + hex, 16));
  assert.equal(h.run("state.diagnostics.validFrames"), 1);
  assert.equal(h.run("state.latest.voltage"), 72);
  assert.ok(h.run("state.diagnostics.crcErrors") > 0);
});

test("stream offsets prevent joining bytes across a USB loss", () => {
  const h = harness(), hex = frame(h);
  h.send(data(hex.slice(0, 16), 0));
  h.send(data(hex.slice(16), 9));
  assert.equal(h.run("state.diagnostics.streamGaps"), 1);
  assert.equal(h.run("state.diagnostics.validFrames"), 0);
  h.send(data(hex, 17));
  assert.equal(h.run("state.diagnostics.validFrames"), 1);
});

test("status continues while UART stops; old valid frames do not stay green", () => {
  const h = harness();
  h.send(status()); h.send(data(frame(h)));
  h.advance(6000); h.send(status({ uptimeMs: 7000, rxTotal: 16 }));
  assert.equal(h.snapshot().usb.level, "ok");
  assert.equal(h.snapshot().uart.level, "warn");
  assert.equal(h.snapshot().frame.level, "warn");
});

test("missing heartbeat is a USB/program observation, not a claim of broken UART", () => {
  const h = harness(); h.send(status()); h.advance(4000);
  assert.match(h.snapshot().usb.title, /상태 보고 없음/);
  assert.equal(h.snapshot().uart.level, "idle");
});

test("old text sketch is rejected without interpreting its text as UART bytes", () => {
  const h = harness(); h.send("RX=0 bytes | WAITING\n"); h.advance(4000);
  assert.equal(h.run("state.byteCount"), 0);
  assert.equal(h.run("state.diagnostics.protocolErrors"), 1);
  assert.match(h.snapshot().next, /새 teensy_uart_web_diagnostic/);
});

test("malformed messages do not fake a heartbeat or UART data", () => {
  const h = harness();
  h.send(status({ rxRecent: -1 }) + data("NOTHEX") + status({ v: 2 }) + "null\n");
  assert.equal(h.run("state.diagnostics.lastStatusAt"), 0);
  assert.equal(h.run("state.diagnostics.protocolErrors"), 4);
  assert.equal(h.run("state.byteCount"), 0);
});

test("unframed text is bounded and the next valid line recovers", () => {
  const h = harness(); h.send("x".repeat(9000));
  assert.equal(h.run("state.diagnostics.textBuffer.length"), 0);
  h.send("\n" + status()); assert.equal(h.snapshot().usb.level, "ok");
});

test("adapter mode accepts binary directly without needing a heartbeat", () => {
  const h = harness(); h.node("sourceSelect").value = "adapter";
  h.run("handleSerialBytes(new Uint8Array(makeSampleFrame(1, [0xD0,2,0,0,0,0,0,0,0,0,0,0])))");
  assert.equal(h.run("state.latest.voltage"), 72);
  assert.equal(h.snapshot().frame.level, "ok");
  assert.match(h.snapshot().usb.title, /COM 포트/);
});

test("sample is blocked during real reception and labelled when disconnected", () => {
  const h = harness(); h.run("injectSampleData()"); assert.equal(h.run("state.byteCount"), 0);
  h.run("state.readActive = false; injectSampleData()");
  assert.match(h.snapshot().usb.title, /샘플/);
  assert.notEqual(h.snapshot().frame.level, "ok");
  h.run("clearData()"); assert.equal(h.run("state.diagnostics.sample"), false);
});

test("board reboot discards stale measurements and partial frames", () => {
  const h = harness(); h.send(status({ uptimeMs: 9000 })); h.send(data(frame(h)));
  h.send(status({ uptimeMs: 100 }));
  assert.equal(h.run("state.latest.voltage"), null);
  assert.equal(h.run("state.diagnostics.lastValidAt"), 0);
});

test("transport errors and disconnection override old success", () => {
  const h = harness(); h.send(status()); h.send(data(frame(h)));
  h.run("state.readActive = false"); assert.equal(h.snapshot().usb.level, "idle");
  h.run("state.diagnostics.error = 'USB disconnected'"); assert.equal(h.snapshot().usb.level, "error");
});

test("record pause does not disable live diagnosis", () => {
  const h = harness(); h.run("state.recording = false"); h.send(status()); h.send(data(frame(h)));
  assert.equal(h.run("state.rawRows.length"), 0);
  assert.equal(h.snapshot().frame.level, "ok");
});

test("connecting clears sample state; disconnect cancels reader and closes port", async () => {
  const h = harness();
  h.run("state.readActive = false; injectSampleData()");
  let finishRead, cancelled = false, released = false, closed = false;
  const reader = {
    read: () => new Promise((resolve) => { finishRead = resolve; }),
    cancel: async () => { cancelled = true; finishRead({ done: true }); },
    releaseLock: () => { released = true; },
  };
  h.context.navigator.serial.requestPort = async () => ({
    open: async (options) => { assert.equal(options.flowControl, "none"); },
    readable: { getReader: () => reader },
    close: async () => { assert.ok(released); closed = true; },
  });
  await h.run("connectSerial()");
  assert.equal(h.run("state.diagnostics.sample"), false);
  assert.equal(h.run("state.byteCount"), 0);
  assert.equal(h.run("state.readActive"), true);
  assert.equal(h.node("sampleBtn").disabled, true);
  await h.run("disconnectSerial()");
  assert.ok(cancelled && released && closed);
  assert.equal(h.run("state.port"), null);
  assert.equal(h.node("sourceSelect").disabled, false);
});

test("failed port open restores controls and records diagnosis", async () => {
  const h = harness(); h.run("state.readActive = false");
  h.context.navigator.serial.requestPort = async () => ({ open: async () => { throw new Error("Port busy"); } });
  await h.run("connectSerial()");
  assert.equal(h.snapshot().usb.level, "error");
  assert.equal(h.node("connectBtn").disabled, false);
  assert.equal(h.run("state.port"), null);
});

test("diagnostic export includes observations and raw logs without sending to a server", async () => {
  const h = harness(); let blob;
  h.context.Blob = Blob;
  h.context.URL = { createObjectURL: (value) => { blob = value; return "blob:test"; }, revokeObjectURL() {} };
  h.context.document.createElement = () => ({ click() {}, remove() {} });
  h.context.document.body = { appendChild() {} };
  h.send(status()); h.send(data(frame(h)));
  h.run("exportDiagnosticReport()");
  const report = JSON.parse(await blob.text());
  assert.equal(report.bytes, 16);
  assert.equal(report.sample, false);
  assert.equal(report.baudRate, 19200);
  assert.equal(report.validFrames, 1);
  assert.ok(report.rawLog.some((row) => row.kind === "chunk"));
});
