#pragma once
#include "lvgl.h"
#include "sw_model.h"

lv_obj_t *sw_miao_init(lv_obj_t *parent);
void sw_miao_state(sw_task_t state, uint32_t task);
void sw_miao_play(bool active, bool charging);
void sw_miao_still(void);
const char *sw_miao_layout(void);
const char *sw_miao_embedded_hash(void);
bool sw_miao_validate_pack(const uint8_t *data, size_t size,
                           bool (*can_continue)(void));
/* Transfer ownership to LVGL. NULL selects the embedded pack. */
void sw_miao_offer_pack(uint8_t *data);
unsigned sw_miao_verify_embedded(void);
unsigned sw_miao_frames_drawn(void);
