#include "sw_sync.h"
#include "cJSON.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "mbedtls/platform_util.h"
#include "muse_state.h"
#include "muse_wifi.h"
#include "nvs.h"
#include "sw_sync_build.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define MANIFEST_MAX 8192
#define TOKEN_LENGTH 32
typedef enum {
  DISABLED,
  UNPAIRED,
  PAIRING,
  WAITING,
  ONLINE,
  REAUTHORIZE,
  PHOTO_FULL,
  RETRYING,
} sync_state_t;
typedef enum { PAIR_IDLE, PAIR_PENDING, PAIR_OK, PAIR_FAILED } pair_state_t;
typedef struct {
  char origin[161];
  char token[TOKEN_LENGTH + 1];
} credential_t;

static atomic_int state, pair_state;
static atomic_bool focused;
static portMUX_TYPE pair_lock = portMUX_INITIALIZER_UNLOCKED;
static char pending[TOKEN_LENGTH + 1];
static int64_t pair_deadline;
static TaskHandle_t worker;
static nvs_handle_t nvs;
static StaticSemaphore_t http_lock_storage;
static SemaphoreHandle_t http_lock;

void sw_sync_http_init(void) {
  http_lock = xSemaphoreCreateMutexStatic(&http_lock_storage);
}

bool sw_sync_http_take(void) {
  return xSemaphoreTake(http_lock, pdMS_TO_TICKS(16000)) == pdTRUE;
}

void sw_sync_http_release(void) { xSemaphoreGive(http_lock); }

static bool valid_token(const char *s) {
  return s && strlen(s) == TOKEN_LENGTH &&
         strspn(s, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456"
                   "789-_") == TOKEN_LENGTH;
}

const char *sw_sync_state(void) {
  static const char *const names[] = {"disabled",   "unpaired", "pairing",
                                      "waiting",    "online",   "reauthorize",
                                      "photo-full", "retrying"};
  return names[atomic_load(&state)];
}

const char *sw_sync_pair_state(void) {
  if (!worker)
    return "disabled";
  static const char *const names[] = {"idle", "pending", "paired", "failed"};
  return names[atomic_load(&pair_state)];
}

bool sw_sync_enroll(const char *code) {
  if (!worker || !valid_token(code) || !sw_companion_pairing_open())
    return false;
  portENTER_CRITICAL(&pair_lock);
  bool accepted = atomic_load(&pair_state) != PAIR_PENDING;
  if (accepted) {
    memcpy(pending, code, sizeof(pending));
    pair_deadline = esp_timer_get_time() + 120000000;
    atomic_store(&pair_state, PAIR_PENDING);
  }
  portEXIT_CRITICAL(&pair_lock);
  if (accepted)
    xTaskNotifyGive(worker);
  return accepted;
}

void sw_sync_focus(bool value) {
  if (atomic_exchange(&focused, value) != value && value && worker)
    xTaskNotifyGive(worker);
}

static bool net_ready(void) {
  return !muse_state_asleep() && muse_wifi_connected() &&
         sw_companion_sync_allowed();
}

static void close_request(esp_http_client_handle_t client) {
  esp_http_client_cleanup(client);
  sw_sync_http_release();
}

/* The origin is compiled in. Reject redirects so bearer credentials can only
 * be sent to that origin. Use the IDF trust bundle and hostname validation. */
