import QRCode from "qrcode";
export const SETUP_URL = "https://lezebomb.github.io/stopwatch/setup/";
// LVGL indexed one-bit image, including a four-module white quiet zone.
export function setupQrHeader() {
  const qr = QRCode.create(SETUP_URL, { errorCorrectionLevel: "M" });
  const scale = 6, size = (qr.modules.size + 8) * scale;
  const stride = Math.ceil(size / 8);
  const pixels = Buffer.alloc(8 + stride * size);
  pixels.set([255, 255, 255, 255, 0, 0, 0, 255]); // BGRA palette: white, black.
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const mx = Math.floor(x / scale) - 4, my = Math.floor(y / scale) - 4;
    if (mx >= 0 && my >= 0 && mx < qr.modules.size && my < qr.modules.size && qr.modules.get(my, mx))
      pixels[8 + y * stride + (x >> 3)] |= 1 << (7 - (x & 7));
  }
  const rows = [];
  for (let i = 0; i < pixels.length; i += 24) rows.push("  " + [...pixels.subarray(i, i + 24)].join(","));
  return `/* Generated public URL only; no identity, credential or pairing code. */\n#pragma once\n#define SW_SETUP_URL "${SETUP_URL}"\nstatic const uint8_t setup_qr_pixels[] = {\n${rows.join(",\n")}\n};\nstatic const lv_image_dsc_t setup_qr_image = {\n .header = {.magic = LV_IMAGE_HEADER_MAGIC, .cf = LV_COLOR_FORMAT_I1, .w = ${size}, .h = ${size}, .stride = ${stride}},\n .data_size = sizeof(setup_qr_pixels), .data = setup_qr_pixels\n};\n`;
}
