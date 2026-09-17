// Teensy 4.1 FarDriver left UART monitor + web diagnostics, protocol v2.
// Based on teensy_fardriver_left_open_keepalive.ino.
// USB Serial <-> monitor/diagnostic web page. Serial7 <-> NER-15966 <-> controller.
// D28 receives controller output. D29 is high impedance except while
// the user explicitly sends Open or KeepAlive from the diagnostic page.
// Never connect the controller power pin to Teensy. Verify that signal voltage
// is 0-3.3V before connecting because Teensy 4.x pins are not 5V tolerant.

#include <Arduino.h>

#if !defined(ARDUINO_TEENSY41)
#error "Select Teensy 4.1. Serial7 RX is D28 and TX is D29."
#endif

HardwareSerialIMXRT &farDriver = Serial7;
constexpr uint8_t RX_PIN = 28;
constexpr uint8_t TX_PIN = 29;
constexpr uint32_t USB_BAUD = 115200;
constexpr uint32_t DEFAULT_UART_BAUD = 19200;
constexpr uint32_t SIGNAL_DURATION_MS = 2000;
constexpr uint32_t SCAN_DURATION_MS = 2000;
constexpr uint32_t KEEPALIVE_INTERVAL_MS = 1000;
constexpr size_t RAW_CHUNK_SIZE = 32;

const uint32_t SCAN_BAUDS[] = {1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200};
constexpr size_t SCAN_BAUD_COUNT = sizeof(SCAN_BAUDS) / sizeof(SCAN_BAUDS[0]);
constexpr size_t SCAN_STEP_COUNT = SCAN_BAUD_COUNT * 2;

const uint8_t OPEN_PACKET[8] = {0xAA, 0x13, 0xEC, 0x07, 0x01, 0xF1, 0xA2, 0x5D};
const uint8_t KEEPALIVE_PACKET[8] = {0xAA, 0x13, 0xEC, 0x07, 0x5F, 0x5F, 0x6E, 0x91};

enum class RunMode : uint8_t { Listening, Signal, Scanning };

struct Metrics {
  uint32_t bytes = 0;
  uint32_t ff = 0;
  uint32_t zero = 0;
  uint32_t aa = 0;
  uint32_t valid = 0;
  uint32_t crcRejects = 0;
  uint16_t unique = 0;
  bool seen[256] = {false};
};

RunMode runMode = RunMode::Listening;
Metrics metrics;
uint32_t currentBaud = DEFAULT_UART_BAUD;
bool currentInverted = false;
bool autoKeepAlive = false;
uint32_t lastKeepAlive = 0;
uint32_t lastStatus = 0;
uint32_t rxLifetime = 0;
uint32_t rxRecent = 0;
uint32_t ffRecent = 0;

uint8_t crcTableHi[256];
uint8_t crcTableLo[256];
uint8_t frame[16];
uint8_t frameLength = 0;

uint8_t rawChunk[RAW_CHUNK_SIZE];
size_t rawLength = 0;
uint32_t rawOffset = 0;
uint32_t rawStartedAt = 0;

char commandBuffer[40];
size_t commandLength = 0;

volatile uint32_t signalEdges = 0;
volatile uint32_t signalIntervals = 0;
volatile uint32_t signalLastEdge = 0;
volatile uint32_t signalMinUs = UINT32_MAX;
volatile uint64_t signalSumUs = 0;
bool signalIdleHigh = false;
uint32_t modeEndsAt = 0;

size_t scanStep = 0;
int32_t bestScanScore = INT32_MIN;
uint32_t bestScanBaud = DEFAULT_UART_BAUD;
bool bestScanInverted = false;
uint32_t bestScanValid = 0;

void resetMetrics() {
  metrics = Metrics{};
  frameLength = 0;
  rawLength = 0;
  rxRecent = 0;
  ffRecent = 0;
}

void buildCrcTables() {
  for (uint16_t i = 0; i < 256; ++i) {
    uint16_t crc = i;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    crcTableHi[i] = crc & 0xFF;
    crcTableLo[i] = (crc >> 8) & 0xFF;
  }
}

bool validCrc(const uint8_t *data) {
  uint8_t hi = 0x3C;
  uint8_t lo = 0x7F;
  for (uint8_t pos = 0; pos < 14; ++pos) {
    const uint8_t index = hi ^ data[pos];
    hi = lo ^ crcTableHi[index];
    lo = crcTableLo[index];
  }
  return data[14] == hi && data[15] == lo;
}