static esp_http_client_handle_t open_request(const char *path,
                                             const char *token,
                                             const char *body, size_t offset,
                                             int *status,
                                             int64_t *length) {
  *status = 0;
  *length = -1;
  if (!net_ready())
    return NULL;
  char url[256], authorization[48] = {0};
  int n = snprintf(url, sizeof(url), "%s%s", SW_RELAY_ORIGIN, path);
  if (n < 0 || n >= sizeof(url))
    return NULL;
  esp_http_client_config_t cfg = {
      .url = url,
      .method = body ? HTTP_METHOD_POST : HTTP_METHOD_GET,
      .crt_bundle_attach = SW_RELAY_CA[0] ? NULL : esp_crt_bundle_attach,
      .cert_pem = SW_RELAY_CA[0] ? SW_RELAY_CA : NULL,
      .timeout_ms = 10000,
      .buffer_size = 1024,
      .buffer_size_tx = 512,
      .disable_auto_redirect = true,
      .max_authorization_retries = -1,
      .transport_type = HTTP_TRANSPORT_OVER_SSL,
  };
  if (!sw_sync_http_take())
    return NULL;
  if (!net_ready() || heap_caps_get_free_size(MALLOC_CAP_INTERNAL) < 12000 ||
      heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL) < 4096) {
    sw_sync_http_release();
    return NULL;
  }
  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (!client) {
    sw_sync_http_release();
    return NULL;
  }
  bool ok = true;
  if (token) {
    snprintf(authorization, sizeof(authorization), "Bearer %s", token);
    ok = esp_http_client_set_header(client, "Authorization", authorization) ==
         ESP_OK;
    mbedtls_platform_zeroize(authorization, sizeof(authorization));
  }
  if (body)
    ok = ok && esp_http_client_set_header(client, "Content-Type",
                                          "application/json") == ESP_OK;
  if (offset) {
    char range[24];
    snprintf(range, sizeof(range), "bytes=%u-", (unsigned)offset);
    ok = ok && esp_http_client_set_header(client, "Range", range) == ESP_OK;
  }
  int body_size = body ? (int)strlen(body) : 0;
  esp_err_t opened = ok ? esp_http_client_open(client, body_size) : ESP_FAIL;
  if (opened == ESP_OK &&
      (!body_size ||
       esp_http_client_write(client, body, body_size) == body_size)) {
    *length = esp_http_client_fetch_headers(client);
    *status = esp_http_client_get_status_code(client);
    if (*length >= 0 && *status == (offset ? 206 : 200))
      return client;
  }
  if (ok && opened != ESP_OK)
    ESP_LOGW("sw_relay", "HTTPS connection failed: %s", esp_err_to_name(opened));
  close_request(client);
  return NULL;
}

static cJSON *get_json(const char *path, const char *token, const char *body,
                       int *status) {
  int64_t length;
  esp_http_client_handle_t client =
      open_request(path, token, body, 0, status, &length);
  if (!client)
    return NULL;
  char *data = length <= MANIFEST_MAX
                   ? heap_caps_malloc(MANIFEST_MAX + 1,
                                      MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
                   : NULL;
  size_t used = 0, limit = length > 0 && length <= MANIFEST_MAX ? (size_t)length
                                                                : MANIFEST_MAX;
  int64_t deadline = esp_timer_get_time() + 12000000;
  while (data && used < limit && net_ready() &&
         esp_timer_get_time() < deadline) {
    int count = esp_http_client_read(client, data + used, limit - used);
    if (count == -ESP_ERR_HTTP_EAGAIN)
      continue;
    if (count <= 0)
      break;
    used += count;
  }
  cJSON *json = NULL;
  if (data && used && esp_http_client_is_complete_data_received(client) &&
      (esp_http_client_is_chunked_response(client) || used == length) &&
      !memchr(data, 0, used)) {
    data[used] = 0;
    json = cJSON_ParseWithLengthOpts(data, used + 1, NULL, true);
  }
  if (data && body)
    mbedtls_platform_zeroize(data, used);
  free(data);
  close_request(client);
  return json;
}

static const char *string(cJSON *object, const char *key) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  return cJSON_IsString(value) ? value->valuestring : NULL;
}

static bool integer(cJSON *object, const char *key, int min, int max,
                    unsigned *out) {
  cJSON *value = cJSON_GetObjectItemCaseSensitive(object, key);
  if (!cJSON_IsNumber(value) || value->valuedouble != value->valueint ||
      value->valueint < min || value->valueint > max)
    return false;
  *out = (unsigned)value->valueint;
  return true;
}

static bool uuid(const char *id) {
  if (!id || strlen(id) != 36)
    return false;
  for (unsigned i = 0; i < 36; i++) {
    if (i == 8 || i == 13 || i == 18 || i == 23) {
      if (id[i] != '-')
        return false;
    } else if (!strchr("0123456789abcdef", id[i]))
      return false;
  }
  return true;
}

