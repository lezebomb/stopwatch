#include "sw_memory.h"

#if !SW_UPDATE_PRODUCTION
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_memory_utils.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sw_sync.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define DRAM (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
#define DMA (MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA)
#define PSRAM (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

void sw_memory_mark(const char *phase, int result, int detail, int flags) {
  ESP_LOGI("sw_mem",
           "@mem %s %llu %u %u %u %u %u %u %u %d %d %d", phase,
           (unsigned long long)(esp_timer_get_time() / 1000),
           (unsigned)heap_caps_get_free_size(DRAM),
           (unsigned)heap_caps_get_minimum_free_size(DRAM),
           (unsigned)heap_caps_get_largest_free_block(DRAM),
           (unsigned)heap_caps_get_largest_free_block(DMA),
           (unsigned)heap_caps_get_free_size(PSRAM),
           (unsigned)heap_caps_get_largest_free_block(PSRAM),
           (unsigned)uxTaskGetStackHighWaterMark(NULL), result, detail, flags);
}

void sw_memory_target(const char *url) {
  static const char *const domains[] = {"muse.ai", "facebook.com", "meta.com"};
  const char prefix[] = "https://";
  if (strncmp(url, prefix, sizeof(prefix) - 1))
    return;
  const char *host = url + sizeof(prefix) - 1;
  size_t authority = strcspn(host, "/?#");
  if (memchr(host, '@', authority))
    return;
  size_t length = strcspn(host, "/:?#");
  if (!length || length > 253 ||
      strspn(host, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
                    "0123456789.-") != length)
    return;
  for (size_t i = 0; i < sizeof(domains) / sizeof(domains[0]); ++i) {
    size_t size = strlen(domains[i]);
    if (length >= size && !strncasecmp(host + length - size, domains[i], size) &&
        (length == size || host[length - size - 1] == '.')) {
      ESP_LOGI("sw_mem", "@mem-target %.*s", (int)length, host);
      return;
    }
  }
}

void sw_memory_status(int id) {
  printf("@sw {\"id\":%d,\"ok\":true,\"ms\":%llu,\"dramTotal\":%u,"
         "\"dramFree\":%u,\"dramMinimum\":%u,\"dramLargest\":%u,"
         "\"internalMinimum\":%u,\"dmaFree\":%u,\"dmaLargest\":%u,"
         "\"psramHeapTotal\":%u,\"psramFree\":%u,\"psramMinimum\":%u,"
         "\"psramLargest\":%u}\n",
         id, (unsigned long long)(esp_timer_get_time() / 1000),
         (unsigned)heap_caps_get_total_size(DRAM),
         (unsigned)heap_caps_get_free_size(DRAM),
         (unsigned)heap_caps_get_minimum_free_size(DRAM),
         (unsigned)heap_caps_get_largest_free_block(DRAM),
         (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
         (unsigned)heap_caps_get_free_size(DMA),
         (unsigned)heap_caps_get_largest_free_block(DMA),
         (unsigned)heap_caps_get_total_size(PSRAM),
         (unsigned)heap_caps_get_free_size(PSRAM),
         (unsigned)heap_caps_get_minimum_free_size(PSRAM),
         (unsigned)heap_caps_get_largest_free_block(PSRAM));
  fflush(stdout);
}

void sw_memory_tasks(void) {
#if CONFIG_FREERTOS_USE_TRACE_FACILITY
  static const struct {
    const char *name;
    unsigned bytes;
  } known[] = {
      {"main", CONFIG_ESP_MAIN_TASK_STACK_SIZE}, {"sw_relay", SW_RELAY_STACK_BYTES},
      {"sw_photo", SW_PHOTO_STACK_BYTES}, {"sw_update", SW_UPDATE_DEV_STACK_BYTES},
      {"muse_boot", 8192}, {"muse_keep", 6144}, {"muse_voice", 6144},
      {"muse_input", 4096}, {"muse_serial", 6144}, {"vm_auth_rfsh", 8192},
      {"muse_vm", 8192}, {"nimble_host", CONFIG_BT_NIMBLE_HOST_TASK_STACK_SIZE},
      {"esp_timer", CONFIG_ESP_TIMER_TASK_STACK_SIZE},
      {"tiT", CONFIG_LWIP_TCPIP_TASK_STACK_SIZE},
  };
  enum { CAPACITY = 48 };
  TaskStatus_t *rows = heap_caps_malloc(sizeof(*rows) * CAPACITY, PSRAM);
  if (!rows)
    return;
  UBaseType_t count = uxTaskGetSystemState(rows, CAPACITY, NULL);
  TaskHandle_t handles[sizeof(known) / sizeof(known[0])];
  for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); ++i)
    handles[i] = xTaskGetHandle(known[i].name);
  for (UBaseType_t n = 0; n < count; ++n) {
    const char *name = "other";
    unsigned bytes = 0;
    for (size_t i = 0; i < sizeof(known) / sizeof(known[0]); ++i) {
      if (rows[n].xHandle == handles[i]) {
        name = known[i].name;
        bytes = known[i].bytes;
        break;
      }
    }
    /* TaskStatus_t's name pointer can expire after the snapshot. */
    ESP_LOGI("sw_mem", "@mem-task %u %s %u %u %u",
             (unsigned)rows[n].xTaskNumber, name, bytes,
             (unsigned)rows[n].usStackHighWaterMark,
             (unsigned)esp_ptr_external_ram(rows[n].pxStackBase));
  }
  free(rows);
#endif
}

void sw_memory_http_probe(void) {
  if (!sw_sync_http_take())
    return;
  const int sizes[] = {4096, SW_VM_HTTP_BUFFER_BYTES};
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    esp_http_client_config_t cfg = {
        .url = "https://api.muse.ai",
        .method = HTTP_METHOD_POST,
        .crt_bundle_attach = esp_crt_bundle_attach,
        .buffer_size = sizes[i],
        .buffer_size_tx = sizes[i],
    };
    sw_memory_mark("probe.before", sizes[i], 0, 0);
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    sw_memory_mark("probe.active", sizes[i], client != NULL, 0);
    if (client)
      esp_http_client_cleanup(client);
    sw_memory_mark("probe.after", sizes[i], 0, 0);
  }
  sw_sync_http_release();
}
#endif
