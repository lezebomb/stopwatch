#include "sw_updater.h"
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/base64.h"
#include "mbedtls/pk.h"
#include "muse_board.h"
#include "muse_state.h"
#include "muse_voice.h"
#include "muse_wifi.h"
#include "nvs.h"
#include "psa/crypto.h"
#include "sw_update_build.h"
#include "sw_update_core.h"
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#if !CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE ||                                  \
    !CONFIG_SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT
#error StopWatch updater requires rollback and software signed-image verification
#endif
#if CONFIG_SECURE_BOOT || CONFIG_BOOTLOADER_APP_ANTI_ROLLBACK
#error This profile must not burn irreversible security eFuses
#endif
extern const unsigned char
    update_public_pem_start[] asm("_binary_update_public_pem_start");
extern const unsigned char
    update_public_pem_end[] asm("_binary_update_public_pem_end");
static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static sw_update_status_t status;
static atomic_bool manual, interaction, services;
static atomic_uint ui_beat;
static bool storage_ready;
static nvs_handle_t nvs;
static sw_update_policy_t policy;
static const char *TAG = "sw_update";
/* Keep the complete OTA path linked in development builds, while failing
 * closed. */
static volatile bool production_configured = SW_UPDATE_PRODUCTION;
static char manifest_url[768];
static TaskHandle_t update_task;
typedef struct {
  char version[32], url[768], build[65];
  uint8_t hash[32];
  size_t size;
  uint64_t sequence;
} manifest_t;
static uint64_t seconds(void) {
  return (uint64_t)(esp_timer_get_time() / 1000000);
}
static void state(const char *phase, const char *detail) {
  portENTER_CRITICAL(&lock);
  snprintf(status.state, sizeof(status.state), "%s", phase);
  snprintf(status.detail, sizeof(status.detail), "%s", detail);
  portEXIT_CRITICAL(&lock);
}
void sw_update_status(sw_update_status_t *out) {
  portENTER_CRITICAL(&lock);
  *out = status;
  portEXIT_CRITICAL(&lock);
}
void sw_update_health_tick(bool ready) {
  if (ready)
    atomic_store(&ui_beat, seconds());
}
void sw_update_services_ready(void) { atomic_store(&services, true); }
void sw_update_interaction(bool busy) { atomic_store(&interaction, busy); }
void sw_update_request_check(void) {
  atomic_store(&manual, true);
  if (update_task)
    xTaskNotifyGive(update_task);
}
static bool busy(void) {
  muse_mode_t m = muse_state_mode(NULL);
  return atomic_load(&interaction) || muse_voice_in_call() ||
         muse_voice_notes_waiting() || m == MUSE_MODE_LISTENING ||
         m == MUSE_MODE_THINKING || m == MUSE_MODE_SPEAKING;
}
static bool https_url(const char *s) {
  return s && strncmp(s, "https://", 8) == 0 && strlen(s) < 768 &&
         !strchr(s, '\n') && !strchr(s, '\r') && !strchr(s, '@') &&
         !strchr(s, '#');
}
static esp_http_client_handle_t http_open(const char *url, size_t max) {
  if (!https_url(url))
    return NULL;
  esp_http_client_config_t cfg = {.url = url,
                                  .crt_bundle_attach = esp_crt_bundle_attach,
                                  .timeout_ms = 15000,
                                  .buffer_size = 2048,
                                  .max_redirection_count = 4,
                                  .disable_auto_redirect = true,
                                  .transport_type = HTTP_TRANSPORT_OVER_SSL};
  esp_http_client_handle_t h = esp_http_client_init(&cfg);
  if (!h)
    return NULL;
  for (int redirect = 0; redirect < 5; redirect++) {
    if (esp_http_client_open(h, 0) != ESP_OK)
      break;
    int64_t length = esp_http_client_fetch_headers(h);
    int code = esp_http_client_get_status_code(h);
    if (code == 200 && (length < 0 || (uint64_t)length <= max))
      return h;
    if (code != 301 && code != 302 && code != 303 && code != 307 && code != 308)
      break;
    esp_http_client_close(h);
    if (esp_http_client_set_redirection(h) != ESP_OK)
      break;
    char redirected[768];
    if (esp_http_client_get_url(h, redirected, sizeof(redirected)) != ESP_OK ||
        !https_url(redirected))
      break;
  }
  esp_http_client_cleanup(h);
  return NULL;
}
static const char *str(cJSON *o, const char *key) {
  cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsString(v) ? v->valuestring : NULL;
}
static bool eq(cJSON *o, const char *key, const char *v) {
  const char *s = str(o, key);
  return s && strcmp(s, v) == 0;
}
static double number(cJSON *o, const char *key) {
  cJSON *v = cJSON_GetObjectItemCaseSensitive(o, key);
  return cJSON_IsNumber(v) ? v->valuedouble : -1;
}
static int parse_manifest(const char *json, manifest_t *out) {
  cJSON *envelope = cJSON_Parse(json), *payload = NULL;
  int ok = -1;
  uint8_t *bytes = NULL, *signature = NULL;
  mbedtls_pk_context key;
  mbedtls_pk_init(&key);
  mbedtls_svc_key_id_t psa_key = MBEDTLS_SVC_KEY_ID_INIT;
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
  const char *body = envelope ? str(envelope, "payload") : NULL,
             *sig = envelope ? str(envelope, "signature") : NULL;
  if (!envelope || !eq(envelope, "algorithm", "RSA-PSS-SHA256") ||
      !eq(envelope, "keyId", "stable-v1") || !body || !sig ||
      strlen(body) > 12000 || strlen(sig) != 512)
    goto done;
  bytes = calloc(1, 9001);
  signature = malloc(384);
  if (!bytes || !signature)
    goto done;
  size_t length = 0, sig_len = 0;
  if (mbedtls_base64_decode(bytes, 9000, &length, (const unsigned char *)body,
                            strlen(body)) ||
      mbedtls_base64_decode(signature, 384, &sig_len,
                            (const unsigned char *)sig, strlen(sig)) ||
      sig_len != 384)
    goto done;
  uint8_t hash[32];
  size_t hash_len = 0;
  if (psa_hash_compute(PSA_ALG_SHA_256, bytes, length, hash, sizeof(hash),
                       &hash_len) != PSA_SUCCESS)
    goto done;
  if (mbedtls_pk_parse_public_key(
          &key, update_public_pem_start,
          (size_t)(update_public_pem_end - update_public_pem_start)) != 0)
    goto done;
  if (mbedtls_pk_get_psa_attributes(&key, PSA_KEY_USAGE_VERIFY_HASH,
                                    &attributes) != 0 ||
      psa_get_key_bits(&attributes) != 3072)
    goto done;
  psa_set_key_algorithm(&attributes, PSA_ALG_RSA_PSS(PSA_ALG_SHA_256));
  if (mbedtls_pk_import_into_psa(&key, &attributes, &psa_key) != 0 ||
      psa_verify_hash(psa_key, PSA_ALG_RSA_PSS(PSA_ALG_SHA_256), hash, 32,
                      signature, sig_len) != PSA_SUCCESS)
    goto done;
  payload = cJSON_ParseWithLength((const char *)bytes, length);
  if (!payload)
    goto done;
  cJSON *compat = cJSON_GetObjectItemCaseSensitive(payload, "compatibility");
  const char *version = str(payload, "version"), *url = str(payload, "url"),
             *sha = str(payload, "sha256"), *build = str(payload, "buildId");
  double size = number(payload, "size"), seq = number(payload, "sequence");
  uint64_t highest = 0, failed = 0;
  nvs_get_u64(nvs, "highest", &highest);
  nvs_get_u64(nvs, "failed_seq", &failed);
  if (number(payload, "schema") != 1 || !eq(payload, "kind", "firmware") ||
      !eq(payload, "channel", "stable") ||
      !eq(payload, "hardware", "m5stack-stopwatch-c152") || !compat ||
      !eq(compat, "partitionLayout", "c152-16m-dual4m-photos7m-v1") ||
      number(compat, "dataSchema") != 1 || !eq(compat, "idf", "6.0.3"))
    goto done;
  if (!version || strlen(version) >= 32 ||
      sw_update_version(version, SW_UPDATE_VERSION) == -2 || !https_url(url) ||
      !sha || strlen(sha) != 64 || !build || strlen(build) < 7 ||
      strlen(build) > 64 || size <= 0 || size > 0x400000 ||
      size != (size_t)size || seq <= 0 || seq > 9007199254740991.0 ||
      seq != (uint64_t)seq || !str(payload, "publishedAt"))
    goto done;
  portENTER_CRITICAL(&lock);
  snprintf(status.latest, sizeof(status.latest), "%s", version);
  portEXIT_CRITICAL(&lock);
  if (sw_update_version(version, SW_UPDATE_VERSION) <= 0 || seq <= highest ||
      seq <= failed) {
    ok = 0;
    goto done;
  }
  memset(out, 0, sizeof(*out));
  snprintf(out->version, sizeof(out->version), "%s", version);
  snprintf(out->url, sizeof(out->url), "%s", url);
  snprintf(out->build, sizeof(out->build), "%s", build);
  out->size = (size_t)size;
  out->sequence = (uint64_t)seq;
  for (unsigned i = 0; i < 32; i++) {
    char a = sha[i * 2], b = sha[i * 2 + 1];
    if (!((a >= '0' && a <= '9') || (a >= 'a' && a <= 'f')) ||
        !((b >= '0' && b <= '9') || (b >= 'a' && b <= 'f')))
      goto done;
    out->hash[i] = (uint8_t)((a <= '9' ? a - '0' : a - 'a' + 10) * 16 +
                             (b <= '9' ? b - '0' : b - 'a' + 10));
  }
  ok = 1;
done:
  psa_destroy_key(psa_key);
  psa_reset_key_attributes(&attributes);
  mbedtls_pk_free(&key);
  free(bytes);
  free(signature);
  cJSON_Delete(payload);
  cJSON_Delete(envelope);
  return ok;
}
typedef struct {
  esp_ota_handle_t handle;
  const esp_partition_t *partition;
  const manifest_t *manifest;
  bool ended;
} ota_context_t;
static int begin(void *p, size_t size) {
  ota_context_t *c = p;
  return esp_ota_begin(c->partition, size, &c->handle) != ESP_OK;
}
static int write_chunk(void *p, const void *data, size_t size) {
  return esp_ota_write(((ota_context_t *)p)->handle, data, size) != ESP_OK;
}
static int end_signature(void *p) {
  ota_context_t *c = p;
  c->ended = true;
  if (esp_ota_end(c->handle) != ESP_OK)
    return -1;
  esp_app_desc_t desc;
  if (esp_ota_get_partition_description(c->partition, &desc) != ESP_OK ||
      strncmp(desc.version, c->manifest->version, sizeof(desc.version)))
    return -1;
  return 0;
}
static void abort_update(void *p) {
  ota_context_t *c = p;
  if (!c->ended)
    esp_ota_abort(c->handle);
}
static int activate(void *p) {
  ota_context_t *c = p;
  const manifest_t *m = c->manifest;
  if (nvs_set_u64(nvs, "pending_seq", m->sequence) != ESP_OK ||
      nvs_set_str(nvs, "pending_ver", m->version) != ESP_OK ||
      nvs_commit(nvs) != ESP_OK)
    return -1;
  if (esp_ota_set_boot_partition(c->partition) != ESP_OK) {
    nvs_erase_key(nvs, "pending_seq");
    nvs_erase_key(nvs, "pending_ver");
    nvs_commit(nvs);
    return -1;
  }
  return 0;
}
static bool install(const manifest_t *m) {
  const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
  if (!part || m->size > part->size)
    return false;
  esp_http_client_handle_t h = http_open(m->url, m->size);
  if (!h)
    return false;
  sw_update_stream_t stream = {0};
  ota_context_t ctx = {.partition = part, .manifest = m};
  sw_update_ops_t ops = {&ctx,          begin,    write_chunk,
                         end_signature, activate, abort_update};
  psa_hash_operation_t hash = PSA_HASH_OPERATION_INIT;
  bool success = false;
  uint8_t *buffer = malloc(4096);
  size_t total = 0;
  if (!buffer || psa_hash_setup(&hash, PSA_ALG_SHA_256) != PSA_SUCCESS ||
      sw_update_stream_begin(&stream, ops, m->size, part->size))
    goto done;
  for (;;) {
    muse_power_t power = muse_state_power();
    if (!(power.usb || power.charging) ||
        power.battery_pct < policy.min_battery || busy() ||
        !muse_wifi_connected())
      goto done;
    int count = esp_http_client_read(h, (char *)buffer, 4096);
    if (count < 0)
      goto done;
    if (!count)
      break;
    if ((size_t)count > m->size - total ||
        psa_hash_update(&hash, buffer, (size_t)count) != PSA_SUCCESS ||
        sw_update_stream_write(&stream, buffer, (size_t)count))
      goto done;
    total += (size_t)count;
    vTaskDelay(pdMS_TO_TICKS(1));
  }
  uint8_t actual[32];
  size_t length = 0;
  if (!esp_http_client_is_complete_data_received(h) ||
      psa_hash_finish(&hash, actual, sizeof(actual), &length) != PSA_SUCCESS ||
      length != 32)
    goto done;
  state("verifying", "校验镜像签名与完整性");
  success = sw_update_stream_finish(&stream, m->hash, actual) == 0;
done:
  if (!success)
    sw_update_stream_abort(&stream);
  psa_hash_abort(&hash);
  free(buffer);
  esp_http_client_cleanup(h);
  return success;
}
static void health(void) {
  const esp_partition_t *running = esp_ota_get_running_partition();
  esp_ota_img_states_t image_state = ESP_OTA_IMG_UNDEFINED;
  if (running)
    esp_ota_get_state_partition(running, &image_state);
  char pending[32] = {0};
  size_t cap = sizeof(pending);
  uint64_t sequence = 0;
  nvs_get_str(nvs, "pending_ver", pending, &cap);
  nvs_get_u64(nvs, "pending_seq", &sequence);
  if (pending[0] && strcmp(pending, SW_UPDATE_VERSION) != 0) {
    /* A power cut between the NVS journal and set_boot_partition is not a
     * failed boot. Quarantine only an image the official OTA journal rejected.
     */
    const esp_partition_t *invalid = esp_ota_get_last_invalid_partition();
    esp_app_desc_t desc;
    if (invalid &&
        esp_ota_get_partition_description(invalid, &desc) == ESP_OK &&
        strncmp(desc.version, pending, sizeof(desc.version)) == 0)
      nvs_set_u64(nvs, "failed_seq", sequence);
    nvs_erase_key(nvs, "pending_ver");
    nvs_erase_key(nvs, "pending_seq");
    nvs_commit(nvs);
    state("rolled-back", "已恢复旧版本，等待修复版本");
  }
  uint64_t deadline = seconds() + 90, start = seconds();
  state("health-check", "检查屏幕、照片、存储与服务任务");
  while (seconds() < deadline) {
    muse_state_poke(); /* Temporary health window; never overwrite saved sleep
                          preferences. */
    if (storage_ready && atomic_load(&services) && atomic_load(&ui_beat) > 0 &&
        seconds() - atomic_load(&ui_beat) < 3 && seconds() - start >= 30 &&
        heap_caps_get_free_size(MALLOC_CAP_INTERNAL) > 12000) {
      if (esp_ota_mark_app_valid_cancel_rollback() == ESP_OK) {
        if (sequence && strcmp(pending, SW_UPDATE_VERSION) == 0)
          nvs_set_u64(nvs, "highest", sequence);
        nvs_erase_key(nvs, "pending_ver");
        nvs_erase_key(nvs, "pending_seq");
        nvs_commit(nvs);
        state("idle", "启动健康检查通过");
        return;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
  state("health-failed", "启动健康检查失败");
  if (image_state == ESP_OTA_IMG_PENDING_VERIFY) {
    esp_ota_mark_app_invalid_rollback_and_reboot();
    esp_restart();
  }
}
static void worker(void *arg) {
  (void)arg;
  health();
  uint64_t last_check = 0, next_attempt = 0, online_since = 0;
  nvs_get_u64(nvs, "last_check", &last_check);
  bool was_online = false, reconnect_due = false;
  unsigned failures = 0;
  manifest_t candidate = {0};
  bool have_candidate = false;
  for (;;) {
    bool online = muse_wifi_connected();
    uint64_t monotonic = seconds();
    time_t wall = time(NULL);
    uint64_t now = wall > 1700000000 ? (uint64_t)wall : monotonic;
    if (wall <= 1700000000 || last_check > now)
      last_check = 0;
    if (online && !was_online) {
      online_since = monotonic;
      reconnect_due = true;
    }
    if (!online)
      online_since = 0;
    was_online = online;
    muse_power_t p = muse_state_power();
    bool user_check = atomic_exchange(&manual, false);
    if (!production_configured || !manifest_url[0]) {
      if (user_check)
        state("unconfigured", "维护者尚未配置正式更新信任根");
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(30000));
      continue;
    }
    sw_update_conditions_t cond = {
        .now = now,
        .last_check = last_check,
        .next_attempt = next_attempt,
        .online = online,
        .charging = p.usb || p.charging,
        .busy = busy(),
        .manual = user_check,
        .reconnected = reconnect_due,
        .battery = p.battery_pct,
        .stable_s = online_since ? (uint32_t)(monotonic - online_since) : 0,
        .idle_s = (uint32_t)muse_state_idle_secs()};
    sw_update_action_t action = sw_update_decide(policy, cond);
    if (have_candidate && cond.online && cond.charging && !cond.busy &&
        cond.battery >= policy.min_battery && cond.idle_s >= policy.idle_s &&
        cond.stable_s >= policy.stable_s && now >= next_attempt)
      action = SW_UP_INSTALL;
    if (action == SW_UP_WAIT) {
      if (user_check)
        state("deferred", "等待稳定网络、空闲或重试间隔");
      ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(have_candidate ? 1000 : 30000));
      continue;
    }
    bool ok = true;
    if (!have_candidate) {
      state("checking", "正在检查签名版本清单");
      last_check = now;
      if (wall > 1700000000) {
        nvs_set_u64(nvs, "last_check", now);
        nvs_commit(nvs);
      }
      reconnect_due = false;
      esp_http_client_handle_t h = http_open(manifest_url, 16384);
      char *json = calloc(1, 16385);
      size_t used = 0;
      if (!h || !json)
        ok = false;
      else {
        while (used < 16384) {
          int count = esp_http_client_read(h, json + used, (int)(16384 - used));
          if (count < 0) {
            ok = false;
            break;
          }
          if (!count)
            break;
          used += (size_t)count;
        }
        if (used >= 16384 || !esp_http_client_is_complete_data_received(h))
          ok = false;
      }
      if (ok) {
        int result = parse_manifest(json, &candidate);
        ok = result >= 0;
        have_candidate = result == 1;
        if (have_candidate) {
          portENTER_CRITICAL(&lock);
          snprintf(status.latest, sizeof(status.latest), "%s",
                   candidate.version);
          portEXIT_CRITICAL(&lock);
        } else if (result == 0)
          state("up-to-date", "已是当前可用版本，或失败版本已隔离");
        else
          state("rejected", "清单签名或兼容性验证失败");
      }
      if (h)
        esp_http_client_cleanup(h);
      free(json);
    }
    if (ok && have_candidate && action == SW_UP_INSTALL) {
      state("downloading", "充电空闲中，下载到备用应用分区");
      ok = install(&candidate);
      if (ok) {
        state("restarting", "更新已验证，正在重启");
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
      } else
        have_candidate = false;
    }
    if (!ok) {
      failures++;
      next_attempt = now + sw_update_backoff(policy, failures, esp_random());
      state("retry-wait", "更新失败，保留当前固件并退避重试");
    } else {
      failures = 0;
      next_attempt = 0;
      if (have_candidate)
        state("deferred", "新版本就绪，等待充电与空闲");
    }
    portENTER_CRITICAL(&lock);
    status.failures = failures;
    portEXIT_CRITICAL(&lock);
    ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(have_candidate ? 1000 : 30000));
  }
}
void sw_update_start(bool storage_ok) {
  storage_ready = storage_ok;
  policy = sw_update_defaults();
  snprintf(manifest_url, sizeof(manifest_url), "%s", SW_UPDATE_MANIFEST_URL);
  psa_crypto_init();
  snprintf(status.current, sizeof(status.current), "%s", SW_UPDATE_VERSION);
  ESP_LOGI(TAG, "Updater started; production trust configured: %d",
           SW_UPDATE_PRODUCTION);
  if (nvs_open("sw_updates", NVS_READWRITE, &nvs) != ESP_OK) {
    state("disabled", "无法打开更新状态存储");
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t current;
    if (running && esp_ota_get_state_partition(running, &current) == ESP_OK &&
        current == ESP_OTA_IMG_PENDING_VERIFY)
      esp_ota_mark_app_invalid_rollback_and_reboot();
    return;
  }
  nvs_get_u32(nvs, "check_s", &policy.check_s);
  nvs_get_u32(nvs, "reconnect_s", &policy.reconnect_s);
  nvs_get_u32(nvs, "stable_s", &policy.stable_s);
  uint8_t min = 40;
  nvs_get_u8(nvs, "min_battery", &min);
  policy.min_battery = min;
  if (policy.check_s < 3600)
    policy.check_s = 3600;
  if (policy.reconnect_s < 300)
    policy.reconnect_s = 300;
  if (policy.stable_s < 15)
    policy.stable_s = 15;
  if (policy.min_battery < 20)
    policy.min_battery = 20;
  if (policy.min_battery > 90)
    policy.min_battery = 90;
  if (xTaskCreate(worker, "sw_update", 14336, NULL, 3, &update_task) !=
      pdPASS) {
    state("disabled", "无法启动更新任务");
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t current;
    if (running && esp_ota_get_state_partition(running, &current) == ESP_OK &&
        current == ESP_OTA_IMG_PENDING_VERIFY)
      esp_ota_mark_app_invalid_rollback_and_reboot();
  }
}