static bool parse_display(cJSON *root, sw_sync_album_t *out) {
  cJSON *obj = cJSON_GetObjectItemCaseSensitive(root, "display");
  sw_display_settings_t *display = &out->display;
  display->sleep_after = 180;
  display->utc_offset = 480;
  display->month = 12;
  display->day = 25;
  if (!obj)
    return true; /* an older relay's album still works */
  out->has_display = true;
  const char *mode = string(obj, "mode"), *date = string(obj, "eggDate");
  const char *message = string(obj, "eggMessage"),
             *photo = string(obj, "eggPhoto");
  unsigned after, offset;
  int month, day;
  if (!mode || !date || strlen(date) != 5 ||
      sscanf(date, "%2d-%2d", &month, &day) != 2 || month < 1 || month > 12 ||
      day < 1 || day > 31 || !integer(obj, "sleepAfter", 0, 3600, &after) ||
      !integer(obj, "utcOffset", -720, 840, &offset))
    return false;
  display->mode = !strcmp(mode, "endurance") ? 2
                  : !strcmp(mode, "smart")   ? 1
                                             : 0;
  display->sleep_after = after;
  display->utc_offset = (int16_t)offset;
  display->month = month;
  display->day = day;
  if (message) {
    size_t n = strnlen(message, sizeof(display->message) - 1);
    while (n && ((uint8_t)message[n] & 0xc0) == 0x80)
      n--;
    memcpy(display->message, message, n);
  }
  if (photo) {
    if (!uuid(photo))
      return false;
    for (unsigned i = 0; i < out->count; i++) {
      if (strcmp(photo, out->photos[i].id))
        continue;
      memcpy(display->egg_hash, out->photos[i].sha256,
             sizeof(display->egg_hash));
      display->has_egg = true;
      return true;
    }
    return false;
  }
  return true;
}

static bool parse_album(cJSON *root, sw_sync_album_t *out) {
  cJSON *list = cJSON_GetObjectItemCaseSensitive(root, "photos");
  cJSON *cover = cJSON_GetObjectItemCaseSensitive(root, "cover");
  if (!cJSON_IsArray(list) || cJSON_GetArraySize(list) > SW_SYNC_PHOTO_LIMIT ||
      !cJSON_IsObject(cover))
    return false;
  cJSON *photo;
  cJSON_ArrayForEach(photo, list) {
    const char *id = string(photo, "id"), *sha = string(photo, "sha256");
    unsigned size;
    if (!uuid(id) || !sha || strlen(sha) != 64 ||
        strspn(sha, "0123456789abcdef") != 64 ||
        !integer(photo, "size", SW_SYNC_PHOTO_BYTES, SW_SYNC_PHOTO_BYTES,
                 &size))
      return false;
    for (unsigned i = 0; i < out->count; i++)
      if (!strcmp(out->photos[i].id, id))
        return false;
    sw_sync_photo_t *item = &out->photos[out->count++];
    memcpy(item->id, id, sizeof(item->id));
    const char *hex = "0123456789abcdef";
    for (unsigned i = 0; i < 32; i++)
      item->sha256[i] = (uint8_t)((strchr(hex, sha[i * 2]) - hex) * 16 +
                                  (strchr(hex, sha[i * 2 + 1]) - hex));
  }
  const char *selected = string(cover, "defaultPhoto"),
             *border = string(cover, "border");
  cJSON *slideshow = cJSON_GetObjectItemCaseSensitive(cover, "slideshow");
  if (!selected || !border || !cJSON_IsBool(slideshow) ||
      !integer(cover, "slideSeconds", 5, 300, &out->slide_seconds) ||
      !integer(cover, "brightness", 10, 80, &out->brightness))
    return false;
  bool found = !strcmp(selected, "builtin-0") ||
               !strcmp(selected, "builtin-1") || !strcmp(selected, "builtin-2");
  for (unsigned i = 0; i < out->count && !found; i++)
    found = !strcmp(selected, out->photos[i].id);
  if (!found)
    return false;
  strlcpy(out->cover, selected, sizeof(out->cover));
  out->slideshow = cJSON_IsTrue(slideshow);
  out->border = !strcmp(border, "gold") ? 2 : !strcmp(border, "mint") ? 1 : 0;
  return parse_display(root, out);
}

