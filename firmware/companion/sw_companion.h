#pragma once
#include <stdbool.h>
/* Called with the LVGL lock held; physical Muse input remains upstream-owned.
 */
void sw_companion_init(void);
/* Existing SDK USB console hook; no public network listener. */
bool sw_companion_console(const char *line);
int sw_companion_brightness(int requested);
bool sw_companion_keep_awake(void);
/* Implemented beside the SDK's existing tileview; LVGL task only. */
bool sw_companion_native_page(bool settings);
/* RAM-only override implemented beside the SDK's persistent BLE setting. */
void sw_companion_phone_ble(bool enabled);
/* Called after an authenticated phone commits a network through Muse. */
void sw_companion_phone_network(const char *ssid);
