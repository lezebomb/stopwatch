import path from "node:path";
import { pathToFileURL } from "node:url";
import { activePortalRelease } from "../updates/portal.mjs";

const root = process.env.STOPWATCH_HOME;
if (!path.isAbsolute(root || "")) throw new Error("An absolute STOPWATCH_HOME is required");
const release = await activePortalRelease(root);
process.chdir(release);
process.env.STOPWATCH_WEB_ROOT = path.join(release, "dist");
await import(pathToFileURL(path.join(release, "server/main.mjs")).href);
