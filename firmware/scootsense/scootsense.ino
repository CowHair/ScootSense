/*
  ScootSense firmware — ESP32 + MPU6050 + NEO-6M GPS

  Streams 50 Hz motion samples as CSV over USB serial (for the web app's Web Serial mode)
  and, optionally, as batched JSON over Wi-Fi to the ScootSense server.

  CSV columns:  time_ms,ax,ay,az,gx,gy,gz,lat,lng,speed_kmh,sats,pm25
    ax..az in g, gx..gz in deg/s, lat/lng blank until the GPS has a fix,
    pm25 in ug/m3 from an optional PMS5003 (blank if not fitted).

  Libraries (Arduino Library Manager): Adafruit MPU6050, Adafruit Unified Sensor, TinyGPSPlus
  Board: "ESP32 Dev Module" (esp32 by Espressif)

  Wiring:
    MPU6050 VCC->3V3  GND->GND  SDA->GPIO21  SCL->GPIO22
    GPS     VCC->per breakout  GND->GND  TX->GPIO16 (RX2)  RX->GPIO17 (TX2)
    PMS5003 VCC->5V  GND->GND  TX->GPIO25   (optional air-quality sensor)
*/

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <TinyGPSPlus.h>

// ----------------------------------------------------------------- Wi-Fi (optional)
// Set USE_WIFI to 1, fill these in, and pick "Wi-Fi" on the Live ride page.
// SERVER_URL must be the laptop's LAN address shown on the Device page, e.g.
// http://192.168.1.23:3000/api/ingest  (a phone hotspot works well outdoors).
#define USE_WIFI 0
const char* WIFI_SSID    = "your-hotspot";
const char* WIFI_PASS    = "your-password";
const char* SERVER_URL   = "http://192.168.1.23:3000/api/ingest";
const char* DEVICE_ID    = "scooter-1";
const char* INGEST_TOKEN = "";  // match INGEST_TOKEN in .env if you set one

#if USE_WIFI
#include <WiFi.h>
#include <HTTPClient.h>
#endif

const uint32_t SAMPLE_US = 20000;   // 50 Hz

// ----------------------------------------------------------------- PMS5003 (optional)
// Sends a 32-byte frame about once a second: 0x42 0x4D ... PM2.5 (atmospheric) in bytes 12-13.
HardwareSerial PMS(1);
const int PMS_RX = 25;
float pm25 = NAN;
uint32_t pmsAt = 0;
uint8_t pmsBuf[32];
int pmsLen = 0;

void readPms() {
  while (PMS.available()) {
    uint8_t b = PMS.read();
    if (pmsLen == 0 && b != 0x42) continue;
    if (pmsLen == 1 && b != 0x4D) { pmsLen = 0; continue; }
    pmsBuf[pmsLen++] = b;
    if (pmsLen == 32) {
      uint16_t sum = 0;
      for (int i = 0; i < 30; i++) sum += pmsBuf[i];
      if (sum == ((pmsBuf[30] << 8) | pmsBuf[31])) { pm25 = (pmsBuf[12] << 8) | pmsBuf[13]; pmsAt = millis(); }
      pmsLen = 0;
    }
  }
  if (millis() - pmsAt > 5000) pm25 = NAN;  // sensor unplugged
}
const int LED_PIN = 2;

Adafruit_MPU6050 mpu;
TinyGPSPlus gps;
uint32_t nextSample = 0;

#if USE_WIFI
// Batch ~0.5 s of samples per HTTP request.
const int BATCH_MAX = 25;
String batch;
int batchCount = 0;
uint32_t lastSend = 0;

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("# Wi-Fi connecting");
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) {
    delay(250);
    Serial.print(".");
    digitalWrite(LED_PIN, i % 2);
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " failed (serial only)");
}

