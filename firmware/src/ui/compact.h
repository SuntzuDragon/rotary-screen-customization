#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

/**
 * Keep big numbers inside the circle: 4548 -> "4548", 12400 -> "12.4k",
 * 123456 -> "123.5k", 1234567 -> "1.2M".
 *
 * The settings page renders the same numbers in its preview, with its own copy
 * of this in web/src/format.ts, and the two must agree exactly. So the rounding
 * is done in whole numbers, half up, rather than by printf: C's printf and
 * JavaScript's toFixed round an exact half differently (12250 would read
 * "12.2k" on the dial and "12.3k" on the page). A web test compiles this header
 * and checks the two against each other.
 *
 * The unit switches where rounding would carry into the next one, so 999950
 * reads "1.0M", not "1000.0k".
 */
inline void compact(int32_t n, char* out, size_t cap) {
  if (n < 10000) {
    snprintf(out, cap, "%ld", static_cast<long>(n));
    return;
  }
  // 64-bit: adding the rounding offset near INT32_MAX would overflow.
  const int64_t v = n;
  const int64_t k = (v + 50) / 100;  // thousands, in tenths
  if (k < 10000) {
    snprintf(out, cap, "%lld.%lldk", static_cast<long long>(k / 10),
             static_cast<long long>(k % 10));
    return;
  }
  const int64_t m = (v + 50000) / 100000;  // millions, in tenths
  snprintf(out, cap, "%lld.%lldM", static_cast<long long>(m / 10), static_cast<long long>(m % 10));
}
