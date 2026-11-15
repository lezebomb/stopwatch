#pragma once
#include <stdbool.h>
void sw_phone_open(void);
void sw_phone_close(void);
bool sw_phone_active(void);
bool sw_phone_ref(char out[65]);
bool sw_phone_begin(const char *challenge);
const char *sw_phone_prove(const char *code, char out[65]);
/* LVGL display only: never expose the six-digit code through BLE or USB. */
bool sw_phone_display(char out[7]);