static sw_sync_album_result_t fetch_photo(const sw_sync_photo_t *photo,
                                          FILE *file, void *ctx) {
  char path[70];
  snprintf(path, sizeof(path), "/api/device/photos/%s", photo->id);
  char *buffer = heap_caps_malloc(4096, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!buffer)
    return SW_SYNC_ALBUM_ERROR;
  size_t used = 0;
  int status = 0;
  bool complete = false, write_failed = false;
  const int64_t deadline = esp_timer_get_time() + 75000000;
  for (unsigned attempt = 0; attempt < 4 && used < SW_SYNC_PHOTO_BYTES &&
                             net_ready() && esp_timer_get_time() < deadline;
       attempt++) {
    int64_t length;
    esp_http_client_handle_t client =
        open_request(path, ctx, NULL, used, &status, &length);
    if (status == 401 || status == 403)
      break;
    if (!client)
      continue;
    if (length == (int64_t)(SW_SYNC_PHOTO_BYTES - used)) {
      while (used < SW_SYNC_PHOTO_BYTES && net_ready() &&
             esp_timer_get_time() < deadline) {
        size_t left = SW_SYNC_PHOTO_BYTES - used;
        int count = esp_http_client_read(client, buffer, left < 4096 ? left : 4096);
        if (count == -ESP_ERR_HTTP_EAGAIN)
          continue;
        if (count <= 0)
          break;
        if (fwrite(buffer, 1, count, file) != count) {
          write_failed = true;
          break;
        }
        used += count;
      }
    }
    complete = used == SW_SYNC_PHOTO_BYTES &&
               esp_http_client_is_complete_data_received(client);
    close_request(client);
    if (write_failed)
      break;
  }
  free(buffer);
  if (status == 401 || status == 403)
    return SW_SYNC_ALBUM_AUTH;
  if (!complete)
    ESP_LOGW("sw_relay", "Photo transfer incomplete (%u/%u bytes, HTTP %d)",
             (unsigned)used, (unsigned)SW_SYNC_PHOTO_BYTES, status);
  return complete ? SW_SYNC_ALBUM_OK : SW_SYNC_ALBUM_ERROR;
}

static void save_task(cJSON *root) {
  cJSON *codex = cJSON_GetObjectItemCaseSensitive(root, "codex");
  cJSON *task = cJSON_GetObjectItemCaseSensitive(codex, "task");
  cJSON *online = cJSON_GetObjectItemCaseSensitive(codex, "online");
  cJSON *quota = cJSON_GetObjectItemCaseSensitive(codex, "quota");
  cJSON *primary = cJSON_GetObjectItemCaseSensitive(quota, "primary");
  cJSON *used = cJSON_GetObjectItemCaseSensitive(primary, "usedPercent");
  cJSON *synced = cJSON_GetObjectItemCaseSensitive(root, "syncedAt");
  if (!cJSON_IsBool(online))
    return;
  int remaining = cJSON_IsTrue(online) && cJSON_IsNumber(used) &&
                          used->valuedouble >= 0 && used->valuedouble <= 100
                      ? 100 - (int)(used->valuedouble + 0.5)
                      : -1;
  uint64_t time = cJSON_IsNumber(synced) && synced->valuedouble >= 0 &&
                          synced->valuedouble < 4102444800000.0
                      ? (uint64_t)synced->valuedouble
                      : 0;
  if (!time)
    return;
  sw_companion_sync_task(cJSON_IsTrue(online), string(task, "state"),
                         string(task, "title"), string(task, "project"),
                         string(task, "id"), string(task, "error"), remaining,
                         time);
}

static bool enroll(credential_t *credentials, const char *code) {
  char body[128];
  snprintf(body, sizeof(body), "{\"code\":\"%s\",\"hardware\":\"%s\"}", code,
           SW_RELAY_HARDWARE);
  int status;
  cJSON *result = get_json("/api/device/enroll", NULL, body, &status);
  mbedtls_platform_zeroize(body, sizeof(body));
  const char *token = string(result, "token");
  bool ok = false;
  if (valid_token(token) && sw_companion_pairing_open()) {
    credential_t next = {.origin = SW_RELAY_ORIGIN};
    memcpy(next.token, token, sizeof(next.token));
    ok = nvs_set_blob(nvs, "credential", &next, sizeof(next)) == ESP_OK &&
         nvs_commit(nvs) == ESP_OK;
    if (ok)
      *credentials = next;
    mbedtls_platform_zeroize(&next, sizeof(next));
    mbedtls_platform_zeroize((void *)token, TOKEN_LENGTH);
  }
  cJSON_Delete(result);
  return ok;
}

