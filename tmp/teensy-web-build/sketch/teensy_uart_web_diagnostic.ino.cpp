#line 1 "C:\\Users\\dazer\\OneDrive\\Desktop\\UART 워크페이스\\teensy_uart_web_diagnostic\\teensy_uart_web_diagnostic.ino"
// Teensy 4.0 / 4.1 receive-only UART diagnostics, protocol v1.
// Arduino Tools: select the actual board, USB Type = Serial.
// Controller OUTPUT (verified 3.3V-compatible) -> pin 0 (Serial1 RX).
// Communication GND -> GND. Power Teensy via USB.
// Leave pin 1 (TX) disconnected; do not connect controller power pins.
// Serial = computer USB. Serial1 = controller UART. No Serial1 writes.
// Website: choose "Teensy 4.1 diagnostics". Close Serial Monitor first.
// Serial Monitor can also show the JSON lines, but not simultaneously.

#include <Arduino.h>

#if !defined(ARDUINO_TEENSY40) && !defined(ARDUINO_TEENSY41)
#error "Select your confirmed Teensy 4.0 or 4.1. RX is pin 0."
#endif

constexpr uint32_t UART_BAUD = 19200;  // Match the known-good UART speed.
constexpr size_t CHUNK_SIZE = 64;
uint8_t uartMemory[1024];
uint8_t chunk[CHUNK_SIZE];
size_t chunkLength = 0;
uint32_t chunkOffset = 0;
uint32_t chunkStartedAt = 0;
uint32_t rxTotal = 0;
uint32_t rxRecent = 0;
uint32_t usbDropped = 0;
uint32_t lastReport = 0;

// Never wait for a USB reader. If the computer cannot keep up, count the loss.
#line 29 "C:\\Users\\dazer\\OneDrive\\Desktop\\UART 워크페이스\\teensy_uart_web_diagnostic\\teensy_uart_web_diagnostic.ino"
bool sendUsbLine(const char *line, size_t length);
#line 34 "C:\\Users\\dazer\\OneDrive\\Desktop\\UART 워크페이스\\teensy_uart_web_diagnostic\\teensy_uart_web_diagnostic.ino"
void flushChunk();
#line 52 "C:\\Users\\dazer\\OneDrive\\Desktop\\UART 워크페이스\\teensy_uart_web_diagnostic\\teensy_uart_web_diagnostic.ino"
void setup();
#line 59 "C:\\Users\\dazer\\OneDrive\\Desktop\\UART 워크페이스\\teensy_uart_web_diagnostic\\teensy_uart_web_diagnostic.ino"
void loop();
#line 29 "C:\\Users\\dazer\\OneDrive\\Desktop\\UART 워크페이스\\teensy_uart_web_diagnostic\\teensy_uart_web_diagnostic.ino"
bool sendUsbLine(const char *line, size_t length) {
  if (!Serial || Serial.availableForWrite() < static_cast<int>(length)) return false;
  return Serial.write(reinterpret_cast<const uint8_t *>(line), length) == length;
}

void flushChunk() {
  if (!chunkLength) return;
  const char digits[] = "0123456789ABCDEF";
  char hex[CHUNK_SIZE * 2 + 1];
  for (size_t i = 0; i < chunkLength; ++i) {
    hex[i * 2] = digits[chunk[i] >> 4];
    hex[i * 2 + 1] = digits[chunk[i] & 15];
  }
  hex[chunkLength * 2] = '\0';
  char line[224];
  const int length = snprintf(line, sizeof(line),
    "{\"v\":1,\"type\":\"data\",\"offset\":%lu,\"hex\":\"%s\"}\n",
    static_cast<unsigned long>(chunkOffset), hex);
  if (length <= 0 || static_cast<size_t>(length) >= sizeof(line) ||
      !sendUsbLine(line, static_cast<size_t>(length))) usbDropped += chunkLength;
  chunkLength = 0;
}

void setup() {
  Serial.begin(115200);  // USB baud is independent of UART_BAUD.
  Serial1.addMemoryForRead(uartMemory, sizeof(uartMemory));
  Serial1.begin(UART_BAUD, SERIAL_8N1);
  lastReport = millis();
}

void loop() {
  for (size_t i = 0; i < 256 && Serial1.available() > 0; ++i) {
    const int value = Serial1.read();
    if (value < 0) break;
    if (!chunkLength) {
      chunkOffset = rxTotal;
      chunkStartedAt = millis();
    }
    chunk[chunkLength++] = static_cast<uint8_t>(value);
    ++rxTotal;
    ++rxRecent;
    if (chunkLength == CHUNK_SIZE) flushChunk();
  }
  const uint32_t now = millis();
  if (chunkLength && now - chunkStartedAt >= 10) flushChunk();
  if (now - lastReport < 1000) return;
  flushChunk();
  char line[256];
  const int length = snprintf(line, sizeof(line),
    "{\"v\":1,\"type\":\"status\",\"uptimeMs\":%lu,\"baud\":%lu,\"rxTotal\":%lu,\"rxRecent\":%lu,\"usbDropped\":%lu}\n",
    static_cast<unsigned long>(now), static_cast<unsigned long>(UART_BAUD),
    static_cast<unsigned long>(rxTotal), static_cast<unsigned long>(rxRecent),
    static_cast<unsigned long>(usbDropped));
  if (length > 0 && static_cast<size_t>(length) < sizeof(line)) {
    sendUsbLine(line, static_cast<size_t>(length));
  }
  rxRecent = 0;
  lastReport = now;
}

