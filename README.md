# rotary-screen-customization

GitHub stats dashboard for the **Elecrow CrowPanel 1.28" HMI ESP32 Rotary Display**
(ESP32-S3R8, 240x240 round IPS / GC9A01, CST816D touch, rotary encoder).

A gift build: spin the knob to page through repo stats, touch to switch views.
Configured from a browser over USB via the Improv Wi-Fi Serial protocol -- no phone,
no captive portal, no pairing code.

## Layout

| Path | What |
|---|---|
| `worker/` | Cloudflare Worker: GitHub aggregation + config API + serves the web UI |
| `web/` | Browser config UI (Web Serial provisioning, live round-screen preview) |
| `firmware/` | PlatformIO / Arduino / LVGL 8.3.11 firmware |
| `docs/` | Research findings and hardware reference |

## Status

Early. See `docs/` for validated API behaviour and `docs/plan.md` for the build order.
