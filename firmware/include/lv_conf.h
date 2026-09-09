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

// Anti-aliased arcs carry the whole design on a round panel.
#define LV_DRAW_COMPLEX 1

/*
 * Widgets: only what the UI actually creates -- label, obj, img, arc -- plus
 * flex for the two centred rows. Everything else is off.
 *
 * LVGL compiles every enabled widget whether or not it is referenced, and it
 * was 192 of the 372 objects in this build. Turning off the unused ones is the
 * single biggest lever on CI build time, and it costs nothing: adding one back
 * is a one-line change here.
 */
#define LV_USE_ARC 1
#define LV_USE_LABEL 1
#define LV_USE_IMG 1
#define LV_USE_BTN 1  /* the default theme styles buttons; cheap to keep */
#define LV_USE_FLEX 1

#define LV_USE_CANVAS 0
#define LV_USE_ANIMIMG 0
#define LV_USE_BAR 0
#define LV_USE_BTNMATRIX 0
#define LV_USE_CHECKBOX 0
#define LV_USE_DROPDOWN 0
#define LV_USE_LINE 0
#define LV_USE_ROLLER 0
#define LV_USE_SLIDER 0
#define LV_USE_SWITCH 0
#define LV_USE_TABLE 0
#define LV_USE_TEXTAREA 0
#define LV_USE_GRID 0

#define LV_USE_CALENDAR 0
#define LV_USE_CHART 0
#define LV_USE_COLORWHEEL 0
#define LV_USE_IMGBTN 0
#define LV_USE_KEYBOARD 0
#define LV_USE_LED 0
#define LV_USE_LIST 0
#define LV_USE_MENU 0
#define LV_USE_METER 0
#define LV_USE_MSGBOX 0
#define LV_USE_SPAN 0
#define LV_USE_SPINBOX 0
#define LV_USE_SPINNER 0
#define LV_USE_TABVIEW 0
#define LV_USE_TILEVIEW 0
#define LV_USE_WIN 0

/* Decoders, filesystems and demos we have no use for. */
#define LV_USE_PNG 0
#define LV_USE_BMP 0
#define LV_USE_SJPG 0
#define LV_USE_GIF 0
#define LV_USE_QRCODE 0
#define LV_USE_FREETYPE 0
#define LV_USE_RLOTTIE 0
#define LV_USE_FFMPEG 0
#define LV_USE_SNAPSHOT 0
#define LV_USE_MONKEY 0
#define LV_USE_GRIDNAV 0
#define LV_USE_FRAGMENT 0
#define LV_USE_IMGFONT 0
#define LV_USE_MSG 0
#define LV_USE_IME_PINYIN 0
#define LV_BUILD_EXAMPLES 0
#define LV_USE_DEMO_WIDGETS 0
#define LV_USE_DEMO_BENCHMARK 0
#define LV_USE_DEMO_STRESS 0
#define LV_USE_DEMO_KEYPAD_AND_ENCODER 0
#define LV_USE_DEMO_MUSIC 0

#define LV_USE_THEME_BASIC 0
#define LV_USE_THEME_MONO 0

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
