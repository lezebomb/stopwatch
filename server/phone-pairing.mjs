import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const hash = value => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(24).toString("base64url");
export const phoneRef = credentialHash => hash(`SWPHONE-REF1:${credentialHash}`);
export const phoneProof = (credentialHash, challenge, code) => createHmac("sha256", Buffer.from(credentialHash, "hex"))
  .update(`SWPHONE1:${challenge}:${code}`).digest("hex");
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

// The relay already stores SHA-256(device bearer) for authentication. A separate
// domain binds this proof to a single browser challenge. Neither bearer nor its
// hash is sent over BLE, a QR, or to the browser. No new device secret is needed.
export function createPhonePairing(store) {
  const db = store.db;
  const device = (ref, now) => db.prepare("SELECT id,hash FROM sessions WHERE role='device' AND revoked=0 AND expires>?")
    .all(now).find(s => phoneRef(s.hash) === ref);
  return {
    begin(ref, browser, now = Date.now()) {
      if (!/^[a-f0-9]{64}$/.test(ref || "")) fail(400, "请连接挂件后开始配对");
      const target = device(ref, now);
      if (!target) fail(409, "挂件尚未准备好云端授权，请联系所有者；不需要重置 Muse 或 Wi-Fi");
      db.prepare("DELETE FROM phone_claims WHERE expires<=?").run(now);
      if (db.prepare("SELECT COUNT(*) AS n FROM phone_claims WHERE device_id=?").get(target.id).n >= 10)
        fail(429, "配对请求过多，请两分钟后重试");
      const challenge = opaque(), expires = now + 120000;
      db.prepare("INSERT INTO phone_claims(id,device_id,ref,browser_hash,expires,attempts,used) VALUES(?,?,?,?,?,0,0)")
        .run(challenge, target.id, ref, hash(browser), expires);
      return { challenge, expires };
    },
    complete({ challenge, code, proof }, browser, now = Date.now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = db.prepare("SELECT * FROM phone_claims WHERE id=?").get(typeof challenge === "string" ? challenge : "");
        if (!claim || claim.used || claim.expires <= now || claim.attempts >= 5 || claim.browser_hash !== hash(browser || ""))
          fail(401, "配对已过期或已使用，请在挂件重新开始");
        db.prepare("UPDATE phone_claims SET attempts=attempts+1 WHERE id=?").run(challenge);
        const target = db.prepare("SELECT hash FROM sessions WHERE id=? AND role='device' AND revoked=0 AND expires>?").get(claim.device_id, now);
        const valid = target && typeof code === "string" && typeof proof === "string" && /^\d{6}$/.test(code) && /^[a-f0-9]{64}$/.test(proof) &&
          timingSafeEqual(Buffer.from(phoneProof(target.hash, challenge, code), "hex"), Buffer.from(proof, "hex"));
        if (!valid) {
          db.exec("COMMIT"); // Wrong attempts must survive the rejected request.
          fail(401, "验证码或设备证明无效，最多尝试五次");
        }
        const token = opaque(), id = randomBytes(8).toString("hex");
        // Remember that the first manager was assigned even after revocation.
        // Scanning again must never silently become the next owner.
        const first = db.prepare("INSERT OR IGNORE INTO phone_owners(device_id,session_id) VALUES(?,?)").run(claim.device_id, id).changes === 1;
        const role = first ? "manager" : "viewer";
        db.prepare("INSERT INTO sessions VALUES(?,?,?,?,0)").run(hash(token), id, role, now + 30 * 86400000);
        db.prepare("INSERT INTO phone_links(session_id,device_id,ref,created) VALUES(?,?,?,?)").run(id, claim.device_id, claim.ref, now);
        db.prepare("UPDATE phone_claims SET used=1 WHERE id=?").run(challenge);
        db.exec("COMMIT");
        store.audit(id, first ? "phone.manager.paired" : "phone.viewer.paired");
        return { id, role, token, deviceId: claim.device_id, deviceRef: claim.ref };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    },
    list(deviceId, currentId) {
      return db.prepare("SELECT s.id,s.role,s.revoked,p.created,p.codex_control AS codexControl FROM phone_links p JOIN sessions s ON s.id=p.session_id WHERE p.device_id=? ORDER BY p.created")
        .all(deviceId).map(s => ({ ...s, phone: true, current: s.id === currentId }));
    },
    change(actor, id, role, reviewed = false) {
      if (actor.phone && id === actor.id && role === "revoke") { store.revoke(id); return; }
      if (!["manager", "operator"].includes(actor.role)) fail(403, "需要管理手机授权");
      const target = db.prepare("SELECT p.device_id,s.role,s.revoked FROM phone_links p JOIN sessions s ON s.id=p.session_id WHERE s.id=?").get(id);
      if (!target || target.revoked || (actor.role !== "operator" && actor.deviceId !== target.device_id)) fail(404, "手机授权不存在");
      if (["codex-on", "codex-off"].includes(role)) {
        if (actor.role !== "operator" || (role === "codex-on" && (!reviewed || target.role !== "manager"))) fail(403, "需要原控制端核对并授权管理手机的 Codex 权限");
        db.prepare("UPDATE phone_links SET codex_control=? WHERE session_id=?").run(role === "codex-on" ? 1 : 0, id);
        store.pending();
        store.audit(actor.id, `phone.${role}`); return;
      }
      if (id === actor.id) fail(409, "请使用另一台管理手机修改当前权限");
      if (role === "revoke") store.revoke(id);
      else if (["manager", "viewer"].includes(role)) {
        db.prepare("UPDATE sessions SET role=? WHERE id=?").run(role, id);
        if (role === "viewer") db.prepare("UPDATE phone_links SET codex_control=0 WHERE session_id=?").run(id);
        store.pending();
      }
      else fail(400, "只支持照片管理或只读权限");
      store.audit(actor.id, `phone.${role}`);
    },
  };
}