void configureUart(uint32_t baud, bool inverted, bool driveTx = false) {
  farDriver.end();
  pinMode(RX_PIN, INPUT);
  pinMode(TX_PIN, INPUT);
  delayMicroseconds(100);
  const uint16_t format = inverted ? SERIAL_8N1_RXINV_TXINV : SERIAL_8N1;
  farDriver.setRX(RX_PIN);
  farDriver.setTX(TX_PIN);
  farDriver.begin(baud, format);
  if (!driveTx) pinMode(TX_PIN, INPUT);
  currentBaud = baud;
  currentInverted = inverted;
  frameLength = 0;
  rawLength = 0;
}

void emitEvent(const char *message, const char *level = "") {
  if (!Serial) return;
  Serial.printf("{\"v\":2,\"type\":\"event\",\"level\":\"%s\",\"message\":\"%s\"}\n", level, message);
}

void flushRaw() {
  if (!rawLength || !Serial || runMode != RunMode::Listening) {
    rawLength = 0;
    return;
  }
  char hex[RAW_CHUNK_SIZE * 2 + 1];
  const char digits[] = "0123456789ABCDEF";
  for (size_t i = 0; i < rawLength; ++i) {
    hex[i * 2] = digits[rawChunk[i] >> 4];
    hex[i * 2 + 1] = digits[rawChunk[i] & 0x0F];
  }
  hex[rawLength * 2] = '\0';
  Serial.printf("{\"v\":2,\"type\":\"data\",\"offset\":%lu,\"hex\":\"%s\"}\n",
                static_cast<unsigned long>(rawOffset), hex);
  rawLength = 0;
}

void resyncFrame() {
  uint8_t next = 16;
  for (uint8_t i = 1; i < 16; ++i) {
    if (frame[i] == 0xAA) {
      next = i;
      break;
    }
  }
  if (next == 16) {
    frameLength = 0;
    return;
  }
  frameLength = 16 - next;
  memmove(frame, frame + next, frameLength);
}

void feedParser(uint8_t value) {
  ++metrics.bytes;
  ++rxLifetime;
  ++rxRecent;
  if (value == 0xFF) {
    ++metrics.ff;
    ++ffRecent;
  }
  if (value == 0x00) ++metrics.zero;
  if (value == 0xAA) ++metrics.aa;
  if (!metrics.seen[value]) {
    metrics.seen[value] = true;
    ++metrics.unique;
  }

  if (runMode == RunMode::Listening) {
    if (!rawLength) {
      rawOffset = rxLifetime - 1;
      rawStartedAt = millis();
    }
    rawChunk[rawLength++] = value;
    if (rawLength == RAW_CHUNK_SIZE) flushRaw();
  }

  if (!frameLength) {
    if (value == 0xAA) {
      frame[0] = value;
      frameLength = 1;
    }
    return;
  }

  frame[frameLength++] = value;
  if (frameLength < 16) return;
  if (validCrc(frame)) {
    ++metrics.valid;
    frameLength = 0;
  } else {
    ++metrics.crcRejects;
    resyncFrame();
  }
}

void readController() {
  for (size_t i = 0; i < 512 && farDriver.available() > 0; ++i) {
    const int value = farDriver.read();
    if (value >= 0) feedParser(static_cast<uint8_t>(value));
  }
  if (rawLength && millis() - rawStartedAt >= 50) flushRaw();
}

void sendStatus() {
  if (!Serial || runMode != RunMode::Listening) return;
  const uint32_t now = millis();
  if (now - lastStatus < 1000) return;
  Serial.printf(
    "{\"v\":2,\"type\":\"status\",\"uptimeMs\":%lu,\"mode\":\"listen\",\"baud\":%lu,\"inverted\":%s,"
    "\"rxTotal\":%lu,\"rxRecent\":%lu,\"usbDropped\":0,\"ffRecent\":%lu,\"bytes\":%lu,\"ff\":%lu,"
    "\"zero\":%lu,\"aa\":%lu,\"unique\":%u,\"valid\":%lu,\"crcRejects\":%lu,\"autoKeepAlive\":%s}\n",
    static_cast<unsigned long>(now), static_cast<unsigned long>(currentBaud), currentInverted ? "true" : "false",
    static_cast<unsigned long>(rxLifetime), static_cast<unsigned long>(rxRecent),
    static_cast<unsigned long>(ffRecent), static_cast<unsigned long>(metrics.bytes),
    static_cast<unsigned long>(metrics.ff), static_cast<unsigned long>(metrics.zero),
    static_cast<unsigned long>(metrics.aa), metrics.unique,
    static_cast<unsigned long>(metrics.valid), static_cast<unsigned long>(metrics.crcRejects),
    autoKeepAlive ? "true" : "false");
  rxRecent = 0;
  ffRecent = 0;
  lastStatus = now;
}

void onSignalEdge() {
  const uint32_t now = micros();
  if (signalLastEdge) {
    const uint32_t delta = now - signalLastEdge;
    if (delta < signalMinUs) signalMinUs = delta;
    signalSumUs += delta;
    ++signalIntervals;
  }
  signalLastEdge = now;
  ++signalEdges;
}

