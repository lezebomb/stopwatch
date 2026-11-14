#include "sw_companion.h"
#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_spiffs.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "lvgl.h"
#include "mbedtls/base64.h"
#include "muse_ble.h"
#include "muse_board.h"
#include "muse_input.h"
#include "muse_link.h"
#include "muse_settings.h"
#include "muse_settings_ui.h"
#include "muse_state.h"
#include "muse_voice.h"
#include "muse_wifi.h"
#include "sw_muse_proxy.h"
#include "sw_muse_egress.h"
#include "nvs.h"
#include "psa/crypto.h"
#include "src/misc/cache/instance/lv_image_cache.h"
#include "sw_miao.h"
#include "sw_memory.h"
#include "sw_model.h"
#include "sw_setup_qr.h"
#include "sw_sync.h"
#include "sw_update_build.h"
#include "sw_updater.h"
#include <dirent.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

LV_FONT_DECLARE(muse_font_cjk_noto_16);
static lv_font_t companion_font;
static lv_obj_t *root, *photo_obj, *caption, *status_label, *pet_face, *menu;
static lv_obj_t *setup_panel, *setup_status;
static lv_obj_t *phone_button, *codex_button, *codex_panel;
static EXT_RAM_BSS_ATTR sw_codex_view_t codex_ui, codex_choices;
static lv_obj_t *cover_frame;
static atomic_bool setup_active;
static atomic_int setup_requested;
static uint32_t setup_started, setup_joined;
static char setup_network[MUSE_SSID_MAX + 1];
static unsigned setup_network_generation;
static lv_image_dsc_t image;
static uint8_t *pixels;
typedef struct {
  uint8_t *data;
  unsigned index;
  char hash[65];
} photo_result_t;
static QueueHandle_t photo_requests, photo_results;
static QueueHandle_t sync_results;
static sw_screen_t screen;
static unsigned photo, taps, phase;
static uint32_t last_tap, last_slide, last_power;
static bool egg, slideshow, displaying_egg;
static unsigned slide_seconds = 20;
typedef struct {
  char id[37];
  uint8_t brightness, border, slideshow;
  uint16_t seconds;
} cover_settings_t;
typedef struct {
  cover_settings_t settings;
  sw_display_settings_t display;
  unsigned index;
  bool changed_album, has_display;
} cover_sync_t;
static cover_settings_t last_cover;
static bool last_cover_valid;
static sw_display_settings_t display_settings = {
    .sleep_after = 180, .utc_offset = 480, .month = 12, .day = 25};
static unsigned egg_day_seen;
static nvs_handle_t config;
static bool nvs_ok;
static atomic_bool audio_silent = true;

/* The legacy PEAP profile shared this namespace with user settings. Purge
 * the one live key and obsolete entries, including any old profile versions. */
static esp_err_t clear_campus_profile(void) {
  nvs_handle_t settings;
  esp_err_t result = nvs_open("stopwatch", NVS_READWRITE_PURGE, &settings);
  if (result != ESP_OK)
    return result;
  result = nvs_erase_key(settings, "eap_profile");
  if (result == ESP_OK || result == ESP_ERR_NVS_NOT_FOUND)
    result = nvs_purge_all(settings);
  if (result == ESP_OK)
    result = nvs_commit(settings);
  if (result == ESP_OK) {
    size_t size;
    result = nvs_get_blob(settings, "eap_profile", NULL, &size);
    if (result == ESP_ERR_NVS_NOT_FOUND)
      result = ESP_OK;
    else if (result == ESP_OK)
      result = ESP_ERR_INVALID_STATE;
  }
  nvs_close(settings);
  return result;
}

bool sw_companion_audio_silent(void) { return atomic_load(&audio_silent); }

static bool persist_audio_silent(bool silent) {
  return nvs_ok && nvs_set_u8(config, "audio_silent", silent) == ESP_OK &&
         nvs_commit(config) == ESP_OK;
}

static bool set_audio_silent(bool silent) {
  if (silent) {
    atomic_store(&audio_silent, true);
    bool applied = sw_companion_amp_refresh();
    return persist_audio_silent(true) && applied;
  }
  if (!persist_audio_silent(false))
    return false;
  atomic_store(&audio_silent, false);
  if (sw_companion_amp_refresh())
    return true;
  atomic_store(&audio_silent, true);
  sw_companion_amp_refresh();
  persist_audio_silent(true);
  return false;
}
static atomic_bool external_power_seen, previous_external_power;
#define PHOTO_BYTES SW_SYNC_PHOTO_BYTES
#define USER_SLOTS SW_SYNC_PHOTO_LIMIT
typedef struct {
  char file[32];
  uint8_t hash[32];
} photo_entry_t;
typedef struct {
  uint32_t magic;
  photo_entry_t entries[USER_SLOTS];
} album_t;
static album_t album, previous_album;
static portMUX_TYPE device_lock = portMUX_INITIALIZER_UNLOCKED;
static bool album_writable, storage_mounted;
static atomic_uint requested_photo = UINT32_MAX;
static atomic_int diagnostic_view;
static atomic_uint task_generation;
static atomic_bool upload_busy;
static FILE *upload_file;
static SemaphoreHandle_t transfer_lock;
static uint32_t upload_seen;
static size_t upload_bytes;
static unsigned upload_slot;
static uint8_t upload_hash[32];
static psa_hash_operation_t upload_digest = PSA_HASH_OPERATION_INIT;
static char displayed_hash[65], task_title[152], task_project[80],
    task_error[96];
static int task_quota = -1;
static uint64_t task_synced_ms;
static uint32_t task_key;
static atomic_bool task_wireless;
static atomic_bool codex_online;
static atomic_uint task_seen;
static const char *TEMP_PHOTO = "/photos/upload.partial";
static const char *names[] = {"照片", "Muse", "Codex", "指南"};
static const char *phases[] = {"休息一下", "正在思考", "认真工作", "运行测试",
                               "等待确认", "任务完成", "任务失败", "已中断"};
