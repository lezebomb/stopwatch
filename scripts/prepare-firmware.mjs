import { readFile, writeFile, cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { assets } from "./assets.mjs";
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
])
  await writeChanged(
    `${component}/${file}`,
    await readFile(`firmware/companion/${file}`, "utf8"),
  );
// Read the pinned original blob each time: deterministic, repeatable patching.
let cmake = git(["show", "HEAD:esp32/components/muse/CMakeLists.txt"]);
cmake = cmake.replace(
  '"muse_app.c"',
  '"muse_app.c"\n        "sw_companion.c"\n        "sw_model.c"',
);
cmake = cmake.replace(
  "idf_component_register(",
  "list(APPEND muse_priv_requires spiffs)\nidf_component_register(",
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
await writeChanged(`${component}/muse_ui.c`, ui);
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
top += `\nspiffs_create_partition_image(photos "${path.resolve("firmware/assets").replaceAll("\\", "/")}" FLASH_IN_PROJECT)\n`;
await writeChanged(`${sdk}/CMakeLists.txt`, top);
await writeChanged(
  `${sdk}/sdkconfig.companion`,
  await readFile("firmware/sdkconfig.companion", "utf8"),
);
if (existsSync("firmware/dependencies.lock"))
  await writeChanged(
    `${sdk}/dependencies.lock`,
    await readFile("firmware/dependencies.lock", "utf8"),
  );
await mkdir("artifacts", { recursive: true });
console.log(
  "Prepared pinned Muse StopWatch extension; no token, no hardware access",
);
