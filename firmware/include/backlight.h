#pragma once
#include <Arduino.h>

#include "board_pins.h"

/**
 * Backlight on GPIO46 via ledc, matching Elecrow's factory firmware
 * (channel 0, 5kHz, 8-bit). LovyanGFX's Light_PWM does not drive this board --
 * the panel initialises and renders, but the backlight never comes on, so the
 * screen reads as completely dead.
 */
namespace backlight {

constexpr int kChannel = 0;
constexpr int kFreq = 5000;
constexpr int kResolution = 8;

inline void begin(uint8_t percent = 50) {
  ledcSetup(kChannel, kFreq, kResolution);
  ledcAttachPin(PIN_LCD_BL, kChannel);
  ledcWrite(kChannel, (percent * 255) / 100);
}

inline void set(uint8_t percent) {
  if (percent > 100) percent = 100;
  ledcWrite(kChannel, (percent * 255) / 100);
}

}  // namespace backlight
