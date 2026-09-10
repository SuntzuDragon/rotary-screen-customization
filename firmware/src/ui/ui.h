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
/**
 * Held knob: the dial's own name badge -- device id, firmware, when it was
 * flashed. The id is what the settings page edits and what a support question
 * starts with, and until now the only place to read it was a browser.
 *
 * Only meaningful once stats are showing; returns false if there was nothing
 * to cover, so the caller knows no release handling is needed.
 */
bool showAbout(const char* deviceId, uint32_t flashedAt);
/** Put the card back after showAbout. */
void hideAbout();
/** Auto-advance tick; honours the configured rotation interval. */
void tick(uint32_t nowMs);

}  // namespace ui
