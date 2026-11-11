import { readFile, writeFile, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assets } from "./assets.mjs";
import releaseConfig from "../release/config.json" with { type: "json" };
import { createPublicKey, X509Certificate } from "node:crypto";
import { setupQrHeader } from "./setup-qr.mjs";
import { miaoAssets, miaoOutput } from "./miao-assets.mjs";
const lock = JSON.parse(await readFile("upstream.lock.json", "utf8"));
const sdk = path.resolve(".deps/muse/esp32"),
  muse = path.resolve(".deps/muse");
async function writeChanged(file, data) {
  try {
    if ((await readFile(file, "utf8")) === data) return;
  } catch {}
  await writeFile(file, data);
}
const git = (args) =>
  execFileSync(
    "git",
    ["-c", `safe.directory=${muse.replaceAll("\\", "/")}`, "-C", muse, ...args],
    { encoding: "utf8" },
  );
if (git(["rev-parse", "HEAD"]).trim() !== lock.muse.commit)
  throw new Error("Muse commit differs from upstream.lock.json");
await assets();
await miaoAssets();
const component = `${sdk}/components/muse`;
for (const [src, dest] of [["miao_data.h", "miao_data.h"], ["miao.pack", "sw_miao_pack.bin"], ["idle.bin", "sw_miao_idle.bin"]]) {
  const bytes = await readFile(path.join(miaoOutput, src));
  const existing = await readFile(`${component}/${dest}`).catch(() => null);
  if (!existing || !bytes.equals(existing)) await writeFile(`${component}/${dest}`, bytes);
}
for (const file of [
  "sw_companion.c",
  "sw_companion.h",
  "sw_model.c",
  "sw_model.h",
  "sw_update_core.c",
  "sw_update_core.h",
  "sw_updater.c",
  "sw_updater.h",
  "sw_updater_ui.c",
  "sw_sync.c",
  "sw_sync.h",
  "sw_miao.c",
  "sw_miao.h",
])
  await writeChanged(
    `${component}/${file}`,
    await readFile(`firmware/companion/${file}`, "utf8"),
  );
// Read the pinned original blob each time: deterministic, repeatable patching.
let cmake = git(["show", "HEAD:esp32/components/muse/CMakeLists.txt"]);
cmake = cmake.replace(
  '"muse_app.c"',
  '"muse_app.c"\n        "sw_companion.c"\n        "sw_model.c"\n        "sw_update_core.c"\n        "sw_updater.c"\n        "sw_updater_ui.c"\n        "sw_sync.c"\n        "sw_miao.c"',
);
cmake = cmake.replace(
  "idf_component_register(",
  'list(APPEND muse_priv_requires spiffs app_update wpa_supplicant)\nlist(APPEND embed "update_public.pem" "sw_miao_pack.bin" "sw_miao_idle.bin")\nidf_component_register(',
);
const museManifest = git(["show", "HEAD:esp32/components/muse/idf_component.yml"]);
if (!museManifest.includes("dependencies:\n")) throw new Error("Upstream Muse dependency manifest changed");
await writeChanged(`${component}/idf_component.yml`, museManifest.replace("dependencies:\n", 'dependencies:\n  espressif/zlib: "1.3.2~2"\n'));
const production = process.env.SW_PRODUCTION === "1";
const relayOrigin = production ? releaseConfig.productionOrigin || "" : process.env.SW_DEVICE_RELAY_ORIGIN || "";
if (relayOrigin) {
  const url = new URL(relayOrigin);
  if (url.protocol !== "https:" || url.origin !== relayOrigin || relayOrigin.length > 160)
    throw new Error("Device relay must be a fixed HTTPS origin with no path or credentials");
}
let relayCa = "";
if (!production && process.env.SW_DEVICE_RELAY_CA) {
  if (!relayOrigin) throw new Error("A development relay CA requires SW_DEVICE_RELAY_ORIGIN");
  const ca = new X509Certificate(await readFile(process.env.SW_DEVICE_RELAY_CA));
  if (!ca.ca) throw new Error("SW_DEVICE_RELAY_CA must be a public CA certificate");
  relayCa = ca.toString();
}
await writeChanged(`${component}/sw_setup_qr.h`, setupQrHeader(relayOrigin ? `${relayOrigin}/setup/` : undefined));
await writeChanged(`${component}/sw_sync_build.h`,
  `#pragma once\n#define SW_RELAY_ORIGIN ${JSON.stringify(relayOrigin)}\n#define SW_RELAY_HARDWARE ${JSON.stringify(releaseConfig.hardware)}\n#define SW_RELAY_CA ${JSON.stringify(relayCa)}\n`);
