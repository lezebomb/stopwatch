#pragma once

#include "sdkconfig.h"
#include "sw_update_build.h"

#define SW_RELAY_STACK_BYTES 8192
#define SW_PHOTO_STACK_BYTES 4096
#define SW_UPDATE_DEV_STACK_BYTES 4096
#define SW_UPDATE_RELEASE_STACK_BYTES 14336

/* Keep the SDK's header capacity and cross IDF's malloc PSRAM threshold. */
#define SW_VM_HTTP_BUFFER_BYTES 4112
void sw_memory_status(int id);
#if !CONFIG_SPIRAM_USE_MALLOC || CONFIG_SPIRAM_MALLOC_ALWAYSINTERNAL >= SW_VM_HTTP_BUFFER_BYTES
#error "Muse HTTP buffers must prefer PSRAM"
#endif

#if !SW_UPDATE_PRODUCTION
#include <stddef.h>
#include <stdint.h>

void sw_memory_mark(const char *phase, int result, int detail, int flags);
void sw_memory_target(const char *url);
void sw_memory_tasks(void);
void sw_memory_http_probe(void);
void sw_memory_dma_begin(unsigned stage);
void sw_memory_dma_end(int result);
void sw_memory_dma_dump(void);
void *sw_memory_i2s_calloc(size_t count, size_t size, uint32_t caps);
void *sw_memory_i2s_aligned_calloc(size_t alignment, size_t count, size_t size,
                                   uint32_t caps);
#else
#define sw_memory_mark(phase, result, detail, flags) ((void)0)
#define sw_memory_target(url) ((void)0)
#endif
