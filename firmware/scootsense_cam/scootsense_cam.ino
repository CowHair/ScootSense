/*
  ScootSense litter camera: ESP32-CAM (AI-Thinker) with OV2640

  Takes a JPEG every few seconds and POSTs it to the ScootSense server, which asks
  Gemini whether there is litter on the path. When there is, the rider's phone asks
  whether they want to pick it up or leave it on the map.

  Board:   "AI Thinker ESP32-CAM" (esp32 by Espressif). Enable PSRAM.
  Flash:   use an ESP32-CAM-MB USB board, or an FTDI adapter with GPIO0 tied to GND.
  Mount:   on the handlebar stem, angled down so the path 2-5 m ahead fills the frame.
  Power:   5V from a USB power bank (the camera browns out on weak 3.3V supplies).

  First boot: open Serial Monitor at 115200. It prints the camera ID (e.g. cam-7f3a).
  In the app: Scan tab -> Link camera -> enter that ID.
*/

#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ----------------------------------------------------------------- settings
const char* WIFI_SSID    = "your-hotspot";
const char* WIFI_PASS    = "your-password";
// The deployed app, or your laptop on the same network (http://192.168.x.x:3000)
const char* SERVER_URL   = "https://scootsense.vercel.app";
const char* INGEST_TOKEN = "";        // match INGEST_TOKEN on the server if you set one
const uint32_t CAPTURE_MS = 5000;     // one frame every 5 s keeps Gemini's free tier happy

// ----------------------------------------------------------------- AI-Thinker pin map
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define STATUS_LED        33   // small red LED on the back, active LOW
#define FLASH_LED          4   // bright white flash: kept off

String deviceId;
uint32_t lastShot = 0;

void blink(int times, int ms) {
  for (int i = 0; i < times; i++) {
    digitalWrite(STATUS_LED, LOW);  delay(ms);
    digitalWrite(STATUS_LED, HIGH); delay(ms);
  }
}

bool startCamera() {
  camera_config_t c = {};
  c.ledc_channel = LEDC_CHANNEL_0;
  c.ledc_timer   = LEDC_TIMER_0;
  c.pin_d0 = Y2_GPIO_NUM; c.pin_d1 = Y3_GPIO_NUM; c.pin_d2 = Y4_GPIO_NUM; c.pin_d3 = Y5_GPIO_NUM;
  c.pin_d4 = Y6_GPIO_NUM; c.pin_d5 = Y7_GPIO_NUM; c.pin_d6 = Y8_GPIO_NUM; c.pin_d7 = Y9_GPIO_NUM;
  c.pin_xclk = XCLK_GPIO_NUM; c.pin_pclk = PCLK_GPIO_NUM;
  c.pin_vsync = VSYNC_GPIO_NUM; c.pin_href = HREF_GPIO_NUM;
  c.pin_sccb_sda = SIOD_GPIO_NUM; c.pin_sccb_scl = SIOC_GPIO_NUM;
  c.pin_pwdn = PWDN_GPIO_NUM; c.pin_reset = RESET_GPIO_NUM;
  c.xclk_freq_hz = 20000000;
  c.pixel_format = PIXFORMAT_JPEG;
  // VGA at quality 14 is ~25-45 KB: enough detail for Gemini, quick to upload on a hotspot.
  c.frame_size   = FRAMESIZE_VGA;
  c.jpeg_quality = 14;
  c.fb_count     = psramFound() ? 2 : 1;
  c.fb_location  = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  c.grab_mode    = CAMERA_GRAB_LATEST;   // always send the newest frame, not a stale one
  if (esp_camera_init(&c) != ESP_OK) return false;

  sensor_t* s = esp_camera_sensor_get();
  s->set_vflip(s, 0);        // flip these if your mount is upside down
  s->set_hmirror(s, 0);
  s->set_whitebal(s, 1);
  s->set_exposure_ctrl(s, 1);
  return true;
}

void connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi");
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) {
    delay(250);
    Serial.print(".");
    digitalWrite(STATUS_LED, i % 2);
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " connected" : " failed, retrying later");
}

void setup() {
  Serial.begin(115200);
  pinMode(STATUS_LED, OUTPUT);
  pinMode(FLASH_LED, OUTPUT);
  digitalWrite(FLASH_LED, LOW);
  digitalWrite(STATUS_LED, HIGH);

  WiFi.mode(WIFI_STA);  // the MAC reads as zeros until Wi-Fi is started
  uint8_t mac[6];
  WiFi.macAddress(mac);
  char id[16];
  snprintf(id, sizeof(id), "cam-%02x%02x", mac[4], mac[5]);
  deviceId = id;

  Serial.println();
  Serial.println("ScootSense litter camera");
  Serial.print("Camera ID: ");
  Serial.println(deviceId);
  Serial.println("Link it in the app: Scan tab -> Link camera");

  if (!startCamera()) {
    Serial.println("Camera init failed. Check the ribbon cable and that PSRAM is enabled.");
    while (true) blink(1, 100);
  }
  connectWifi();
}

void sendFrame() {
  camera_fb_t* fb = esp_camera_fb_get();
  if (!fb) { Serial.println("Capture failed"); return; }

  String url = String(SERVER_URL) + "/api/cam/frame?device=" + deviceId;
  HTTPClient http;
  WiFiClientSecure secure;
  WiFiClient plain;
  if (url.startsWith("https")) {
    secure.setInsecure();  // hackathon shortcut: skips certificate checks. Pin the CA for real use.
    http.begin(secure, url);
  } else {
    http.begin(plain, url);
  }
  http.setTimeout(30000);   // Gemini takes a few seconds
  http.addHeader("Content-Type", "image/jpeg");
  if (strlen(INGEST_TOKEN)) http.addHeader("x-scootsense-token", INGEST_TOKEN);

  uint32_t t0 = millis();
  int code = http.POST(fb->buf, fb->len);
  size_t bytes = fb->len;
  esp_camera_fb_return(fb);   // free the buffer before handling the reply

  String body = code > 0 ? http.getString() : http.errorToString(code);
  http.end();
  Serial.printf("%u bytes -> HTTP %d in %lu ms: %s\n", (unsigned)bytes, code, millis() - t0, body.substring(0, 160).c_str());

  if (body.indexOf("\"trash\":true") >= 0) blink(3, 120);          // litter: rider's phone is asking now
  else if (body.indexOf("\"paired\":false") >= 0) blink(2, 400);   // not linked to a rider yet
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWifi();
    delay(2000);
    return;
  }
  if (millis() - lastShot >= CAPTURE_MS) {
    lastShot = millis();
    sendFrame();
  }
  delay(20);
}
