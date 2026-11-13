#include "sw_memory.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include <stdio.h>

#define DRAM (MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)
#define DMA (MALLOC_CAP_INTERNAL | MALLOC_CAP_DMA)
#define PSRAM (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)

#if !SW_UPDATE_PRODUCTION
#include "esp_attr.h"
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
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>


typedef struct {
  unsigned free, largest;
} dma_heap_t;

typedef struct {
  unsigned stage, kind, bytes, alignment, caps;
  int result;
  unsigned ms;
  dma_heap_t before, after;
} dma_record_t;

/* The driver's trace runs only in the board's audio initialization task.
 * Publish completed rows for USB diagnostics without logging mid-allocation. */
static EXT_RAM_BSS_ATTR dma_record_t dma_records[40];
static atomic_uint dma_count;
static _Atomic(TaskHandle_t) dma_owner;
static unsigned dma_stage;
static dma_heap_t dma_stage_before;

static dma_heap_t dma_heap(void) {
  return (dma_heap_t){heap_caps_get_free_size(DMA),
                      heap_caps_get_largest_free_block(DMA)};
}

static void dma_record(dma_record_t row) {
  unsigned index = atomic_load_explicit(&dma_count, memory_order_relaxed);
  if (index >= sizeof(dma_records) / sizeof(dma_records[0]))
    return;
  row.ms = (unsigned)(esp_timer_get_time() / 1000);
  dma_records[index] = row;
  atomic_store_explicit(&dma_count, index + 1, memory_order_release);
}

void sw_memory_dma_begin(unsigned stage) {
  dma_stage = stage;
  dma_stage_before = dma_heap();
  atomic_store(&dma_owner, xTaskGetCurrentTaskHandle());
}

void sw_memory_dma_end(int result) {
  atomic_store(&dma_owner, NULL);
  dma_record((dma_record_t){.stage = dma_stage, .result = result,
                            .before = dma_stage_before, .after = dma_heap()});
}

static bool dma_trace_active(void) {
  TaskHandle_t owner = atomic_load(&dma_owner);
  return owner && owner == xTaskGetCurrentTaskHandle();
}

/* Only esp_driver_i2s/i2s_common.c uses these substitutes, and only in
 * development builds. The requested sizes, alignment and capabilities pass
 * through unchanged. */
void *sw_memory_i2s_calloc(size_t count, size_t size, uint32_t caps) {
  if (!dma_trace_active())
    return heap_caps_calloc(count, size, caps);
  dma_heap_t before = dma_heap();
  void *ptr = heap_caps_calloc(count, size, caps);
  dma_record((dma_record_t){.stage = dma_stage, .kind = 1,
                            .bytes = count * size, .caps = caps,
                            .result = ptr ? ESP_OK : ESP_ERR_NO_MEM,
                            .before = before, .after = dma_heap()});
  return ptr;
}

void *sw_memory_i2s_aligned_calloc(size_t alignment, size_t count, size_t size,
                                   uint32_t caps) {
  if (!dma_trace_active())
    return heap_caps_aligned_calloc(alignment, count, size, caps);
  dma_heap_t before = dma_heap();
  void *ptr = heap_caps_aligned_calloc(alignment, count, size, caps);
  dma_record((dma_record_t){.stage = dma_stage, .kind = 2,
                            .bytes = count * size, .alignment = alignment,
                            .caps = caps, .result = ptr ? ESP_OK : ESP_ERR_NO_MEM,
                            .before = before, .after = dma_heap()});
  return ptr;
}

void sw_memory_dma_dump(void) {
  unsigned count = atomic_load_explicit(&dma_count, memory_order_acquire);
  for (unsigned i = 0; i < count; ++i) {
    const dma_record_t *row = &dma_records[i];
    ESP_LOGI("sw_mem", "@mem-dma %u %u %u %u %u %u %d %u %u %u %u", row->ms,
             row->stage, row->kind, row->bytes, row->alignment, row->caps,
             row->result, row->before.free, row->before.largest,
             row->after.free, row->after.largest);
  }
  /* Simulated call entry: observe current capacity without enabling audio,
   * allocating a channel, connecting to Muse, or capturing microphone data. */
  dma_heap_t current = dma_heap();
  ESP_LOGI("sw_mem", "@mem-dma %u 5 0 0 0 0 0 %u %u %u %u",
           (unsigned)(esp_timer_get_time() / 1000), current.free,
           current.largest, current.free, current.largest);
}

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


void sw_memory_tasks(void) {
#if CONFIG_FREERTOS_USE_TRACE_FACILITY
  static const struct {
    const char *name;
    unsigned bytes;
  } known[] = {
      {"main", CONFIG_ESP_MAIN_TASK_STACK_SIZE}, {"sw_relay", SW_RELAY_STACK_BYTES},
      {"sw_photo", SW_PHOTO_STACK_BYTES}, {"sw_update", SW_UPDATE_DEV_STACK_BYTES},
      {"sw_ota", SW_UPDATE_RELEASE_STACK_BYTES},
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
