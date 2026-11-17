#!/usr/bin/env node
// Usage: rakazo-ask <bot> <message...>     (message may also come from stdin)
//        rakazo-ask --list
// Env: BRIDGE_URL (default http://127.0.0.1:7480), BRIDGE_TOKEN (a CALLER_TOKENS value),
//      RAKAZO_ASK_MAX_WAIT_S (total wait incl. polling, default 600)
const base = (process.env.BRIDGE_URL || "http://127.0.0.1:7480").replace(/\/$/, "");
const token = process.env.BRIDGE_TOKEN;
const maxWait = Number(process.env.RAKAZO_ASK_MAX_WAIT_S || 600) * 1000;
if (!token) { console.error("Set BRIDGE_TOKEN"); process.exit(2); }
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return [r.status, j];
}

const [bot, ...rest] = process.argv.slice(2);
if (!bot || bot === "-h" || bot === "--help") {
  console.error("Usage: rakazo-ask <bot> <message>  |  rakazo-ask --list"); process.exit(2);
}
if (bot === "--list") {
  const [s, j] = await call("GET", "/bots");
  if (s !== 200) { console.error(j.error || s); process.exit(1); }
  console.log(j.bots.join("\n")); process.exit(0);
}
let message = rest.join(" ");
if (!message && !process.stdin.isTTY) { for await (const c of process.stdin) message += c; }
if (!message.trim()) { console.error("No message given"); process.exit(2); }

const start = Date.now();
let [status, j] = await call("POST", "/ask", { bot, message });
while (status === 202 && Date.now() - start < maxWait) {
  await new Promise((r) => setTimeout(r, 3000));
  [status, j] = await call("GET", `/result/${j.request_id}`);
}
if (status === 200) { console.log(j.reply); process.exit(0); }
if (status === 202) { console.error(`Still pending; poll later: request_id ${j.request_id}`); process.exit(3); }
console.error(j.error || `HTTP ${status}`); process.exit(1);
