#include "sw_muse_proxy.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "nvs.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define PROXY_NAMESPACE "sw_muse_proxy"
#define PROXY_HEADER_BYTES 1024
#define PROXY_TIMEOUT_MS 15000

typedef struct {
  char host[16];
  uint16_t port;
} proxy_config_t;

static portMUX_TYPE config_lock = portMUX_INITIALIZER_UNLOCKED;
static proxy_config_t config;

/* Stages identify argument, endpoint, buffer, socket, flags, TCP, write,
 * response and final socket setup failures. Destinations and headers stay out
 * of logs. Preserve errno because ESP-TLS records it after this call. */
static esp_err_t failed(unsigned stage, int error, unsigned status,
                         esp_err_t result) {
  ESP_LOGW("sw_muse_proxy", "CONNECT failed stage=%u errno=%d status=%u",
           stage, error, status);
  errno = error;
  return result;
}

static proxy_config_t snapshot(void) {
  proxy_config_t saved;
  portENTER_CRITICAL(&config_lock);
  saved = config;
  portEXIT_CRITICAL(&config_lock);
  return saved;
}

static void publish(proxy_config_t next) {
  portENTER_CRITICAL(&config_lock);
  config = next;
  portEXIT_CRITICAL(&config_lock);
}

static bool private_address(struct in_addr address) {
  uint32_t host = ntohl(address.s_addr);
  return (host >> 24) == 10 || (host >> 20) == 0xac1 ||
         (host >> 16) == 0xc0a8;
}

static bool valid_config(const proxy_config_t *saved) {
  struct in_addr address;
  return saved->port && memchr(saved->host, 0, sizeof(saved->host)) &&
         (!strcmp(saved->host, "@gateway") ||
          (inet_pton(AF_INET, saved->host, &address) == 1 &&
           private_address(address)));
}

static bool endpoint(const proxy_config_t *saved, struct sockaddr_in *out) {
  if (!valid_config(saved))
    return false;
  struct in_addr address;
  if (!strcmp(saved->host, "@gateway")) {
    esp_netif_t *sta = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    esp_netif_ip_info_t ip;
    if (!sta || esp_netif_get_ip_info(sta, &ip) != ESP_OK || !ip.ip.addr)
      return false;
    address.s_addr = ip.gw.addr;
  } else if (inet_pton(AF_INET, saved->host, &address) != 1) {
    return false;
  }
  if (!private_address(address))
    return false;
  *out = (struct sockaddr_in){.sin_family = AF_INET,
                              .sin_port = htons(saved->port),
                              .sin_addr = address};
  return true;
}

void sw_muse_proxy_init(void) {
  nvs_handle_t handle;
  proxy_config_t saved = {0};
  if (nvs_open(PROXY_NAMESPACE, NVS_READONLY, &handle) != ESP_OK)
    return;
  size_t size = sizeof(saved);
  bool ok = nvs_get_blob(handle, "endpoint", &saved, &size) == ESP_OK &&
            size == sizeof(saved) &&
            valid_config(&saved);
  nvs_close(handle);
  if (ok)
    publish(saved);
}

esp_err_t sw_muse_proxy_set(const char *host, uint16_t port) {
  if (!host || strlen(host) >= sizeof(config.host))
    return ESP_ERR_INVALID_ARG;
  proxy_config_t next = {.port = port};
  memcpy(next.host, host, strlen(host) + 1);
  if (!valid_config(&next))
    return ESP_ERR_INVALID_ARG;
  nvs_handle_t handle;
  esp_err_t result = nvs_open(PROXY_NAMESPACE, NVS_READWRITE, &handle);
  if (result != ESP_OK)
    return result;
  result = nvs_set_blob(handle, "endpoint", &next, sizeof(next));
  if (result == ESP_OK)
    result = nvs_commit(handle);
  nvs_close(handle);
  if (result == ESP_OK)
    publish(next);
  return result;
}

esp_err_t sw_muse_proxy_clear(void) {
  nvs_handle_t handle;
  esp_err_t result = nvs_open(PROXY_NAMESPACE, NVS_READWRITE, &handle);
  if (result != ESP_OK)
    return result;
  result = nvs_erase_all(handle);
  if (result == ESP_OK)
    result = nvs_commit(handle);
  nvs_close(handle);
  if (result == ESP_OK)
    publish((proxy_config_t){0});
  return result;
}

bool sw_muse_proxy_enabled(void) { return snapshot().port != 0; }

bool sw_muse_proxy_endpoint_ready(void) {
  proxy_config_t saved = snapshot();
  struct sockaddr_in address;
  return endpoint(&saved, &address);
}

static bool muse_host(const char *host, int length, int port) {
  if (!host || length <= 0 || length > 253 || port != 443)
    return false;
  for (int i = 0; i < length; ++i) {
    unsigned char c = host[i];
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '.'))
      return false;
  }
  const char *suffixes[] = {".muse.ai", ".metaaivm.com"};
  for (size_t i = 0; i < sizeof(suffixes) / sizeof(suffixes[0]); ++i) {
    size_t tail = strlen(suffixes[i]);
    if ((size_t)length > tail &&
        !strncasecmp(host + length - tail, suffixes[i], tail))
      return true;
  }
  return false;
}

bool sw_muse_proxy_applies(const char *host, int hostlen, int port) {
  return sw_muse_proxy_enabled() && muse_host(host, hostlen, port);
}

