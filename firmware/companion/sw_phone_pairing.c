#include "sw_phone_pairing.h"
#include "sw_sync.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "mbedtls/platform_util.h"
#include "psa/crypto.h"
#include <stdio.h>
#include <string.h>

static portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
static int64_t window_until, code_until;
static char pending[33], digits[7];
static unsigned attempts;
static int64_t now_ms(void) { return esp_timer_get_time() / 1000; }
static void hex(const unsigned char *bytes, char out[65]) {
  static const char alphabet[] = "0123456789abcdef";
  for (int i = 0; i < 32; i++) { out[2*i] = alphabet[bytes[i] >> 4]; out[2*i+1] = alphabet[bytes[i] & 15]; }
  out[64] = 0;
}
static bool key(unsigned char out[32]) {
  char token[33] = {0}; size_t length = 0;
  bool ok = sw_sync_muse_credential(token) && psa_hash_compute(PSA_ALG_SHA_256, (const unsigned char *)token, 32, out, 32, &length) == PSA_SUCCESS && length == 32;
  mbedtls_platform_zeroize(token, sizeof(token));
  return ok;
}
bool sw_phone_ref(char out[65]) {
  unsigned char digest[32], ref[32]; char input[78] = "SWPHONE-REF1:"; size_t length = 0;
  bool ok = key(digest);
  if (ok) {
    hex(digest, input + 13);
    ok = psa_hash_compute(PSA_ALG_SHA_256, (unsigned char *)input, strlen(input), ref, 32, &length) == PSA_SUCCESS && length == 32;
    if (ok) hex(ref, out);
  }
  mbedtls_platform_zeroize(digest, sizeof(digest)); mbedtls_platform_zeroize(input, sizeof(input));
  if (!ok) out[0] = 0;
  return ok;
}
void sw_phone_open(void) {
  portENTER_CRITICAL(&lock);
  window_until = now_ms() + 300000; code_until = 0; attempts = 0; pending[0] = digits[0] = 0;
  portEXIT_CRITICAL(&lock);
}
void sw_phone_close(void) {
  portENTER_CRITICAL(&lock);
  window_until = code_until = 0; pending[0] = digits[0] = 0;
  portEXIT_CRITICAL(&lock);
}
bool sw_phone_active(void) {
  portENTER_CRITICAL(&lock); bool active = now_ms() < window_until; portEXIT_CRITICAL(&lock); return active;
}
bool sw_phone_begin(const char *challenge) {
  if (!challenge || strlen(challenge) != 32) return false;
  for (int i = 0; i < 32; i++) if (!((challenge[i] >= 'a' && challenge[i] <= 'z') || (challenge[i] >= 'A' && challenge[i] <= 'Z') || (challenge[i] >= '0' && challenge[i] <= '9') || challenge[i] == '-' || challenge[i] == '_')) return false;
  char ref[65]; if (!sw_phone_ref(ref)) return false;
  portENTER_CRITICAL(&lock);
  int64_t now = now_ms();
  bool allowed = now < window_until && attempts < 5 && (!pending[0] || now >= code_until);
  if (allowed) {
    strlcpy(pending, challenge, sizeof(pending)); snprintf(digits, sizeof(digits), "%06lu", (unsigned long)(esp_random() % 1000000)); code_until = now + 120000;
  }
  portEXIT_CRITICAL(&lock);
  return allowed;
}
bool sw_phone_display(char out[7]) {
  portENTER_CRITICAL(&lock);
  bool valid = now_ms() < window_until && now_ms() < code_until && pending[0] && attempts < 5;
  if (valid) memcpy(out, digits, 7); else out[0] = 0;
  portEXIT_CRITICAL(&lock); return valid;
}
const char *sw_phone_prove(const char *code, char out[65]) {
  char challenge[33], approved[7];
  portENTER_CRITICAL(&lock);
  if (now_ms() >= window_until || now_ms() >= code_until || !pending[0] || attempts >= 5) { portEXIT_CRITICAL(&lock); return "expired"; }
  attempts++;
  if (!code || strlen(code) != 6 || memcmp(code, digits, 6)) { portEXIT_CRITICAL(&lock); return "wrong-code"; }
  memcpy(challenge, pending, sizeof(challenge)); memcpy(approved, digits, sizeof(approved));
  pending[0] = digits[0] = 0; code_until = 0; // one proof per physical challenge
  portEXIT_CRITICAL(&lock);
  unsigned char digest[32], mac[32]; char message[56]; size_t length = 0;
  snprintf(message, sizeof(message), "SWPHONE1:%s:%s", challenge, approved);
  psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT; psa_key_id_t handle = 0;
  psa_set_key_type(&attributes, PSA_KEY_TYPE_HMAC); psa_set_key_bits(&attributes, 256);
  psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_MESSAGE); psa_set_key_algorithm(&attributes, PSA_ALG_HMAC(PSA_ALG_SHA_256));
  bool ok = key(digest) && psa_import_key(&attributes, digest, 32, &handle) == PSA_SUCCESS &&
    psa_mac_compute(handle, PSA_ALG_HMAC(PSA_ALG_SHA_256), (unsigned char *)message, strlen(message), mac, 32, &length) == PSA_SUCCESS && length == 32;
  if (handle) psa_destroy_key(handle);
  if (ok) hex(mac, out);
  mbedtls_platform_zeroize(digest, sizeof(digest)); mbedtls_platform_zeroize(mac, sizeof(mac)); mbedtls_platform_zeroize(message, sizeof(message));
  mbedtls_platform_zeroize(approved, sizeof(approved));
  return ok ? out : "error";
}