static void show(void);
static void load_photo(void);
int sw_companion_brightness(int requested) {
  if (!root || screen == SW_MUSE)
    return requested;
  muse_power_t power = muse_state_power();
  return sw_power_policy((sw_power_input_t){
                             .charging = power.usb || power.charging,
                             .battery = power.battery_pct,
                             .screen = screen,
                             .idle_s = atomic_load(&setup_active)
                                           ? 0
                                           : (unsigned)muse_state_idle_secs(),
                             .brightness = requested,
                             .mode = display_settings.mode,
                             .sleep_after = display_settings.sleep_after})
      .brightness;
}
bool sw_companion_controls_sleep(void) { return root && screen != SW_MUSE; }
bool sw_companion_keep_awake(void) {
  muse_power_t power = muse_state_power();
  /* Bridge the short interval until the UI consumes an unplug edge and
   * resets idle. The input task must not sleep on the old charging idle. */
  return atomic_load(&setup_active) ||
         (root && screen != SW_MUSE &&
          (power.usb || power.charging ||
           (atomic_load(&external_power_seen) &&
            atomic_load(&previous_external_power))));
}
static void hash_hex(const uint8_t *bytes, char *text) {
  static const char h[] = "0123456789abcdef";
  for (unsigned i = 0; i < 32; i++) {
    text[i * 2] = h[bytes[i] >> 4];
    text[i * 2 + 1] = h[bytes[i] & 15];
  }
  text[64] = 0;
}
static bool parse_hash(const char *text, uint8_t *out) {
  if (!text || strlen(text) != 64)
    return false;
  for (unsigned i = 0; i < 32; i++) {
    char a = text[2 * i], b = text[2 * i + 1];
    if (!((a >= '0' && a <= '9') || (a >= 'a' && a <= 'f')) ||
        !((b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')))
      return false;
    out[i] = (uint8_t)((a <= '9' ? a - '0' : a - 'a' + 10) * 16 +
                       (b <= '9' ? b - '0' : b - 'a' + 10));
  }
  return true;
}
static bool managed_name(const char *s) {
  if (strlen(s) != 29 || s[0] != 'u' || s[3] != '-' || s[20] != '-' ||
      strcmp(s + 25, ".rgb"))
    return false;
  if (s[1] < '0' || s[1] > '9' || s[2] < '0' || s[2] > '9')
    return false;
  for (unsigned i = 4; i < 25; i++)
    if (i != 20 &&
        !((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f')))
      return false;
  return true;
}
static bool photo_path(unsigned index, char *path, photo_entry_t *entry) {
  if (index < 3) {
    snprintf(path, 48, "/photos/%u.rgb", index);
    memset(entry, 0, sizeof(*entry));
    return true;
  }
  if (index >= 3 + USER_SLOTS)
    return false;
  portENTER_CRITICAL(&device_lock);
  *entry = album.entries[index - 3];
  portEXIT_CRITICAL(&device_lock);
  if (!entry->file[0])
    return false;
  snprintf(path, 48, "/photos/%s", entry->file);
  return true;
}
static unsigned next_photo(unsigned current) {
  for (unsigned n = 1; n <= 3 + USER_SLOTS; n++) {
    unsigned value = (current + n) % (3 + USER_SLOTS);
    char path[48];
    photo_entry_t entry;
    if (photo_path(value, path, &entry) &&
        !(value >= 3 && display_settings.has_egg &&
          !memcmp(entry.hash, display_settings.egg_hash, 32)))
      return value;
  }
  return 0;
}
static unsigned egg_index(void) {
  if (!egg || !display_settings.has_egg)
    return UINT32_MAX;
  for (unsigned i = 3; i < 3 + USER_SLOTS; i++) {
    char path[48];
    photo_entry_t entry;
    if (photo_path(i, path, &entry) &&
        !memcmp(entry.hash, display_settings.egg_hash, 32))
      return i;
  }
  return UINT32_MAX;
}
static bool photo_file_valid(const char *path, const uint8_t expected[32]) {
  FILE *file = fopen(path, "rb");
  if (!file)
    return false;
  uint8_t *buffer = heap_caps_malloc(2048, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  psa_hash_operation_t op = PSA_HASH_OPERATION_INIT;
  bool ok = buffer && psa_hash_setup(&op, PSA_ALG_SHA_256) == PSA_SUCCESS;
  size_t total = 0, n = 0, hash_size = 0;
  uint8_t hash[32];
  while (ok && (n = fread(buffer, 1, 2048, file)) > 0) {
    total += n;
    ok = total <= PHOTO_BYTES && psa_hash_update(&op, buffer, n) == PSA_SUCCESS;
  }
  ok = ok && !ferror(file) && total == PHOTO_BYTES &&
       psa_hash_finish(&op, hash, 32, &hash_size) == PSA_SUCCESS &&
       hash_size == 32 && !memcmp(hash, expected, 32);
  psa_hash_abort(&op);
  free(buffer);
  fclose(file);
  return ok;
}
static bool file_valid(const photo_entry_t *entry) {
  if (!entry->file[0])
    return true;
  if (!memchr(entry->file, 0, sizeof(entry->file)) ||
      !managed_name(entry->file))
    return false;
  char path[48];
  snprintf(path, sizeof(path), "/photos/%s", entry->file);
  return photo_file_valid(path, entry->hash);
}
static bool album_valid(const album_t *value) {
  if (value->magic != 0x53574131)
    return false;
  for (unsigned i = 0; i < USER_SLOTS; i++)
    if (!file_valid(&value->entries[i]))
      return false;
  return true;
}
static bool album_read(const char *key, album_t *value) {
  size_t size = sizeof(*value);
  return nvs_get_blob(config, key, value, &size) == ESP_OK &&
         size == sizeof(*value);
}
static void album_init(void) {
  album.magic = previous_album.magic = 0x53574131;
  if (!storage_mounted || !nvs_ok)
    return;
  size_t size = 0;
  esp_err_t result = nvs_get_blob(config, "album", NULL, &size);
  if (result == ESP_ERR_NVS_NOT_FOUND) {
    /* Missing index may mean NVS recovery, not an empty personal album.
     * Never garbage-collect recoverable images in that case. */
    DIR *dir = opendir("/photos");
    struct dirent *item;
    bool found = false;
    if (!dir)
      goto recover_previous;
    if (dir) {
      while ((item = readdir(dir)))
        if (managed_name(item->d_name))
          found = true;
      closedir(dir);
    }
    if (found) {
      ESP_LOGW("companion", "Personal album index missing; retaining images "
                            "and checking recovery generation");
      goto recover_previous;
    }
    album_writable = true;
    return;
  }
  if (album_read("album", &album) && album_valid(&album)) {
    if (!album_read("album_prev", &previous_album) ||
        !album_valid(&previous_album)) {
      memset(&previous_album, 0, sizeof(previous_album));
      previous_album.magic = 0x53574131;
    }
    album_writable = true;
    return;
  }
recover_previous:
  if (album_read("album_prev", &previous_album) &&
      album_valid(&previous_album)) {
    album = previous_album;
    album_writable =
        nvs_set_blob(config, "album", &album, sizeof(album)) == ESP_OK &&
        nvs_commit(config) == ESP_OK;
    ESP_LOGW("companion", "Recovered previous personal album generation");
    return;
  }
  memset(&album, 0, sizeof(album));
  album.magic = 0x53574131;
  ESP_LOGE("companion",
           "Personal album damaged; preserving files and disabling writes");
}
static void collect_photos(void) {
  DIR *dir = opendir("/photos");
  if (!dir)
    return;
  struct dirent *item;
  while ((item = readdir(dir))) {
    if (!managed_name(item->d_name))
      continue;
    bool keep = false;
    for (unsigned i = 0; i < USER_SLOTS; i++)
      if (!strcmp(item->d_name, album.entries[i].file) ||
          !strcmp(item->d_name, previous_album.entries[i].file))
        keep = true;
    if (!keep) {
      char path[48];
      snprintf(path, sizeof(path), "/photos/%.31s", item->d_name);
      unlink(path);
    }
  }
  closedir(dir);
}
static bool install_photo(photo_entry_t *entry, const uint8_t sha[32],
                          unsigned tag) {
  char hex[65], path[48];
  hash_hex(sha, hex);
  for (unsigned i = 0; i < 8; i++) {
    snprintf(entry->file, sizeof(entry->file), "u%02u-%.16s-%04x.rgb", tag, hex,
             (unsigned)(esp_random() & 65535));
    snprintf(path, sizeof(path), "/photos/%s", entry->file);
    if (access(path, F_OK) == 0)
      continue;
    if (rename(TEMP_PHOTO, path))
      return false;
    memcpy(entry->hash, sha, sizeof(entry->hash));
    return true;
  }
  return false;
}

/* Caller owns transfer_lock. Both transports use the same recovery index. */
static bool commit_album(const album_t *next) {
  if (nvs_set_blob(config, "album_prev", &album, sizeof(album)) != ESP_OK ||
      nvs_commit(config) != ESP_OK ||
      nvs_set_blob(config, "album", next, sizeof(*next)) != ESP_OK ||
      nvs_commit(config) != ESP_OK) {
    /* A failed commit may have reached flash. Preserve all files until boot
     * can determine which generation is authoritative. */
    album_writable = false;
    return false;
  }
  portENTER_CRITICAL(&device_lock);
  previous_album = album;
  album = *next;
  portEXIT_CRITICAL(&device_lock);
  return true;
}

bool sw_companion_sync_allowed(void) {
  muse_mode_t mode = muse_state_mode(NULL);
  if (muse_voice_in_call() || muse_voice_notes_waiting() ||
      mode == MUSE_MODE_LISTENING || mode == MUSE_MODE_THINKING ||
      mode == MUSE_MODE_SPEAKING)
    return false;
  sw_update_status_t update;
  sw_update_status(&update);
  return strcmp(update.state, "health-check") &&
         strcmp(update.state, "health-failed") &&
         strcmp(update.state, "checking") &&
         strcmp(update.state, "downloading") &&
         strcmp(update.state, "verifying") &&
         strcmp(update.state, "restarting");
}

bool sw_companion_pairing_open(void) { return atomic_load(&setup_active); }

bool sw_companion_resource_reserve(size_t bytes, size_t reclaim) {
  if (!storage_mounted || !album_writable || !transfer_lock ||
      xSemaphoreTake(transfer_lock, 0) != pdTRUE)
    return false;
  size_t total = 0, used = 0;
  if (esp_spiffs_info("photos", &total, &used) != ESP_OK ||
      used - (reclaim < used ? reclaim : used) + bytes + 65536 > total * 85 / 100) {
    xSemaphoreGive(transfer_lock);
    return false;
  }
  return true;
}

void sw_companion_resource_release(void) { xSemaphoreGive(transfer_lock); }

/* The caller owns transfer_lock. Only these re-downloadable caches may be
 * reclaimed here. The player already owns its current frames in PSRAM. */
static bool photo_space(size_t bytes) {
  size_t total = 0, used = 0;
  if (esp_spiffs_info("photos", &total, &used) != ESP_OK)
    return false;
  size_t needed = used + bytes + 65536, budget = total * 85 / 100;
  if (needed <= budget)
    return true;
  const char *const caches[] = {SW_MIAO_SLOT_A, SW_MIAO_SLOT_B};
  size_t reclaim = 0;
  for (unsigned i = 0; i < 2; i++) {
    struct stat st;
    if (stat(caches[i], &st) == 0 && st.st_size > 0)
      reclaim += (size_t)st.st_size;
  }
  if (reclaim < needed - budget)
    return false;
  for (unsigned i = 0; i < 2; i++) {
    if (unlink(caches[i]) == 0 && esp_spiffs_info("photos", &total, &used) == ESP_OK &&
        used + bytes + 65536 <= total * 85 / 100)
      return true;
  }
  return false;
}

static bool photo_wanted(const sw_sync_album_t *desired,
                         const uint8_t sha[32]) {
  for (unsigned i = 0; i < desired->count; i++) {
    if (!memcmp(desired->photos[i].sha256, sha, 32))
      return true;
  }
  return false;
}

/* Tag 99 is outside the USB slots (00..11) but valid in older firmware. It
 * marks only files this relay manages, keeping USB uploads and rollback safe.
 */
#define RELAY_PHOTO_TAG 99
sw_sync_album_result_t sw_companion_sync_album(const sw_sync_album_t *desired,
                                               sw_sync_fetch_photo fetch,
                                               void *ctx) {
  if (!transfer_lock || !sync_results ||
      xSemaphoreTake(transfer_lock, 0) != pdTRUE)
    return SW_SYNC_ALBUM_BUSY;
  sw_sync_album_result_t result = SW_SYNC_ALBUM_ERROR;
  if (upload_file) {
    result = SW_SYNC_ALBUM_BUSY;
    goto done;
  }
  if (!album_writable)
    goto done;

  album_t next = album;
  bool occupied[USER_SLOTS];
  const sw_sync_photo_t *download[USER_SLOTS] = {0};
  unsigned missing = 0;
  for (unsigned i = 0; i < USER_SLOTS; i++) {
    photo_entry_t *entry = &next.entries[i];
    if (!strncmp(entry->file, "u99-", 4) && !photo_wanted(desired, entry->hash))
      memset(entry, 0, sizeof(*entry));
    occupied[i] = entry->file[0] != 0;
  }
  cover_sync_t cover = {0};
  cover.display = desired->display;
  cover.has_display = desired->has_display;
  strlcpy(cover.settings.id, desired->cover, sizeof(cover.settings.id));
  cover.settings.brightness = desired->brightness;
  cover.settings.border = desired->border;
  cover.settings.seconds = desired->slide_seconds;
  cover.settings.slideshow = desired->slideshow;
  if (!strncmp(desired->cover, "builtin-", 8))
    cover.index = desired->cover[8] - '0';
  for (unsigned i = 0; i < desired->count; i++) {
    const sw_sync_photo_t *item = &desired->photos[i];
    unsigned slot = USER_SLOTS, free_slot = USER_SLOTS;
    for (unsigned j = 0; j < USER_SLOTS; j++) {
      if (occupied[j] && !memcmp(next.entries[j].hash, item->sha256, 32)) {
        slot = j;
        break;
      }
      if (!occupied[j] && free_slot == USER_SLOTS)
        free_slot = j;
    }
    if (slot == USER_SLOTS) {
      if (free_slot == USER_SLOTS) {
        result = SW_SYNC_ALBUM_FULL;
        goto done;
      }
      slot = free_slot;
      occupied[slot] = true;
      download[slot] = item;
      memcpy(next.entries[slot].hash, item->sha256, 32);
      missing++;
    }
    if (!strcmp(desired->cover, item->id) &&
        (!desired->display.has_egg ||
         memcmp(item->sha256, desired->display.egg_hash, 32)))
      cover.index = slot + 3;
  }

  if (missing) {
    collect_photos();
    if (!photo_space(missing * PHOTO_BYTES)) {
      result = SW_SYNC_ALBUM_FULL;
      goto done;
    }
  }
  atomic_store(&upload_busy, true);
  const int64_t deadline = esp_timer_get_time() + 90000000;
  for (unsigned slot = 0; slot < USER_SLOTS; slot++) {
    if (!download[slot])
      continue;
    if (esp_timer_get_time() >= deadline || !sw_companion_sync_allowed())
      goto rollback;
    FILE *file = fopen(TEMP_PHOTO, "wb");
    if (!file)
      goto rollback;
    sw_sync_album_result_t received = fetch(download[slot], file, ctx);
    int closed = fclose(file);
    if (received != SW_SYNC_ALBUM_OK) {
      result = received;
      goto rollback;
    }
    if (closed || !photo_file_valid(TEMP_PHOTO, download[slot]->sha256) ||
        !install_photo(&next.entries[slot], download[slot]->sha256,
                       RELAY_PHOTO_TAG))
      goto rollback;
  }
  cover.changed_album = memcmp(&album, &next, sizeof(album)) != 0;
  if (cover.changed_album && !commit_album(&next))
    goto rollback;
  xQueueOverwrite(sync_results, &cover);
  result = SW_SYNC_ALBUM_OK;
  goto release;

rollback:
  unlink(TEMP_PHOTO);
  if (album_writable)
    collect_photos();
release:
  atomic_store(&upload_busy, false);
done:
  xSemaphoreGive(transfer_lock);
  return result;
}
static void upload_abort(void) {
  if (upload_file)
    fclose(upload_file);
  upload_file = NULL;
  psa_hash_abort(&upload_digest);
  unlink(TEMP_PHOTO);
  upload_bytes = 0;
  atomic_store(&upload_busy, false);
}
static unsigned task_phase(const char *state) {
  static const char *const states[] = {"idle",    "thinking",   "working",
                                       "testing", "approval",   "completed",
                                       "failed",  "interrupted"};
  for (unsigned i = 0; state && i < sizeof(states) / sizeof(states[0]); i++)
    if (!strcmp(states[i], state))
      return i;
  return UINT32_MAX;
}

static void copy_caption(char *out, size_t size, const char *text) {
  if (!text)
    text = "";
  size_t n = strnlen(text, size - 1);
  while (n && ((uint8_t)text[n] & 0xc0) == 0x80)
    n--;
  memcpy(out, text, n);
  out[n] = 0;
}

static void update_task(bool wireless, bool online, const char *state,
                        const char *title, const char *project, const char *id,
                        const char *error, int quota, uint64_t synced_ms) {
  unsigned next = task_phase(state);
  uint32_t key = 2166136261u;
  for (const char *p = id ? id : title; p && *p; p++)
    key = (key ^ (uint8_t)*p) * 16777619u;
  portENTER_CRITICAL(&device_lock);
  if (!wireless || synced_ms) {
    phase = next == UINT32_MAX ? 0 : next;
    copy_caption(task_title, sizeof(task_title), title);
    copy_caption(task_project, sizeof(task_project), project);
    copy_caption(task_error, sizeof(task_error), error);
    task_seen = lv_tick_get();
    task_synced_ms = synced_ms;
    task_key = key;
  }
  task_wireless = wireless;
  task_quota = quota;
  codex_online = online;
  portEXIT_CRITICAL(&device_lock);
  atomic_fetch_add(&task_generation, 1);
}

void sw_companion_sync_task(bool online, const char *state, const char *title,
                            const char *project, const char *id,
                            const char *error, int quota, uint64_t synced_ms) {
  update_task(true, online, state, title, project, id, error, quota, synced_ms);
}
static void device_reply(int id, const char *error) {
  printf("@sw {\"id\":%d,\"ok\":%s,\"error\":\"%s\",\"received\":%u}\n", id,
         error ? "false" : "true", error ? error : "", (unsigned)upload_bytes);
  fflush(stdout);
}
static bool device_console_locked(const char *line) {
  if (strncmp(line, "sw:", 3))
    return false;
  cJSON *request = cJSON_Parse(line + 3);
  cJSON *identifier =
      request ? cJSON_GetObjectItemCaseSensitive(request, "id") : NULL;
  cJSON *operation =
      request ? cJSON_GetObjectItemCaseSensitive(request, "op") : NULL;
  int id = cJSON_IsNumber(identifier) ? identifier->valueint : 0;
  const char *op = cJSON_IsString(operation) ? operation->valuestring : "";
  const char *error = "invalid-command";
  if (id <= 0 || !request)
    goto done;
  if (!strcmp(op, "codex.status") || !strcmp(op, "codex.control")) {
    sw_codex_view_t *view = heap_caps_calloc(1, sizeof(*view), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!view) goto done;
    sw_sync_codex_view(view);
    if (!strcmp(op, "codex.control")) {
      cJSON *action = cJSON_GetObjectItemCaseSensitive(request, "action");
      cJSON *target = cJSON_GetObjectItemCaseSensitive(request, "taskId");
      cJSON *decision = cJSON_GetObjectItemCaseSensitive(request, "decision");
      bool queued = cJSON_IsString(action) && sw_sync_codex_submit(action->valuestring,
          cJSON_IsString(target) ? target->valuestring : view->id, view->approval,
          cJSON_IsString(decision) ? decision->valuestring : "");
      free(view); error = queued ? NULL : "remote-action-unavailable"; goto done;
    }
    printf("@sw {\"id\":%d,\"ok\":true,\"taskId\":\"%s\",\"taskCount\":%u,\"canControl\":%s,\"commandState\":\"%s\"}\n", id, view->id, view->count,
           view->can_control ? "true" : "false", sw_sync_codex_command_state());
    free(view); fflush(stdout); cJSON_Delete(request); return true;
  }
  if (!strcmp(op, "muse.proxy.set")) {
    cJSON *host = cJSON_GetObjectItemCaseSensitive(request, "host");
    cJSON *port = cJSON_GetObjectItemCaseSensitive(request, "port");
    if (!cJSON_IsString(host) || !cJSON_IsNumber(port) ||
        port->valuedouble != port->valueint || port->valueint < 1 || port->valueint > 65535)
      goto done;
    esp_err_t result = sw_muse_proxy_set(host->valuestring, (uint16_t)port->valueint);
    error = result == ESP_OK ? NULL : esp_err_to_name(result);
    goto done;
  }
  if (!strcmp(op, "muse.proxy.clear")) {
    esp_err_t result = sw_muse_proxy_clear();
    error = result == ESP_OK ? NULL : esp_err_to_name(result);
    goto done;
  }
  if (!strcmp(op, "muse.proxy.status")) {
    printf("@sw {\"id\":%d,\"ok\":true,\"enabled\":%s,\"endpointReady\":%s}\n", id,
           sw_muse_proxy_enabled() ? "true" : "false",
           sw_muse_proxy_endpoint_ready() ? "true" : "false");
    fflush(stdout);
    cJSON_Delete(request);
    return true;
  }
  if (!strcmp(op, "wifi.enterprise.clear")) {
    esp_err_t result = clear_campus_profile();
    error = result == ESP_OK ? NULL : esp_err_to_name(result);
    goto done;
  }
  if (!strcmp(op, "wifi.enterprise.status")) {
    size_t size;
    esp_err_t result = nvs_ok ? nvs_get_blob(config, "eap_profile", NULL, &size)
                              : ESP_ERR_INVALID_STATE;
    if (result != ESP_OK && result != ESP_ERR_NVS_NOT_FOUND) {
      error = esp_err_to_name(result);
      goto done;
    }
    printf("@sw {\"id\":%d,\"ok\":true,\"stored\":%s}\n", id,
           result == ESP_OK ? "true" : "false");
    fflush(stdout);
    cJSON_Delete(request);
    return true;
  }
  if (!strcmp(op, "audio.silent")) {
    cJSON *enabled = cJSON_GetObjectItemCaseSensitive(request, "enabled");
    if (cJSON_IsBool(enabled) && set_audio_silent(cJSON_IsTrue(enabled)))
      error = NULL;
    goto done;
  }
  if (!strcmp(op, "muse.status")) {
    muse_ble_status_t ble;
    muse_ble_status(&ble);
    printf("@sw {\"id\":%d,\"ok\":true,\"sdkTokenStored\":%s,"
           "\"tokenChanged\":%s,\"accountLinked\":%s,\"linkState\":\"%s\","
           "\"bleStarted\":%s,\"bleConnected\":%s,\"bleSecure\":%s,"
           "\"wifi\":%s,\"sessionReady\":%s,\"inCall\":%s,\"silent\":%s,"
           "\"speakerAmp\":%d,\"volume\":%d,\"speaker\":%s}\n",
           id, muse_link_sdk_token() ? "true" : "false",
           muse_link_sdk_token_changed() ? "true" : "false",
           muse_link_hatch_linked() ? "true" : "false",
           muse_link_state_name(muse_link_state()),
           muse_link_ble_started() ? "true" : "false",
           ble.state == MUSE_BLE_CONNECTED ? "true" : "false",
           ble.secure ? "true" : "false",
           muse_wifi_connected() ? "true" : "false",
           muse_link_req_ready() ? "true" : "false",
           muse_voice_in_call() ? "true" : "false",
           sw_companion_audio_silent() ? "true" : "false",
           sw_companion_amp_state(), muse_settings_volume(),
           muse_settings_speaker_on() ? "true" : "false");
    fflush(stdout);
    cJSON_Delete(request);
    return true;
  }
  if (!strcmp(op, "muse.egress.status")) {
    sw_muse_egress_status(id);
    cJSON_Delete(request);
    return true;
  }
  if (!strcmp(op, "info")) {
    char hash[65];
    char hashes[USER_SLOTS * 67 + 3];
    size_t used = 0;
    hashes[used++] = '[';
    for (unsigned i = 0; i < USER_SLOTS; i++) {
      char h[65] = "";
      if (album.entries[i].file[0])
        hash_hex(album.entries[i].hash, h);
      used += (size_t)snprintf(hashes + used, sizeof(hashes) - used, "%s\"%s\"",
                               i ? "," : "", h);
    }
    snprintf(hashes + used, sizeof(hashes) - used, "]");
    portENTER_CRITICAL(&device_lock);
    memcpy(hash, displayed_hash, 65);
    portEXIT_CRITICAL(&device_lock);
    unsigned count = 0;
    for (unsigned i = 0; i < USER_SLOTS; i++)
      if (album.entries[i].file[0])
        count++;
    muse_power_t power = muse_state_power();
    const esp_partition_t *running = esp_ota_get_running_partition();
    sw_update_status_t update;
    sw_update_status(&update);
    printf(
        "@sw "
        "{\"id\":%d,\"ok\":true,\"protocol\":1,\"userPhotos\":%u,"
        "\"displaySha256\":\"%s\",\"internalFree\":%u,\"internalMinimum\":%u,"
        "\"psramFree\":%u,\"battery\":%d,\"usb\":%s,\"charging\":%s,\"wifi\":%"
        "s,\"received\":%u,\"uptimeMs\":%lu,\"photoSha256\":%s,\"codexOnline\":"
        "%s,\"codexPhase\":%u,\"serialStackMinimum\":%u,\"asleep\":%s,"
        "\"brightnessSaved\":%d,\"brightnessPolicy\":%d,\"idleSeconds\":%u,"
        "\"bootOffset\":%lu,\"displayMode\":%u,\"miaoFramesDrawn\":%u,"
        "\"relayState\":\"%s\",\"version\":\"%s\",\"otaState\":\"%s\"}\n",
        id, count, hash, (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
        (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), power.battery_pct,
        power.usb ? "true" : "false", power.charging ? "true" : "false",
        muse_wifi_connected() ? "true" : "false", (unsigned)upload_bytes,
        (unsigned long)lv_tick_get(), hashes, codex_online ? "true" : "false",
        phase, (unsigned)uxTaskGetStackHighWaterMark(NULL),
        muse_state_asleep() ? "true" : "false", muse_settings_brightness(),
        muse_state_asleep()
            ? 0
            : sw_companion_brightness(muse_settings_brightness()),
        (unsigned)muse_state_idle_secs(),
        running ? (unsigned long)running->address : 0UL, display_settings.mode,
        sw_miao_frames_drawn(), sw_sync_state(), SW_UPDATE_VERSION, update.state);
    fflush(stdout);
    cJSON_Delete(request);
    return true;
  }
  if (!strcmp(op, "memory.stats")) {
    sw_memory_status(id);
    cJSON_Delete(request);
    return true;
  }
#if !SW_UPDATE_PRODUCTION
  if (!strcmp(op, "memory.dma")) {
    sw_memory_dma_dump();
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "memory.tasks") || !strcmp(op, "memory.http-probe")) {
    if (!strcmp(op, "memory.tasks"))
      sw_memory_tasks();
    else
      sw_memory_http_probe();
    error = NULL;
    goto done;
  }
#endif
  if (!SW_UPDATE_PRODUCTION && !strcmp(op, "diag.miao")) {
    sw_memory_mark("miao.before", 0, 0, 0);
    unsigned frames = sw_miao_verify_embedded();
    sw_memory_mark("miao.after", (int)frames, 0, 0);
    printf("@sw {\"id\":%d,\"ok\":true,\"decoded\":%u}\n", id, frames);
    fflush(stdout);
    cJSON_Delete(request);
    return true;
  }
  if (!SW_UPDATE_PRODUCTION && !strcmp(op, "diag.codex")) {
    cJSON *enabled = cJSON_GetObjectItemCaseSensitive(request, "enabled");
    if (!cJSON_IsBool(enabled) || atomic_load(&setup_active) || muse_voice_in_call())
      goto done;
    atomic_store(&diagnostic_view, cJSON_IsTrue(enabled) ? 1 : -1);
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "setup.open") || !strcmp(op, "setup.close")) {
    atomic_store(&setup_requested, !strcmp(op, "setup.open") ? 1 : -1);
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "update.check")) {
    sw_update_request_check();
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "update.status")) {
    sw_update_diagnostics(id);
    cJSON_Delete(request);
    return true;
  }
  if (!strcmp(op, "task")) {
    cJSON *source = cJSON_GetObjectItemCaseSensitive(request, "source"),
          *state = cJSON_GetObjectItemCaseSensitive(request, "state"),
          *title = cJSON_GetObjectItemCaseSensitive(request, "title"),
          *online = cJSON_GetObjectItemCaseSensitive(request, "online");
    if (!cJSON_IsString(source) || strcmp(source->valuestring, "app-server") ||
        !cJSON_IsString(state) || !cJSON_IsBool(online) ||
        !cJSON_IsString(title) ||
        strlen(title->valuestring) >= sizeof(task_title) ||
        task_phase(state->valuestring) == UINT32_MAX)
      goto done;
    update_task(false, cJSON_IsTrue(online), state->valuestring,
                title->valuestring, NULL, NULL, NULL, -1, 0);
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "select")) {
    cJSON *value = cJSON_GetObjectItemCaseSensitive(request, "index");
    char path[48];
    photo_entry_t entry;
    if (!cJSON_IsNumber(value) || value->valuedouble != value->valueint ||
        value->valueint < 0 || !photo_path(value->valueint, path, &entry))
      goto done;
    atomic_store(&requested_photo, (unsigned)value->valueint);
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "photo.abort")) {
    upload_abort();
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "photo.begin")) {
    if (!album_writable) {
      error = "album-recovery-required";
      goto done;
    }
    cJSON *slot = cJSON_GetObjectItemCaseSensitive(request, "slot"),
          *size = cJSON_GetObjectItemCaseSensitive(request, "size"),
          *sha = cJSON_GetObjectItemCaseSensitive(request, "sha256");
    uint8_t hash[32];
    if (!cJSON_IsNumber(slot) || slot->valuedouble != slot->valueint ||
        slot->valueint < 0 || slot->valueint >= USER_SLOTS ||
        !cJSON_IsNumber(size) || size->valuedouble != PHOTO_BYTES ||
        !cJSON_IsString(sha) || !parse_hash(sha->valuestring, hash))
      goto done;
    sw_update_status_t update;
    sw_update_status(&update);
    if (muse_voice_in_call() || !strcmp(update.state, "downloading") ||
        !strcmp(update.state, "verifying") ||
        !strcmp(update.state, "restarting")) {
      error = "busy";
      goto done;
    }
    upload_abort();
    collect_photos();
    if (!photo_space(PHOTO_BYTES)) {
      error = "photo-space-full";
      goto done;
    }
    if (psa_hash_setup(&upload_digest, PSA_ALG_SHA_256) != PSA_SUCCESS) {
      error = "hash-unavailable";
      goto done;
    }
    upload_file = fopen(TEMP_PHOTO, "wb");
    if (!upload_file) {
      upload_abort();
      error = "storage-error";
      goto done;
    }
    upload_slot = (unsigned)slot->valueint;
    memcpy(upload_hash, hash, 32);
    atomic_store(&upload_busy, true);
    upload_seen = lv_tick_get();
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "photo.chunk")) {
    cJSON *offset = cJSON_GetObjectItemCaseSensitive(request, "offset"),
          *data = cJSON_GetObjectItemCaseSensitive(request, "data");
    uint8_t decoded[512];
    size_t size = 0;
    if (!upload_file || !cJSON_IsNumber(offset) ||
        offset->valuedouble != upload_bytes || !cJSON_IsString(data) ||
        strlen(data->valuestring) > 684 ||
        mbedtls_base64_decode(decoded, sizeof(decoded), &size,
                              (const unsigned char *)data->valuestring,
                              strlen(data->valuestring)) ||
        !size || size > PHOTO_BYTES - upload_bytes) {
      error = "invalid-chunk";
      goto done;
    }
    if (muse_voice_in_call() || fwrite(decoded, 1, size, upload_file) != size ||
        psa_hash_update(&upload_digest, decoded, size) != PSA_SUCCESS) {
      upload_abort();
      error = "write-interrupted";
      goto done;
    }
    upload_bytes += size;
    upload_seen = lv_tick_get();
    error = NULL;
    goto done;
  }
  if (!strcmp(op, "photo.end")) {
    uint8_t actual[32];
    size_t size = 0;
    if (!upload_file || upload_bytes != PHOTO_BYTES) {
      error = "incomplete-photo";
      goto done;
    }
    int flushed = fflush(upload_file);
    int closed = fclose(upload_file);
    upload_file = NULL;
    if (flushed || closed ||
        psa_hash_finish(&upload_digest, actual, 32, &size) != PSA_SUCCESS ||
        size != 32 || memcmp(actual, upload_hash, 32)) {
      upload_abort();
      error = "photo-hash-mismatch";
      goto done;
    }
    album_t *next =
        heap_caps_malloc(sizeof(*next), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!next) {
      upload_abort();
      error = "no-memory";
      goto done;
    }
    *next = album;
    if (!install_photo(&next->entries[upload_slot], actual, upload_slot) ||
        !commit_album(next)) {
      free(next);
      upload_abort();
      error = "commit-failed";
      goto done;
    }
    free(next);
    atomic_store(&upload_busy, false);
    error = NULL;
    goto done;
  }
done:
  device_reply(id, error);
  cJSON_Delete(request);
  return true;
}
bool sw_companion_console(const char *line) {
  if (strncmp(line, "sw:", 3))
    return false;
  if (!transfer_lock ||
      xSemaphoreTake(transfer_lock, pdMS_TO_TICKS(5000)) != pdTRUE)
    return true;
  bool handled = device_console_locked(line);
  xSemaphoreGive(transfer_lock);
  return handled;
}
static void save(void) {
  if (nvs_ok) {
    nvs_set_u32(config, "photo", photo);
    nvs_set_u8(config, "slide", slideshow);
    nvs_commit(config);
  }
}
static void set_frame(unsigned border) {
  lv_obj_set_style_border_width(cover_frame, border ? 3 : 0, 0);
  lv_obj_set_style_border_color(
      cover_frame, lv_color_hex(border == 2 ? 0xd7bb78 : 0xb5d9bd), 0);
}

