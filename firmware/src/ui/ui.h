#pragma once
#include <lvgl.h>

#include "../model/stats.h"

namespace ui {

enum Deck : uint8_t { DeckSummary = 0, DeckRepos, DeckActivity, DeckCount };

void init(uint32_t accent);
/** Brief wordmark shown while the network comes up. */
void showSplash();
/** Big centred hostname for the unprovisioned state. */
void showSetup(const char* host);
/** Full-screen message used for boot, provisioning and error states. */
void showStatus(const char* title, const char* detail);
void setStats(const Stats& s);

/** Encoder detents: +1 clockwise. Moves within the current deck. */
void onRotate(int delta);
/** Knob press: advance to the next enabled deck. */
void onPress();
/** Auto-advance tick; honours the configured rotation interval. */
void tick(uint32_t nowMs);

}  // namespace ui
