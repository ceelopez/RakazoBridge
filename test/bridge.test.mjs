import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.CALLER_TOKENS = "caller-secret";
process.env.BOT_TOKEN = "bot-secret";
process.env.ASK_TIMEOUT_S = "1";
const { createBridge } = await import("../server.mjs");

const config = { rakazoUrl: "http://rakazo.test", bots: { zoe: { botId: "b1", webhookSecret: "wh" } } };

async function start(fetchImpl) {
  const bridge = createBridge({ config, fetchImpl });
  const server = http.createServer(bridge.handle);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const req = (method, path, body, token = "caller-secret") =>
    fetch(url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body && JSON.stringify(body) })
      .then(async (r) => [r.status, await r.json()]);
  return { server, req };
}

test("ask → webhook → reply round trip", async () => {
  let seen;
  let req;
  const fetchImpl = async (u, init) => {
    seen = { u, init, body: JSON.parse(init.body) };
    // simulate the bot calling the reply tool shortly after
    setTimeout(() => req("POST", "/reply", { request_id: seen.body.request_id, text: "hello muse" }, "bot-secret"), 50);
    return new Response("{}", { status: 200 });
  };
  const s = await start(fetchImpl); req = s.req;
  const [status, j] = await req("POST", "/ask", { bot: "zoe", message: "hi" });
  assert.equal(status, 200);
  assert.equal(j.reply, "hello muse");
  assert.equal(seen.u, "http://rakazo.test/api/v1/bots/b1/webhook");
  assert.equal(seen.init.headers.authorization, "Bearer wh");
  s.server.close();
});

test("timeout returns 202 and result can be polled", async () => {
  const s = await start(async () => new Response("{}", { status: 200 }));
  const [status, j] = await s.req("POST", "/ask", { bot: "zoe", message: "slow" });
  assert.equal(status, 202);
  assert.deepEqual(await s.req("GET", `/result/${j.request_id}`), [202, { status: "pending", request_id: j.request_id }]);
  await s.req("POST", "/reply", { request_id: j.request_id, text: "late" }, "bot-secret");
  const [s2, j2] = await s.req("GET", `/result/${j.request_id}`);
  assert.equal(s2, 200); assert.equal(j2.reply, "late");
  s.server.close();
});

test("auth and validation", async () => {
  const s = await start(async () => new Response("{}", { status: 200 }));
  assert.equal((await s.req("POST", "/ask", { bot: "zoe", message: "x" }, "wrong"))[0], 401);
  assert.equal((await s.req("POST", "/reply", { request_id: "x", text: "y" }, "caller-secret"))[0], 401);
  assert.equal((await s.req("POST", "/ask", { bot: "nobody", message: "x" }))[0], 404);
  assert.equal((await s.req("POST", "/reply", { request_id: "nope", text: "y" }, "bot-secret"))[0], 404);
  assert.deepEqual(await s.req("GET", "/bots"), [200, { bots: ["zoe"] }]);
  s.server.close();
});

test("rakazo error surfaces as 502", async () => {
  const s = await start(async () => new Response("bad secret", { status: 401 }));
  const [status, j] = await s.req("POST", "/ask", { bot: "zoe", message: "x" });
  assert.equal(status, 502); assert.match(j.error, /401/);
  s.server.close();
});
