import { Store } from "../server/store.mjs";
const store = new Store(".data");
const ticket = store.ticket(
  process.argv.includes("--viewer") ? "viewer" : "operator",
);
console.log(
  `两分钟有效、一次性配对：\nhttp://127.0.0.1:${process.env.PORT || 8787}/#pair=${ticket.code}`,
);
store.close();
