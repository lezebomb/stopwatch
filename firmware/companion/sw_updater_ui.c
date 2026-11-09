#include "muse_state.h"
#include "nvs.h"
#include "sw_updater.h"
#include <stdio.h>
LV_FONT_DECLARE(muse_font_cjk_noto_16);
static lv_obj_t *panel, *info;
static lv_timer_t *refresh;
static void tick(lv_timer_t *timer) {
  (void)timer;
  sw_update_status_t s;
  sw_update_status(&s);
  lv_label_set_text_fmt(info, "当前版本：%s\n最新版本：%s\n状态：%s\n%s",
                        s.current, s.latest[0] ? s.latest : "尚未检查", s.state,
                        s.detail);
}
static void close_page(lv_event_t *event) {
  (void)event;
  if (refresh)
    lv_timer_delete(refresh);
  refresh = NULL;
  lv_obj_delete(panel);
  panel = NULL;
}
static void check(lv_event_t *event) {
  (void)event;
  muse_state_poke();
  sw_update_request_check();
}
static void policy_cycle(lv_event_t *event) {
  (void)event;
  nvs_handle_t h;
  if (nvs_open("sw_updates", NVS_READWRITE, &h) == ESP_OK) {
    uint32_t hours = 21600;
    nvs_get_u32(h, "check_s", &hours);
    hours = hours == 21600 ? 43200 : hours == 43200 ? 86400 : 21600;
    nvs_set_u32(h, "check_s", hours);
    nvs_commit(h);
    nvs_close(h);
    lv_obj_t *label = lv_obj_get_child(lv_event_get_target_obj(event), 0);
    lv_label_set_text_fmt(label, "检查间隔 %lu 小时（重启生效）",
                          (unsigned long)(hours / 3600));
  }
}
static void battery_cycle(lv_event_t *event) {
  nvs_handle_t h;
  if (nvs_open("sw_updates", NVS_READWRITE, &h) == ESP_OK) {
    uint8_t minimum = 40;
    nvs_get_u8(h, "min_battery", &minimum);
    minimum = minimum == 40 ? 60 : minimum == 60 ? 80 : 40;
    nvs_set_u8(h, "min_battery", minimum);
    nvs_commit(h);
    nvs_close(h);
    lv_obj_t *label = lv_obj_get_child(lv_event_get_target_obj(event), 0);
    lv_label_set_text_fmt(label, "最低电量 %u%%（重启生效）", minimum);
  }
}
void sw_update_settings_open(lv_event_t *event) {
  (void)event;
  if (panel)
    return;
  panel = lv_obj_create(lv_screen_active());
  lv_obj_set_size(panel, 466, 466);
  lv_obj_center(panel);
  lv_obj_set_style_radius(panel, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(panel, lv_color_hex(0x122521), 0);
  lv_obj_set_style_text_color(panel, lv_color_hex(0xe5e9d3), 0);
  lv_obj_set_style_text_font(panel, &muse_font_cjk_noto_16, 0);
  lv_obj_remove_flag(panel, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_t *title = lv_label_create(panel);
  lv_label_set_text(title, "软件更新");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 40);
  info = lv_label_create(panel);
  lv_obj_set_width(info, 300);
  lv_label_set_long_mode(info, LV_LABEL_LONG_WRAP);
  lv_obj_align(info, LV_ALIGN_TOP_MID, 0, 90);
  lv_obj_t *b = lv_button_create(panel);
  lv_obj_set_size(b, 230, 40);
  lv_obj_align(b, LV_ALIGN_BOTTOM_MID, 0, -148);
  lv_obj_add_event_cb(b, check, LV_EVENT_CLICKED, NULL);
  lv_obj_t *l = lv_label_create(b);
  lv_label_set_text(l, "手动检查更新");
  lv_obj_center(l);
  b = lv_button_create(panel);
  lv_obj_set_size(b, 290, 35);
  lv_obj_align(b, LV_ALIGN_BOTTOM_MID, 0, -106);
  lv_obj_add_event_cb(b, policy_cycle, LV_EVENT_CLICKED, NULL);
  l = lv_label_create(b);
  lv_label_set_text(l, "调整检查间隔（充电联网时）");
  lv_obj_center(l);
  b = lv_button_create(panel);
  lv_obj_set_size(b, 290, 35);
  lv_obj_align(b, LV_ALIGN_BOTTOM_MID, 0, -64);
  lv_obj_add_event_cb(b, battery_cycle, LV_EVENT_CLICKED, NULL);
  l = lv_label_create(b);
  lv_label_set_text(l, "调整安装最低电量");
  lv_obj_center(l);
  b = lv_button_create(panel);
  lv_obj_set_size(b, 80, 30);
  lv_obj_align(b, LV_ALIGN_BOTTOM_MID, 0, -20);
  lv_obj_add_event_cb(b, close_page, LV_EVENT_CLICKED, NULL);
  l = lv_label_create(b);
  lv_label_set_text(l, "返回");
  lv_obj_center(l);
  refresh = lv_timer_create(tick, 1000, NULL);
  tick(NULL);
}
