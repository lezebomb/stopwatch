/* Included after the existing photo/Codex helpers; all LVGL work stays on its
 * original task. Input/phone tasks only publish bounded requests. */
static void nav_click(lv_event_t *e) {
  int route = (int)(intptr_t)lv_event_get_user_data(e);
  nav_open(route);
}
static lv_obj_t *nav_text(lv_obj_t *parent, const char *text, int y) {
  lv_obj_t *label = lv_label_create(parent); lv_obj_set_width(label, 310);
  lv_label_set_long_mode(label, LV_LABEL_LONG_WRAP); lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_label_set_text(label, text); lv_obj_align(label, LV_ALIGN_CENTER, 0, y); return label;
}
static void nav_row(lv_obj_t *parent, const char *text, int route, int y) {
  lv_obj_t *button = lv_button_create(parent); navigation_style(button);
  lv_obj_set_size(button, 286, 48); lv_obj_align(button, LV_ALIGN_CENTER, 0, y);
  lv_obj_add_event_cb(button, nav_click, LV_EVENT_CLICKED, (void *)(intptr_t)route);
  lv_obj_t *label = lv_label_create(button); lv_label_set_text(label, text); lv_obj_center(label);
}
static void nav_confirm_off(lv_event_t *e) { (void)e; muse_input_request_power_off(); }
static void nav_check_update(lv_event_t *e) { (void)e; sw_update_request_check(); }
static void nav_display_change(lv_event_t *e) {
  int value = (int)(intptr_t)lv_event_get_user_data(e);
  if (value >= 10) {
    int level = muse_settings_brightness() + (value == 10 ? -10 : 10);
    muse_settings_set_brightness(level < 5 ? 5 : level > 100 ? 100 : level);
  } else if (nvs_ok && value >= 0 && value <= 2) {
    sw_display_settings_t next = display_settings; next.mode = value;
    if (nvs_set_blob(config, "display_cfg", &next, sizeof(next)) == ESP_OK && nvs_commit(config) == ESP_OK) display_settings = next;
  } else if (value == 20) {
    sw_companion_toggle_silent();
  } else if (value == 21) {
    int level = muse_settings_volume() + 25;
    muse_settings_set_volume(level > 100 ? 0 : level);
  }
  nav_open(NAV_DISPLAY);
}
static void nav_display_row(const char *label, int value, int y, bool selected) {
  lv_obj_t *button = lv_button_create(nav_panel); navigation_style(button);
  lv_obj_set_size(button, 286, 44); lv_obj_align(button, LV_ALIGN_CENTER, 0, y);
  if (selected) lv_obj_set_style_border_color(button, lv_color_hex(0xffdc87), 0);
  lv_obj_add_event_cb(button, nav_display_change, LV_EVENT_CLICKED, (void *)(intptr_t)value);
  lv_obj_t *text = lv_label_create(button); lv_label_set_text(text, label); lv_obj_center(text);
}
static void nav_qr(const char *url) {
  lv_obj_t *qr = lv_qrcode_create(nav_panel); lv_qrcode_set_size(qr, 214);
  lv_qrcode_set_dark_color(qr, lv_color_black()); lv_qrcode_set_light_color(qr, lv_color_white());
  lv_qrcode_set_quiet_zone(qr, true); lv_obj_align(qr, LV_ALIGN_CENTER, 0, -10);
  if (lv_qrcode_update(qr, url, strlen(url)) != LV_RESULT_OK) nav_text(nav_panel, "二维码暂不可用", 110);
}
static void nav_open(int route) {
  int old = nav_route;
  if (route == NAV_PHONE && old != NAV_PHONE) phone_parent = old == NAV_SETTINGS ? NAV_SETTINGS : NAV_AI;
  if ((old == NAV_PHONE || old == NAV_CODEX_PAIR) && route != old) {
    sw_phone_close(); if (!atomic_load(&setup_active)) sw_companion_phone_ble(false);
  }
  if (route == NAV_SHUTDOWN && old != NAV_SHUTDOWN) shutdown_parent = old;
  if (atomic_load(&setup_active)) close_phone_setup(NULL);
  if (nav_panel) { lv_obj_delete(nav_panel); nav_panel = nav_status = nav_code = NULL; }
  codex_close(NULL); nav_route = route; atomic_store(&nav_awake, route != NAV_COVER);
  screen = route == NAV_MUSE || route == NAV_NATIVE_NETWORK ? SW_MUSE : route == NAV_CODEX_CONTROL || route == NAV_CODEX_DETAIL ? SW_CODEX : SW_PHOTOS;
  egg = false; muse_state_poke();
  if (route == NAV_MUSE || route == NAV_NATIVE_NETWORK) sw_companion_native_page(route == NAV_NATIVE_NETWORK);
  if (route == NAV_NATIVE_NETWORK) sw_companion_official_network();
  show();
  if (route == NAV_COVER || route == NAV_MUSE || route == NAV_NATIVE_NETWORK || route == NAV_CODEX_DETAIL) return;
  if (route == NAV_CODEX_CONTROL) { codex_open(NULL); return; }
  nav_panel = lv_obj_create(lv_screen_active()); lv_obj_set_size(nav_panel, 466, 466); lv_obj_center(nav_panel);
  lv_obj_set_style_bg_color(nav_panel, lv_color_hex(0x122521), 0); lv_obj_set_style_text_color(nav_panel, lv_color_hex(0xf4f5e9), 0);
  lv_obj_set_style_text_font(nav_panel, &companion_font, 0); lv_obj_set_style_radius(nav_panel, LV_RADIUS_CIRCLE, 0); lv_obj_set_style_clip_corner(nav_panel, true, 0);
  lv_obj_remove_flag(nav_panel, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_GESTURE_BUBBLE);
  lv_obj_add_event_cb(nav_panel, nav_gesture, LV_EVENT_GESTURE, NULL);
  if (route == NAV_AI) {
    nav_text(nav_panel, "AI", -153); nav_row(nav_panel, "Muse", NAV_MUSE, -65); nav_row(nav_panel, "Codex", NAV_CODEX, 0); nav_row(nav_panel, "手机控制", NAV_PHONE, 65);
  } else if (route == NAV_SETTINGS) {
    nav_text(nav_panel, "设置", -174); nav_row(nav_panel, "网络", NAV_NETWORK, -112); nav_row(nav_panel, "手机配对与管理", NAV_PHONE, -56);
    nav_row(nav_panel, "亮度与显示", NAV_DISPLAY, 0); nav_row(nav_panel, "指南", NAV_GUIDE, 56); nav_row(nav_panel, "系统与更新", NAV_SYSTEM, 112);
  } else if (route == NAV_PHONE) {
    sw_phone_open(); sw_companion_phone_ble(true);
    char ref[65], url[192];
    if (sw_phone_ref(ref)) snprintf(url, sizeof(url), "%.*s/pair/?device=%s", (int)(strlen(SW_SETUP_URL) - strlen("/setup/")), SW_SETUP_URL, ref);
    else snprintf(url, sizeof(url), "%.*s/pair/", (int)(strlen(SW_SETUP_URL) - strlen("/setup/")), SW_SETUP_URL);
    nav_text(nav_panel, "手机配对", -165); nav_qr(url);
    nav_status = nav_text(nav_panel, "扫码后点开始配对", 123); nav_code = nav_text(nav_panel, "", 160);
    lv_obj_set_style_transform_scale_x(nav_code, 384, 0); lv_obj_set_style_transform_scale_y(nav_code, 384, 0);
  } else if (route == NAV_GUIDE) {
    char url[160]; snprintf(url, sizeof(url), "%.*s/guide/", (int)(strlen(SW_SETUP_URL) - strlen("/setup/")), SW_SETUP_URL);
    nav_text(nav_panel, "手机查看指南", -165); nav_qr(url); nav_text(nav_panel, "扫码查看完整使用说明", 125);
  } else if (route == NAV_NETWORK) {
    nav_text(nav_panel, muse_wifi_connected() ? "设备已联网" : "等待联网", -135);
    nav_row(nav_panel, "手机扫码设置网络", NAV_NETWORK, -30);
    // Replace the self-route callback with the existing protected BLE utility.
    lv_obj_t *button = lv_obj_get_child(nav_panel, -1); lv_obj_remove_event_cb(button, nav_click);
    lv_obj_add_event_cb(button, open_phone_setup, LV_EVENT_CLICKED, NULL);
    nav_row(nav_panel, "官方 Wi-Fi 管理", NAV_NATIVE_NETWORK, 35);
    nav_text(nav_panel, "与手机配对、Muse 账号相互独立", 118);
  } else if (route == NAV_DISPLAY) {
    char label[64]; snprintf(label, sizeof(label), "亮度 %d", muse_settings_brightness()); nav_text(nav_panel, label, -167);
    nav_display_row("亮度 -", 10, -167, false); nav_display_row("亮度 +", 11, -124, false);
    snprintf(label, sizeof(label), "静音 %s / 音量 %d", sw_companion_audio_silent() ? "开" : "关", muse_settings_volume());
    nav_display_row(label, 20, -81, false); nav_display_row("音量 +25", 21, -38, false);
    nav_display_row("照片展示", 0, 5, display_settings.mode == 0); nav_display_row("智能省电", 1, 48, display_settings.mode == 1); nav_display_row("续航优先", 2, 91, display_settings.mode == 2);
  } else if (route == NAV_SYSTEM) {
    sw_update_status_t update; sw_update_status(&update);
    char text[240]; snprintf(text, sizeof(text), "StopWatch C152\n版本 %s\n最新 %s\n%s\n当前静音", SW_UPDATE_VERSION, update.latest[0] ? update.latest : "尚未检查", update.state);
    nav_status = nav_text(nav_panel, text, -35);
    nav_row(nav_panel, "检查更新", NAV_SYSTEM, 100);
    lv_obj_t *button = lv_obj_get_child(nav_panel, -1); lv_obj_remove_event_cb(button, nav_click); lv_obj_add_event_cb(button, nav_check_update, LV_EVENT_CLICKED, NULL);
  } else if (route == NAV_CODEX) {
    nav_text(nav_panel, "Codex", -145); nav_row(nav_panel, "配对", NAV_CODEX_PAIR, -45); nav_row(nav_panel, "控制", NAV_CODEX_CONTROL, 25);
    nav_text(nav_panel, "语音输入暂未获准", 112);
  } else if (route == NAV_CODEX_PAIR) {
    sw_sync_codex_view(&codex_ui); nav_text(nav_panel, codex_ui.online ? "电脑已配对并在线" : "连接电脑", -165);
    sw_phone_open(); sw_companion_phone_ble(true);
    char url[216], ref[65];
    if (sw_phone_ref(ref)) snprintf(url, sizeof(url), "%.*s/pair/?device=%s&view=settings", (int)(strlen(SW_SETUP_URL) - strlen("/setup/")), SW_SETUP_URL, ref);
    else snprintf(url, sizeof(url), "%.*s/pair/", (int)(strlen(SW_SETUP_URL) - strlen("/setup/")), SW_SETUP_URL);
    nav_qr(url); nav_status = nav_text(nav_panel, "手机设置 / 电脑授权\n需原控制端授予 Codex 控制", 125); nav_code = nav_text(nav_panel, "", 172);
  } else if (route == NAV_SHUTDOWN) {
    nav_text(nav_panel, "确认关机？", -90); nav_row(nav_panel, "取消", shutdown_parent, 20);
    lv_obj_t *button = lv_button_create(nav_panel); navigation_style(button); lv_obj_set_size(button, 286, 48); lv_obj_align(button, LV_ALIGN_CENTER, 0, 80);
    lv_obj_add_event_cb(button, nav_confirm_off, LV_EVENT_CLICKED, NULL); lv_obj_t *text = lv_label_create(button); lv_label_set_text(text, "确认关机"); lv_obj_center(text);
  }
  lv_obj_move_foreground(nav_panel);
}
static void nav_back(void) {
  if (atomic_load(&setup_active)) { close_phone_setup(NULL); nav_open(NAV_NETWORK); return; }
  if (codex_panel && nav_route == NAV_CODEX_DETAIL) { codex_close(NULL); show(); return; }
  int route = nav_route, parent = NAV_COVER;
  if (route == NAV_PHONE) parent = phone_parent;
  else if (route == NAV_MUSE || route == NAV_CODEX) parent = NAV_AI;
  else if (route == NAV_CODEX_PAIR || route == NAV_CODEX_CONTROL) parent = NAV_CODEX;
  else if (route == NAV_CODEX_DETAIL) parent = NAV_CODEX_CONTROL;
  else if (route == NAV_NETWORK || route == NAV_GUIDE || route == NAV_DISPLAY || route == NAV_SYSTEM) parent = NAV_SETTINGS;
  else if (route == NAV_NATIVE_NETWORK) parent = NAV_NETWORK;
  else if (route == NAV_SHUTDOWN) parent = shutdown_parent;
  nav_open(parent);
}
static void nav_gesture(lv_event_t *event) {
  (void)event;
  lv_dir_t direction = lv_indev_get_gesture_dir(lv_indev_active());
  if (direction == LV_DIR_RIGHT || direction == LV_DIR_LEFT) nav_back();
}
static void nav_tick(void) {
  int request = atomic_exchange(&nav_requested, 0);
  if (request < 0) nav_back(); else if (request) nav_open(request - 1);
  if ((nav_route == NAV_PHONE || nav_route == NAV_CODEX_PAIR) && nav_status && nav_code) {
    char code[7]; bool pending = sw_phone_display(code);
    const char *hint = pending ? "在手机输入以下验证码" : sw_phone_active() ? nav_route == NAV_PHONE ? "扫码后点开始配对" : "手机设置 / 电脑授权\n需原控制端授予 Codex 控制" : "配对已过期，请重新进入";
    if (strcmp(lv_label_get_text(nav_status), hint)) lv_label_set_text(nav_status, hint);
    if (strcmp(lv_label_get_text(nav_code), pending ? code : "")) lv_label_set_text(nav_code, pending ? code : "");
    if (!sw_phone_active() && !atomic_load(&setup_active)) sw_companion_phone_ble(false);
  }
  if (nav_route == NAV_SYSTEM && nav_status) {
    sw_update_status_t update; sw_update_status(&update); char text[240];
    snprintf(text, sizeof(text), "StopWatch C152\n版本 %s\n最新 %s\n%s\n当前静音", SW_UPDATE_VERSION, update.latest[0] ? update.latest : "尚未检查", update.state);
    if (strcmp(lv_label_get_text(nav_status), text)) lv_label_set_text(nav_status, text);
  }
}
void sw_companion_native_back(void) { atomic_store(&nav_requested, -1); }
void sw_companion_shutdown_prompt(void) { atomic_store(&nav_requested, NAV_SHUTDOWN + 1); }
void sw_companion_manual_sleep(bool asleep) { atomic_store(&manual_display_off, asleep); }
void sw_companion_device_status(char *out, size_t capacity) {
  size_t total = 0, used = 0; unsigned count = 0;
  if (storage_mounted) esp_spiffs_info("photos", &total, &used);
  portENTER_CRITICAL(&device_lock);
  for (unsigned i = 0; i < USER_SLOTS; i++) if (album.entries[i].file[0]) count++;
  portEXIT_CRITICAL(&device_lock);
  snprintf(out, capacity, "{\"wifi\":%s,\"museLinked\":%s,\"museReady\":%s,\"silent\":%s,\"storageTotal\":%u,\"storageUsed\":%u,\"photoCount\":%u}",
    muse_wifi_connected() ? "true" : "false", muse_link_hatch_linked() ? "true" : "false", muse_link_req_ready() ? "true" : "false",
    sw_companion_audio_silent() ? "true" : "false", (unsigned)total, (unsigned)used, count);
}
unsigned sw_companion_buttons(unsigned events) {
  static bool down, blue_down, long_sent, voice_sent, pairing_press, silent_visual, egg_shown;
  static int64_t pressed_at, blue_at;
  events |= atomic_exchange(&injected_buttons, 0);
  int64_t now = esp_timer_get_time() / 1000;
  bool released = events & MUSE_BTN_TALK_RELEASE;
  if (events & MUSE_BTN_TALK_PRESS) {
    pairing_press = muse_link_talk_press(); down = true; pressed_at = now; long_sent = voice_sent = false;
    if (!pairing_press) sw_companion_input_wake();
  }
  unsigned forwarded = events & ~(MUSE_BTN_TALK_PRESS | MUSE_BTN_TALK_RELEASE | MUSE_BTN_SPEAKER_PRESS | MUSE_BTN_SPEAKER_RELEASE);
  // Never swallow the release of an already-authorized hold if mute changes.
  // A release alone cannot start recording; it safely closes an existing PTT.
  if (voice_sent && sw_companion_audio_silent()) { forwarded |= MUSE_BTN_TALK_RELEASE; voice_sent = false; }
  if (events & MUSE_BTN_SPEAKER_PRESS) {
    blue_down = true; blue_at = now; sw_companion_input_wake();
    atomic_store(&nav_requested, NAV_SETTINGS + 1);
  }
  if (events & MUSE_BTN_SPEAKER_RELEASE) blue_down = false;
  /* Egg: both rim keys are held within a short window. This only adds one
   * action; single-key behaviour below is unchanged. */
  if (down && blue_down && (blue_at > pressed_at ? blue_at - pressed_at : pressed_at - blue_at) < 900 &&
      sw_companion_egg_trigger(true, true)) {
    forwarded &= ~(MUSE_BTN_SPEAKER_PRESS | MUSE_BTN_TALK_PRESS);
    atomic_store(&nav_requested, 0);
    egg_shown = true;
  }
  if (down && !egg_shown && !pairing_press && !long_sent && now - pressed_at >= 600 && !released) {
    long_sent = true; atomic_store(&nav_requested, NAV_MUSE + 1);
    if (!sw_companion_audio_silent()) { voice_sent = true; forwarded |= MUSE_BTN_TALK_PRESS; }
    else {
      silent_visual = true;
      muse_state_set_asleep(false);
      muse_state_set_mode(MUSE_MODE_LISTENING);
      muse_state_set_caption("静音中 / 长按说话需先开声音");
    }
  }
  if (released && down) {
    if (!egg_shown && !pairing_press && !long_sent) atomic_store(&nav_requested, NAV_AI + 1);
    if (voice_sent) forwarded |= MUSE_BTN_TALK_RELEASE;
    if (silent_visual) {
      silent_visual = false;
      muse_state_set_mode(MUSE_MODE_IDLE);
      muse_state_set_caption("%s", "");
    }
    down = voice_sent = pairing_press = egg_shown = false;
  }
  return forwarded;
}
