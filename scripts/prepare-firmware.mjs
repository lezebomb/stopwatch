import { readFile, writeFile, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assets } from "./assets.mjs";
import releaseConfig from "../release/config.json" with { type: "json" };
import { createPublicKey } from "node:crypto";
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
const component = `${sdk}/components/muse`;
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
])
  await writeChanged(
    `${component}/${file}`,
    await readFile(`firmware/companion/${file}`, "utf8"),
  );
// Read the pinned original blob each time: deterministic, repeatable patching.
let cmake = git(["show", "HEAD:esp32/components/muse/CMakeLists.txt"]);
cmake = cmake.replace(
  '"muse_app.c"',
  '"muse_app.c"\n        "sw_companion.c"\n        "sw_model.c"\n        "sw_update_core.c"\n        "sw_updater.c"\n        "sw_updater_ui.c"',
);
cmake = cmake.replace(
  "idf_component_register(",
  'list(APPEND muse_priv_requires spiffs app_update)\nlist(APPEND embed "update_public.pem")\nidf_component_register(',
);
const production = process.env.SW_PRODUCTION === "1";
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
  `#pragma once\n#define SW_UPDATE_VERSION ${JSON.stringify(releaseConfig.version)}\n#define SW_UPDATE_PRODUCTION ${production ? 1 : 0}\n#define SW_UPDATE_MANIFEST_URL ${JSON.stringify(production ? releaseConfig.manifestUrl : "")}\n`,
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
    '    if (sw_companion_keep_awake()) {\n        if (muse_state_asleep()) set_asleep(false, "charging cover");\n        return;\n    }\n' +
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
await writeChanged(`${sdk}/main/app.c`, mainApp);
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
let board = git([
  "show",
  "HEAD:esp32/components/muse/boards/board_m5stack_stopwatch.c",
]);
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
let chat = git(["show", "HEAD:esp32/components/muse/muse_chat_session.cpp"]);
const unsafeCaption = 'snprintf(err, err_cap, "Can\'t reach %s", s_host);';
if (!chat.includes(unsafeCaption))
  throw new Error("Upstream host error caption hook changed");
chat = chat.replace(
  unsafeCaption,
  'snprintf(err, err_cap, "Can\'t reach %.32s", s_host);',
);
await writeChanged(`${component}/muse_chat_session.cpp`, chat);
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
    `CONFIG_SECURE_BOOT_SIGNING_KEY=${JSON.stringify(path.resolve(process.env.SW_SIGNING_KEY_PATH).replaceAll("\\", "/"))}\n`,
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