if (!production) await import("./update-dev-key.mjs");
const publicPath = production
  ? releaseConfig.productionPublicKey
  : ".data/update-dev-public.pem";
const publicPem = await readFile(publicPath, "utf8");
const publicKey = createPublicKey(publicPem);
if (
  publicKey.asymmetricKeyType !== "rsa" ||
  publicKey.asymmetricKeyDetails.modulusLength !== 3072
)
  throw new Error("RSA-3072 release public key required");
if (production && !process.env.SW_SIGNING_KEY_PATH)
  throw new Error("Private image signing key path required for production");
await writeChanged(
  `${component}/update_public.pem`,
  (publicPem.endsWith("\n") ? publicPem : publicPem + "\n") + "\0",
);
await writeChanged(
  `${component}/sw_update_build.h`,
  `#pragma once\n#define SW_UPDATE_VERSION ${JSON.stringify(releaseConfig.version)}\n#define SW_UPDATE_PRODUCTION ${production ? 1 : 0}\n#define SW_UPDATE_MANIFEST_URL ${JSON.stringify(production ? releaseConfig.manifestUrl : "")}\n#define SW_RESOURCE_MANIFEST_URL ${JSON.stringify(production ? releaseConfig.resourceManifestUrl : "")}\n`,
);
await writeChanged(`${component}/CMakeLists.txt`, cmake);
let ui = git(["show", "HEAD:esp32/components/muse/muse_ui.c"]);
ui = '#include "sw_companion.h"\n' + ui;
if (!ui.includes("    build_overlays();"))
  throw new Error("Upstream UI hook changed");
ui = ui.replace(
  "    build_overlays();",
  "    build_overlays();\n    sw_companion_init();",
);
const brightnessHook = "        apply_brightness(target);";
if (!ui.includes(brightnessHook))
  throw new Error("Upstream brightness hook changed");
ui = ui.replace(
  brightnessHook,
  "        apply_brightness(sw_companion_brightness(target));",
);
if (!ui.includes("s_settings = lv_tileview_add_tile(s_tv, 1, 0, LV_DIR_LEFT);"))
  throw new Error("Upstream settings tile changed");
ui +=
  "\nbool sw_companion_native_page(bool settings) {\n    if (!s_tv || !s_settings || !s_face) return false;\n    lv_tileview_set_tile(s_tv, settings ? s_settings : s_face, LV_ANIM_OFF);\n    update_tileview_swipe();\n    return true;\n}\n";
await writeChanged(`${component}/muse_ui.c`, ui);
let app = git(["show", "HEAD:esp32/components/muse/muse_app.c"]);
app = '#include "sw_updater.h"\n' + app;
app = app.replace(
  '        muse_state_set_caption("%s", "");   /* the button icons say how to talk */',
  '        muse_state_set_caption("%s", "");   /* the button icons say how to talk */\n        sw_update_services_ready();',
);
await writeChanged(`${component}/muse_app.c`, app);
let tokenConsole = git(["show", "HEAD:esp32/main/sdk_token_console.c"]);
const tokenHook = "bool sdk_token_console_command(const char *line) {";
if (!tokenConsole.includes(tokenHook))
  throw new Error("Upstream console hook changed");
tokenConsole =
  '#include "sw_companion.h"\n' +
  tokenConsole.replace(
    tokenHook,
    tokenHook + "\n    if (sw_companion_console(line)) return true;",
  );
tokenConsole = tokenConsole.replace(
  'ESP_LOGI(TAG, "stored SDK token %.12s, restarting to use it", token);',
  'ESP_LOGI(TAG, "stored SDK token, restarting to use it");',
);
await writeChanged(`${sdk}/main/sdk_token_console.c`, tokenConsole);
let input = git(["show", "HEAD:esp32/components/muse/muse_input.c"]);
const serialStack =
  'xTaskCreate(serial_task, "muse_serial", 3584, NULL, 5, NULL);';
if (!input.includes(serialStack))
  throw new Error("Upstream serial task changed");
input = input.replace(
  serialStack,
  'xTaskCreate(serial_task, "muse_serial", 6144, NULL, 5, NULL);',
);
const sleepHook = "    int after = muse_settings_sleep_s();";
if (!input.includes(sleepHook)) throw new Error("Upstream sleep hook changed");
input =
  '#include "sw_companion.h"\n' +
  input.replace(
    sleepHook,
    '    if (sw_companion_keep_awake()) {\n        if (muse_state_asleep()) set_asleep(false, "charging cover");\n        return;\n    }\n    if (sw_companion_controls_sleep()) return;\n' +
      sleepHook,
  );
