#pragma once
#include <Wire.h>

// Run only after camera initialization has failed and released its SCCB bus.
static void diagnoseCameraBus() {
  bool clock = ledcAttach(XCLK_GPIO_NUM, 20000000, 1);
  if (clock) ledcWrite(XCLK_GPIO_NUM, 1);
  bool bus = Wire.begin(SIOD_GPIO_NUM, SIOC_GPIO_NUM, 100000);
  Serial.printf("CAM_DIAG clock=%d bus=%d SDA=%d SCL=%d\n", clock, bus,
                digitalRead(SIOD_GPIO_NUM), digitalRead(SIOC_GPIO_NUM));
  if (bus) {
    Wire.setTimeOut(50);
    delay(20);
    int found = 0;
    for (uint8_t addr = 8; addr < 120; addr++) {
      Wire.beginTransmission(addr);
      if (Wire.endTransmission() != 0) continue;
      found++;
      Serial.printf("CAM_DIAG ACK address=0x%02x\n", addr);
      if (addr == 0x3c) {
        for (uint16_t reg : {0x300a, 0x300b}) {
          Wire.beginTransmission(addr);
          Wire.write(reg >> 8); Wire.write(reg & 0xff);
          int status = Wire.endTransmission();
          size_t count = status == 0 ? Wire.requestFrom(addr, (uint8_t)1) : 0;
          Serial.printf("CAM_DIAG reg=0x%04x status=%d value=%d\n", reg, status, count ? Wire.read() : -1);
        }
      }
    }
    Serial.printf("CAM_DIAG total_responding_addresses=%d\n", found);
    Wire.end();
  }
  if (clock) ledcDetach(XCLK_GPIO_NUM);
}
