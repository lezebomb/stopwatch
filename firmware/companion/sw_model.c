#include <stddef.h>
#include "sw_model.h"
sw_power_policy_t sw_power_policy(sw_power_input_t in) {
    bool asleep = !in.charging && ((in.battery >= 0 && in.battery <= 5) || in.idle_s >= 180);
    int brightness = in.brightness < 10 ? 10 : in.brightness > 80 ? 80 : in.brightness;
    if (!in.charging && in.battery >= 0 && in.battery <= 15 && brightness > 15) brightness = 15;
    return (sw_power_policy_t){ .display = !asleep, .wifi = !asleep && (in.screen == SW_MUSE || in.screen == SW_CODEX), .pixel_shift = in.charging, .brightness = asleep ? 0 : brightness, .refresh_hz = in.screen == SW_PHOTOS ? 1 : 12 };
}
bool sw_photo_capacity(unsigned count, size_t used, size_t incoming) {
    const size_t budget = 6u * 1024u * 1024u;
    return count < 12 && used <= budget && incoming <= budget - used;
}
bool sw_transition_allowed(sw_task_t from, sw_task_t to) {
    if (from >= SW_TASK_COUNT || to >= SW_TASK_COUNT) return false;
    if (from == to || to == SW_OFFLINE || to == SW_INTERRUPTED || to == SW_FAILED) return true;
    if (to == SW_THINKING) return from == SW_IDLE || from == SW_COMPLETED || from == SW_FAILED || from == SW_INTERRUPTED || from == SW_OFFLINE;
    return (from == SW_THINKING && to == SW_WORKING) || (from == SW_WORKING && (to == SW_TESTING || to == SW_APPROVAL)) || (from == SW_APPROVAL && to == SW_TESTING) || (from == SW_TESTING && to == SW_COMPLETED);
}
