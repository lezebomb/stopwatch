#include "sw_miao.h"
#include "esp_heap_caps.h"
#include "esp_random.h"
#include "muse_state.h"
#include "muse_voice.h"
#include "src/misc/cache/instance/lv_image_cache.h"
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

typedef struct {
  uint8_t frame;
  uint16_t ms;
} miao_step_t;
typedef struct {
  const miao_step_t *steps;
  uint8_t count, repeat, loop;
  int8_t outro;
} miao_action_t;
typedef struct {
  int8_t first, second;
} miao_mapping_t;
typedef struct {
  uint8_t action, weight;
} miao_weight_t;
#include "miao_data.h"

#define FRAME_BYTES (MIAO_WIDTH * MIAO_HEIGHT * 3u)
#define SCRATCH_LIMIT (48u * 1024u)
extern const uint8_t pack[] asm("_binary_sw_miao_pack_bin_start");
extern const uint8_t pack_end[] asm("_binary_sw_miao_pack_bin_end");
extern const uint8_t idle[] asm("_binary_sw_miao_idle_bin_start");

static const lv_image_dsc_t still = {
    .header = {.magic = LV_IMAGE_HEADER_MAGIC,
               .cf = LV_COLOR_FORMAT_RGB565A8,
               .w = MIAO_WIDTH,
               .h = MIAO_HEIGHT,
               .stride = MIAO_WIDTH * 2},
    .data_size = FRAME_BYTES,
    .data = idle,
};
static lv_image_dsc_t frame;
static lv_obj_t *image;
static lv_timer_t *timer;
static uint8_t *pixels;
static bool pack_ok, active, charging;
static sw_task_t state = SW_OFFLINE;
static sw_task_t last_terminal = SW_OFFLINE;
static uint32_t terminal_key;
static uint32_t task_key, due, wash_due, tap_at;
static unsigned step, repetition, shown = UINT32_MAX;
static int action = -1;
static bool alternate, reaction;
static lv_point_t touch_origin;
static _Atomic(const uint8_t *) offered;
static atomic_uint frames_drawn;
static const uint8_t *selected = pack;

const char *sw_miao_layout(void) { return MIAO_LAYOUT_SHA256; }
const char *sw_miao_embedded_hash(void) { return MIAO_EMBEDDED_SHA256; }

static void release_pack(const uint8_t *data) {
  if (data && data != pack)
    free((void *)data);
}
void sw_miao_offer_pack(uint8_t *data) {
  release_pack(atomic_exchange(&offered, data ? data : pack));
}

static uint32_t le(const uint8_t *p, unsigned bytes) {
  uint32_t value = 0;
  for (unsigned i = 0; i < bytes; i++)
    value |= (uint32_t)p[i] << (8 * i);
  return value;
}

static bool valid_pack(const uint8_t *data, size_t size) {
  const size_t table = 12 + MIAO_COUNT * 8;
  if (size < table || size > MIAO_BUDGET - FRAME_BYTES ||
      memcmp(data, "MIA1", 4) || le(data + 4, 2) != MIAO_WIDTH ||
      le(data + 6, 2) != MIAO_HEIGHT || le(data + 8, 2) != MIAO_COUNT ||
      le(data + 10, 2))
    return false;
  size_t offset = table;
  for (unsigned i = 0; i < MIAO_COUNT; i++) {
    size_t length = le(data + 16 + i * 8, 4);
    if (le(data + 12 + i * 8, 4) != offset || !length || length > size - offset)
      return false;
    offset += length;
  }
  return offset == size;
}

