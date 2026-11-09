#pragma once
#include <stdbool.h>
/* Called with the LVGL lock held; physical Muse input remains upstream-owned.
 */
void sw_companion_init(void);
/* Existing SDK USB console hook; no public network listener. */
bool sw_companion_console(const char *line);
int sw_companion_brightness(int requested);
bool sw_companion_keep_awake(void);