static void apply_synced_cover(const cover_sync_t *sync) {
  const cover_settings_t *prefs = &sync->settings;
  bool first = !last_cover_valid;
  bool select = first || strcmp(last_cover.id, prefs->id);
  bool changed = select || last_cover.slideshow != prefs->slideshow ||
                 last_cover.seconds != prefs->seconds ||
                 last_cover.brightness != prefs->brightness ||
                 last_cover.border != prefs->border;
  bool display_changed =
      sync->has_display &&
      memcmp(&display_settings, &sync->display, sizeof(display_settings)) != 0;
  if (display_changed) {
    display_settings = sync->display;
    if (nvs_ok)
      nvs_set_blob(config, "display_cfg", &display_settings,
                   sizeof(display_settings));
  }
  char path[48];
  photo_entry_t entry;
  bool reselect = select || !photo_path(photo, path, &entry) ||
                  (photo >= 3 && display_settings.has_egg &&
                   !memcmp(entry.hash, display_settings.egg_hash, 32));
  if (reselect)
    photo = sync->index;
  if (first || last_cover.slideshow != prefs->slideshow)
    slideshow = prefs->slideshow;
  if (first || last_cover.seconds != prefs->seconds)
    slide_seconds = prefs->seconds;
  if (first || last_cover.brightness != prefs->brightness)
    muse_settings_set_brightness(prefs->brightness);
  if (first || last_cover.border != prefs->border)
    set_frame(prefs->border);
  if (changed && nvs_ok)
    nvs_set_blob(config, "relay_cover", prefs, sizeof(*prefs));
  if (changed || reselect || display_changed)
    save();
  if (changed || reselect)
    last_slide = lv_tick_get();
  last_cover = *prefs;
  last_cover_valid = true;
  if (reselect || sync->changed_album)
    load_photo();
  if (display_changed && egg)
    show();
}
static void photo_worker(void *arg) {
  (void)arg;
  unsigned index;
  for (;;) {
    if (xQueueReceive(photo_requests, &index, pdMS_TO_TICKS(1000)) != pdTRUE) {
      if (xSemaphoreTake(transfer_lock, 0) == pdTRUE) {
        if (upload_file && lv_tick_get() - upload_seen > 60000)
          upload_abort();
        xSemaphoreGive(transfer_lock);
      }
      continue;
    }
    sw_memory_mark("photo.before", 0, 0, 0);
    uint8_t *data =
        heap_caps_malloc(466u * 466u * 2u, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!data) {
      ESP_LOGW("companion", "photo allocation failed");
      continue;
    }
    char filename[48];
    photo_entry_t entry;
    if (!photo_path(index, filename, &entry)) {
      free(data);
      continue;
    }
    FILE *file = fopen(filename, "rb");
    size_t count = file ? fread(data, 1, 466u * 466u * 2u, file) : 0;
    if (file)
      fclose(file);
    uint8_t hash[32];
    size_t hash_size = 0;
    if (count != PHOTO_BYTES ||
        psa_hash_compute(PSA_ALG_SHA_256, data, count, hash, 32, &hash_size) !=
            PSA_SUCCESS ||
        hash_size != 32 || (index >= 3 && memcmp(hash, entry.hash, 32))) {
      free(data);
      ESP_LOGW("companion", "missing or invalid photo");
      continue;
    }
    photo_result_t result = {.data = data, .index = index};
    hash_hex(hash, result.hash);
    if (xQueueSend(photo_results, &result, pdMS_TO_TICKS(20)) != pdTRUE)
      free(data);
    sw_memory_mark("photo.decoded", 0, 0, 0);
  }
}
static void load_photo(void) {
  unsigned index = egg_index();
  if (index == UINT32_MAX)
    index = photo;
  if (photo_requests)
    xQueueOverwrite(photo_requests, &index);
}
static void touch(lv_event_t *event) {
  muse_state_poke();
  if (lv_event_get_code(event) == LV_EVENT_GESTURE) {
    lv_dir_t direction = lv_indev_get_gesture_dir(lv_indev_active());
    if (direction == LV_DIR_LEFT)
      screen = (screen + 1) % SW_SCREEN_COUNT;
    else if (direction == LV_DIR_RIGHT)
      screen = (screen + SW_SCREEN_COUNT - 1) % SW_SCREEN_COUNT;
    else
      return;
    egg = false;
    show();
    return;
  }
  if (lv_event_get_code(event) != LV_EVENT_CLICKED)
    return;
  if (egg) {
    egg = false;
    show();
    return;
  }
  if (screen == SW_PHOTOS) {
    uint32_t now = lv_tick_get();
    taps = now - last_tap < 600 ? taps + 1 : 1;
    last_tap = now;
    if (taps >= 5) {
      taps = 0;
      egg = true;
      show();
    } else {
      photo = next_photo(photo);
      load_photo();
      save();
    }
  } else if (screen == SW_GUIDE) {
    screen = SW_PHOTOS;
    show();
  }
}
static void back(lv_event_t *event) {
  (void)event;
  screen = SW_PHOTOS;
  show();
  muse_state_poke();
}
static void page(lv_event_t *event) {
  screen = (sw_screen_t)(uintptr_t)lv_event_get_user_data(event);
  egg = false;
  if (screen == SW_MUSE)
    sw_companion_native_page(false);
  show();
  muse_state_poke();
}
static void open_settings(lv_event_t *event) {
  (void)event;
  if (!sw_companion_native_page(true)) {
    lv_label_set_text(caption, "设置尚未就绪");
    return;
  }
  screen = SW_MUSE;
  egg = false;
  show();
  muse_state_poke();
}
static void navigation_style(lv_obj_t *button) {
  lv_obj_set_style_bg_color(button, lv_color_hex(0x244b3e), 0);
  lv_obj_set_style_bg_opa(button, LV_OPA_COVER, 0);
  lv_obj_set_style_border_width(button, 1, 0);
  lv_obj_set_style_border_color(button, lv_color_hex(0xc2d1ad), 0);
  lv_obj_set_style_radius(button, 12, 0);
  lv_obj_set_style_pad_all(button, 0, 0);
  lv_obj_set_style_text_color(button, lv_color_hex(0xf4f5e9), 0);
  lv_obj_set_style_text_font(button, &companion_font, 0);
  lv_obj_remove_flag(button, LV_OBJ_FLAG_EVENT_BUBBLE);
}
void sw_companion_phone_network(const char *ssid) {
  portENTER_CRITICAL(&device_lock);
  if (atomic_load(&setup_active)) {
    strlcpy(setup_network, ssid, sizeof(setup_network));
    setup_network_generation++;
  }
  portEXIT_CRITICAL(&device_lock);
}
static void close_phone_setup(lv_event_t *event) {
  (void)event;
  if (!atomic_exchange(&setup_active, false))
    return;
  lv_obj_add_flag(setup_panel, LV_OBJ_FLAG_HIDDEN);
  sw_companion_phone_ble(false);
  screen = SW_PHOTOS;
  egg = false;
  show();
  muse_state_poke();
}
static void open_phone_setup(lv_event_t *event) {
  (void)event;
  if (atomic_load(&setup_active))
    return;
  portENTER_CRITICAL(&device_lock);
  setup_network[0] = '\0';
  setup_network_generation++;
  atomic_store(&setup_active, true);
  portEXIT_CRITICAL(&device_lock);
  sw_companion_phone_ble(true);
  setup_started = lv_tick_get();
  lv_obj_remove_flag(setup_panel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_move_foreground(setup_panel);
  muse_state_set_asleep(false);
}
static void tick_phone_setup(uint32_t now, bool critical_battery) {
  if (!atomic_load(&setup_active))
    return;
  if (now - setup_started >= 300000 || critical_battery) {
    close_phone_setup(NULL);
    return;
  }
  char target[sizeof(setup_network)];
  static unsigned observed_generation;
  portENTER_CRITICAL(&device_lock);
  memcpy(target, setup_network, sizeof(target));
  unsigned generation = setup_network_generation;
  portEXIT_CRITICAL(&device_lock);
  if (observed_generation != generation) {
    observed_generation = generation;
    setup_joined = now;
  }
  char hint[128];
  muse_wifi_status_t wifi;
  muse_wifi_status(&wifi);
  if (!target[0]) {
    muse_ble_status_t ble;
    muse_ble_status(&ble);
    snprintf(hint, sizeof(hint), "扫码后用 Chrome 打开\n%s", ble.name);
  } else if (wifi.state == MUSE_WIFI_CONNECTED && wifi.ip[0] &&
             !strcmp(wifi.ssid, target)) {
    /* Allow the phone to read the successful status before BLE is released. */
    if (now - setup_joined >= 6000) {
      close_phone_setup(NULL);
      return;
    }
    strlcpy(hint, "Wi-Fi 已连接\n即将返回照片", sizeof(hint));
  } else {
    setup_joined = now;
    const char *text = "正在连接网络\n请保持手机热点开启";
    if (wifi.state == MUSE_WIFI_FAILED)
      text = "连接失败，请检查密码\n然后在手机上重试";
    else if (wifi.state == MUSE_WIFI_NOT_NEARBY ||
             wifi.state == MUSE_WIFI_CONNECTED)
      text = "暂未连上所选网络\n请检查 2.4GHz 网络";
    strlcpy(hint, text, sizeof(hint));
  }
  if (strcmp(hint, lv_label_get_text(setup_status)))
    lv_label_set_text(setup_status, hint);
}
static void codex_close(lv_event_t *event) {
  (void)event;
  if (codex_panel) { lv_obj_delete(codex_panel); codex_panel = NULL; }
}
static void codex_action(lv_event_t *event) {
  const char *action = lv_event_get_user_data(event);
  const char *decision = "";
  if (!strcmp(action, "accept") || !strcmp(action, "decline")) { decision = action; action = "approve"; }
  sw_sync_codex_submit(action, codex_choices.id, codex_choices.approval, decision);
  codex_close(NULL);
}
static void codex_select(lv_event_t *event) {
  unsigned index = (unsigned)(uintptr_t)lv_event_get_user_data(event);
  if (index < codex_choices.count) sw_sync_codex_submit("focus", codex_choices.ids[index], NULL, NULL);
  codex_close(NULL);
}
static void codex_row(lv_obj_t *parent, const char *text, lv_event_cb_t callback, void *data) {
  lv_obj_t *button = lv_button_create(parent);
  navigation_style(button); lv_obj_set_size(button, 292, 42);
  lv_obj_add_event_cb(button, callback, LV_EVENT_CLICKED, data);
  lv_obj_t *label = lv_label_create(button); lv_obj_set_width(label, 270);
  lv_label_set_long_mode(label, LV_LABEL_LONG_DOT); lv_label_set_text(label, text); lv_obj_center(label);
}
static void codex_open(lv_event_t *event) {
  (void)event;
  if (codex_panel) return;
  sw_sync_codex_view(&codex_choices);
  codex_panel = lv_obj_create(lv_screen_active()); lv_obj_set_size(codex_panel, 466, 466); lv_obj_center(codex_panel);
  lv_obj_set_style_bg_color(codex_panel, lv_color_hex(0x122521), 0); lv_obj_set_style_text_font(codex_panel, &companion_font, 0);
  lv_obj_remove_flag(codex_panel, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_GESTURE_BUBBLE);
  lv_obj_t *list = lv_obj_create(codex_panel); lv_obj_set_size(list, 330, 300); lv_obj_center(list);
  lv_obj_set_flex_flow(list, LV_FLEX_FLOW_COLUMN); lv_obj_remove_flag(list, LV_OBJ_FLAG_GESTURE_BUBBLE);
  lv_obj_t *label = lv_label_create(list); lv_obj_set_width(label, 292);
  lv_label_set_text(label, codex_choices.detail[0] ? codex_choices.detail : "请先从手机创建任务");
  for (unsigned i = 0; i < codex_choices.count; i++) codex_row(list, codex_choices.titles[i], codex_select, (void *)(uintptr_t)i);
  if (codex_choices.online && codex_choices.can_control) {
    if (codex_choices.approval[0]) {
      label = lv_label_create(list); lv_obj_set_width(label, 292);
      lv_label_set_text(label, "此处仅为摘要，不可批准\n手机打开 fym.lezebomb.top\nCodex 任务 → 待审批任务");
      codex_row(list, "拒绝本次操作", codex_action, "decline");
    } else {
      if (codex_choices.running) codex_row(list, "中断当前任务", codex_action, "interrupt");
      else codex_row(list, "继续当前任务", codex_action, "continue");
      codex_row(list, "新建只读检查任务", codex_action, "start");
    }
  } else { label = lv_label_create(list); lv_obj_set_width(label, 292); lv_label_set_text(label, "请在手机授权快捷操作\n离线时不发送任务"); }
  codex_row(list, "返回", codex_close, NULL);
}
static void show(void) {
  sw_sync_focus(screen == SW_CODEX);
  muse_power_t power = muse_state_power();
  sw_miao_play(screen == SW_CODEX && !egg && !atomic_load(&setup_active) &&
                   !muse_state_asleep(),
               power.usb || power.charging);
  lv_obj_set_flag(root, LV_OBJ_FLAG_HIDDEN, screen == SW_MUSE);
  lv_obj_set_flag(menu, LV_OBJ_FLAG_HIDDEN, screen != SW_MUSE);
  lv_obj_set_flag(codex_button, LV_OBJ_FLAG_HIDDEN, screen != SW_CODEX);
  lv_obj_set_flag(phone_button, LV_OBJ_FLAG_HIDDEN, screen == SW_CODEX);
  if (screen != SW_CODEX) codex_close(NULL);
  lv_obj_set_height(caption, LV_SIZE_CONTENT);
  lv_label_set_long_mode(caption, LV_LABEL_LONG_WRAP);
  if (screen == SW_MUSE)
    return;
  unsigned hidden = egg_index();
  lv_obj_set_flag(photo_obj, LV_OBJ_FLAG_HIDDEN,
                  screen != SW_PHOTOS || egg || displaying_egg);
  lv_obj_set_flag(cover_frame, LV_OBJ_FLAG_HIDDEN, screen != SW_PHOTOS || egg);
  lv_obj_set_flag(pet_face, LV_OBJ_FLAG_HIDDEN,
                  screen != SW_CODEX && (!egg || hidden != UINT32_MAX));
  lv_obj_set_style_bg_opa(caption, egg ? LV_OPA_70 : LV_OPA_TRANSP, 0);
  if (egg) {
    sw_miao_still();
    lv_label_set_text(caption, display_settings.message[0]
                                   ? display_settings.message
                                   : "今天也要记得给自己放个小假。");
    if (hidden != UINT32_MAX)
      load_photo();
  } else if (screen == SW_PHOTOS) {
    lv_label_set_text(caption, "轻点换照片 · 左右滑动切换");
    load_photo();
  } else if (screen == SW_CODEX) {
    sw_sync_codex_view(&codex_ui);
    char title[sizeof(task_title)], project[sizeof(task_project)],
        error[sizeof(task_error)];
    char connection[88], quota_text[32];
    bool online, synced;
    int quota;
    unsigned p;
    uint32_t seen, key;
    portENTER_CRITICAL(&device_lock);
    memcpy(title, task_title, sizeof(title));
    memcpy(project, task_project, sizeof(project));
    memcpy(error, task_error, sizeof(error));
    online = codex_online;
    p = phase;
    seen = task_seen;
    synced = task_synced_ms != 0;
    quota = task_quota;
    key = task_key;
    portEXIT_CRITICAL(&device_lock);
    sw_miao_state(online ? (sw_task_t)(p + SW_IDLE) : SW_OFFLINE, key);
    if (online && quota >= 0)
      snprintf(quota_text, sizeof(quota_text), "额度剩余 %d%%", quota);
    else
      strlcpy(quota_text, "额度不可用", sizeof(quota_text));
    const char *sync = sw_sync_state();
    if (!strcmp(sync, "reauthorize"))
      strlcpy(connection, "请在手机控制台重新授权", sizeof(connection));
    else if (!strcmp(sync, "unpaired"))
      strlcpy(connection, "请在手机控制台绑定挂件", sizeof(connection));
    else if (!strcmp(sync, "photo-full"))
      strlcpy(connection, "相册空间不足", sizeof(connection));
    else if (!online && synced)
      snprintf(connection, sizeof(connection), "上次同步 %lu 秒前",
               (unsigned long)((lv_tick_get() - seen) / 1000));
    else
      strlcpy(connection, online ? quota_text : "尚未同步 · 额度不可用",
              sizeof(connection));
    const char *command_state = sw_sync_codex_command_state();
    if (!strcmp(command_state, "sending")) strlcpy(connection, "正在提交指令", sizeof(connection));
    else if (!strcmp(command_state, "received")) strlcpy(connection, "中转已接收，等待电脑回执", sizeof(connection));
    else if (!strcmp(command_state, "accepted")) strlcpy(connection, "电脑已接收，等待执行结果", sizeof(connection));
    else if (!strcmp(command_state, "executing")) strlcpy(connection, "指令正在执行", sizeof(connection));
    else if (!strcmp(command_state, "succeeded")) strlcpy(connection, "指令执行成功", sizeof(connection));
    else if (!strcmp(command_state, "interrupted")) strlcpy(connection, "任务已中断", sizeof(connection));
    else if (!strcmp(command_state, "uncertain")) strlcpy(connection, "执行状态待核对，请看手机", sizeof(connection));
    else if (!strcmp(command_state, "failed")) strlcpy(connection, "指令失败，请在手机查看原因", sizeof(connection));
    lv_label_set_text_fmt(
        caption, "%s\n%s%s%s%s%s\n%s\n%.180s", online ? phases[p] : "Codex 离线",
        project, *project ? " · " : "", title, p == 6 && *error ? "\n" : "",
        p == 6 ? error : "", connection, codex_ui.detail);
    lv_obj_set_height(caption, 105); lv_label_set_long_mode(caption, LV_LABEL_LONG_DOT);
  } else
    lv_label_set_text(
        caption,
        "左右滑动切换界面\n轻点照片切换封面\n黄键按住说话，松开发送\n五次轻点打"
        "开彩蛋\n照片页左上角手机配网\n在手机控制台绑定、上传照片\n低电量请连接"
        "充电\n轻点返回照片");
  lv_obj_align(caption, LV_ALIGN_CENTER, 0,
               screen == SW_GUIDE   ? 0
               : screen == SW_CODEX ? 82
                                    : 130);
  if (!atomic_load(&setup_active))
    lv_obj_move_foreground(root);
}
static void tick(lv_timer_t *timer) {
  (void)timer;
  muse_mode_t mode = muse_state_mode(NULL);
  if (mode == MUSE_MODE_LISTENING || mode == MUSE_MODE_THINKING ||
      mode == MUSE_MODE_SPEAKING) {
    close_phone_setup(NULL);
    if (screen != SW_MUSE) {
      screen = SW_MUSE;
      show();
    }
  }
  uint32_t now = lv_tick_get();
  muse_power_t power = muse_state_power();
  bool external = power.usb || power.charging;
  int setup_request = atomic_exchange(&setup_requested, 0);
  if (setup_request > 0)
    open_phone_setup(NULL);
  else if (setup_request < 0)
    close_phone_setup(NULL);
  tick_phone_setup(now, !external && power.battery_pct >= 0 &&
                            power.battery_pct <= 5);
  int view = atomic_exchange(&diagnostic_view, 0);
  if (view && !atomic_load(&setup_active) && !muse_voice_in_call()) {
    screen = view > 0 ? SW_CODEX : SW_PHOTOS;
    show();
  }
  unsigned selection = atomic_exchange(&requested_photo, UINT32_MAX);
  if (selection != UINT32_MAX) {
    photo = selection;
    load_photo();
    save();
  }
  cover_sync_t cover;
  if (sync_results && xQueueReceive(sync_results, &cover, 0) == pdTRUE)
    apply_synced_cover(&cover);
  static unsigned observed_generation;
  unsigned generation = atomic_load(&task_generation);
  if (codex_online) {
    bool network_lost = atomic_load(&task_wireless) && !muse_wifi_connected();
    portENTER_CRITICAL(&device_lock);
    bool stale =
        codex_online && (lv_tick_elaps(task_seen) > 30000 ||
                         (atomic_load(&task_wireless) && network_lost));
    if (stale)
      codex_online = false;
    portEXIT_CRITICAL(&device_lock);
    if (stale)
      atomic_fetch_add(&task_generation, 1);
  }
  if (generation != observed_generation) {
    observed_generation = generation;
    if (screen == SW_CODEX && !egg)
      show();
  }
  if (!atomic_exchange(&external_power_seen, true)) {
    atomic_store(&previous_external_power, external);
  } else if (atomic_load(&previous_external_power) != external) {
    if (screen != SW_MUSE)
      muse_state_set_asleep(false); /* Poke once per physical source change. */
    atomic_store(&previous_external_power, external);
    ESP_LOGI("companion", "Power source changed to %s; fresh idle window",
             external ? "USB" : "battery");
  }
  sw_update_health_tick(pixels != NULL);
  if (screen == SW_MUSE)
    lv_obj_set_flag(menu, LV_OBJ_FLAG_HIDDEN, muse_settings_ui_in_subpage());
  sw_update_interaction(screen == SW_CODEX || egg ||
                        atomic_load(&upload_busy) ||
                        atomic_load(&setup_active));
  photo_result_t result;
  if (photo_results && xQueueReceive(photo_results, &result, 0) == pdTRUE) {
    unsigned hidden = egg_index(),
             index = hidden == UINT32_MAX ? photo : hidden;
    bool matches = result.index == index;
    if (matches && index >= 3) {
      char path[48], expected[65];
      photo_entry_t entry;
      matches = photo_path(index, path, &entry);
      if (matches) {
        hash_hex(entry.hash, expected);
        matches = !strcmp(expected, result.hash);
      }
    }
    if (matches) {
      uint8_t *old = pixels;
      lv_image_cache_drop(&image);
      pixels = result.data;
      portENTER_CRITICAL(&device_lock);
      memcpy(displayed_hash, result.hash, 65);
      portEXIT_CRITICAL(&device_lock);
      image.data = pixels;
      lv_image_set_src(photo_obj, &image);
      lv_obj_invalidate(photo_obj);
      displaying_egg = hidden != UINT32_MAX;
      if (screen == SW_PHOTOS && (!egg || displaying_egg)) {
        lv_obj_remove_flag(photo_obj, LV_OBJ_FLAG_HIDDEN);
        if (displaying_egg)
          lv_obj_fade_in(photo_obj, 450, 0);
        else
          lv_obj_set_style_opa(photo_obj, LV_OPA_COVER, 0);
      }
      free(old);
    } else
      free(result.data);
  }
  sw_miao_play(screen == SW_CODEX && !egg && !atomic_load(&setup_active) &&
                   !muse_state_asleep() && !muse_voice_in_call(),
               external);
  sw_power_policy_t policy = sw_power_policy((sw_power_input_t){
      .charging = power.usb || power.charging,
      .battery = power.battery_pct,
      .screen = screen,
      .idle_s =
          atomic_load(&setup_active) ? 0 : (unsigned)muse_state_idle_secs(),
      .brightness = muse_settings_brightness(),
      .mode = display_settings.mode,
      .sleep_after = display_settings.sleep_after});
  if (now - last_power >= 1000) {
    last_power = now;
    if (screen == SW_CODEX && !egg && !codex_online)
      show();
    if (screen != SW_MUSE) {
      if (!policy.display && !muse_state_asleep())
        muse_state_set_asleep(true);
    }
    /* Muse owns the saved Wi-Fi switch, reconnect backoff and screen-off nap.
     * Never turn off the user's network preference when showing the cover. */
    const char *status = "";
    if (screen == SW_CODEX)
      status = codex_online ? "在线" : "离线";
    else if (screen == SW_PHOTOS && !muse_wifi_connected())
      status = "未联网";
    lv_label_set_text_fmt(status_label, "%s  %s  %d%%", names[screen], status,
                          power.battery_pct);
    if (policy.pixel_shift) {
      int shift_x = (int)((now / 60000) % 3) - 1;
      int shift_y = (int)((now / 120000) % 3) - 1;
      lv_obj_align(status_label, LV_ALIGN_TOP_MID, -40 + shift_x, 55 + shift_y);
      lv_obj_align(photo_obj, LV_ALIGN_CENTER, shift_x, shift_y);
    }
    time_t wall = time(NULL) + (int)display_settings.utc_offset * 60;
    struct tm local;
    gmtime_r(&wall, &local);
    unsigned day = local.tm_year * 366 + local.tm_yday;
    if (screen == SW_PHOTOS && !egg && !muse_state_asleep() &&
        local.tm_year >= 126 && local.tm_mon + 1 == display_settings.month &&
        local.tm_mday == display_settings.day && day != egg_day_seen) {
      egg_day_seen = day;
      egg = true;
      show();
    }
  }
  if (slideshow && screen == SW_PHOTOS &&
      now - last_slide >= slide_seconds * 1000) {
    last_slide = now;
    photo = next_photo(photo);
    load_photo();
  }
}
static void toggle_slide(lv_event_t *event) {
  (void)event;
  slideshow = !slideshow;
  last_slide = lv_tick_get();
  save();
}
void sw_companion_init(void) {
  sw_muse_proxy_init();
  /* The SDK Noto subset starts at U+3000: ASCII must resolve through a
   * Latin font. Keep this local copy; never mutate the SDK's const font. */
  companion_font = muse_font_cjk_noto_16;
  companion_font.fallback = LV_FONT_DEFAULT;
  psa_crypto_init();
  esp_vfs_spiffs_conf_t fs = {.base_path = "/photos",
                              .partition_label = "photos",
                              .max_files = 3,
                              .format_if_mount_failed = false};
  esp_err_t mounted = esp_vfs_spiffs_register(&fs);
  storage_mounted = mounted == ESP_OK;
  if (mounted != ESP_OK)
    ESP_LOGW("companion", "assets unavailable: %s", esp_err_to_name(mounted));
  if (nvs_open("stopwatch", NVS_READWRITE, &config) == ESP_OK) {
    nvs_ok = true;
    uint8_t silent = 1;
    esp_err_t silent_result = nvs_get_u8(config, "audio_silent", &silent);
    atomic_store(&audio_silent, silent_result != ESP_OK || silent != 0);
    if (silent_result == ESP_ERR_NVS_NOT_FOUND) {
      nvs_set_u8(config, "audio_silent", 1);
      nvs_commit(config);
    }
    uint32_t selected = 0;
    uint8_t slide = 0;
    nvs_get_u32(config, "photo", &selected);
    nvs_get_u8(config, "slide", &slide);
    sw_display_settings_t saved;
    size_t cfg_size = sizeof(saved);
    if (nvs_get_blob(config, "display_cfg", &saved, &cfg_size) == ESP_OK &&
        cfg_size == sizeof(saved) && saved.mode <= SW_POWER_ENDURANCE &&
        saved.sleep_after <= 3600 && saved.utc_offset >= -720 &&
        saved.utc_offset <= 840 && saved.month >= 1 && saved.month <= 12 &&
        saved.day >= 1 && saved.day <= 31 &&
        !saved.message[sizeof(saved.message) - 1])
      display_settings = saved;
    photo = selected < 3 + USER_SLOTS ? selected : 0;
    slideshow = slide;
    size_t bytes = sizeof(last_cover);
    last_cover_valid =
        nvs_get_blob(config, "relay_cover", &last_cover, &bytes) == ESP_OK &&
        bytes == sizeof(last_cover) && last_cover.id[36] == 0 &&
        last_cover.seconds >= 5 && last_cover.seconds <= 300;
    if (last_cover_valid)
      slide_seconds = last_cover.seconds;
  }
  album_init();
  transfer_lock = xSemaphoreCreateMutex();
  char initial_path[48];
  photo_entry_t initial_entry;
  if (!photo_path(photo, initial_path, &initial_entry) ||
      (photo >= 3 && display_settings.has_egg &&
       !memcmp(initial_entry.hash, display_settings.egg_hash, 32)))
    photo = 0;
  if (storage_mounted)
    unlink(TEMP_PHOTO);
  photo_requests = xQueueCreate(1, sizeof(unsigned));
  photo_results = xQueueCreate(1, sizeof(photo_result_t));
  sync_results = xQueueCreate(1, sizeof(cover_sync_t));
  if (!transfer_lock || !photo_requests || !photo_results ||
      xTaskCreate(photo_worker, "sw_photo", SW_PHOTO_STACK_BYTES, NULL, 2, NULL) != pdPASS) {
    if (photo_requests)
      vQueueDelete(photo_requests);
    if (photo_results)
      vQueueDelete(photo_results);
    photo_requests = photo_results = NULL;
    ESP_LOGE("companion",
             "photo worker unavailable; text UI remains available");
  }
  image = (lv_image_dsc_t){.header = {.magic = LV_IMAGE_HEADER_MAGIC,
                                      .cf = LV_COLOR_FORMAT_RGB565,
                                      .w = 466,
                                      .h = 466,
                                      .stride = 932},
                           .data_size = 466u * 466u * 2u,
                           .data = pixels};
  root = lv_obj_create(lv_screen_active());
  lv_obj_set_size(root, 466, 466);
  lv_obj_center(root);
  lv_obj_remove_flag(root, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_pad_all(root, 0, 0);
  lv_obj_set_style_border_width(root, 0, 0);
  lv_obj_set_style_radius(root, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_clip_corner(root, true, 0);
  lv_obj_set_style_bg_color(root, lv_color_hex(0x122521), 0);
  lv_obj_set_style_text_font(root, &companion_font, 0);
  lv_obj_set_style_text_color(root, lv_color_hex(0xf4f5e9), 0);
  lv_obj_add_event_cb(root, touch, LV_EVENT_CLICKED, NULL);
  lv_obj_add_event_cb(root, touch, LV_EVENT_GESTURE, NULL);
  photo_obj = lv_image_create(root);
  cover_frame = lv_obj_create(root);
  lv_obj_remove_style_all(cover_frame);
  lv_obj_remove_flag(cover_frame,
                     LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_size(cover_frame, 464, 464);
  lv_obj_center(cover_frame);
  lv_obj_set_style_radius(cover_frame, LV_RADIUS_CIRCLE, 0);
  set_frame(last_cover_valid ? last_cover.border : 0);
  lv_obj_center(photo_obj);
  lv_obj_remove_flag(photo_obj, LV_OBJ_FLAG_CLICKABLE);
  status_label = lv_label_create(root);
  lv_obj_set_style_text_font(status_label, &companion_font, 0);
  lv_obj_set_style_text_color(status_label, lv_color_hex(0xe1e9ce), 0);
  lv_obj_align(status_label, LV_ALIGN_TOP_MID, -40, 55);
  pet_face = sw_miao_init(root);
  lv_obj_align(pet_face, LV_ALIGN_CENTER, 0, -50);
  caption = lv_label_create(root);
  lv_obj_set_width(caption, 300);
  lv_obj_set_style_bg_color(caption, lv_color_hex(0x122521), 0);
  lv_obj_set_style_radius(caption, 12, 0);
  lv_obj_set_style_text_align(caption, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_font(caption, &companion_font, 0);
  lv_obj_set_style_text_color(caption, lv_color_hex(0xe5e9d3), 0);
  menu = lv_button_create(lv_screen_active());
  navigation_style(menu);
  lv_obj_set_size(menu, 126, 42);
  lv_obj_align(menu, LV_ALIGN_BOTTOM_MID, 0, -30);
  lv_obj_add_event_cb(menu, back, LV_EVENT_CLICKED, NULL);
  lv_obj_t *back_label = lv_label_create(menu);
  lv_label_set_text(back_label, "返回照片");
  lv_obj_center(back_label);
  for (unsigned i = 0; i < SW_SCREEN_COUNT; i++) {
    lv_obj_t *button = lv_button_create(root);
    navigation_style(button);
    lv_obj_set_size(button, 68, 42);
    lv_obj_align(button, LV_ALIGN_CENTER, ((int)i * 72) - 108, 172);
    lv_obj_add_event_cb(button, page, LV_EVENT_CLICKED, (void *)(uintptr_t)i);
    lv_obj_t *label = lv_label_create(button);
    lv_obj_set_style_text_font(label, &companion_font, 0);
    lv_label_set_text(label, names[i]);
    lv_obj_center(label);
  }
  lv_obj_t *settings_button = lv_button_create(root);
  navigation_style(settings_button);
  lv_obj_set_size(settings_button, 100, 42);
  lv_obj_align(settings_button, LV_ALIGN_CENTER, 100, -145);
  lv_obj_add_event_cb(settings_button, open_settings, LV_EVENT_CLICKED, NULL);
  lv_obj_t *settings_label = lv_label_create(settings_button);
  lv_label_set_text(settings_label, "设置");
  lv_obj_center(settings_label);
  phone_button = lv_button_create(root);
  navigation_style(phone_button);
  lv_obj_set_size(phone_button, 128, 42);
  lv_obj_align(phone_button, LV_ALIGN_CENTER, -80, -145);
  lv_obj_add_event_cb(phone_button, open_phone_setup, LV_EVENT_CLICKED, NULL);
  lv_obj_t *phone_label = lv_label_create(phone_button);
  lv_label_set_text(phone_label, "手机配网");
  lv_obj_center(phone_label);
  codex_button = lv_button_create(root); navigation_style(codex_button);
  lv_obj_set_size(codex_button, 128, 42); lv_obj_align(codex_button, LV_ALIGN_CENTER, -80, -145);
  lv_obj_add_event_cb(codex_button, codex_open, LV_EVENT_CLICKED, NULL);
  lv_obj_t *codex_label = lv_label_create(codex_button); lv_label_set_text(codex_label, "任务操作"); lv_obj_center(codex_label);
  setup_panel = lv_obj_create(lv_screen_active());
  lv_obj_set_size(setup_panel, 466, 466);
  lv_obj_center(setup_panel);
  lv_obj_remove_flag(setup_panel, LV_OBJ_FLAG_SCROLLABLE);
  lv_obj_set_style_radius(setup_panel, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_clip_corner(setup_panel, true, 0);
  lv_obj_set_style_pad_all(setup_panel, 0, 0);
  lv_obj_set_style_border_width(setup_panel, 0, 0);
  lv_obj_set_style_bg_color(setup_panel, lv_color_hex(0x122521), 0);
  lv_obj_set_style_text_color(setup_panel, lv_color_hex(0xf4f5e9), 0);
  lv_obj_set_style_text_font(setup_panel, &companion_font, 0);
  lv_obj_t *setup_title = lv_label_create(setup_panel);
  lv_label_set_text(setup_title, "手机扫码配网");
  lv_obj_align(setup_title, LV_ALIGN_CENTER, 0, -175);
  lv_obj_t *qr = lv_image_create(setup_panel);
  lv_image_set_src(qr, &setup_qr_image);
  lv_obj_align(qr, LV_ALIGN_CENTER, 0, -25);
  setup_status = lv_label_create(setup_panel);
  lv_obj_set_width(setup_status, 320);
  lv_obj_set_style_text_align(setup_status, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(setup_status, LV_ALIGN_CENTER, 0, 140);
  lv_obj_t *setup_close = lv_button_create(setup_panel);
  navigation_style(setup_close);
  lv_obj_set_size(setup_close, 126, 42);
  lv_obj_align(setup_close, LV_ALIGN_CENTER, 0, 195);
  lv_obj_add_event_cb(setup_close, close_phone_setup, LV_EVENT_CLICKED, NULL);
  lv_obj_t *close_label = lv_label_create(setup_close);
  lv_label_set_text(close_label, "返回");
  lv_obj_center(close_label);
  lv_obj_add_flag(setup_panel, LV_OBJ_FLAG_HIDDEN);
  lv_obj_add_event_cb(photo_obj, toggle_slide, LV_EVENT_LONG_PRESSED, NULL);
  lv_obj_add_flag(photo_obj, LV_OBJ_FLAG_CLICKABLE);
  lv_obj_add_flag(photo_obj, LV_OBJ_FLAG_EVENT_BUBBLE);
  lv_obj_add_flag(photo_obj, LV_OBJ_FLAG_GESTURE_BUBBLE);
  uint8_t initialized = 0;
  if (nvs_ok && nvs_get_u8(config, "initialized", &initialized) ==
                    ESP_ERR_NVS_NOT_FOUND) {
    /* Adopt existing Muse preferences; only the new companion marker is
     * written. */
    nvs_set_u8(config, "initialized", 1);
    nvs_commit(config);
  }
  sw_update_start(mounted == ESP_OK && nvs_ok);
  lv_timer_create(tick, 250, NULL);
  screen = SW_PHOTOS;
  show();
  ESP_LOGI("companion",
           "StopWatch ready; personal album preserved; Codex waits for real "
           "App Server; Muse authorization remains upstream-owned");
}