void startSignalMeasurement() {
  if (runMode != RunMode::Listening) return;
  autoKeepAlive = false;
  farDriver.end();
  pinMode(TX_PIN, INPUT);
  pinMode(RX_PIN, INPUT);
  signalEdges = 0;
  signalIntervals = 0;
  signalLastEdge = 0;
  signalMinUs = UINT32_MAX;
  signalSumUs = 0;
  signalIdleHigh = digitalRead(RX_PIN) == HIGH;
  attachInterrupt(digitalPinToInterrupt(RX_PIN), onSignalEdge, CHANGE);
  runMode = RunMode::Signal;
  modeEndsAt = millis() + SIGNAL_DURATION_MS;
  if (Serial) Serial.println("{\"v\":2,\"type\":\"signal_start\"}");
}

void finishSignalMeasurement() {
  detachInterrupt(digitalPinToInterrupt(RX_PIN));
  noInterrupts();
  const uint32_t edges = signalEdges;
  const uint32_t intervals = signalIntervals;
  const uint32_t minimum = signalMinUs;
  const uint64_t total = signalSumUs;
  interrupts();
  const double average = intervals ? static_cast<double>(total) / intervals : 0.0;
  if (Serial) {
    Serial.printf("{\"v\":2,\"type\":\"signal\",\"idleHigh\":%s,\"edges\":%lu,\"minUs\":%lu,\"avgUs\":%.1f}\n",
                  signalIdleHigh ? "true" : "false", static_cast<unsigned long>(edges),
                  static_cast<unsigned long>(minimum == UINT32_MAX ? 0 : minimum), average);
  }
  configureUart(currentBaud, currentInverted);
  resetMetrics();
  runMode = RunMode::Listening;
  lastStatus = millis();
}

void configureScanStep() {
  const bool inverted = scanStep >= SCAN_BAUD_COUNT;
  const uint32_t baud = SCAN_BAUDS[scanStep % SCAN_BAUD_COUNT];
  configureUart(baud, inverted);
  resetMetrics();
  modeEndsAt = millis() + SCAN_DURATION_MS;
}

void startScan() {
  if (runMode != RunMode::Listening) return;
  autoKeepAlive = false;
  runMode = RunMode::Scanning;
  scanStep = 0;
  bestScanScore = INT32_MIN;
  bestScanBaud = DEFAULT_UART_BAUD;
  bestScanInverted = false;
  bestScanValid = 0;
  if (Serial) Serial.printf("{\"v\":2,\"type\":\"scan_start\",\"steps\":%u}\n", static_cast<unsigned>(SCAN_STEP_COUNT));
  configureScanStep();
}

int32_t scanScore() {
  const int32_t ffPenalty = metrics.bytes ? static_cast<int32_t>((metrics.ff * 30UL) / metrics.bytes) : 0;
  const int32_t rejectPenalty = metrics.crcRejects > 50 ? 50 : static_cast<int32_t>(metrics.crcRejects);
  return static_cast<int32_t>(metrics.valid * 10000UL + metrics.aa * 100UL + metrics.unique * 4UL) - rejectPenalty - ffPenalty;
}

void finishScanStep() {
  if (Serial) {
    Serial.printf(
      "{\"v\":2,\"type\":\"scan\",\"baud\":%lu,\"inverted\":%s,\"bytes\":%lu,"
      "\"unique\":%u,\"ff\":%lu,\"zero\":%lu,\"aa\":%lu,\"valid\":%lu,\"crcRejects\":%lu}\n",
      static_cast<unsigned long>(currentBaud), currentInverted ? "true" : "false",
      static_cast<unsigned long>(metrics.bytes), metrics.unique,
      static_cast<unsigned long>(metrics.ff), static_cast<unsigned long>(metrics.zero),
      static_cast<unsigned long>(metrics.aa), static_cast<unsigned long>(metrics.valid),
      static_cast<unsigned long>(metrics.crcRejects));
  }

  const int32_t score = scanScore();
  if (score > bestScanScore) {
    bestScanScore = score;
    bestScanBaud = currentBaud;
    bestScanInverted = currentInverted;
    bestScanValid = metrics.valid;
  }

  ++scanStep;
  if (scanStep < SCAN_STEP_COUNT) {
    configureScanStep();
    return;
  }

  if (bestScanScore <= 0) {
    bestScanBaud = DEFAULT_UART_BAUD;
    bestScanInverted = false;
    bestScanValid = 0;
  }
  configureUart(bestScanBaud, bestScanInverted);
  resetMetrics();
  runMode = RunMode::Listening;
  lastStatus = millis();
  if (Serial) {
    Serial.printf("{\"v\":2,\"type\":\"scan_done\",\"baud\":%lu,\"inverted\":%s,\"valid\":%lu}\n",
                  static_cast<unsigned long>(bestScanBaud), bestScanInverted ? "true" : "false",
                  static_cast<unsigned long>(bestScanValid));
  }
}

