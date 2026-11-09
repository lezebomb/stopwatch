#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef struct {
  uint32_t check_s, reconnect_s, retry_s, max_retry_s, stable_s, idle_s;
  int min_battery;
} sw_update_policy_t;
typedef struct {
  uint64_t now, last_check, next_attempt;
  bool online, charging, busy, manual, reconnected;
  int battery;
  uint32_t stable_s, idle_s;
} sw_update_conditions_t;
typedef enum { SW_UP_WAIT, SW_UP_CHECK, SW_UP_INSTALL } sw_update_action_t;
sw_update_policy_t sw_update_defaults(void);
sw_update_action_t sw_update_decide(sw_update_policy_t p,
                                    sw_update_conditions_t c);
uint32_t sw_update_backoff(sw_update_policy_t p, unsigned failures,
                           unsigned jitter);
int sw_update_version(const char *a, const char *b); /* -2 invalid, -1/0/1 */
typedef struct {
  void *ctx;
  int (*begin)(void *, size_t);
  int (*write)(void *, const void *, size_t);
  int (*end_verify_signature)(void *);
  int (*activate)(void *);
  void (*abort)(void *);
} sw_update_ops_t;
typedef struct {
  sw_update_ops_t ops;
  size_t expected, received;
  bool begun, finished;
} sw_update_stream_t;
int sw_update_stream_begin(sw_update_stream_t *s, sw_update_ops_t ops,
                           size_t expected, size_t slot_size);
int sw_update_stream_write(sw_update_stream_t *s, const void *bytes,
                           size_t length);
int sw_update_stream_finish(sw_update_stream_t *s,
                            const uint8_t expected_hash[32],
                            const uint8_t actual_hash[32]);
void sw_update_stream_abort(sw_update_stream_t *s);
