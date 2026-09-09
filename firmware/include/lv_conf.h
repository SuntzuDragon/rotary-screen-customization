/**
 * LVGL 8.3 configuration. Only the values that differ from lv_conf_internal.h
 * defaults are set here -- everything else falls through to LVGL's defaults.
 */
#pragma once

#define LV_CONF_SKIP 0

#define LV_COLOR_DEPTH 16
// 0, not 1. The flush hands LovyanGFX an lgfx::rgb565_t buffer, which is
// already the panel's native order. Setting this to 1 as well swaps the bytes
// twice and the colours come out wrong.
#define LV_COLOR_16_SWAP 0

#define LV_MEM_CUSTOM 0
#define LV_MEM_SIZE (48U * 1024U)

#define LV_TICK_CUSTOM 1
#define LV_TICK_CUSTOM_INCLUDE "Arduino.h"
#define LV_TICK_CUSTOM_SYS_TIME_EXPR (millis())

#define LV_DISP_DEF_REFR_PERIOD 16
#define LV_INDEV_DEF_READ_PERIOD 16

#define LV_USE_LOG 0
#define LV_USE_ASSERT_NULL 1
#define LV_USE_PERF_MONITOR 0

// Anti-aliased arcs and lines carry the whole design on a round panel.
#define LV_DRAW_COMPLEX 1
#define LV_USE_ARC 1
#define LV_USE_CANVAS 1
#define LV_USE_LABEL 1
#define LV_USE_BTN 1
#define LV_USE_IMG 1

#define LV_FONT_MONTSERRAT_10 1
#define LV_FONT_MONTSERRAT_12 1
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_MONTSERRAT_28 1
#define LV_FONT_MONTSERRAT_48 1   // hero numbers on the summary dial
#define LV_FONT_DEFAULT &lv_font_montserrat_14

#define LV_USE_THEME_DEFAULT 1
#define LV_THEME_DEFAULT_DARK 1
