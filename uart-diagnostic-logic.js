(function attachDiagnosticLogic(root) {
  "use strict";

  const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
  const TOTAL_SCAN_STEPS = BAUDS.length * 2;

  function ratio(part, total) {
    return total > 0 ? part / total : 0;
  }

  function classifyScan(row) {
    if (row.valid > 0) return { level: "ok", label: "정상 프레임" };
    if (row.aa > 0 && row.crcRejects > 0) return { level: "warn", label: "프레임 근접" };
    if (row.bytes === 0) return { level: "idle", label: "무수신" };
    if (ratio(row.ff, row.bytes) >= 0.9) return { level: "warn", label: "FF 편중" };
    if (ratio(row.zero, row.bytes) >= 0.9) return { level: "warn", label: "00 편중" };
    if (row.unique >= 6) return { level: "warn", label: "다른 데이터" };
    return { level: "idle", label: "판별 부족" };
  }

  function scoreScan(row) {
    const crcPenalty = Math.min(row.crcRejects || 0, 50);
    return (row.valid || 0) * 10000 + (row.aa || 0) * 100 + (row.unique || 0) * 4 - crcPenalty - ratio(row.ff || 0, row.bytes || 0) * 30;
  }

  function bestScan(rows) {
    if (!rows.length) return null;
    return [...rows].sort((a, b) => scoreScan(b) - scoreScan(a))[0];
  }

  function diagnose({ status, scans, signal }) {
    const best = bestScan(scans || []);
    if (best?.valid > 0) {
      return {
        level: "ok",
        badge: "정상 조건 발견",
        title: `${best.baud}bps · ${best.inverted ? "반전" : "일반"} 모드에서 정상 프레임을 찾았습니다.`,
        detail: `CRC 정상 프레임 ${best.valid}개가 확인되었습니다.`,
        next: "이 UART 조건을 선택한 상태에서 Open 전후를 비교한 뒤 기존 모니터 설정에 반영하세요.",
      };
    }

    if (status?.valid > 0) {
      return {
        level: "ok",
        badge: "정상 수신",
        title: "현재 정상 FarDriver 프레임을 수신하고 있습니다.",
        detail: `최근 정상 프레임 ${status.valid}개, CRC 거절 ${status.crcRejects}개입니다.`,
        next: "Open 또는 KeepAlive 이후 시작됐다면 그 전송 순서와 간격을 보고서에 기록하세요.",
      };
    }

    if (best?.aa > 0 && best?.crcRejects > 0) {
      return {
        level: "warn",
        badge: "프레임 근접",
        title: "0xAA는 보이지만 CRC 정상 프레임은 아직 없습니다.",
        detail: `${best.baud}bps · ${best.inverted ? "반전" : "일반"} 조건이 가장 가깝습니다.`,
        next: "해당 조건으로 고정한 뒤 원본 바이트를 비교하고, 공식 앱 실행 전후 변화를 확인하세요.",
      };
    }

    if (best && best.bytes > 0 && ratio(best.ff, best.bytes) >= 0.9) {
      return {
        level: "warn",
        badge: "FF 편중",
        title: "수신 데이터가 대부분 0xFF입니다.",
        detail: `가장 나은 조건에서도 FF 비율이 ${(ratio(best.ff, best.bytes) * 100).toFixed(1)}%입니다.`,
        next: "신호 측정의 유휴 상태와 펄스 간격을 확인하고, 공식 케이블과 Teensy의 신호 극성·풀업·전압을 비교하세요.",
      };
    }

    if ((scans || []).length >= TOTAL_SCAN_STEPS && !(scans || []).some((row) => row.bytes > 0)) {
      return {
        level: "error",
        badge: "전체 무수신",
        title: "모든 속도와 극성에서 수신이 없습니다.",
        detail: "현재 배선에서는 Teensy RX까지 신호가 도달하지 않습니다.",
        next: "통신 GND, 컨트롤러 전원, 실제 출력선과 Teensy RX 핀을 확인하세요. TX 시험 전에 수신 경로부터 검증해야 합니다.",
      };
    }

    if (signal && signal.edges === 0) {
      return {
        level: "warn",
        badge: "신호 전환 없음",
        title: `RX 핀이 ${signal.idleHigh ? "HIGH" : "LOW"} 상태로 고정되어 있습니다.`,
        detail: "2초 동안 논리 상태 변화가 측정되지 않았습니다.",
        next: "컨트롤러가 아직 송신하지 않는 상태일 수 있습니다. 전체 스캔 후에도 무수신이면 Open 시험 또는 공식 앱 전후 비교를 진행하세요.",
      };
    }

    if (status && status.rxRecent > 0 && status.aa === 0) {
      return {
        level: "warn",
        badge: "비프레임 데이터",
        title: "바이트는 들어오지만 0xAA 시작 바이트가 없습니다.",
        detail: `최근 ${status.rxRecent}바이트를 받았지만 FarDriver 상태 프레임으로 시작되지 않았습니다.`,
        next: "전체 보레이트·극성 스캔을 실행해 정상 조건 또는 다른 데이터 형식을 찾으세요.",
      };
    }

    return {
      level: "idle",
      badge: "대기",
      title: "진단을 시작하세요.",
      detail: "아직 원인을 판단할 데이터가 충분하지 않습니다.",
      next: "신호 측정을 먼저 실행하고 이어서 전체 스캔을 진행하세요.",
    };
  }

  const api = { BAUDS, TOTAL_SCAN_STEPS, ratio, classifyScan, scoreScan, bestScan, diagnose };
  root.UartDiagnosticLogic = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
