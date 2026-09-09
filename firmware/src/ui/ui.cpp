#include "ui.h"

#include <math.h>
#include <time.h>

namespace {

constexpr int16_t kSize = 240;
constexpr int16_t kR = kSize / 2;
constexpr float kTau = 6.28318530718f;
constexpr float kTop = -1.57079632679f;  // 12 o'clock

lv_obj_t* gScreen = nullptr;
lv_obj_t* gRoot = nullptr;   // rebuilt on every view change
lv_color_t gAccent;
Stats gStats;
bool gHasStats = false;

uint8_t gDeck = ui::DeckSummary;
int gIndex = 0;
uint32_t gLastAdvance = 0;

lv_color_t rgb(uint32_t v) { return lv_color_hex(v); }

/** Relative time rendered on-device from the NTP clock, never from the server. */
void formatAgo(int64_t epoch, char* out, size_t cap) {
  if (epoch <= 0) {
    snprintf(out, cap, "--");
    return;
  }
  const int64_t now = static_cast<int64_t>(time(nullptr));
  int64_t d = now - epoch;
  if (d < 0) d = 0;
  if (d < 60) snprintf(out, cap, "just now");
  else if (d < 3600) snprintf(out, cap, "%lldm ago", d / 60);
  else if (d < 86400) snprintf(out, cap, "%lldh ago", d / 3600);
  else if (d < 86400LL * 365) snprintf(out, cap, "%lldd ago", d / 86400);
  else snprintf(out, cap, "%lldy ago", d / (86400LL * 365));
}

void compact(int32_t n, char* out, size_t cap) {
  if (n < 10000) snprintf(out, cap, "%ld", static_cast<long>(n));
  else if (n < 1000000) snprintf(out, cap, "%.1fk", n / 1000.0);
  else snprintf(out, cap, "%.1fM", n / 1000000.0);
}

lv_obj_t* label(lv_obj_t* parent, const char* text, const lv_font_t* font, lv_color_t color,
                lv_coord_t y, lv_align_t align = LV_ALIGN_CENTER) {
  lv_obj_t* l = lv_label_create(parent);
  lv_label_set_text(l, text);
  lv_obj_set_style_text_font(l, font, 0);
  lv_obj_set_style_text_color(l, color, 0);
  lv_obj_align(l, align, 0, y);
  return l;
}

void resetRoot() {
  if (gRoot) lv_obj_del(gRoot);
  gRoot = lv_obj_create(gScreen);
  lv_obj_remove_style_all(gRoot);
  lv_obj_set_size(gRoot, kSize, kSize);
  lv_obj_center(gRoot);
  lv_obj_clear_flag(gRoot, LV_OBJ_FLAG_SCROLLABLE);
}

/** Small dots near 6 o'clock showing position within a deck. */
void positionDots(lv_obj_t* parent, int count, int active, lv_coord_t radius) {
  if (count <= 1) return;
  const float spread = fminf(kTau * 0.28f, count * 0.09f);
  for (int i = 0; i < count; i++) {
    const float t = static_cast<float>(i) / (count - 1) - 0.5f;
    // Subtract, matching the browser renderer: adding puts card 0 on the right.
    const float a = 1.57079632679f - t * spread;
    lv_obj_t* dot = lv_obj_create(parent);
    lv_obj_remove_style_all(dot);
    const int d = (i == active) ? 6 : 4;
    lv_obj_set_size(dot, d, d);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(dot, i == active ? gAccent : lv_color_hex(0x3A424C), 0);
    lv_obj_align(dot, LV_ALIGN_CENTER, static_cast<lv_coord_t>(cosf(a) * radius),
                 static_cast<lv_coord_t>(sinf(a) * radius));
  }
}

/* ------------------------------- decks ------------------------------- */

void buildSummary() {
  // Bezel arc: progress through the calendar year, giving the contribution
  // count a frame of reference.
  lv_obj_t* ring = lv_arc_create(gRoot);
  lv_obj_set_size(ring, kSize - 10, kSize - 10);
  lv_obj_center(ring);
  lv_arc_set_rotation(ring, 270);
  lv_arc_set_bg_angles(ring, 0, 360);
  lv_obj_remove_style(ring, nullptr, LV_PART_KNOB);
  lv_obj_clear_flag(ring, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_set_style_arc_width(ring, 4, LV_PART_MAIN);
  lv_obj_set_style_arc_width(ring, 4, LV_PART_INDICATOR);
  lv_obj_set_style_arc_color(ring, lv_color_hex(0x1E242B), LV_PART_MAIN);
  lv_obj_set_style_arc_color(ring, gAccent, LV_PART_INDICATOR);

  const time_t now = time(nullptr);
  struct tm tmv;
  gmtime_r(&now, &tmv);
  lv_arc_set_value(ring, (tmv.tm_yday * 100) / 365);

  char buf[24];
  compact(gStats.contrib, buf, sizeof(buf));
  label(gRoot, buf, &lv_font_montserrat_48, lv_color_white(), -6);
  label(gRoot, "CONTRIBUTIONS", &lv_font_montserrat_10, gAccent, 24);

  label(gRoot, gStats.name[0] ? gStats.name : gStats.login, &lv_font_montserrat_14,
        lv_color_hex(0xD8DEE5), -52);

  snprintf(buf, sizeof(buf), "%ld  |  %ld followers", static_cast<long>(gStats.stars),
           static_cast<long>(gStats.followers));
  label(gRoot, buf, &lv_font_montserrat_12, lv_color_hex(0x8B97A5), 66);
}

void statCell(lv_obj_t* parent, lv_coord_t x, lv_coord_t y, int32_t value, const char* name) {
  char buf[16];
  compact(value, buf, sizeof(buf));
  lv_obj_t* v = lv_label_create(parent);
  lv_label_set_text(v, buf);
  lv_obj_set_style_text_font(v, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(v, lv_color_white(), 0);
  lv_obj_align(v, LV_ALIGN_CENTER, x, y);

  lv_obj_t* n = lv_label_create(parent);
  lv_label_set_text(n, name);
  lv_obj_set_style_text_font(n, &lv_font_montserrat_10, 0);
  lv_obj_set_style_text_color(n, gAccent, 0);
  lv_obj_align(n, LV_ALIGN_CENTER, x, y + 15);
}

void buildRepo() {
  if (gStats.repoCount == 0) {
    label(gRoot, "no repos selected", &lv_font_montserrat_14, lv_color_hex(0x8B97A5), 0);
    return;
  }
  const RepoStat& r = gStats.repos[gIndex % gStats.repoCount];

  lv_obj_t* title = lv_label_create(gRoot);
  lv_label_set_text(title, r.name);
  lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);
  lv_obj_set_width(title, 150);
  lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(title, lv_color_white(), 0);
  lv_obj_align(title, LV_ALIGN_CENTER, 4, -62);

  if (r.langColor) {
    lv_obj_t* dot = lv_obj_create(gRoot);
    lv_obj_remove_style_all(dot);
    lv_obj_set_size(dot, 8, 8);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(dot, rgb(r.langColor), 0);
    lv_obj_align_to(dot, title, LV_ALIGN_OUT_LEFT_MID, -6, 0);
  }

  statCell(gRoot, -40, -18, r.stars, "STARS");
  statCell(gRoot, 40, -18, r.forks, "FORKS");
  statCell(gRoot, -40, 30, r.openPRs, "OPEN PRS");
  statCell(gRoot, 40, 30, r.openIssues, "ISSUES");

  char ts[24];
  formatAgo(r.lastCommitAt, ts, sizeof(ts));
  label(gRoot, ts, &lv_font_montserrat_10, lv_color_hex(0x76818E), 62);

  positionDots(gRoot, gStats.repoCount, gIndex % gStats.repoCount, kR - 10);
}

/**
 * 52 weekly commit totals as radial bars -- one revolution is one year.
 * Normalised per repo: peaks range from 18 to 228 across these repos, so a
 * shared scale would flatten most of them to nothing.
 */
void buildSpark() {
  if (gStats.repoCount == 0) return;
  const RepoStat& r = gStats.repos[gIndex % gStats.repoCount];

  const int16_t inner = kR - 40;
  const int16_t outer = kR - 8;

  if (r.weekCount == 0) {
    label(gRoot, "no commit data yet", &lv_font_montserrat_14, lv_color_hex(0x8B97A5), 8);
  } else {
    uint16_t peak = 1;
    for (uint8_t i = 0; i < r.weekCount; i++) peak = max(peak, r.weeks[i]);

    // A canvas is the only sane way to draw 52 arbitrary-angle bars; 240x240 at
    // 16bpp is ~113KB, which is nothing against 8MB of PSRAM.
    static lv_color_t* buf = nullptr;
    if (!buf) {
      buf = static_cast<lv_color_t*>(
          heap_caps_malloc(kSize * kSize * sizeof(lv_color_t), MALLOC_CAP_SPIRAM));
    }
    if (buf) {
      lv_obj_t* canvas = lv_canvas_create(gRoot);
      lv_canvas_set_buffer(canvas, buf, kSize, kSize, LV_IMG_CF_TRUE_COLOR);
      lv_obj_center(canvas);
      lv_canvas_fill_bg(canvas, rgb(gStats.bg), LV_OPA_COVER);

      lv_draw_line_dsc_t dsc;
      lv_draw_line_dsc_init(&dsc);
      dsc.round_start = 1;
      dsc.round_end = 1;

      const float step = kTau / r.weekCount;
      for (uint8_t i = 0; i < r.weekCount; i++) {
        const float a = kTop + i * step;
        const bool zero = r.weeks[i] == 0;
        const float len = zero ? 2.0f : 4.0f + (outer - inner - 4) * (static_cast<float>(r.weeks[i]) / peak);
        dsc.color = zero ? lv_color_hex(0x2A313A) : gAccent;
        dsc.width = zero ? 2 : 4;
        lv_point_t pts[2] = {
            {static_cast<lv_coord_t>(kR + cosf(a) * inner), static_cast<lv_coord_t>(kR + sinf(a) * inner)},
            {static_cast<lv_coord_t>(kR + cosf(a) * (inner + len)),
             static_cast<lv_coord_t>(kR + sinf(a) * (inner + len))},
        };
        lv_canvas_draw_line(canvas, pts, 2, &dsc);
      }
    }

    char buf2[16];
    snprintf(buf2, sizeof(buf2), "%u", static_cast<unsigned>(peak));
    label(gRoot, buf2, &lv_font_montserrat_14, lv_color_hex(0xE0E6EC), 24);
    label(gRoot, "PEAK WEEK", &lv_font_montserrat_10, lv_color_hex(0x76818E), 40);
    label(gRoot, "52 WEEKS", &lv_font_montserrat_10, lv_color_hex(0x5C6672), 54);
  }

  lv_obj_t* title = lv_label_create(gRoot);
  lv_label_set_text(title, r.name);
  lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);
  lv_obj_set_width(title, 130);
  lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(title, lv_color_white(), 0);
  lv_obj_align(title, LV_ALIGN_CENTER, 0, -4);

  positionDots(gRoot, gStats.repoCount, gIndex % gStats.repoCount, inner - 14);
}

void buildActivity() {
  label(gRoot, "ACTIVITY", &lv_font_montserrat_10, gAccent, -80);

  if (gStats.eventCount == 0) {
    label(gRoot, "all quiet", &lv_font_montserrat_14, lv_color_hex(0x8B97A5), 4);
    return;
  }

  const int rows = min<int>(gStats.eventCount, 4);
  const int rowH = 30;
  const int top = -(rows * rowH) / 2 + 20;

  for (int i = 0; i < rows; i++) {
    const EventStat& e = gStats.events[i];
    const lv_coord_t y = top + i * rowH;

    char head[24];
    if (e.delta > 0) snprintf(head, sizeof(head), "+%ld %s", static_cast<long>(e.delta), e.kind);
    else if (e.delta < 0) snprintf(head, sizeof(head), "%ld %s", static_cast<long>(e.delta), e.kind);
    else snprintf(head, sizeof(head), "%s", e.kind);

    lv_obj_t* h = lv_label_create(gRoot);
    lv_label_set_text(h, head);
    lv_obj_set_style_text_font(h, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(h, strcmp(e.kind, "star") == 0 ? gAccent : lv_color_white(), 0);
    lv_obj_align(h, LV_ALIGN_CENTER, -84 + 40, y);
    lv_obj_set_style_text_align(h, LV_TEXT_ALIGN_LEFT, 0);

    const char* slash = strchr(e.repo, '/');
    lv_obj_t* n = lv_label_create(gRoot);
    lv_label_set_text(n, slash ? slash + 1 : e.repo);
    lv_label_set_long_mode(n, LV_LABEL_LONG_DOT);
    lv_obj_set_width(n, 96);
    lv_obj_set_style_text_font(n, &lv_font_montserrat_12, 0);
    lv_obj_set_style_text_color(n, lv_color_hex(0x9AA5B1), 0);
    lv_obj_align(n, LV_ALIGN_CENTER, 26, y);

    char ts[24];
    formatAgo(e.at, ts, sizeof(ts));
    lv_obj_t* t = lv_label_create(gRoot);
    lv_label_set_text(t, ts);
    lv_obj_set_style_text_font(t, &lv_font_montserrat_10, 0);
    lv_obj_set_style_text_color(t, lv_color_hex(0x5C6672), 0);
    lv_obj_align(t, LV_ALIGN_CENTER, 52, y + 13);
  }
}

bool deckOn(uint8_t d) { return !gHasStats || gStats.deckEnabled[d]; }

int deckLength() {
  if (gDeck == ui::DeckRepos || gDeck == ui::DeckSpark) return max<int>(1, gStats.repoCount);
  return 1;
}

void redraw() {
  if (!gHasStats) return;
  resetRoot();
  lv_obj_set_style_bg_color(gScreen, rgb(gStats.bg), 0);
  gAccent = rgb(gStats.accent);

  switch (gDeck) {
    case ui::DeckSummary: buildSummary(); break;
    case ui::DeckRepos: buildRepo(); break;
    case ui::DeckSpark: buildSpark(); break;
    case ui::DeckActivity: buildActivity(); break;
    default: break;
  }
}

}  // namespace

namespace ui {

void init(uint32_t accent) {
  gAccent = rgb(accent);
  gScreen = lv_scr_act();
  lv_obj_set_style_bg_color(gScreen, lv_color_hex(0x0B0D10), 0);
  lv_obj_set_style_bg_opa(gScreen, LV_OPA_COVER, 0);
  lv_obj_clear_flag(gScreen, LV_OBJ_FLAG_SCROLLABLE);
  resetRoot();
}

void showStatus(const char* title, const char* detail) {
  resetRoot();
  label(gRoot, title, &lv_font_montserrat_16, lv_color_white(), -12);
  lv_obj_t* d = lv_label_create(gRoot);
  lv_label_set_text(d, detail);
  lv_label_set_long_mode(d, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(d, 170);
  lv_obj_set_style_text_align(d, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(d, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(d, lv_color_hex(0x8B97A5), 0);
  lv_obj_align(d, LV_ALIGN_CENTER, 0, 18);
}

void setStats(const Stats& s) {
  gStats = s;
  gHasStats = true;
  if (!deckOn(gDeck)) onPress();
  else redraw();
}

void onRotate(int delta) {
  if (!gHasStats) return;
  const int len = deckLength();
  gIndex = ((gIndex + delta) % len + len) % len;
  redraw();
}

void onPress() {
  if (!gHasStats) return;
  for (int i = 1; i <= DeckCount; i++) {
    const uint8_t next = (gDeck + i) % DeckCount;
    if (deckOn(next)) {
      gDeck = next;
      break;
    }
  }
  gIndex = 0;
  gLastAdvance = millis();
  redraw();
}

void tick(uint32_t nowMs) {
  if (!gHasStats || gStats.rotSec == 0) return;
  if (nowMs - gLastAdvance < gStats.rotSec * 1000UL) return;
  gLastAdvance = nowMs;

  // Walk cards first, then move on to the next deck.
  const int len = deckLength();
  if (gIndex + 1 < len) {
    gIndex++;
    redraw();
  } else {
    onPress();
  }
}

}  // namespace ui
