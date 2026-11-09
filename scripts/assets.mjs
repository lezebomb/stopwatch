import sharp from "sharp";
import { mkdir, writeFile } from "node:fs/promises";
export async function assets() {
  await mkdir("assets/photos", { recursive: true });
  await mkdir("firmware/assets", { recursive: true });
  const scenes = [
    `<defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#a0bbad"/><stop offset="1" stop-color="#d9d8ac"/></linearGradient></defs><rect width="466" height="466" fill="url(#s)"/><circle cx="329" cy="119" r="35" fill="#eee5b5"/><path d="M0 258 99 131 205 277 300 166 466 285V466H0" fill="#6d9384"/><path d="m0 337 147-150 133 155 95-104 91 75v153H0" fill="#426d62"/><path d="M0 371q125-90 237 0t229-26v121H0" fill="#254f48"/><path d="m0 420q130-35 247-17t219-10v73H0" fill="#183e3c"/>`,
    `<defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#d6aaa0"/><stop offset=".6" stop-color="#edc891"/><stop offset="1" stop-color="#82b3ad"/></linearGradient></defs><rect width="466" height="466" fill="url(#s)"/><circle cx="233" cy="219" r="47" fill="#f6e0ae"/><path d="M0 285q112-22 224 0t242-5v186H0" fill="#639c9c"/><path d="M0 325q130-35 240 0t226-5" fill="none" stroke="#bad0ba" stroke-width="6"/><path d="M0 391q100-30 229-8t237-12v95H0" fill="#4b7d81"/><path d="M0 438q185-24 466-4" fill="none" stroke="#97b5a5" stroke-width="5"/>`,
    `<defs><linearGradient id="s" x2="0" y2="1"><stop stop-color="#182b40"/><stop offset="1" stop-color="#657b8a"/></linearGradient></defs><rect width="466" height="466" fill="url(#s)"/><circle cx="315" cy="130" r="35" fill="#e9dca4"/><circle cx="330" cy="120" r="32" fill="#203447"/>${Array.from({ length: 36 }, (_, i) => `<circle cx="${(i * 97 + 37) % 466}" cy="${(i * 47 + 19) % 310}" r="${i % 3 === 0 ? 2 : 1}" fill="#e2dcb4"/>`).join("")}<path d="m0 357 134-151 129 151 76-107 127 127v89H0" fill="#304957"/><path d="M0 407q169-70 295-3t171-15v77H0" fill="#1c3542"/>`,
  ];
  for (let i = 0; i < scenes.length; i++) {
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="466" height="466">${scenes[i]}</svg>`,
    );
    const image = sharp(svg);
    const raw = await image.clone().removeAlpha().raw().toBuffer();
    const pixels = Buffer.alloc(466 * 466 * 2);
    for (let p = 0; p < 466 * 466; p++)
      pixels.writeUInt16LE(
        ((raw[p * 3] >> 3) << 11) |
          ((raw[p * 3 + 1] >> 2) << 5) |
          (raw[p * 3 + 2] >> 3),
        p * 2,
      );
    await writeFile(
      `assets/photos/${i}.jpg`,
      await image.jpeg({ quality: 85 }).toBuffer(),
    );
    await writeFile(`firmware/assets/${i}.rgb`, pixels);
  }
}
if (process.argv[1]?.endsWith("assets.mjs")) {
  await assets();
  console.log("Created 3 original test landscapes and device RGB565 assets");
}