await writeChanged(`${component}/muse_input.c`, input);
// Companion health checks replace the Link-only WS validation on this profile.
let mainApp = git(["show", "HEAD:esp32/main/app.c"]);
const healthHook = "static void ota_verify_task(void *arg) {\n    (void)arg;";
if (!mainApp.includes(healthHook))
  throw new Error("Upstream health hook changed");
mainApp = mainApp.replace(
  healthHook,
  healthHook +
    "\n#if CONFIG_MUSE_BOARD_M5STACK_STOPWATCH\n    stack_monitor_record(NULL);\n    vTaskDelete(NULL);\n    return; /* sw_updater owns storage/UI/services health, including offline operation. */\n#endif",
);
mainApp = mainApp.replace(
  'ESP_LOGI(TAG, "  SDK token:  %.12s", identity_sdk_token() ? identity_sdk_token() : "(none)");',
  'ESP_LOGI(TAG, "  SDK token configured: %s", identity_sdk_token() ? "yes" : "no");',
).replace(
  'ESP_LOGW(TAG, "  Paired with SDK token %s, not this one. Pair again in the "\n                      "Muse app to use it.", paired_sdk_hint);',
  'ESP_LOGW(TAG, "SDK token changed; pair again in the Muse app");',
);
await writeChanged(`${sdk}/main/app.c`, mainApp);
let glue = git(["show", "HEAD:esp32/main/muse_glue.c"]);
glue = glue.replace(
  'ESP_LOGI(TAG, "SDK token %.12s set in settings, restarting to use it", token);',
  'ESP_LOGI(TAG, "SDK token stored in settings; restarting");',
);
await writeChanged(`${sdk}/main/muse_glue.c`, glue);
let wifiManager = '#include "sw_companion.h"\n' + git(["show", "HEAD:esp32/main/wifi_mgr.c"]);
const stationConfig = '    esp_err_t err = ESP_OK;\n    for (int i = 0; i < 30; i++) {  // ~1.5s budget @ 50ms';
const stationConnect = '    atomic_store(&s_sta_idle, false);\n    err = esp_wifi_connect();';
if (!wifiManager.includes(stationConfig) || !wifiManager.includes(stationConnect))
  throw new Error("Upstream station connection hooks changed");
wifiManager = wifiManager.replace(stationConfig, stationConfig.replace('esp_err_t err = ESP_OK;',
  'esp_err_t err = sw_companion_wifi_prepare(&wc);\n    if (err != ESP_OK) goto done;'));
wifiManager = wifiManager.replace(stationConnect,
  '    err = sw_companion_wifi_enable(&wc);\n    if (err != ESP_OK) goto done;\n' + stationConnect);
await writeChanged(`${sdk}/main/wifi_mgr.c`, wifiManager);
let settingsUi = git(["show", "HEAD:esp32/components/muse/muse_settings_ui.c"]);
settingsUi = '#include "sw_updater.h"\n' + settingsUi;
const settingsHook =
  '    row(list, LV_SYMBOL_BATTERY_FULL, "Battery", &s_home_battery, on_nav, (void *)&BATTERY);';
if (!settingsUi.includes(settingsHook))
  throw new Error("Upstream settings hook changed");
settingsUi = settingsUi.replace(
  settingsHook,
  settingsHook +
    '\n    row(list, LV_SYMBOL_REFRESH, "Software update", NULL, sw_update_settings_open, NULL);',
);
await writeChanged(`${component}/muse_settings_ui.c`, settingsUi);
let settings = git(["show", "HEAD:esp32/components/muse/muse_settings.c"]);
const bleSettingHook = "bool muse_settings_ble_on(void) { return s.ble_on; }";
if (!settings.includes(bleSettingHook))
  throw new Error("Upstream Bluetooth setting hook changed");
