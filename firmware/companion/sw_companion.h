#pragma once
#include <stdbool.h>
#include <stddef.h>
#define SW_MIAO_SLOT_A "/photos/miao0.pack"
#define SW_MIAO_SLOT_B "/photos/miao1.pack"
bool sw_companion_resource_reserve(size_t bytes, size_t reclaim);
void sw_companion_resource_release(void);
/* Called with the LVGL lock held; physical Muse input remains upstream-owned.
 */
void sw_companion_init(void);
/* Existing SDK USB console hook; no public network listener. */
bool sw_companion_console(const char *line);
/* Persistent local audio permission. Default is silent on an existing device. */
bool sw_companion_audio_silent(void);
/* Board expander operations. State is -1 if readback failed. */
bool sw_companion_amp_refresh(void);
int sw_companion_amp_state(void);
int sw_companion_brightness(int requested);
bool sw_companion_keep_awake(void);
bool sw_companion_controls_sleep(void);
/* Implemented beside the SDK's existing tileview; LVGL task only. */
bool sw_companion_native_page(bool settings);
/* RAM-only override implemented beside the SDK's persistent BLE setting. */
void sw_companion_phone_ble(bool enabled);
/* Called after an authenticated phone commits a network through Muse. */
void sw_companion_phone_network(const char *ssid);