static bool wait_socket(int fd, bool writing, int64_t deadline) {
  for (;;) {
    int64_t remaining = deadline - esp_timer_get_time();
    if (remaining <= 0) {
      errno = ETIMEDOUT;
      return false;
    }
    struct timeval timeout = {.tv_sec = remaining / 1000000,
                               .tv_usec = remaining % 1000000};
    fd_set pending;
    FD_ZERO(&pending);
    FD_SET(fd, &pending);
    int ready = select(fd + 1, writing ? NULL : &pending,
                        writing ? &pending : NULL, NULL, &timeout);
    if (ready > 0)
      return true;
    if (ready == 0) {
      errno = ETIMEDOUT;
      return false;
    }
    if (errno != EINTR)
      return false;
  }
}

static bool send_request(int fd, const char *data, size_t size, int64_t deadline) {
  size_t sent = 0;
  while (sent < size) {
    if (!wait_socket(fd, true, deadline))
      return false;
    ssize_t count = send(fd, data + sent, size - sent, 0);
    if (count > 0)
      sent += (size_t)count;
    else if (count == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR))
      return false;
  }
  return true;
}

static bool read_response(int fd, char *data, int64_t deadline, unsigned *status) {
  size_t used = 0;
  while (used < PROXY_HEADER_BYTES - 1) {
    if (!wait_socket(fd, false, deadline))
      return false;
    /* Never consume bytes beyond the CONNECT header into the TLS stream. */
    ssize_t count = recv(fd, data + used, 1, 0);
    if (count == 0) {
      errno = ECONNRESET;
      return false;
    }
    if (count < 0) {
      if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
        continue;
      return false;
    }
    if (data[used] == '\0') {
      errno = EPROTO;
      return false;
    }
    ++used;
    if (used >= 4 && !memcmp(data + used - 4, "\r\n\r\n", 4)) {
      data[used] = 0;
      if (used >= 12 &&
          (!memcmp(data, "HTTP/1.0 ", 9) || !memcmp(data, "HTTP/1.1 ", 9)) &&
          data[9] >= '0' && data[9] <= '9' &&
          data[10] >= '0' && data[10] <= '9' &&
          data[11] >= '0' && data[11] <= '9')
        *status = (unsigned)(data[9] - '0') * 100 +
                  (unsigned)(data[10] - '0') * 10 + (unsigned)(data[11] - '0');
      if (used >= 16 &&
          (!memcmp(data, "HTTP/1.0 200 ", 13) ||
           !memcmp(data, "HTTP/1.1 200 ", 13)))
        return true;
      errno = EACCES;
      return false;
    }
  }
  errno = EMSGSIZE;
  return false;
}

esp_err_t sw_muse_proxy_connect(const char *host, int hostlen, int port,
                                int timeout_ms, int *sockfd) {
  if (!sockfd || !muse_host(host, hostlen, port)) {
    return failed(1, EINVAL, 0, ESP_ERR_INVALID_ARG);
  }
  *sockfd = -1;
  proxy_config_t saved = snapshot();
  struct sockaddr_in address;
  if (!endpoint(&saved, &address)) {
    return failed(2, ENETUNREACH, 0, ESP_ERR_INVALID_STATE);
  }
  char *buffer = heap_caps_malloc(PROXY_HEADER_BYTES,
                                   MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!buffer) {
    return failed(3, ENOMEM, 0, ESP_ERR_NO_MEM);
  }
  int size = snprintf(buffer, PROXY_HEADER_BYTES,
                       "CONNECT %.*s:443 HTTP/1.1\r\nHost: %.*s:443\r\n\r\n",
                       hostlen, host, hostlen, host);
  int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (fd < 0) {
    int error = errno;
    free(buffer);
    return failed(4, error, 0, ESP_FAIL);
  }
  bool ok = false;
  unsigned stage = 5, status = 0;
  if (timeout_ms <= 0 || timeout_ms > PROXY_TIMEOUT_MS)
    timeout_ms = PROXY_TIMEOUT_MS;
  int64_t deadline = esp_timer_get_time() + (int64_t)timeout_ms * 1000;
  int flags = fcntl(fd, F_GETFL, 0);
  if (size <= 0 || size >= PROXY_HEADER_BYTES || flags < 0 ||
      fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0)
    goto done;
  stage = 6;
  if (connect(fd, (struct sockaddr *)&address, sizeof(address)) < 0) {
    if (errno != EINPROGRESS || !wait_socket(fd, true, deadline))
      goto done;
    int error = 0;
    socklen_t length = sizeof(error);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0)
      goto done;
    if (error) {
      errno = error;
      goto done;
    }
  }
  stage = 7;
  if (!send_request(fd, buffer, (size_t)size, deadline))
    goto done;
  stage = 8;
  if (!read_response(fd, buffer, deadline, &status))
    goto done;
  stage = 9;
  struct timeval timeout = {.tv_sec = timeout_ms / 1000,
                             .tv_usec = timeout_ms % 1000 * 1000};
  if (setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0 ||
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) < 0 ||
      fcntl(fd, F_SETFL, flags & ~O_NONBLOCK) < 0)
    goto done;
  *sockfd = fd;
  ok = true;
done:
  {
    int failure_errno = errno;
    if (!ok)
      close(fd);
    free(buffer);
    if (!ok)
      return failed(stage, failure_errno, status, ESP_FAIL);
  }
  return ESP_OK;
}
