#pragma once
#include <Arduino.h>

// Fixed-capacity storage: the UI redraws constantly, and a fragmented heap on
// a long-running device is far worse than a few wasted KB of PSRAM.
static constexpr size_t kMaxRepos = 8;
static constexpr size_t kMaxEvents = 6;

struct RepoStat {
  char name[40];
  char lang[16];
  char msg[72];
  uint32_t langColor;  // 0xRRGGBB, 0 when unknown
  int32_t stars, forks, openPRs, openIssues;
  int64_t lastCommitAt;  // epoch seconds, 0 = unknown
};

struct EventStat {
  char kind[8];
  char repo[48];
  int32_t delta;
  int64_t at;
};

struct Stats {
  char login[40];
  char name[48];
  int32_t followers, stars, contrib;

  RepoStat repos[kMaxRepos];
  uint8_t repoCount;

  EventStat events[kMaxEvents];
  uint8_t eventCount;

  uint32_t accent, bg;  // 0xRRGGBB
  uint8_t brightness;   // 5..100
  uint16_t rotSec;      // 0 = manual only
  bool deckEnabled[3];  // summary, repos, activity

  /**
   * config.updatedAt this payload was built from, echoed back on the next poll
   * so the settings page can tell "saved" from "the dial is showing it".
   */
  uint32_t configApplied;

  bool valid;
};
