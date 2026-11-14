#pragma once
#include "lvgl.h"
#include <stdbool.h>
typedef struct {
  char current[32], latest[32], state[24], detail[120];
  unsigned failures;
} sw_update_status_t;
void sw_update_start(bool storage_ok);
void sw_update_boot_memory(const char *phase);
void sw_update_health_tick(bool photo_ready);
void sw_update_services_ready(void);
void sw_update_interaction(bool busy);
void sw_update_request_check(void);
void sw_update_status(sw_update_status_t *out);
bool sw_update_boot_ready(void);
void sw_update_maintenance(void);
/* USB-only, read-only update/stack diagnostics; no credentials or reset. */
void sw_update_diagnostics(int id);
void sw_update_settings_open(lv_event_t *event);
