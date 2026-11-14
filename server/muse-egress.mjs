import { lookup } from "node:dns/promises";
import { BlockList, createConnection, isIP } from "node:net";
import { WebSocketServer, createWebSocketStream } from "ws";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(address, prefix, "ipv4");

export function museDestination(host) {
  if (typeof host !== "string" || host.length > 253) return false;
  if (host === "api.muse.ai") return true;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.metaaivm\.com$/.test(host);
}

/* Carries opaque official TLS bytes. No TLS termination to Muse, account
 * credential handling, shell execution, arbitrary destination or new port. */
export function createMuseEgress({
  session, enabled = false, resolve = lookup, connect = createConnection,
  checkInterval = 30000,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536,
    perMessageDeflate: false });
  const active = new Set();
  const counts = new Map();
  const reject = (socket, code) => socket.end(
    `HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  return {
    upgrade(req, socket, head) {
      let url;
      try { url = new URL(req.url, "http://localhost"); } catch { return false; }
      if (url.pathname !== "/api/device/muse-tunnel") return false;
      socket.on("error", () => {});
      if (!enabled) { reject(socket, 503); return true; }
      const token = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization || "")?.[1];
      const owner = token && session(token);
      if (owner?.role !== "device") { reject(socket, 401); return true; }
      const host = url.searchParams.get("host");
      if (!museDestination(host) || [...url.searchParams.keys()].some(key => key !== "host") ||
          url.searchParams.getAll("host").length !== 1) {
        reject(socket, 400); return true;
      }
      if (active.size >= 16 || (counts.get(owner.id) || 0) >= 6) {
        reject(socket, 429); return true;
      }
      let upstream, ws, stream, closed = false, check;
      const authorized = () => {
        const current = session(token);
        return current?.role === "device" && current.id === owner.id;
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        clearTimeout(deadline); clearInterval(check);
        upstream?.destroy(); stream?.destroy(); ws?.terminate(); socket.destroy();
        active.delete(finish);
        const count = (counts.get(owner.id) || 1) - 1;
        if (count) counts.set(owner.id, count); else counts.delete(owner.id);
      };
      const deadline = setTimeout(finish, 10000).unref();
      active.add(finish); counts.set(owner.id, (counts.get(owner.id) || 0) + 1);
      socket.once("close", finish);
      (async () => {
        const addresses = await resolve(host, { family: 4, all: true, verbatim: true });
        if (closed) return;
        if (!addresses.length || addresses.some(row => isIP(row.address) !== 4 ||
            blocked.check(row.address, "ipv4"))) {
          reject(socket, 403); return;
        }
        // Pin the validated IP; never resolve the hostname again in connect().
        upstream = connect({ host: addresses[0].address, port: 443, family: 4 });
        upstream.on("error", finish);
        // Normal EOF must drain queued encrypted bytes through the WS stream.
        // Terminating here would truncate the final TLS record on a slow link.
        upstream.once("close", hadError => { if (hadError || !ws) finish(); });
        upstream.once("connect", () => {
          if (closed) return;
          if (!authorized()) { reject(socket, 401); return; }
          clearTimeout(deadline);
          upstream.setTimeout(180000, finish);
          wss.handleUpgrade(req, socket, head, connection => {
            ws = connection;
            ws.on("error", finish); ws.once("close", finish);
            ws.on("message", (_bytes, binary) => { if (!binary) finish(); });
            stream = createWebSocketStream(ws, { highWaterMark: 16384 });
            stream.on("error", finish);
            stream.pipe(upstream).pipe(stream);
            check = setInterval(() => {
              if (!authorized()) finish();
              else if (ws.readyState === 1) ws.ping();
            }, checkInterval).unref();
          });
        });
      })().catch(() => { if (!closed) reject(socket, 502); });
      return true;
    },
    close() { for (const finish of [...active]) finish(); wss.close(); },
    get active() { return active.size; },
  };
}
