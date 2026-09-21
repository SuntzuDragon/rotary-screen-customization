#pragma once

// Pin map from the Elecrow CrowPanel 1.28" HMI wiki. Verified against the
// board enumerating as USB VID 0x303A PID 0x1001 (native ESP32-S3 USB).

// Board power enables. NOT documented in the Elecrow wiki pin table -- found
// only in their factory source, which drives both HIGH first thing in setup().
// Without them the panel has no power at all: the backlight pin does nothing in
// either state and the display appears completely dead.
#define PIN_PWR_EN1 1
#define PIN_PWR_EN2 2

// GC9A01 240x240 round IPS over SPI
#define PIN_LCD_SCLK 10
#define PIN_LCD_MOSI 11
#define PIN_LCD_DC   3
#define PIN_LCD_CS   9
#define PIN_LCD_RST  14
#define PIN_LCD_BL   46  // backlight, PWM for brightness

// CST816D capacitive touch over I2C
#define PIN_TP_SDA   6
#define PIN_TP_SCL   7
#define PIN_TP_INT   5
#define PIN_TP_RST   13
#define CST816D_ADDR 0x15

// Rotary encoder with push
#define PIN_ENC_A  45
#define PIN_ENC_B  42
#define PIN_ENC_SW 41

#define PIN_RGB_LED 48
#define PIN_PWR_IND 40  // power indicator LED, active low

// External I2C on the 4P connector -- NOT the touch bus. The wiki's pin table
// lists these as the touch pins, which is wrong; touch is on 6/7 above.
#define PIN_EXT_SDA 38
#define PIN_EXT_SCL 39

#define SCREEN_W 240
#define SCREEN_H 240
