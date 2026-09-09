#pragma once

/**
 * Firmware version, reported to the stats API and shown on the splash screen.
 *
 * CI overwrites this file with the tag being published (see
 * .github/workflows/firmware.yml). Local builds keep the "-dev" suffix so a
 * hand-flashed board is never mistaken for a released build in the settings
 * page's version comparison.
 */
#define FW_VERSION "0.1.0-dev"