static voidpf scratch_alloc(voidpf context, uInt items, uInt size) {
  size_t *used = context;
  if (!size || items > (SCRATCH_LIMIT - *used) / size)
    return NULL;
  size_t bytes = (size_t)items * size;
  void *memory =
      heap_caps_calloc(1, bytes, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (memory)
    *used += bytes;
  return memory;
}
static void scratch_free(voidpf ignored, voidpf memory) {
  (void)ignored;
  free(memory);
}

static bool decode(const uint8_t *data, unsigned index, uint8_t *output) {
  size_t used = 0;
  const uint8_t *entry = data + 12 + index * 8;
  z_stream stream = {.zalloc = scratch_alloc,
                     .zfree = scratch_free,
                     .opaque = &used,
                     .next_in = (Bytef *)(data + le(entry, 4)),
                     .avail_in = le(entry + 4, 4),
                     .next_out = output,
                     .avail_out = FRAME_BYTES};
  if (inflateInit(&stream) != Z_OK)
    return false;
  bool ok = inflate(&stream, Z_FINISH) == Z_STREAM_END &&
            stream.total_out == FRAME_BYTES && !stream.avail_in;
  inflateEnd(&stream);
  return ok;
}

bool sw_miao_validate_pack(const uint8_t *data, size_t size,
                           bool (*can_continue)(void)) {
  if (!valid_pack(data, size))
    return false;
  uint8_t *output =
      heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!output)
    return false;
  bool ok = true;
  for (unsigned i = 0; ok && i < MIAO_COUNT; i++)
    ok = (!can_continue || can_continue()) && decode(data, i, output);
  free(output);
  return ok;
}

unsigned sw_miao_verify_embedded(void) {
  return sw_miao_validate_pack(pack, (size_t)(pack_end - pack), NULL)
             ? MIAO_COUNT
             : 0;
}
unsigned sw_miao_frames_drawn(void) { return atomic_load(&frames_drawn); }

static void display(unsigned index) {
  if (shown == index)
    return;
  shown = index;
  if ((!index && selected == pack) || !pack_ok) {
    lv_image_set_src(image, &still);
    return;
  }
  if (!pixels)
    pixels = heap_caps_malloc(FRAME_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!pixels) {
    pack_ok = false;
    lv_image_set_src(image, &still);
    return;
  }
  pack_ok = decode(selected, index, pixels);
  if (!pack_ok) {
    lv_image_set_src(image, &still);
    return;
  }
  frame = still;
  frame.data = pixels;
  lv_image_cache_drop(&frame);
  lv_image_set_src(image, &frame);
  lv_obj_invalidate(image);
  atomic_fetch_add(&frames_drawn, 1);
}

static unsigned between(unsigned min, unsigned max) {
  return min + esp_random() % (max - min + 1);
}
static int choose(const miao_weight_t *weights, unsigned count) {
  unsigned value = esp_random() % 100;
  for (unsigned i = 0; i < count; i++) {
    if (value < weights[i].weight)
      return weights[i].action;
    value -= weights[i].weight;
  }
  return weights[count - 1].action;
}
static void start(int next, uint32_t now) {
  action = next;
  repetition = step = 0;
  due = now;
}
static void rest(uint32_t now) {
  start(-1, now);
  display(0);
  due += between(MIAO_IDLE_MIN, MIAO_IDLE_MAX) * (charging ? 1 : 3);
}
static bool can_draw(void) {
  muse_mode_t mode = muse_state_mode(NULL);
  return active && !muse_state_asleep() && !muse_voice_in_call() &&
         mode != MUSE_MODE_LISTENING && mode != MUSE_MODE_THINKING &&
         mode != MUSE_MODE_SPEAKING;
}
static void next_frame(lv_timer_t *timer_arg) {
  (void)timer_arg;
  uint32_t now = lv_tick_get();
  if (!can_draw() || !pack_ok || (int32_t)(now - due) < 0)
    return;
  if (action < 0) {
    if (state == SW_APPROVAL)
      return;
    if (state == SW_THINKING || state == SW_WORKING || state == SW_TESTING) {
      const miao_mapping_t *choice = &mapping[state];
      start(alternate && choice->second >= 0 ? choice->second : choice->first,
            now);
      alternate = !alternate;
    } else if (charging && (int32_t)(now - wash_due) >= 0) {
      wash_due = now + between(MIAO_WASH_MIN, MIAO_WASH_MAX);
      if (esp_random() % 100 < MIAO_WASH_CHANCE)
        start(MIAO_WASH_FACE, now);
    }
    if (action < 0)
      start(choose(idle_choices, sizeof(idle_choices) / sizeof(*idle_choices)),
            now);
  }
  const miao_action_t *clip = &actions[action];
  if (step >= clip->count) {
    if (++repetition < clip->repeat) {
      step = 0;
    } else if (clip->outro >= 0) {
      start(clip->outro, now);
      clip = &actions[action];
    } else if (clip->loop && state == SW_TESTING && !reaction) {
      alternate = !alternate;
      start(alternate ? mapping[state].second : mapping[state].first, now);
      clip = &actions[action];
    } else {
      reaction = false;
      rest(now);
      return;
    }
  }
  miao_step_t current = clip->steps[step++];
  display(current.frame);
  if (now - due > 100)
    due = now;
  due += !charging && current.ms < 180 ? 180 : current.ms;
}