void transmitPacket(const char *name, const uint8_t *packet, size_t length) {
  if (runMode != RunMode::Listening) {
    emitEvent("스캔 또는 신호 측정 중에는 송신할 수 없습니다.", "warn");
    return;
  }
  flushRaw();
  configureUart(currentBaud, currentInverted, true);
  const size_t accepted = farDriver.write(packet, length);
  farDriver.flush();
  pinMode(TX_PIN, INPUT);
  if (Serial) {
    char hex[33];
    const char digits[] = "0123456789ABCDEF";
    for (size_t i = 0; i < length; ++i) {
      hex[i * 2] = digits[packet[i] >> 4];
      hex[i * 2 + 1] = digits[packet[i] & 0x0F];
    }
    hex[length * 2] = '\0';
    Serial.printf("{\"v\":2,\"type\":\"tx\",\"name\":\"%s\",\"requested\":%u,\"accepted\":%u,\"hex\":\"%s\"}\n",
                  name, static_cast<unsigned>(length), static_cast<unsigned>(accepted), hex);
  }
}

void handleCommand(const char *command) {
  if (!strcmp(command, "signal")) {
    startSignalMeasurement();
  } else if (!strcmp(command, "scan")) {
    startScan();
  } else if (!strcmp(command, "open")) {
    transmitPacket("Open", OPEN_PACKET, sizeof(OPEN_PACKET));
  } else if (!strcmp(command, "keepalive")) {
    transmitPacket("KeepAlive", KEEPALIVE_PACKET, sizeof(KEEPALIVE_PACKET));
  } else if (!strcmp(command, "auto_on")) {
    if (runMode == RunMode::Listening) {
      autoKeepAlive = true;
      lastKeepAlive = 0;
      if (Serial) Serial.println("{\"v\":2,\"type\":\"auto_keepalive\",\"enabled\":true}");
    }
  } else if (!strcmp(command, "auto_off")) {
    autoKeepAlive = false;
    if (Serial) Serial.println("{\"v\":2,\"type\":\"auto_keepalive\",\"enabled\":false}");
  } else if (!strcmp(command, "monitor_on")) {
    if (runMode == RunMode::Listening) {
      transmitPacket("Open", OPEN_PACKET, sizeof(OPEN_PACKET));
      autoKeepAlive = true;
      lastKeepAlive = millis();
      if (Serial) Serial.println("{\"v\":2,\"type\":\"auto_keepalive\",\"enabled\":true}");
    }
  } else if (!strcmp(command, "clear")) {
    resetMetrics();
    emitEvent("진단 카운터를 초기화했습니다.", "ok");
  } else if (*command) {
    emitEvent("알 수 없는 USB 명령입니다.", "warn");
  }
}

void readUsbCommands() {
  while (Serial.available() > 0) {
    const char value = static_cast<char>(Serial.read());
    if (value == '\r') continue;
    if (value == '\n') {
      commandBuffer[commandLength] = '\0';
      handleCommand(commandBuffer);
      commandLength = 0;
      continue;
    }
    if (commandLength + 1 < sizeof(commandBuffer)) commandBuffer[commandLength++] = value;
  }
}

void setup() {
  Serial.begin(USB_BAUD);
  buildCrcTables();
  configureUart(DEFAULT_UART_BAUD, false);
  resetMetrics();
  lastStatus = millis();
}

void loop() {
  static bool usbWasConnected = false;
  const bool usbConnected = static_cast<bool>(Serial);
  if (usbConnected && !usbWasConnected) {
    Serial.println("{\"v\":2,\"type\":\"hello\",\"board\":\"Teensy 4.x FarDriver UART Diagnostic\"}");
  }
  usbWasConnected = usbConnected;

  readUsbCommands();

  if (runMode == RunMode::Signal) {
    if (static_cast<int32_t>(millis() - modeEndsAt) >= 0) finishSignalMeasurement();
    return;
  }

  readController();

  if (runMode == RunMode::Scanning) {
    if (static_cast<int32_t>(millis() - modeEndsAt) >= 0) finishScanStep();
    return;
  }

  if (autoKeepAlive && millis() - lastKeepAlive >= KEEPALIVE_INTERVAL_MS) {
    transmitPacket("KeepAliveAuto", KEEPALIVE_PACKET, sizeof(KEEPALIVE_PACKET));
    lastKeepAlive = millis();
  }
  sendStatus();
}
