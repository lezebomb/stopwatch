#pragma once
#include "lvgl.h"
#include "sw_model.h"

lv_obj_t *sw_miao_init(lv_obj_t *parent);
void sw_miao_state(sw_task_t state, uint32_t task);
void sw_miao_play(bool active, bool charging);
void sw_miao_still(void);