static void touch(lv_event_t *event) {
  lv_indev_t *input = lv_indev_active();
  if (!input)
    return;
  if (lv_event_get_code(event) == LV_EVENT_PRESSED) {
    lv_indev_get_point(input, &touch_origin);
    return;
  }
  lv_point_t point;
  lv_indev_get_point(input, &point);
  uint32_t now = lv_tick_get();
  if (abs(point.x - touch_origin.x) > 12 ||
      abs(point.y - touch_origin.y) > 12 || !can_draw() || action >= 0 ||
      (tap_at && now - tap_at < MIAO_TAP_COOLDOWN))
    return;
  tap_at = now;
  reaction = true;
  muse_state_poke();
  start(choose(touch_choices, sizeof(touch_choices) / sizeof(*touch_choices)),
        now);
}

lv_obj_t *sw_miao_init(lv_obj_t *parent) {
  image = lv_image_create(parent);
  lv_image_set_src(image, &still);
  lv_obj_add_flag(image, LV_OBJ_FLAG_CLICKABLE | LV_OBJ_FLAG_GESTURE_BUBBLE);
  lv_obj_add_event_cb(image, touch, LV_EVENT_PRESSED, NULL);
  lv_obj_add_event_cb(image, touch, LV_EVENT_SHORT_CLICKED, NULL);
  pack_ok = valid_pack(pack, (size_t)(pack_end - pack));
  timer = lv_timer_create(next_frame, 32, NULL);
  if (timer)
    lv_timer_pause(timer);
  wash_due = lv_tick_get() + between(MIAO_WASH_MIN, MIAO_WASH_MAX);
  rest(lv_tick_get());
  return image;
}
void sw_miao_state(sw_task_t next, uint32_t key) {
  if (next == state && key == task_key)
    return;
  state = next;
  task_key = key;
  alternate = reaction = false;
  uint32_t now = lv_tick_get();
  bool terminal = next == SW_COMPLETED || next == SW_FAILED;
  if (mapping[next].first == MIAO_IDLE ||
      (terminal && last_terminal == next && terminal_key == key))
    rest(now);
  else {
    if (terminal) {
      last_terminal = next;
      terminal_key = key;
    }
    alternate = next == SW_THINKING;
    start(mapping[next].first, now);
  }
}
void sw_miao_play(bool enabled, bool external) {
  charging = external;
  bool changed = active != enabled;
  active = enabled;
  const uint8_t *next = can_draw() ? atomic_exchange(&offered, NULL) : NULL;
  if (next) {
    release_pack(selected);
    selected = next;
    pack_ok = true;
    shown = UINT32_MAX;
    display(action < 0 ? 0 : actions[action].steps[step ? step - 1 : 0].frame);
  }
  if (changed && timer) {
    if (active)
      lv_timer_resume(timer);
    else
      lv_timer_pause(timer);
  }
}
void sw_miao_still(void) { display(0); }
