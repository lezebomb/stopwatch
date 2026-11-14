import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import assert from "node:assert/strict";
const root = process.argv[2] || "firmware/build";
const config = await readFile(`${root}/sdkconfig`, "utf8");
if (process.env.SW_PRODUCTION === "1") {
  assert(
    /^CONFIG_GADGET_SDK_TOKEN=""\r?$/m.test(config),
    "Public firmware must use device-local Muse enrollment",
  );
  assert(
    /^CONFIG_MUSE_REALTIME_VOICE=y\r?$/m.test(config),
    "Public firmware must include Muse voice playback",
  );
}
for (const name of [
  "BOOTLOADER_APP_ROLLBACK_ENABLE",
  "SECURE_SIGNED_APPS_NO_SECURE_BOOT",
  "SECURE_SIGNED_ON_UPDATE_NO_SECURE_BOOT",
  "SECURE_SIGNED_APPS_RSA_SCHEME",
  "SPIRAM_FETCH_INSTRUCTIONS",
  "SPIRAM_RODATA",
  "FREERTOS_TASK_CREATE_ALLOW_EXT_MEM",
  "HOMEHUB_SETUP_TASKS_IN_PSRAM",
])
  assert(
    config.includes(`CONFIG_${name}=y`),
    `Required config ${name} missing`,
  );
for (const name of [
  "SECURE_BOOT",
  "BOOTLOADER_APP_ANTI_ROLLBACK",
  "SECURE_FLASH_ENC_ENABLED",
  "HOMEHUB_NVS_ENCRYPTION",
  "NVS_ENCRYPTION",
])
  assert(
    !config.includes(`CONFIG_${name}=y`),
    `Irreversible option ${name} must be off`,
  );
const args = await readFile(`${root}/flash_args`, "utf8");
const build = await readFile(`${root}/build.ninja`, "utf8");
for (const api of ["esp_flash_read", "esp_flash_write", "esp_flash_write_encrypted",
  "esp_flash_erase_region", "esp_flash_erase_chip", "spi_flash_mmap", "spi_flash_munmap"])
  assert(build.includes(`--wrap=${api}`), `OTA external stack requires Flash dispatcher wrapper ${api}`);
if (!process.env.SW_ALLOW_FACTORY_ASSETS)
  assert(
    !args.includes("photos.bin"),
    "Default flash plan must preserve photos",
  );
const partitions = await readFile("firmware/partitions.csv", "utf8");
assert(partitions.includes("0x822000,0x700000"));
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/build-security.json",
  JSON.stringify(
    {
      rollback: true,
      signedOta: true,
      hardwareSecureBoot: false,
      efuseAntiRollback: false,
      flashEncryption: false,
      nvsEncryption: false,
      partitionLayout: "c152-16m-dual4m-photos7m-v1",
      firmwareBytes: (await stat(`${root}/muse-gadget.bin`)).size,
      photoImageInDefaultFlashArgs: args.includes("photos.bin"),
    },
    null,
    2,
  ),
);
console.log(
  "Verified rollback, signed OTA, unchanged layout; no irreversible security options.",
);
