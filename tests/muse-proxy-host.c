#include "test-platform.h"
#include "sw_muse_proxy.c"
#include <assert.h>
#include <stdarg.h>

#undef free

static const char *response;
static size_t response_used, response_size, sent_bytes;
static int closes, allocations, allocation_fail, send_limit, socket_error;
static int would_block_reads, would_block_writes, reject_wait, connect_pending;
static int64_t clock_us;
static proxy_config_t stored;
static int has_record, commits, nvs_error;
static unsigned failure_stage, failure_status;
static int failure_errno;

void proxy_test_warn(const char *tag, const char *format, ...) {
  assert(!strcmp(tag, "sw_muse_proxy"));
  assert(!strcmp(format, "CONNECT failed stage=%u errno=%d status=%u"));
  va_list args;
  va_start(args, format);
  failure_stage = va_arg(args, unsigned);
  failure_errno = va_arg(args, int);
  failure_status = va_arg(args, unsigned);
  va_end(args);
}

void proxy_test_free(void *ptr) {
  if (ptr)
    --allocations;
  free(ptr);
}

void *heap_caps_malloc(size_t bytes, unsigned caps) {
  assert(caps == (MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  assert(bytes == PROXY_HEADER_BYTES);
  if (allocation_fail)
    return NULL;
  ++allocations;
  return malloc(bytes);
}

int64_t esp_timer_get_time(void) { return ++clock_us * 1000; }

esp_netif_t *esp_netif_get_handle_from_ifkey(const char *key) {
  assert(!strcmp(key, "WIFI_STA_DEF"));
  return (esp_netif_t *)1;
}

int esp_netif_get_ip_info(esp_netif_t *netif, esp_netif_ip_info_t *out) {
  assert(netif);
  *out = (esp_netif_ip_info_t){.ip.addr = 0x0201a8c0, .gw.addr = 0x0101a8c0};
  return ESP_OK;
}

int proxy_test_inet_pton(int family, const char *text, void *out) {
  unsigned a, b, c, d;
  char end;
  assert(family == AF_INET);
  if (sscanf(text, "%u.%u.%u.%u%c", &a, &b, &c, &d, &end) != 4 ||
      a > 255 || b > 255 || c > 255 || d > 255)
    return 0;
  ((struct in_addr *)out)->s_addr = a | b << 8 | c << 16 | d << 24;
  return 1;
}

uint32_t proxy_test_ntohl(uint32_t value) {
  return value >> 24 | (value >> 8 & 0xff00) | (value << 8 & 0xff0000) | value << 24;
}

uint16_t proxy_test_htons(uint16_t value) { return value >> 8 | value << 8; }

int proxy_test_socket(int family, int type, int protocol) {
  assert(family == AF_INET && type == SOCK_STREAM && protocol == IPPROTO_TCP);
  return 4;
}

int proxy_test_connect(int fd, const struct sockaddr *address, size_t length) {
  const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)address;
  assert(fd == 4 && length == sizeof(*ipv4));
  assert(ipv4->sin_addr.s_addr == 0x0101a8c0);
  assert(ipv4->sin_port == proxy_test_htons(7890));
  if (connect_pending) {
    errno = EINPROGRESS;
    return -1;
  }
  return 0;
}

int proxy_test_fcntl(int fd, int cmd, ...) {
  assert(fd == 4 && (cmd == F_GETFL || cmd == F_SETFL));
  return 0;
}

int proxy_test_select(int nfds, fd_set *readfds, fd_set *writefds,
                      fd_set *exceptfds, struct timeval *timeout) {
  assert(nfds == 5 && (readfds || writefds) && !exceptfds);
  assert(timeout->tv_sec >= 0 && timeout->tv_usec >= 0);
  return reject_wait ? 0 : 1;
}

int proxy_test_getsockopt(int fd, int level, int option, void *value, socklen_t *length) {
  assert(fd == 4 && level == SOL_SOCKET && option == SO_ERROR);
  assert(*length == sizeof(int));
  *(int *)value = socket_error;
  return 0;
}

int proxy_test_setsockopt(int fd, int level, int option, const void *value, size_t size) {
  assert(fd == 4 && level == SOL_SOCKET && (option == SO_RCVTIMEO || option == SO_SNDTIMEO));
  assert(value && size == sizeof(struct timeval));
  return 0;
}

ssize_t proxy_test_send(int fd, const void *data, size_t size, int flags) {
  assert(fd == 4 && data && !flags);
  if (would_block_writes-- > 0) {
    errno = EAGAIN;
    return -1;
  }
  size_t count = send_limit && size > (size_t)send_limit ? (size_t)send_limit : size;
  sent_bytes += count;
  return (ssize_t)count;
}

ssize_t proxy_test_recv(int fd, void *data, size_t size, int flags) {
  assert(fd == 4 && size == 1 && !flags);
  if (would_block_reads-- > 0) {
    errno = EAGAIN;
    return -1;
  }
  if (response_used == response_size)
    return 0;
  *(char *)data = response[response_used++];
  return 1;
}

int proxy_test_close(int fd) {
  assert(fd == 4);
  ++closes;
  return 0;
}

int nvs_open(const char *space, int mode, nvs_handle_t *handle) {
  assert(!strcmp(space, "sw_muse_proxy"));
  assert(mode == NVS_READONLY || mode == NVS_READWRITE);
  *handle = 7;
  return nvs_error;
}

int nvs_get_blob(nvs_handle_t handle, const char *key, void *out, size_t *size) {
  assert(handle == 7 && !strcmp(key, "endpoint") && *size == sizeof(stored));
  if (!has_record)
    return -1;
  memcpy(out, &stored, sizeof(stored));
  return ESP_OK;
}

int nvs_set_blob(nvs_handle_t handle, const char *key, const void *data, size_t size) {
  assert(handle == 7 && !strcmp(key, "endpoint") && size == sizeof(stored));
  memcpy(&stored, data, size);
  has_record = 1;
  return ESP_OK;
}

int nvs_erase_all(nvs_handle_t handle) {
  assert(handle == 7);
  has_record = 0;
  return ESP_OK;
}

int nvs_commit(nvs_handle_t handle) {
  assert(handle == 7);
  ++commits;
  return ESP_OK;
}

void nvs_close(nvs_handle_t handle) { assert(handle == 7); }

static void reset_io(const char *input, size_t size) {
  response = input;
  response_size = size;
  response_used = sent_bytes = 0;
  closes = allocation_fail = socket_error = reject_wait = 0;
  would_block_reads = would_block_writes = 0;
  connect_pending = 1;
  send_limit = 3;
  clock_us = 0;
  failure_stage = failure_status = 0;
  errno = 0;
  assert(allocations == 0);
}

static void rejected(const char *input, size_t size, int expected_errno) {
  reset_io(input, size);
  int fd = 99;
  assert(sw_muse_proxy_connect("api.muse.ai", 11, 443, 15000, &fd) != ESP_OK);
  assert(fd == -1 && closes == 1 && allocations == 0 && errno == expected_errno);
}

int main(void) {
  sw_muse_proxy_init();
  assert(!sw_muse_proxy_enabled());
  assert(sw_muse_proxy_set("@gateway", 7890) == ESP_OK);
  assert(commits == 1 && sw_muse_proxy_enabled() && sw_muse_proxy_endpoint_ready());
  assert(sw_muse_proxy_applies("api.muse.ai", 11, 443));
  assert(sw_muse_proxy_applies("hatch.metaaivm.com", strlen("hatch.metaaivm.com"), 443));
  assert(sw_muse_proxy_applies("dynamic-123.metaaivm.com", strlen("dynamic-123.metaaivm.com"), 443));
  assert(sw_muse_proxy_applies("API.MUSE.AI", 11, 443));
  assert(!sw_muse_proxy_applies("api.muse.ai.evil.com", 20, 443));
  assert(!sw_muse_proxy_applies("evilmetaaivm.com", 15, 443));
  assert(!sw_muse_proxy_applies("api.muse.ai", 11, 80));
  assert(!sw_muse_proxy_applies("10.0.0.1", 8, 443));
  assert(!sw_muse_proxy_applies("api.muse.ai\r\n", 13, 443));
  assert(!sw_muse_proxy_applies("api.muse.ai\0x", 13, 443));
  assert(sw_muse_proxy_set("example.com", 7890) == ESP_ERR_INVALID_ARG);
  assert(sw_muse_proxy_set("8.8.8.8", 7890) == ESP_ERR_INVALID_ARG);
  assert(sw_muse_proxy_set("@gateway", 0) == ESP_ERR_INVALID_ARG);

  const char valid[] = "HTTP/1.1 200 Connection established\r\nProxy-Agent: test\r\n\r\nTLS";
  reset_io(valid, sizeof(valid) - 1);
  would_block_reads = would_block_writes = 1;
  int fd = -1;
  assert(sw_muse_proxy_connect("api.muse.ai", 11, 443, 15000, &fd) == ESP_OK);
  assert(fd == 4 && closes == 0 && allocations == 0);
  assert(sent_bytes == strlen("CONNECT api.muse.ai:443 HTTP/1.1\r\nHost: api.muse.ai:443\r\n\r\n"));
  assert(response_used == sizeof(valid) - 4 && !memcmp(response + response_used, "TLS", 3));

  const char denied[] = "HTTP/1.1 407 Authentication required\r\n\r\n";
  rejected(denied, sizeof(denied) - 1, EACCES);
  assert(failure_stage == 8 && failure_status == 407 && failure_errno == EACCES);
  const char incomplete[] = "HTTP/1.1 200 Connection";
  rejected(incomplete, sizeof(incomplete) - 1, ECONNRESET);
  const char invalid[] = "HTTP/1.1 2000 INVALID\r\n\r\n";
  rejected(invalid, sizeof(invalid) - 1, EACCES);
  char oversized[1024];
  memset(oversized, 'a', sizeof(oversized));
  rejected(oversized, sizeof(oversized), EMSGSIZE);

  reset_io(valid, sizeof(valid) - 1);
  reject_wait = 1;
  assert(sw_muse_proxy_connect("api.muse.ai", 11, 443, 15000, &fd) != ESP_OK);
  assert(fd == -1 && closes == 1 && allocations == 0 && errno == ETIMEDOUT);
  assert(failure_stage == 6 && failure_status == 0 && failure_errno == ETIMEDOUT);
  reset_io(valid, sizeof(valid) - 1);
  socket_error = ECONNREFUSED;
  assert(sw_muse_proxy_connect("api.muse.ai", 11, 443, 15000, &fd) != ESP_OK);
  assert(fd == -1 && closes == 1 && allocations == 0 && errno == ECONNREFUSED);
  reset_io(valid, sizeof(valid) - 1);
  allocation_fail = 1;
  assert(sw_muse_proxy_connect("api.muse.ai", 11, 443, 15000, &fd) == ESP_ERR_NO_MEM);
  assert(fd == -1 && closes == 0 && allocations == 0 && errno == ENOMEM);

  publish((proxy_config_t){0});
  sw_muse_proxy_init();
  assert(sw_muse_proxy_enabled());
  nvs_error = ESP_FAIL;
  assert(sw_muse_proxy_clear() == ESP_FAIL && sw_muse_proxy_enabled());
  nvs_error = ESP_OK;
  assert(sw_muse_proxy_clear() == ESP_OK && !sw_muse_proxy_enabled());
  assert(!sw_muse_proxy_applies("api.muse.ai", 11, 443));
  assert(!sw_muse_proxy_endpoint_ready());
  puts("Muse CONNECT host checks passed");
  return 0;
}
