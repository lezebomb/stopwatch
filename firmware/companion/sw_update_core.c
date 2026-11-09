#include "sw_update_core.h"
#include <string.h>
sw_update_policy_t sw_update_defaults(void) {
  return (sw_update_policy_t){21600, 1800, 60, 21600, 60, 30, 40};
}
sw_update_action_t sw_update_decide(sw_update_policy_t p,
                                    sw_update_conditions_t c) {
  if (!c.online || c.busy || c.stable_s < p.stable_s || c.now < c.next_attempt)
    return SW_UP_WAIT;
  if (!c.manual && !c.charging && !c.reconnected)
    return SW_UP_WAIT;
  if (!c.manual && !c.next_attempt && c.last_check &&
      c.now - c.last_check < (c.reconnected ? p.reconnect_s : p.check_s))
    return SW_UP_WAIT;
  return c.charging && c.battery >= p.min_battery && c.idle_s >= p.idle_s
             ? SW_UP_INSTALL
             : SW_UP_CHECK;
}
uint32_t sw_update_backoff(sw_update_policy_t p, unsigned failures,
                           unsigned jitter) {
  uint64_t d = p.retry_s;
  for (unsigned i = 1; i < failures && d < p.max_retry_s; i++)
    d *= 2;
  if (d > p.max_retry_s)
    d = p.max_retry_s;
  return (uint32_t)d + (jitter % 31);
}
static bool parse_version(const char *s, unsigned out[3]) {
  if (!s)
    return false;
  for (int i = 0; i < 3; i++) {
    unsigned v = 0, n = 0;
    while (*s >= '0' && *s <= '9') {
      if (++n > 5)
        return false;
      v = v * 10 + (unsigned)(*s++ - '0');
    }
    if (!n)
      return false;
    out[i] = v;
    if (i < 2) {
      if (*s++ != '.')
        return false;
    } else if (*s)
      return false;
  }
  return true;
}
int sw_update_version(const char *a, const char *b) {
  unsigned x[3], y[3];
  if (!parse_version(a, x) || !parse_version(b, y))
    return -2;
  for (int i = 0; i < 3; i++)
    if (x[i] != y[i])
      return x[i] > y[i] ? 1 : -1;
  return 0;
}
int sw_update_stream_begin(sw_update_stream_t *s, sw_update_ops_t ops,
                           size_t expected, size_t slot_size) {
  if (!s || !expected || expected > slot_size || !ops.begin || !ops.write ||
      !ops.end_verify_signature || !ops.activate || !ops.abort)
    return -1;
  *s = (sw_update_stream_t){.ops = ops, .expected = expected};
  if (ops.begin(ops.ctx, expected))
    return -1;
  s->begun = true;
  return 0;
}
void sw_update_stream_abort(sw_update_stream_t *s) {
  if (s && s->begun && !s->finished) {
    s->ops.abort(s->ops.ctx);
    s->finished = true;
  }
}
int sw_update_stream_write(sw_update_stream_t *s, const void *bytes,
                           size_t length) {
  if (!s || !s->begun || s->finished || length > s->expected - s->received)
    return -1;
  if (s->ops.write(s->ops.ctx, bytes, length)) {
    sw_update_stream_abort(s);
    return -1;
  }
  s->received += length;
  return 0;
}
int sw_update_stream_finish(sw_update_stream_t *s, const uint8_t expected[32],
                            const uint8_t actual[32]) {
  if (!s || !s->begun || s->finished)
    return -1;
  unsigned diff = 0;
  for (unsigned i = 0; i < 32; i++)
    diff |= expected[i] ^ actual[i];
  if (s->received != s->expected || diff) {
    sw_update_stream_abort(s);
    return -1;
  }
  s->finished = true; /* esp_ota_end consumes its handle even on failure. */
  if (s->ops.end_verify_signature(s->ops.ctx))
    return -1;
  return s->ops.activate(s->ops.ctx) ? -1 : 0;
}
