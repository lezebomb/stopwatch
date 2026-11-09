#include "sw_model.h"
#include <assert.h>
#include <stdio.h>
int main(void) {
  sw_power_policy_t p=sw_power_policy((sw_power_input_t){.battery=80,.screen=SW_PHOTOS,.brightness=30});
  assert(p.display && !p.wifi && p.refresh_hz==1);
  p=sw_power_policy((sw_power_input_t){.battery=3,.screen=SW_MUSE,.brightness=50}); assert(!p.display && !p.wifi && p.brightness==0);
  p=sw_power_policy((sw_power_input_t){.battery=3,.charging=true,.screen=SW_PHOTOS,.brightness=50}); assert(p.display && p.pixel_shift && p.brightness==50);
  p=sw_power_policy((sw_power_input_t){.battery=12,.brightness=50}); assert(p.brightness==15);
  p=sw_power_policy((sw_power_input_t){.battery=97,.brightness=80}); assert(p.brightness==20);
  assert(sw_photo_capacity(11,0,434312)); assert(!sw_photo_capacity(12,0,1)); assert(!sw_photo_capacity(1,(size_t)-1,1)); assert(!sw_photo_capacity(1,6*1024*1024-1,2));
  assert(sw_transition_allowed(SW_THINKING,SW_WORKING)); assert(!sw_transition_allowed(SW_COMPLETED,SW_APPROVAL)); assert(!sw_transition_allowed(SW_TASK_COUNT,SW_IDLE));
  puts("C firmware state machine: power, storage overflow, task transitions passed"); return 0;
}
