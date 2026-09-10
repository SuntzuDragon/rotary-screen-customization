-- What network the dial is on.
--
-- Wi-Fi credentials only ever travel over USB, so the settings page had no way
-- to show the current network -- which made "change network" look like a
-- destructive re-setup rather than an edit. The device reports the SSID it
-- associated with on each poll; the password stays on the device.
ALTER TABLE devices ADD COLUMN wifi_ssid TEXT;
ALTER TABLE devices ADD COLUMN wifi_rssi INTEGER;