static void sync_worker(void *arg) {
  (void)arg;
  credential_t credentials = {0};
  size_t bytes = sizeof(credentials);
  if (nvs_get_blob(nvs, "credential", &credentials, &bytes) != ESP_OK ||
      bytes != sizeof(credentials) ||
      !memchr(credentials.origin, 0, sizeof(credentials.origin)) ||
      strcmp(credentials.origin, SW_RELAY_ORIGIN) ||
      credentials.token[TOKEN_LENGTH] || !valid_token(credentials.token))
    mbedtls_platform_zeroize(&credentials, sizeof(credentials));
  atomic_store(&state, credentials.token[0] ? WAITING : UNPAIRED);
  unsigned backoff = 10;
  int64_t due = 0, last_request = -10000000;
  for (;;) {
    const int64_t now = esp_timer_get_time();
    bool ready = net_ready();
    char code[TOKEN_LENGTH + 1] = {0};
    portENTER_CRITICAL(&pair_lock);
    if (pending[0] && (now >= pair_deadline || !sw_companion_pairing_open())) {
      mbedtls_platform_zeroize(pending, sizeof(pending));
      atomic_store(&pair_state, PAIR_FAILED);
    } else if (ready && pending[0]) {
      memcpy(code, pending, sizeof(code));
      mbedtls_platform_zeroize(pending, sizeof(pending));
    }
    portEXIT_CRITICAL(&pair_lock);
    if (code[0]) {
      atomic_store(&state, PAIRING);
      bool paired = enroll(&credentials, code);
      mbedtls_platform_zeroize(code, sizeof(code));
      atomic_store(&pair_state, paired ? PAIR_OK : PAIR_FAILED);
      atomic_store(&state, credentials.token[0] ? WAITING : UNPAIRED);
      due = 0;
    }
    if (credentials.token[0] && ready && now >= due) {
      last_request = esp_timer_get_time();
      int status;
      cJSON *root =
          get_json("/api/device/sync", credentials.token, NULL, &status);
      unsigned version;
      const char *hardware = string(root, "hardware");
      sw_sync_album_result_t result = SW_SYNC_ALBUM_ERROR;
      if (status == 401 || status == 403)
        result = SW_SYNC_ALBUM_AUTH;
      else if (root && integer(root, "schema", 1, 1, &version) && hardware &&
               !strcmp(hardware, SW_RELAY_HARDWARE)) {
        save_task(root);
        sw_sync_album_t *album = heap_caps_calloc(
            1, sizeof(*album), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (album && parse_album(root, album))
          result =
              sw_companion_sync_album(album, fetch_photo, credentials.token);
        free(album);
      }
      cJSON_Delete(root);
      unsigned interval = atomic_load(&focused) ? 12 : 60;
      if (result == SW_SYNC_ALBUM_AUTH) {
        mbedtls_platform_zeroize(&credentials, sizeof(credentials));
        nvs_erase_key(nvs, "credential");
        nvs_commit(nvs);
        sw_companion_sync_task(false, NULL, NULL, NULL, NULL, NULL, -1, 0);
        atomic_store(&state, REAUTHORIZE);
      } else if (result == SW_SYNC_ALBUM_OK || result == SW_SYNC_ALBUM_FULL) {
        atomic_store(&state, result == SW_SYNC_ALBUM_OK ? ONLINE : PHOTO_FULL);
        backoff = 10;
      } else {
        atomic_store(&state, RETRYING);
        interval = backoff;
        if (backoff < 160)
          backoff *= 2;
      }
      due = esp_timer_get_time() + (int64_t)interval * 1000000;
    }
    unsigned wait_ms =
        atomic_load(&focused) || atomic_load(&pair_state) == PAIR_PENDING
            ? 3000
            : 10000;
    if (ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(wait_ms)) && backoff == 10 &&
        due > last_request + 8000000)
      due = last_request + 8000000;
  }
}

void sw_sync_start(void) {
  if (!SW_RELAY_ORIGIN[0] ||
      nvs_open("sw_relay", NVS_READWRITE, &nvs) != ESP_OK)
    return;
  /* A photo download opens TLS while the album transaction is on the stack. */
  if (xTaskCreate(sync_worker, "sw_relay", 8192, NULL, 2, &worker) != pdPASS) {
    nvs_close(nvs);
    worker = NULL;
  }
}
