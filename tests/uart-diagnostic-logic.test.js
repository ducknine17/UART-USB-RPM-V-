"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const logic = require("../uart-diagnostic-logic.js");

test("normal CRC frames outrank noisy candidates", () => {
  const noisy = { baud: 9600, inverted: false, bytes: 100, unique: 20, ff: 0, zero: 0, aa: 4, valid: 0, crcRejects: 4 };
  const valid = { baud: 19200, inverted: true, bytes: 100, unique: 30, ff: 0, zero: 0, aa: 2, valid: 1, crcRejects: 0 };
  assert.equal(logic.bestScan([noisy, valid]), valid);
  assert.equal(logic.classifyScan(valid).label, "정상 프레임");
});

test("mostly FF input is diagnosed separately from CRC failure", () => {
  const row = { baud: 19200, inverted: false, bytes: 200, unique: 3, ff: 198, zero: 0, aa: 0, valid: 0, crcRejects: 0 };
  const result = logic.diagnose({ status: null, signal: null, scans: [row] });
  assert.equal(result.badge, "FF 편중");
  assert.match(result.title, /0xFF/);
});

test("all scan modes without bytes reports total silence", () => {
  const scans = Array.from({ length: logic.TOTAL_SCAN_STEPS }, (_, index) => ({
    baud: logic.BAUDS[index % logic.BAUDS.length], inverted: index >= logic.BAUDS.length,
    bytes: 0, unique: 0, ff: 0, zero: 0, aa: 0, valid: 0, crcRejects: 0,
  }));
  const result = logic.diagnose({ status: null, signal: null, scans });
  assert.equal(result.badge, "전체 무수신");
});

test("AA with rejected CRC is reported as a near frame", () => {
  const row = { baud: 19200, inverted: false, bytes: 100, unique: 20, ff: 0, zero: 0, aa: 3, valid: 0, crcRejects: 3 };
  const result = logic.diagnose({ status: null, signal: null, scans: [row] });
  assert.equal(result.badge, "프레임 근접");
});
