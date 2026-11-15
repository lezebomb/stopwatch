import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

// Validate the actual pinned font tables, not a hand-maintained glyph list.
function coverage(text) {
  const result = new Set();
  const at = text.indexOf("lv_font_fmt_txt_cmap_t cmaps");
  assert(at >= 0, "Pinned LVGL font cmap layout changed");
  const maps = text.slice(at, text.indexOf("};", at));
  const array = name => {
    const body = new RegExp(`\\b${name}\\[\\]\\s*=\\s*\\{([^}]+)\\}`, "s").exec(text)?.[1];
    assert(body, `Missing font array ${name}`);
    return [...body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/0x[\da-f]+|\b\d+\b/gi)].map(m => Number(m[0]));
  };
  for (const match of maps.matchAll(/\{([^{}]+)\}/gs)) {
    const block = match[1], start = Number(/\.range_start\s*=\s*(\d+)/.exec(block)?.[1]);
    const length = Number(/\.range_length\s*=\s*(\d+)/.exec(block)?.[1]);
    const type = /\.type\s*=\s*(\w+)/.exec(block)?.[1];
    if (type?.includes("SPARSE")) {
      for (const offset of array(/\.unicode_list\s*=\s*(\w+)/.exec(block)[1])) result.add(start + offset);
    } else if (type?.includes("FORMAT0_FULL")) {
      array(/\.glyph_id_ofs_list\s*=\s*(\w+)/.exec(block)[1]).forEach((offset, i) => { if (offset || i === 0) result.add(start + i); });
    } else {
      assert(type?.includes("FORMAT0_TINY"), "Unsupported pinned font cmap");
      for (let i = 0; i < length; i++) result.add(start + i);
    }
  }
  return result;
}
export async function checkDeviceText(buildRoot) {
  const config = await readFile(`${buildRoot}/sdkconfig`, "utf8");
  const size = /^CONFIG_LV_FONT_DEFAULT_MONTSERRAT_(\d+)=y\r?$/m.exec(config)?.[1];
  assert(size, "Device text check needs the actual default font");
  const fonts = await Promise.all([
    ".deps/muse/esp32/components/muse/fonts/muse_font_cjk_noto_16.c",
    `.deps/muse/esp32/managed_components/lvgl__lvgl/src/font/lv_font_montserrat_${size}.c`,
  ].map(file => readFile(file, "utf8")));
  const glyphs = new Set(fonts.flatMap(text => [...coverage(text)]));
  const missing = new Set();
  for (const file of ["firmware/companion/sw_companion.c", "firmware/companion/sw_navigation.inc"]) {
    const source = await readFile(file, "utf8");
    // Keep C string literals; skip comments, including URLs inside strings.
    for (const token of source.matchAll(/"(?:\\.|[^"\\])*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)) {
      if (!token[0].startsWith('"')) continue;
      for (const char of token[0]) if (char.codePointAt(0) > 127 && !glyphs.has(char.codePointAt(0))) missing.add(`U+${char.codePointAt(0).toString(16).toUpperCase()}`);
    }
  }
  assert.equal(missing.size, 0, `Unsupported static device glyphs: ${[...missing].join(", ")}`);
  console.log("Verified static device text against the pinned CJK/default fonts");
}
