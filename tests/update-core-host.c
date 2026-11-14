#include "sw_update_core.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
typedef struct {
  unsigned began, written, ended, activated, aborted;
  bool signature_ok;
} mock_t;
static int begin(void *p, size_t n) {
  (void)n;
  ((mock_t *)p)->began++;
  return 0;
}
static int write_bytes(void *p, const void *b, size_t n) {
  (void)b;
  ((mock_t *)p)->written += (unsigned)n;
  return 0;
}
static int end(void *p) {
  mock_t *m = p;
  m->ended++;
  return m->signature_ok ? 0 : -1;
}
static int activate(void *p) {
  ((mock_t *)p)->activated++;
  return 0;
}
static void abort_update(void *p) { ((mock_t *)p)->aborted++; }
static sw_update_ops_t ops(mock_t *m) {
  return (sw_update_ops_t){m, begin, write_bytes, end, activate, abort_update};
}
int main(void) {
  assert(!sw_update_install_authorized(false, "", "0.2.2"));
  assert(!sw_update_install_authorized(false, "0.2.1", "0.2.2"));
  assert(!sw_update_install_authorized(false, "garbage", "garbage"));
  assert(sw_update_install_authorized(false, "0.2.2", "0.2.2"));
  assert(sw_update_install_authorized(true, "", "0.2.2"));
  sw_update_policy_t p = sw_update_defaults();
  sw_update_conditions_t c = {.now = 10000,
                              .online = true,
                              .charging = true,
                              .battery = 70,
                              .stable_s = 61,
                              .idle_s = 31};
  assert(sw_update_decide(p, c) == SW_UP_INSTALL);
  c.busy = true;
  assert(sw_update_decide(p, c) == SW_UP_WAIT);
  c.busy = false;
  c.charging = false;
  assert(sw_update_decide(p, c) == SW_UP_WAIT);
  c.reconnected = true;
  assert(sw_update_decide(p, c) == SW_UP_CHECK);
  c.next_attempt = 10001;
  assert(sw_update_decide(p, c) == SW_UP_WAIT);
  c.next_attempt = 9999;
  c.last_check = 9999;
  assert(sw_update_decide(p, c) == SW_UP_CHECK);
  assert(sw_update_backoff(p, 1, 0) == 60);
  assert(sw_update_backoff(p, 20, 0) == 21600);
  assert(sw_update_version("0.2.1", "0.2.0") == 1);
  assert(sw_update_version("1.0.0evil", "0.2.0") == -2);
  assert(sw_update_version("999999.0.0", "0.2.0") == -2);
  uint8_t hash[32] = {1}, bad[32] = {2};
  sw_update_stream_t stream;
  mock_t m = {.signature_ok = true};
  assert(sw_update_stream_begin(&stream, ops(&m), 4, 4) == 0);
  assert(sw_update_stream_write(&stream, "data", 4) == 0);
  assert(sw_update_stream_finish(&stream, hash, hash) == 0);
  assert(m.ended == 1 && m.activated == 1 && !m.aborted);
  m = (mock_t){.signature_ok = true};
  assert(sw_update_stream_begin(&stream, ops(&m), 4, 4) == 0);
  sw_update_stream_write(&stream, "data", 4);
  assert(sw_update_stream_finish(&stream, hash, bad));
  assert(m.aborted == 1 && !m.ended && !m.activated);
  m = (mock_t){.signature_ok = false};
  sw_update_stream_begin(&stream, ops(&m), 4, 4);
  sw_update_stream_write(&stream, "data", 4);
  assert(sw_update_stream_finish(&stream, hash, hash));
  assert(m.ended == 1 && !m.activated && !m.aborted);
  m = (mock_t){.signature_ok = true};
  sw_update_stream_begin(&stream, ops(&m), 4, 4);
  sw_update_stream_write(&stream, "da", 2);
  assert(sw_update_stream_finish(&stream, hash, hash));
  assert(m.aborted == 1 && !m.activated);
  assert(sw_update_stream_begin(&stream, ops(&m), 5, 4));
  puts("C OTA policy and official-operation adapter order passed");
  return 0;
}
