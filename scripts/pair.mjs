import { Store } from "../server/store.mjs";
import config from "../release/config.json" with { type: "json" };
import path from "node:path";

const production = process.env.STOPWATCH_MODE === "production";
const directory = process.env.STOPWATCH_DATA_DIR || ".data";
const origin = production ? config.productionOrigin : `http://127.0.0.1:${process.env.PORT || 8787}`;
if (production && (!process.stdout.isTTY || !path.isAbsolute(directory) ||
    !origin?.startsWith("https://") || process.env.STOPWATCH_PUBLIC_ORIGIN !== origin))
  throw new Error("Issue a production pairing link only in a private terminal using the reviewed service settings");

const store = new Store(directory);
try {
  const ticket = store.ticket(process.argv.includes("--viewer") ? "viewer" : "operator");
  console.log(`两分钟有效、一次性配对：\n${origin}/#pair=${ticket.code}`);
} finally { store.close(); }
