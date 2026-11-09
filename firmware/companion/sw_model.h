#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
typedef enum { SW_PHOTOS, SW_MUSE, SW_CODEX, SW_GUIDE, SW_SCREEN_COUNT } sw_screen_t;
typedef enum { SW_OFFLINE, SW_IDLE, SW_THINKING, SW_WORKING, SW_TESTING, SW_APPROVAL, SW_COMPLETED, SW_FAILED, SW_INTERRUPTED, SW_TASK_COUNT } sw_task_t;
typedef struct { bool charging; int battery; sw_screen_t screen; unsigned idle_s; int brightness; } sw_power_input_t;
typedef struct { bool display; bool wifi; bool pixel_shift; int brightness; int refresh_hz; } sw_power_policy_t;
sw_power_policy_t sw_power_policy(sw_power_input_t in);
bool sw_photo_capacity(unsigned count, size_t used, size_t incoming);
bool sw_transition_allowed(sw_task_t from, sw_task_t to);
