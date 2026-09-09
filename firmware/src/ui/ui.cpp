#include "ui.h"

#include "star_img.h"

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

/**
 * Every screen is one entry in a single flat list the knob scrolls end to end,
 * so nothing is reachable only by touch. The knob press jumps to the head of
 * the next section rather than stepping, so reaching Activity does not mean
 * cranking past every repo.
 */
struct Card {
  uint8_t deck;
  uint8_t index;
};

constexpr uint8_t kMaxCards = 2 + kMaxRepos;
Card gCards[kMaxCards];
uint8_t gCardCount = 0;
uint8_t gCursor = 0;
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

/**
 * Position indicator near 6 o'clock.
 *
 * The scroll list is flat but not uniform -- Summary and Activity are single
 * cards while Repos and Sparks are runs of one per repo. Drawing every dot
 * identically hides that, so sections are separated by a gap and the first dot
 * of each section is drawn slightly larger. You can read the shape of the whole
 * list at a glance and tell a section head from a sub-item.
 */
void positionDots(lv_obj_t* parent, lv_coord_t radius) {
  if (gCardCount <= 1) return;

  constexpr float kGapUnits = 1.15f;  // extra spacing inserted between sections

  // First pass: lay cards out on a 1-unit pitch, widening at section changes.
  float offset[kMaxCards];
  float cursor = 0.0f;
  for (uint8_t i = 0; i < gCardCount; i++) {
    if (i > 0) cursor += (gCards[i].deck != gCards[i - 1].deck) ? (1.0f + kGapUnits) : 1.0f;
    offset[i] = cursor;
  }
  const float span = cursor > 0.0f ? cursor : 1.0f;

  const float spread = fminf(kTau * 0.34f, span * 0.085f);
  for (uint8_t i = 0; i < gCardCount; i++) {
    const float t = offset[i] / span - 0.5f;
    const float a = 1.57079632679f - t * spread;  // clockwise from 6 o'clock

    const bool head = (i == 0) || (gCards[i].deck != gCards[i - 1].deck);
    const bool active = (i == gCursor);
    const int d = active ? 7 : (head ? 5 : 3);

    lv_obj_t* dot = lv_obj_create(parent);
    lv_obj_remove_style_all(dot);
    lv_obj_set_size(dot, d, d);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(
        dot, active ? gAccent : lv_color_hex(head ? 0x5C6672 : 0x333B45), 0);
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

  char buf[32];
  compact(gStats.contrib, buf, sizeof(buf));
  label(gRoot, buf, &lv_font_montserrat_48, lv_color_white(), -8);
  label(gRoot, "CONTRIBUTIONS", &lv_font_montserrat_12, gAccent, 26);

  lv_obj_t* name = lv_label_create(gRoot);
  lv_label_set_text(name, gStats.name[0] ? gStats.name : gStats.login);
  lv_label_set_long_mode(name, LV_LABEL_LONG_DOT);
  lv_obj_set_width(name, 210);
  lv_obj_set_style_text_align(name, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(name, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_color(name, lv_color_hex(0xD8DEE5), 0);
  lv_obj_align(name, LV_ALIGN_CENTER, 0, -56);

  // Star + count as a centred row. The glyph is a generated alpha image
  // (tools/gen_star.py) because neither LVGL's Montserrat build nor its
  // FontAwesome symbol subset contains a star.
  lv_obj_t* row = lv_obj_create(gRoot);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(row, 5, 0);
  lv_obj_align(row, LV_ALIGN_CENTER, 0, 60);

  lv_obj_t* star = lv_img_create(row);
  lv_img_set_src(star, &kStarImg);
  lv_obj_set_style_img_recolor(star, gAccent, 0);
  lv_obj_set_style_img_recolor_opa(star, LV_OPA_COVER, 0);

  snprintf(buf, sizeof(buf), "%ld", static_cast<long>(gStats.stars));
  lv_obj_t* stars = lv_label_create(row);
  lv_label_set_text(stars, buf);
  lv_obj_set_style_text_font(stars, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(stars, lv_color_white(), 0);

  snprintf(buf, sizeof(buf), "%ld FOLLOWERS", static_cast<long>(gStats.followers));
  label(gRoot, buf, &lv_font_montserrat_12, lv_color_hex(0x8B97A5), 84);
}

void statCell(lv_obj_t* parent, lv_coord_t x, lv_coord_t y, int32_t value, const char* name) {
  char buf[16];
  compact(value, buf, sizeof(buf));
  lv_obj_t* v = lv_label_create(parent);
  lv_label_set_text(v, buf);
  lv_obj_set_style_text_font(v, &lv_font_montserrat_28, 0);
  lv_obj_set_style_text_color(v, lv_color_white(), 0);
  lv_obj_align(v, LV_ALIGN_CENTER, x, y);

  lv_obj_t* n = lv_label_create(parent);
  lv_label_set_text(n, name);
  lv_obj_set_style_text_font(n, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(n, gAccent, 0);
  lv_obj_align(n, LV_ALIGN_CENTER, x, y + 20);
}

void buildRepo(uint8_t idx) {
  if (gStats.repoCount == 0) {
    label(gRoot, "no repos selected", &lv_font_montserrat_14, lv_color_hex(0x8B97A5), 0);
    return;
  }
  const RepoStat& r = gStats.repos[idx % gStats.repoCount];

  // Title, with the language colour dot beside it in a centred flex row.
  //
  // The dot used to be aligned to the *label object*, which is a fixed-width
  // box far wider than the text, so it landed outside the circle and got
  // clipped. Measuring the text and letting flex size the row keeps the pair
  // centred and inside the glass whatever the repo name length.
  const lv_coord_t kTitleMax = 150;
  lv_point_t textSize;
  lv_txt_get_size(&textSize, r.name, &lv_font_montserrat_20, 0, 0, LV_COORD_MAX,
                  LV_TEXT_FLAG_NONE);

  lv_obj_t* row = lv_obj_create(gRoot);
  lv_obj_remove_style_all(row);
  lv_obj_set_size(row, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
  lv_obj_set_flex_flow(row, LV_FLEX_FLOW_ROW);
  lv_obj_set_flex_align(row, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
  lv_obj_set_style_pad_column(row, 6, 0);
  lv_obj_align(row, LV_ALIGN_CENTER, 0, -72);

  if (r.langColor) {
    lv_obj_t* dot = lv_obj_create(row);
    lv_obj_remove_style_all(dot);
    lv_obj_set_size(dot, 8, 8);
    lv_obj_set_style_radius(dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
    lv_obj_set_style_bg_color(dot, rgb(r.langColor), 0);
  }

  lv_obj_t* title = lv_label_create(row);
  lv_label_set_text(title, r.name);
  lv_label_set_long_mode(title, LV_LABEL_LONG_DOT);
  lv_obj_set_width(title, LV_MIN(textSize.x + 2, kTitleMax));
  lv_obj_set_style_text_align(title, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(title, lv_color_white(), 0);

  statCell(gRoot, -46, -22, r.stars, "STARS");
  statCell(gRoot, 46, -22, r.forks, "FORKS");
  statCell(gRoot, -46, 34, r.openPRs, "OPEN PRS");
  statCell(gRoot, 46, 34, r.openIssues, "ISSUES");

  char ts[24];
  formatAgo(r.lastCommitAt, ts, sizeof(ts));
  label(gRoot, ts, &lv_font_montserrat_12, lv_color_hex(0x8B97A5), 76);
}

void buildActivity() {
  label(gRoot, "ACTIVITY", &lv_font_montserrat_12, gAccent, -88);

  if (gStats.eventCount == 0) {
    label(gRoot, "all quiet", &lv_font_montserrat_20, lv_color_hex(0x8B97A5), 0);
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
    lv_obj_set_style_text_font(h, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(h, strcmp(e.kind, "star") == 0 ? gAccent : lv_color_white(), 0);
    lv_obj_align(h, LV_ALIGN_CENTER, -48, y);
    lv_obj_set_style_text_align(h, LV_TEXT_ALIGN_LEFT, 0);

    const char* slash = strchr(e.repo, '/');
    lv_obj_t* n = lv_label_create(gRoot);
    lv_label_set_text(n, slash ? slash + 1 : e.repo);
    lv_label_set_long_mode(n, LV_LABEL_LONG_DOT);
    lv_obj_set_width(n, 110);
    lv_obj_set_style_text_font(n, &lv_font_montserrat_14, 0);
    lv_obj_set_style_text_color(n, lv_color_hex(0x9AA5B1), 0);
    lv_obj_align(n, LV_ALIGN_CENTER, 34, y);

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

/** Flatten the enabled decks into one scrollable list. */
void rebuildCards() {
  gCardCount = 0;
  const auto add = [](uint8_t deck, uint8_t index) {
    if (gCardCount < kMaxCards) gCards[gCardCount++] = {deck, index};
  };

  if (deckOn(ui::DeckSummary)) add(ui::DeckSummary, 0);
  if (deckOn(ui::DeckRepos))
    for (uint8_t i = 0; i < gStats.repoCount; i++) add(ui::DeckRepos, i);
  if (deckOn(ui::DeckActivity)) add(ui::DeckActivity, 0);

  if (gCardCount == 0) add(ui::DeckSummary, 0);  // never leave the screen empty
  if (gCursor >= gCardCount) gCursor = 0;
}

void redraw() {
  if (!gHasStats || gCardCount == 0) return;
  resetRoot();
  lv_obj_set_style_bg_color(gScreen, rgb(gStats.bg), 0);
  gAccent = rgb(gStats.accent);

  const Card& card = gCards[gCursor];
  switch (card.deck) {
    case ui::DeckSummary: buildSummary(); break;
    case ui::DeckRepos: buildRepo(card.index); break;
    case ui::DeckActivity: buildActivity(); break;
    default: break;
  }

  // Always the same radius: the dots must not move as you scroll.
  positionDots(gRoot, kR - 9);
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
  rebuildCards();
  redraw();
}

void onRotate(int delta) {
  if (!gHasStats || gCardCount == 0) return;
  gCursor = static_cast<uint8_t>((gCursor + delta + gCardCount) % gCardCount);
  gLastAdvance = millis();
  redraw();
}

/** Jump to the first card of the next section. */
void onPress() {
  if (!gHasStats || gCardCount == 0) return;
  const uint8_t curDeck = gCards[gCursor].deck;
  for (uint8_t step = 1; step <= gCardCount; step++) {
    const uint8_t idx = static_cast<uint8_t>((gCursor + step) % gCardCount);
    if (gCards[idx].deck != curDeck) {
      gCursor = idx;
      break;
    }
  }
  gLastAdvance = millis();
  redraw();
}

void tick(uint32_t nowMs) {
  if (!gHasStats || gStats.rotSec == 0 || gCardCount == 0) return;
  if (nowMs - gLastAdvance < gStats.rotSec * 1000UL) return;
  gLastAdvance = nowMs;
  gCursor = static_cast<uint8_t>((gCursor + 1) % gCardCount);
  redraw();
}

}  // namespace ui