settings = '#include "sw_companion.h"\n' + settings.replace(bleSettingHook,
  `static atomic_bool s_phone_setup_ble;
bool muse_settings_ble_on(void) { return s.ble_on || atomic_load(&s_phone_setup_ble); }
void sw_companion_phone_ble(bool enabled) {
    if (atomic_exchange(&s_phone_setup_ble, enabled) != enabled) {
        notify(MUSE_SETTING_BLE);
    }
}`);
await writeChanged(`${component}/muse_settings.c`, settings);
let ble = git(["show", "HEAD:esp32/components/muse/muse_ble.c"]);
const bleCommand = "static void run_command(char *cmd)";
const bleSave = "            muse_settings_set_wifi(s_pending_ssid, s_pending_pass);";
if (!ble.includes(bleCommand) || !ble.includes(bleSave) ||
    !ble.includes("            run_command(cmd);"))
  throw new Error("Upstream phone Wi-Fi command hook changed");
const bleSecret = 'bool secret = !strcmp(cmd, "wifi.pass") || !strncmp(cmd, "hatch.token", 11);';
const bleCommands = '    } else if (!strcmp(cmd, "wifi.forget")) {';
if (!ble.includes(bleSecret) || !ble.includes(bleCommands))
  throw new Error("Upstream encrypted phone command hook changed");
ble = '#include "sw_companion.h"\n#include "sw_sync.h"\n' + ble
  .replace(bleCommand, "static void run_command(char *cmd, bool phone)")
  .replace(bleSave, bleSave + "\n            if (phone) sw_companion_phone_network(s_pending_ssid);")
  .replace("    run_command(cmd);\n}", "    run_command(cmd, false);\n}")
  .replace("            run_command(cmd);", "            run_command(cmd, true);")
  .replace(bleSecret, bleSecret.replace('!strcmp(cmd, "wifi.pass")', '!strcmp(cmd, "sync.enroll") || !strcmp(cmd, "wifi.pass")'))
  .replace(bleCommands, `    } else if (!strcmp(cmd, "sync.enroll")) {
        if (!phone || !sw_sync_enroll(v)) res = "error: setup unavailable";
        memset(v, 0, strlen(v));
    } else if (!strcmp(cmd, "sync.status")) {
        res = sw_sync_pair_state();
${bleCommands}`);
await writeChanged(`${component}/muse_ble.c`, ble);
let board = git([
  "show",
  "HEAD:esp32/components/muse/boards/board_m5stack_stopwatch.c",
]);
board = '#include "sw_companion.h"\n#include <stdatomic.h>\n' + board;
const ampOutput = '        uint16_t want = (v & ~mask) | (bits & mask);';
if (!board.includes(ampOutput)) throw new Error("Upstream amp output hook changed");
board = board.replace(ampOutput, ampOutput + '\n        if (reg == IOE_OUT && sw_companion_audio_silent()) want &= ~IOE_SPK;');
const ampSet = '    return ioe_set(IOE_SPK, high) == ESP_OK ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_WRITE_FAIL;';
if (!board.includes(ampSet)) throw new Error("Upstream amp driver hook changed");
const ampHelpers = `
static atomic_bool sw_amp_requested;
bool sw_companion_amp_refresh(void) {
    return s_ioe && s_ioe_lock && ioe_set(IOE_SPK, atomic_load(&sw_amp_requested)) == ESP_OK;
}
int sw_companion_amp_state(void) {
    if (!s_ioe || !s_ioe_lock) return -1;
    uint8_t output[2];
    xSemaphoreTake(s_ioe_lock, portMAX_DELAY);
    esp_err_t err = reg_read(s_ioe, IOE_OUT, output, sizeof(output));
    xSemaphoreGive(s_ioe_lock);
    return err == ESP_OK ? !!((output[0] | output[1] << 8) & IOE_SPK) : -1;
}
`;
board = board.replace('static int ioe_gpio_set(int16_t gpio, bool high)', ampHelpers + '\nstatic int ioe_gpio_set(int16_t gpio, bool high)');
board = board.replace(ampSet, '    atomic_store(&sw_amp_requested, high);\n    return sw_companion_amp_refresh() ? ESP_CODEC_DEV_OK : ESP_CODEC_DEV_WRITE_FAIL;');
const begin = board.indexOf(
  "#if !CONFIG_MUSE_REALTIME_VOICE\n#define TALK_GPIO",
);
const end = board.indexOf("#endif", begin);
if (begin < 0 || end < 0) throw new Error("Upstream button hook changed");
board =
  board.slice(0, begin) +
  "#define TALK_GPIO GPIO_NUM_2 /* StopWatch gift: yellow always talks */\n#define SPEAKER_GPIO GPIO_NUM_1 /* blue retains official speaker control */\n" +
  board.slice(end + 6);