void sendBatch() {
  if (batchCount == 0) return;
  if (WiFi.status() != WL_CONNECTED) { batch = ""; batchCount = 0; return; }
  HTTPClient http;
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");
  if (strlen(INGEST_TOKEN)) http.addHeader("x-scootsense-token", INGEST_TOKEN);
  String body = String("{\"device\":\"") + DEVICE_ID + "\",\"samples\":[" + batch + "]}";
  int code = http.POST(body);
  if (code != 200) Serial.printf("# ingest HTTP %d\n", code);
  http.end();
  batch = "";
  batchCount = 0;
}
#endif

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Wire.begin(21, 22);
  Wire.setClock(400000);

  if (!mpu.begin()) {
    Serial.println("# MPU6050 not found! Check SDA=21, SCL=22, 3V3 and GND.");
    while (true) { digitalWrite(LED_PIN, !digitalRead(LED_PIN)); delay(150); }
  }
  // +/-8 g so pothole impacts don't clip; 44 Hz low-pass keeps vibration content.
  mpu.setAccelerometerRange(MPU6050_RANGE_8_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_44_HZ);

  Serial2.begin(9600, SERIAL_8N1, 16, 17);
  PMS.begin(9600, SERIAL_8N1, PMS_RX, -1);

#if USE_WIFI
  connectWifi();
#endif
  Serial.println("time_ms,ax,ay,az,gx,gy,gz,lat,lng,speed_kmh,sats");
  nextSample = micros();
}

void loop() {
  while (Serial2.available()) gps.encode(Serial2.read());
  readPms();

  if ((int32_t)(micros() - nextSample) < 0) return;
  nextSample += SAMPLE_US;

  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);
  const float G = 9.80665f, RAD2DEG = 57.29578f;
  float ax = a.acceleration.x / G, ay = a.acceleration.y / G, az = a.acceleration.z / G;
  float gx = g.gyro.x * RAD2DEG, gy = g.gyro.y * RAD2DEG, gz = g.gyro.z * RAD2DEG;
  bool fix = gps.location.isValid() && gps.location.age() < 3000;

  char line[160];
  if (fix) {
    snprintf(line, sizeof(line), "%lu,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,%.6f,%.6f,%.1f,%lu",
             millis(), ax, ay, az, gx, gy, gz, gps.location.lat(), gps.location.lng(),
             gps.speed.isValid() ? gps.speed.kmph() : 0.0, (unsigned long)gps.satellites.value());
  } else {
    snprintf(line, sizeof(line), "%lu,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,,,,%lu",
             millis(), ax, ay, az, gx, gy, gz, (unsigned long)gps.satellites.value());
  }
  char pmField[12] = "";
  if (!isnan(pm25)) snprintf(pmField, sizeof(pmField), "%.0f", pm25);
  Serial.print(line);
  Serial.print(",");
  Serial.println(pmField);
  digitalWrite(LED_PIN, fix ? HIGH : (millis() / 500) % 2);

#if USE_WIFI
  // JSON array row: [t,ax,ay,az,gx,gy,gz,lat,lng,speed,sats] (null when no fix)
  char row[180];
  if (fix) {
    snprintf(row, sizeof(row), "[%lu,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,%.6f,%.6f,%.1f,%lu]",
             millis(), ax, ay, az, gx, gy, gz, gps.location.lat(), gps.location.lng(),
             gps.speed.isValid() ? gps.speed.kmph() : 0.0, (unsigned long)gps.satellites.value());
  } else {
    snprintf(row, sizeof(row), "[%lu,%.3f,%.3f,%.3f,%.1f,%.1f,%.1f,null,null,null,%lu]",
             millis(), ax, ay, az, gx, gy, gz, (unsigned long)gps.satellites.value());
  }
  row[strlen(row) - 1] = '\0';  // drop "]" to append pm25
  if (batchCount) batch += ",";
  batch += row;
  batch += isnan(pm25) ? String(",null]") : String(",") + String(pm25, 0) + "]";
  batchCount++;
  // Note: the HTTP POST blocks briefly; a few dropped samples per batch are fine for 0.5 s windows.
  if (batchCount >= BATCH_MAX || millis() - lastSend > 1000) {
    sendBatch();
    lastSend = millis();
    nextSample = micros() + SAMPLE_US;
  }
#endif
}
