#pragma once

#include "esp_err.h"
#include <stdbool.h>
#include <stdint.h>

/* Optional HTTP CONNECT through a trusted phone or router on the local WLAN.
 * The proxy transports the original Muse TLS connection, including SNI. */
void sw_muse_proxy_init(void);
esp_err_t sw_muse_proxy_set(const char *host, uint16_t port);
esp_err_t sw_muse_proxy_clear(void);
bool sw_muse_proxy_enabled(void);
bool sw_muse_proxy_endpoint_ready(void);
bool sw_muse_proxy_applies(const char *host, int hostlen, int port);
esp_err_t sw_muse_proxy_connect(const char *host, int hostlen, int port,
                                int timeout_ms, int *sockfd);
