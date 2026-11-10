#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>

#define SW_SYNC_PHOTO_BYTES (466u * 466u * 2u)
#define SW_SYNC_PHOTO_LIMIT 12

typedef struct {
  char id[37];
  uint8_t sha256[32];
} sw_sync_photo_t;

typedef struct {
  char message[192];
  uint8_t egg_hash[32];
  uint16_t sleep_after;
  int16_t utc_offset;
  uint8_t mode, month, day, has_egg;
} sw_display_settings_t;

typedef struct {
  unsigned count;
  sw_sync_photo_t photos[SW_SYNC_PHOTO_LIMIT];
  char cover[37];
  sw_display_settings_t display;
  bool has_display;
  unsigned slide_seconds, brightness;
  bool slideshow;
  uint8_t border; /* 0: none, 1: mint, 2: gold */
} sw_sync_album_t;

typedef enum {
  SW_SYNC_ALBUM_OK,
  SW_SYNC_ALBUM_BUSY,
  SW_SYNC_ALBUM_FULL,
  SW_SYNC_ALBUM_ERROR,
  SW_SYNC_ALBUM_AUTH,
} sw_sync_album_result_t;
typedef sw_sync_album_result_t (*sw_sync_fetch_photo)(const sw_sync_photo_t *,
                                                      FILE *, void *);
sw_sync_album_result_t sw_companion_sync_album(const sw_sync_album_t *album,
                                               sw_sync_fetch_photo fetch,
                                               void *ctx);
void sw_companion_sync_task(bool online, const char *state, const char *title,
                            const char *project, const char *id,
                            const char *error, int quota, uint64_t synced_ms);
bool sw_companion_sync_allowed(void);
bool sw_companion_pairing_open(void);
void sw_sync_start(void);
void sw_sync_focus(bool focused);
bool sw_sync_enroll(const char *code);
const char *sw_sync_state(void);
const char *sw_sync_pair_state(void);
