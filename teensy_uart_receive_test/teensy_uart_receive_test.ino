// Receive-only UART diagnostic for Teensy 4.0 / 4.1.
// Select Tools > USB Type > Serial.
// Serial1 RX: pin 0. Leave pin 1 (TX) physically disconnected.
// Verify controller TX is compatible with 3.3V logic before connecting.
// Controller communication GND -> Teensy GND. Power Teensy via USB.
// Do not connect controller power pins to Teensy.
// This sketch prints TEXT for Serial Monitor, not raw bytes for the website.

#if !defined(ARDUINO_TEENSY40) && !defined(ARDUINO_TEENSY41)
#error "This sketch requires a confirmed Teensy 4.0 or 4.1 and Serial1 RX on pin 0."
#endif

constexpr uint32_t UART_BAUD = 19200;  // Match the previous successful PC test.
constexpr size_t SAMPLE_SIZE = 32;

uint32_t totalBytes = 0;
uint32_t intervalBytes = 0;
uint32_t lastReport = 0;
uint8_t sampleBytes[SAMPLE_SIZE];
size_t sampleLength = 0;
bool monitorWasOpen = false;

void setup() {
  Serial.begin(115200);  // USB Serial; this does not set the controller UART baud.
  Serial1.begin(UART_BAUD, SERIAL_8N1);
  lastReport = millis();
}

void loop() {
  // Limit each batch so that reports also run during continuous reception.
  for (size_t i = 0; i < 256 && Serial1.available() > 0; ++i) {
    const int value = Serial1.read();
    if (value < 0) break;
    ++totalBytes;
    ++intervalBytes;
    if (sampleLength < SAMPLE_SIZE) {
      sampleBytes[sampleLength++] = static_cast<uint8_t>(value);
    }
  }

  const bool monitorOpen = static_cast<bool>(Serial);
  if (monitorOpen && !monitorWasOpen) {
    Serial.println("UART receive diagnostic: Teensy 4.0/4.1");
    Serial.println("RX=pin 0; TX=pin 1 MUST remain disconnected.");
    Serial.print("Controller UART baud: ");
    Serial.println(UART_BAUD);
    Serial.println("Text output only. Received bytes do not prove valid frames.");
  }
  monitorWasOpen = monitorOpen;

  const uint32_t now = millis();
  const uint32_t elapsed = now - lastReport;
  if (elapsed < 1000) return;

  if (monitorOpen) {
    Serial.print("t=");
    Serial.print(now);
    Serial.print(" ms | window=");
    Serial.print(elapsed);
    Serial.print(" ms | RX=");
    Serial.print(intervalBytes);
    Serial.print(" bytes | total=");
    Serial.print(totalBytes);
    Serial.println(intervalBytes ? " | RECEIVED" : " | WAITING");

    if (sampleLength > 0) {
      Serial.print("HEX sample (first up to 32 bytes; not frame-aligned): ");
      for (size_t i = 0; i < sampleLength; ++i) {
        if (sampleBytes[i] < 0x10) Serial.print('0');
        Serial.print(sampleBytes[i], HEX);
        Serial.print(' ');
      }
      Serial.println();
    }
  }

  intervalBytes = 0;
  sampleLength = 0;
  lastReport = now;
}
