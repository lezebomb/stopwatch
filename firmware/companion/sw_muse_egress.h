#pragma once
#include "esp_err.h"
#include <stdbool.h>
#include <stddef.h>

bool sw_muse_egress_target(const char *host, int length, int port);
bool sw_muse_egress_ready(void);
bool sw_muse_egress_direct_due(void);
void sw_muse_egress_direct_failed(void);
esp_err_t sw_muse_egress_connect(const char *host, int length, int timeout_ms, int *fd);
void sw_muse_egress_bind(void *tls, int fd, const char *host, int length, int port);
void sw_muse_egress_bio(void *tls, void *ssl);
int sw_muse_egress_pending(void *tls);
void sw_muse_egress_result(void *tls, int result);
bool sw_muse_egress_release(void *tls);
bool sw_muse_egress_abort_fd(int fd);
void *sw_muse_egress_alloc(size_t size, bool *handled);
void sw_muse_egress_status(int id);