const hintBegin = board.indexOf(
  "#if !CONFIG_MUSE_REALTIME_VOICE\n    .talk_button",
);
const hintEnd = board.indexOf("#endif", hintBegin);
if (hintBegin < 0 || hintEnd < 0) throw new Error("Upstream hint hook changed");
board =
  board.slice(0, hintBegin) +
  '    .talk_button = "top-left",\n    .speaker_button = "top-right",\n    .talk_hint = { LV_ALIGN_CENTER, -144, -110 },\n    .speaker_hint = { LV_ALIGN_CENTER, 144, -110 },\n' +
  board.slice(hintEnd + 6);
await writeChanged(`${component}/boards/board_m5stack_stopwatch.c`, board);
let audio = '#include "sw_companion.h"\n' + git(["show", "HEAD:esp32/components/muse/muse_audio.c"]);
for (const signature of ["void muse_audio_chirp(int rising)", "void muse_audio_loopback_test(int volume)"]) {
  const body = signature + "\n{";
  if (!audio.includes(body)) throw new Error("Upstream audio diagnostic hook changed");
  audio = audio.replace(body, body + '\n    if (sw_companion_audio_silent()) return;');
}
const pcmMute = "bool mute = !muse_settings_speaker_on();";
if (!audio.includes(pcmMute)) throw new Error("Upstream PCM mute hook changed");
audio = audio.replace(pcmMute, "bool mute = sw_companion_audio_silent() || !muse_settings_speaker_on();");
await writeChanged(`${component}/muse_audio.c`, audio);
let chat = git(["show", "HEAD:esp32/components/muse/muse_chat_session.cpp"]);
const unsafeCaption = 'snprintf(err, err_cap, "Can\'t reach %s", s_host);';
if (!chat.includes(unsafeCaption))
  throw new Error("Upstream host error caption hook changed");
chat = chat.replace(
  unsafeCaption,
  'snprintf(err, err_cap, "Can\'t reach %.32s", s_host);',
);
await writeChanged(`${component}/muse_chat_session.cpp`, chat);
let voiceCall = git(["show", "HEAD:esp32/components/muse/muse_voice_call.cpp"]);
voiceCall = '#include "esp_attr.h"\n' + voiceCall;
// These session-task buffers never go to I2S DMA. Leave internal RAM for DMA.
for (const declaration of [
  "static muse_vc_call_t s_call;",
  "static muse_vc_uplink_t s_up;",
  "static char s_append[MUSE_VC_APPEND_MAX];",
  "static int16_t s_mic[MIC_PIECE];",
]) {
  if (!voiceCall.includes(declaration)) throw new Error("Upstream voice call buffers changed");
  voiceCall = voiceCall.replace(declaration, `EXT_RAM_BSS_ATTR ${declaration}`);
}
await writeChanged(`${component}/muse_voice_call.cpp`, voiceCall);
await writeChanged(
  `${sdk}/partitions_companion.csv`,
  await readFile("firmware/partitions.csv", "utf8"),
);
let top = git(["show", "HEAD:esp32/CMakeLists.txt"]);
top += `\nif(SW_FACTORY_ASSETS)\n  spiffs_create_partition_image(photos "${path.resolve("firmware/assets").replaceAll("\\", "/")}" FLASH_IN_PROJECT)\nelse()\n  spiffs_create_partition_image(photos "${path.resolve("firmware/assets").replaceAll("\\", "/")}")\nendif()\n`;
await writeChanged(`${sdk}/CMakeLists.txt`, top);
await writeChanged(
  `${sdk}/sdkconfig.companion`,
  await readFile("firmware/sdkconfig.companion", "utf8"),
);
if (production) {
  const privatePem = await readFile(process.env.SW_SIGNING_KEY_PATH, "utf8");
  if (
    createPublicKey(privatePem).export({ type: "spki", format: "pem" }) !==
    publicKey.export({ type: "spki", format: "pem" })
  )
    throw new Error("Signing key/public trust mismatch");
  await writeChanged(
    `${sdk}/sdkconfig.release`,
    `CONFIG_SECURE_BOOT_SIGNING_KEY=${JSON.stringify(path.resolve(process.env.SW_SIGNING_KEY_PATH).replaceAll("\\", "/"))}\nCONFIG_MUSE_REALTIME_VOICE=y\n`,
  );
}
if (existsSync("firmware/dependencies.lock"))
  await writeChanged(
    `${sdk}/dependencies.lock`,
    await readFile("firmware/dependencies.lock", "utf8"),
  );
await mkdir("artifacts", { recursive: true });
console.log(
  "Prepared pinned Muse StopWatch extension; no token, no hardware access",
);
