#include <Arduino.h>
#include <ESP_I2S.h>
#include "esp_wn_models.h"
#include "model_path.h"
#include "wake_word.h"

static I2SClass microphone;
static srmodel_list_t *models = nullptr;
static const esp_wn_iface_t *wakeNet = nullptr;
static model_iface_data_t *wakeData = nullptr;
static int16_t *samples = nullptr;
static size_t frameBytes = 0, filled = 0;
static uint32_t reportAt = 0, frames = 0;

void endWakeWord() {
  microphone.end();
  free(samples); samples = nullptr;
  if (wakeData) wakeNet->destroy(wakeData);
  wakeData = nullptr;
  if (models) esp_srmodel_deinit(models);
  models = nullptr;
}

bool beginWakeWord() {
  if (!psramFound()) { Serial.println("WAKE_ERROR PSRAM missing"); return false; }
  models = esp_srmodel_init("model");
  char *name = models ? esp_srmodel_filter(models, ESP_WN_PREFIX, "miaomiaotongxue") : nullptr;
  if (!name) { Serial.println("WAKE_ERROR model partition missing"); endWakeWord(); return false; }
  wakeNet = esp_wn_handle_from_name(name);
  wakeData = wakeNet ? wakeNet->create(name, DET_MODE_95) : nullptr;
  if (!wakeData) { Serial.println("WAKE_ERROR incompatible model"); endWakeWord(); return false; }
  int chunk = wakeNet->get_samp_chunksize(wakeData);
  int rate = wakeNet->get_samp_rate(wakeData);
  int channels = wakeNet->get_channel_num(wakeData);
  if (chunk <= 0 || rate != 16000 || channels != 1) {
    Serial.printf("WAKE_ERROR audio format chunk=%d rate=%d channels=%d\n", chunk, rate, channels);
    endWakeWord(); return false;
  }
  frameBytes = chunk * sizeof(int16_t);
  samples = static_cast<int16_t *>(malloc(frameBytes));
  microphone.setPinsPdmRx(42, 41);
  if (!samples || !microphone.begin(I2S_MODE_PDM_RX, rate, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO)) {
    Serial.println("WAKE_ERROR microphone init"); endWakeWord(); return false;
  }
  Serial.printf("WAKE_READY word=%s model=%s chunk=%d heap=%u psramFree=%u\n",
                wakeNet->get_word_name(wakeData, 1), name, chunk, ESP.getFreeHeap(), ESP.getFreePsram());
  reportAt = millis();
  return true;
}

bool pollWakeWord() {
  size_t got = microphone.readBytes(reinterpret_cast<char *>(samples) + filled, frameBytes - filled);
  filled += got;
  if (filled != frameBytes) return false;
  filled = 0;
  uint32_t started = micros();
  int result = wakeNet->detect(wakeData, samples);
  uint32_t inferenceUs = micros() - started;
  frames++;
  if (millis() - reportAt >= 5000) {
    int peak = 0;
    for (size_t i = 0; i < frameBytes / sizeof(int16_t); ++i) peak = max(peak, abs((int)samples[i]));
    Serial.printf("WAKE_LISTEN frames=%u peak=%d inference_us=%u heap=%u\n", frames, peak, inferenceUs, ESP.getFreeHeap());
    reportAt = millis();
  }
  if (result > 0) { Serial.printf("WAKE_DETECTED index=%d\n", result); return true; }
  return false;
}
