#include "sw_companion.h"
#include "sw_model.h"
#include "muse_board.h"
#include "muse_settings.h"
#include "muse_state.h"
#include "muse_input.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "nvs.h"
#include "lvgl.h"
#include "src/misc/cache/instance/lv_image_cache.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

LV_FONT_DECLARE(muse_font_cjk_noto_16);
static lv_obj_t *root, *photo_obj, *caption, *status_label, *pet_face, *menu;
static lv_image_dsc_t image;
static uint8_t *pixels;
typedef struct { uint8_t *data; unsigned index; } photo_result_t;
static QueueHandle_t photo_requests, photo_results;
static sw_screen_t screen;
static unsigned photo, taps, phase;
static uint32_t last_tap, last_slide, last_power;
static bool egg, slideshow;
static int brightness = 30;
static char message[192] = "今天也要记得给自己放个小假。";
static nvs_handle_t config;
static bool nvs_ok;
static bool was_wifi;
static const char *names[] = { "照片", "Muse", "Codex", "指南" };
static const char *phases[] = { "休息一下", "正在思考", "认真工作", "运行测试", "等待确认", "任务完成", "任务失败" };
static void show(void);
static void save(void) { if (nvs_ok) { nvs_set_u32(config, "photo", photo); nvs_set_u8(config, "slide", slideshow); nvs_commit(config); } }
static void photo_worker(void *arg) {
    (void)arg;
    unsigned index;
    for (;;) {
        if (xQueueReceive(photo_requests, &index, portMAX_DELAY) != pdTRUE) continue;
        uint8_t *data = heap_caps_malloc(466u * 466u * 2u, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!data) { ESP_LOGW("companion", "photo allocation failed"); continue; }
        char filename[48]; snprintf(filename, sizeof(filename), "/photos/%u.rgb", index);
        FILE *file = fopen(filename, "rb");
        size_t count = file ? fread(data, 1, 466u * 466u * 2u, file) : 0;
        if (file) fclose(file);
        if (count != 466u * 466u * 2u) { free(data); ESP_LOGW("companion", "missing or invalid photo"); continue; }
        photo_result_t result = { .data = data, .index = index };
        if (xQueueSend(photo_results, &result, pdMS_TO_TICKS(20)) != pdTRUE) free(data);
    }
}
static void load_photo(void) { if (photo_requests) xQueueOverwrite(photo_requests, &photo); }
static void touch(lv_event_t *event) {
    muse_state_poke();
    if (lv_event_get_code(event) == LV_EVENT_GESTURE) {
        lv_dir_t direction = lv_indev_get_gesture_dir(lv_indev_active());
        if (direction == LV_DIR_LEFT) screen = (screen + 1) % SW_SCREEN_COUNT;
        else if (direction == LV_DIR_RIGHT) screen = (screen + SW_SCREEN_COUNT - 1) % SW_SCREEN_COUNT;
        else return;
        egg = false; show(); return;
    }
    if (lv_event_get_code(event) != LV_EVENT_CLICKED) return;
    if (egg) { egg = false; show(); return; }
    if (screen == SW_PHOTOS) {
        uint32_t now = lv_tick_get(); taps = now - last_tap < 600 ? taps + 1 : 1; last_tap = now;
        if (taps >= 5) { taps = 0; egg = true; show(); } else { photo = (photo + 1) % 3; load_photo(); save(); }
    } else if (screen == SW_CODEX) { phase = (phase + 1) % 7; show(); }
    else if (screen == SW_GUIDE) { screen = SW_PHOTOS; show(); }
}
static void back(lv_event_t *event) { (void)event; screen = SW_PHOTOS; show(); muse_state_poke(); }
static void page(lv_event_t *event) { screen = (sw_screen_t)(uintptr_t)lv_event_get_user_data(event); egg = false; show(); muse_state_poke(); }
static void show(void) {
    lv_obj_set_flag(root, LV_OBJ_FLAG_HIDDEN, screen == SW_MUSE);
    lv_obj_set_flag(menu, LV_OBJ_FLAG_HIDDEN, screen != SW_MUSE);
    if (screen == SW_MUSE) { muse_settings_set_wifi_on(true); return; }
    lv_obj_set_flag(photo_obj, LV_OBJ_FLAG_HIDDEN, screen != SW_PHOTOS || egg);
    lv_obj_set_flag(pet_face, LV_OBJ_FLAG_HIDDEN, screen != SW_CODEX && !egg);
    if (egg) { lv_label_set_text(pet_face, "^ . ^"); lv_label_set_text(caption, message); }
    else if (screen == SW_PHOTOS) { lv_label_set_text(caption, "轻点换照片 · 左右滑动切换"); load_photo(); }
    else if (screen == SW_CODEX) { lv_label_set_text(pet_face, phase == 5 ? "^ . ^" : phase == 4 ? "o ! o" : "= . ="); lv_label_set_text_fmt(caption, "MOCK · %s\n轻点体验任务状态", phases[phase]); }
    else lv_label_set_text(caption, "左右滑动切换界面\n轻点照片切换封面\n黄键按住说话，松开发送\n五次轻点打开彩蛋\nMuse 设置中连接 Wi-Fi\n扫码控制台管理照片与任务\n低电量休眠后连接充电\n轻点返回照片");
    lv_obj_align(caption, LV_ALIGN_CENTER, 0, screen == SW_GUIDE ? 0 : 130);
    lv_obj_move_foreground(root);
}
static void tick(lv_timer_t *timer) {
    (void)timer;
    muse_mode_t mode = muse_state_mode(NULL);
    if (mode == MUSE_MODE_LISTENING || mode == MUSE_MODE_THINKING || mode == MUSE_MODE_SPEAKING) {
        if (screen != SW_MUSE) { screen = SW_MUSE; show(); }
    }
    uint32_t now = lv_tick_get(); muse_power_t power = muse_state_power();
    photo_result_t result;
    if (photo_results && xQueueReceive(photo_results, &result, 0) == pdTRUE) {
        if (result.index == photo) {
            uint8_t *old = pixels;
            lv_image_cache_drop(&image);
            pixels = result.data; image.data = pixels;
            lv_image_set_src(photo_obj, &image); lv_obj_invalidate(photo_obj);
            free(old);
        } else free(result.data);
    }
    if (screen == SW_CODEX || egg) lv_obj_align(pet_face, LV_ALIGN_CENTER, 0, (now / 750) % 2 ? -3 : 3);
    sw_power_policy_t policy = sw_power_policy((sw_power_input_t){ .charging = power.usb || power.charging, .battery = power.battery_pct, .screen = screen, .idle_s = (unsigned)muse_state_idle_secs(), .brightness = brightness });
    if (now - last_power >= 1000) {
        last_power = now;
        if (screen != SW_MUSE) {
            muse_settings_set_brightness(policy.brightness ? policy.brightness : 10);
            if (!policy.display) muse_state_set_asleep(true);
        }
        /* Settings owns actual hardware changes. Keep Muse radio on while its view is active. */
        if (screen == SW_PHOTOS && was_wifi && !power.usb) { muse_settings_set_wifi_on(false); was_wifi = false; }
        else if ((screen == SW_MUSE || screen == SW_CODEX) && !was_wifi) { muse_settings_set_wifi_on(true); was_wifi = true; }
        lv_label_set_text_fmt(status_label, "%s  %s  %d%%", names[screen], screen == SW_CODEX ? "MOCK" : "", power.battery_pct);
        if (policy.pixel_shift) {
            int shift_x = (int)((now / 60000) % 3) - 1;
            int shift_y = (int)((now / 120000) % 3) - 1;
            lv_obj_align(status_label, LV_ALIGN_TOP_MID, shift_x, 55 + shift_y);
            lv_obj_align(photo_obj, LV_ALIGN_CENTER, shift_x, shift_y);
        }
        time_t wall = time(NULL); struct tm local; localtime_r(&wall, &local);
        if (local.tm_year >= 126 && local.tm_mon == 11 && local.tm_mday == 25 && !egg) { egg = true; show(); }
    }
    if (slideshow && screen == SW_PHOTOS && now - last_slide >= 20000) { last_slide = now; photo = (photo + 1) % 3; load_photo(); }
}
static void toggle_slide(lv_event_t *event) { (void)event; slideshow = !slideshow; save(); }
void sw_companion_init(void) {
    esp_vfs_spiffs_conf_t fs = { .base_path = "/photos", .partition_label = "photos", .max_files = 3, .format_if_mount_failed = false };
    esp_err_t mounted = esp_vfs_spiffs_register(&fs); if (mounted != ESP_OK) ESP_LOGW("companion", "assets unavailable: %s", esp_err_to_name(mounted));
    if (nvs_open("stopwatch", NVS_READWRITE, &config) == ESP_OK) {
        nvs_ok = true; uint32_t selected = 0; uint8_t slide = 0; nvs_get_u32(config, "photo", &selected); nvs_get_u8(config, "slide", &slide); photo = selected % 3; slideshow = slide;
    }
    photo_requests = xQueueCreate(1, sizeof(unsigned)); photo_results = xQueueCreate(1, sizeof(photo_result_t));
    if (!photo_requests || !photo_results || xTaskCreate(photo_worker, "sw_photo", 4096, NULL, 2, NULL) != pdPASS) {
        if (photo_requests) vQueueDelete(photo_requests);
        if (photo_results) vQueueDelete(photo_results);
        photo_requests = photo_results = NULL;
        ESP_LOGE("companion", "photo worker unavailable; text UI remains available");
    }
    image = (lv_image_dsc_t){ .header = { .magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_RGB565, .w = 466, .h = 466, .stride = 932 }, .data_size = 466u * 466u * 2u, .data = pixels };
    root = lv_obj_create(lv_screen_active()); lv_obj_set_size(root, 466, 466); lv_obj_center(root); lv_obj_remove_flag(root, LV_OBJ_FLAG_SCROLLABLE); lv_obj_set_style_pad_all(root, 0, 0); lv_obj_set_style_border_width(root, 0, 0); lv_obj_set_style_radius(root, LV_RADIUS_CIRCLE, 0); lv_obj_set_style_clip_corner(root, true, 0); lv_obj_set_style_bg_color(root, lv_color_hex(0x122521), 0);
    lv_obj_add_event_cb(root, touch, LV_EVENT_CLICKED, NULL); lv_obj_add_event_cb(root, touch, LV_EVENT_GESTURE, NULL);
    photo_obj = lv_image_create(root); lv_obj_center(photo_obj); lv_obj_remove_flag(photo_obj, LV_OBJ_FLAG_CLICKABLE);
    status_label = lv_label_create(root); lv_obj_set_style_text_font(status_label, &muse_font_cjk_noto_16, 0); lv_obj_set_style_text_color(status_label, lv_color_hex(0xe1e9ce), 0); lv_obj_align(status_label, LV_ALIGN_TOP_MID, 0, 55);
    pet_face = lv_label_create(root); lv_obj_set_style_text_font(pet_face, &lv_font_montserrat_28, 0); lv_obj_set_style_text_color(pet_face, lv_color_hex(0xe3e6d0), 0); lv_obj_center(pet_face);
    caption = lv_label_create(root); lv_obj_set_width(caption, 300); lv_obj_set_style_text_align(caption, LV_TEXT_ALIGN_CENTER, 0); lv_obj_set_style_text_font(caption, &muse_font_cjk_noto_16, 0); lv_obj_set_style_text_color(caption, lv_color_hex(0xe5e9d3), 0);
    menu = lv_button_create(lv_screen_active()); lv_obj_set_size(menu, 95, 34); lv_obj_align(menu, LV_ALIGN_BOTTOM_MID, 0, -30); lv_obj_add_event_cb(menu, back, LV_EVENT_CLICKED, NULL); lv_obj_t *back_label = lv_label_create(menu); lv_label_set_text(back_label, "HOME"); lv_obj_center(back_label);
    for (unsigned i = 0; i < SW_SCREEN_COUNT; i++) { lv_obj_t *button = lv_button_create(root); lv_obj_set_size(button, 60, 28); lv_obj_align(button, LV_ALIGN_BOTTOM_MID, ((int)i - 2) * 64 + 32, -60); lv_obj_add_event_cb(button, page, LV_EVENT_CLICKED, (void *)(uintptr_t)i); lv_obj_t *label = lv_label_create(button); lv_obj_set_style_text_font(label, &muse_font_cjk_noto_16, 0); lv_label_set_text(label, names[i]); lv_obj_center(label); }
    lv_obj_add_event_cb(photo_obj, toggle_slide, LV_EVENT_LONG_PRESSED, NULL); lv_obj_add_flag(photo_obj, LV_OBJ_FLAG_CLICKABLE); lv_obj_add_flag(photo_obj, LV_OBJ_FLAG_EVENT_BUBBLE); lv_obj_add_flag(photo_obj, LV_OBJ_FLAG_GESTURE_BUBBLE);
    muse_settings_set_brightness(30); muse_settings_set_sleep_s(180); was_wifi = muse_settings_wifi_on();
    lv_timer_create(tick, 250, NULL); screen = SW_PHOTOS; show();
    ESP_LOGI("companion", "StopWatch MVP ready; Codex is MOCK, Muse authorization remains upstream-owned");
}
