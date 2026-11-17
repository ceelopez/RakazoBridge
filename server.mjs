#!/usr/bin/env node
// rakazo-bridge: lets external agents message Rakazo bots and get replies synchronously.
// Zero dependencies; Node >= 18.
import http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const env = process.env;
const PORT = Number(env.PORT || 7480);
const HOST = env.HOST || "127.0.0.1";
const ASK_TIMEOUT_MS = Number(env.ASK_TIMEOUT_S || 120) * 1000;
const RESULT_TTL_MS = Number(env.RESULT_TTL_S || 3600) * 1000;
const MAX_MESSAGE_CHARS = Number(env.MAX_MESSAGE_CHARS || 32000);
const RATE_PER_MIN = Number(env.RATE_LIMIT_PER_MIN || 30);
const PUBLIC_URL = (env.PUBLIC_URL || `http://${HOST}:${PORT}`).replace(/\/$/, "");
const CALLER_TOKENS = (env.CALLER_TOKENS || "").split(",").map((s) => s.trim()).filter(Boolean);
const BOT_TOKEN = env.BOT_TOKEN || "";

export function loadConfig(path = env.BOTS_CONFIG || "./bots.json") {
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const rakazoUrl = (env.RAKAZO_URL || cfg.rakazoUrl || "").replace(/\/$/, "");
  if (!rakazoUrl) throw new Error("Set rakazoUrl in bots.json or RAKAZO_URL");
  const bots = cfg.bots || {};
  for (const [name, b] of Object.entries(bots)) {
    if (!b.botId || !b.webhookSecret) throw new Error(`Bot "${name}" needs botId and webhookSecret`);
  }
  return { rakazoUrl, bots };
}

function safeEqual(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function bearer(req) {
  const m = /^bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return m ? m[1].trim() : "";
}
const authed = (req, tokens) => { const t = bearer(req); return !!t && tokens.some((k) => safeEqual(t, k)); };

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req, limit = 256 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 }); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

export function openapi() {
  return {
    openapi: "3.0.3",
    info: { title: "rakazo-bridge reply", version: "0.1.0", description: "Send your answer back to the external agent that messaged you." },
    servers: [{ url: PUBLIC_URL }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    security: [{ bearer: [] }],
    paths: {
      "/reply": {
        post: {
          operationId: "reply_to_external_agent",
          summary: "Reply to an external agent's message. Use the request_id from the incoming webhook message.",
          requestBody: { required: true, content: { "application/json": { schema: {
            type: "object", required: ["request_id", "text"],
            properties: {
              request_id: { type: "string", description: "The request_id from the incoming message" },
              text: { type: "string", description: "Your full answer" },
            },
          } } } },
          responses: { 200: { description: "Delivered" }, 404: { description: "Unknown or expired request_id" } },
        },
      },
    },
  };
}

export function createBridge({ config, fetchImpl = fetch, now = Date.now } = {}) {
  const pending = new Map(); // id -> { bot, createdAt, reply?, repliedAt?, waiters: Set<fn> }
  const hits = new Map();    // token -> [timestamps]

  const sweep = setInterval(() => {
    const t = now();
    for (const [id, r] of pending) if (t - r.createdAt > RESULT_TTL_MS) pending.delete(id);
  }, 60_000);
  sweep.unref();

  function rateOk(key) {
    const t = now(); const list = (hits.get(key) || []).filter((x) => t - x < 60_000);
    if (list.length >= RATE_PER_MIN) { hits.set(key, list); return false; }
    list.push(t); hits.set(key, list); return true;
  }

  function waitFor(id, ms) {
    const r = pending.get(id);
    if (!r) return Promise.resolve(null);
    if (r.reply !== undefined) return Promise.resolve(r.reply);
    return new Promise((resolve) => {
      const done = (v) => { clearTimeout(timer); r.waiters.delete(done); resolve(v); };
      const timer = setTimeout(() => done(null), ms);
      r.waiters.add(done);
    });
  }

  async function ask(body, caller) {
    const { bot, message } = body;
    if (typeof bot !== "string" || typeof message !== "string" || !message.trim())
      return [400, { error: "Body needs bot and message (strings)" }];
    if (message.length > MAX_MESSAGE_CHARS) return [413, { error: `message over ${MAX_MESSAGE_CHARS} chars` }];
    const target = config.bots[bot];
    if (!target) return [404, { error: `Unknown bot "${bot}"`, bots: Object.keys(config.bots) }];

    const id = randomUUID();
    pending.set(id, { bot, createdAt: now(), waiters: new Set() });
    const from = typeof body.from === "string" ? body.from.slice(0, 80) : caller;
    const payload = {
      request_id: id,
      from,
      message,
      reply_instructions: `Answer this message, then call reply_to_external_agent with request_id "${id}" and your answer as text.`,
    };
    let resp;
    try {
      resp = await fetchImpl(`${config.rakazoUrl}/api/v1/bots/${encodeURIComponent(target.botId)}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.webhookSecret}` },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      pending.delete(id);
      return [502, { error: `Could not reach Rakazo: ${e.message}` }];
    }
    if (!resp.ok) {
      pending.delete(id);
      const text = await resp.text().catch(() => "");
      return [502, { error: `Rakazo webhook returned ${resp.status}`, detail: text.slice(0, 500) }];
    }
    const wait = Math.min(Number(body.timeout_s) * 1000 || ASK_TIMEOUT_MS, ASK_TIMEOUT_MS);
    const reply = await waitFor(id, wait);
    if (reply === null) return [202, { status: "pending", request_id: id, poll: `/result/${id}` }];
    return [200, { status: "done", request_id: id, bot, reply }];
  }

  function reply(body) {
    const { request_id, text } = body;
    if (typeof request_id !== "string" || typeof text !== "string") return [400, { error: "Body needs request_id and text" }];
    const r = pending.get(request_id);
    if (!r) return [404, { error: "Unknown or expired request_id" }];
    if (r.reply !== undefined) return [409, { error: "Already replied" }];
    r.reply = text; r.repliedAt = now();
    for (const w of [...r.waiters]) w(text);
    return [200, { ok: true }];
  }

  function result(id) {
    const r = pending.get(id);
    if (!r) return [404, { error: "Unknown or expired request_id" }];
    if (r.reply === undefined) return [202, { status: "pending", request_id: id }];
    return [200, { status: "done", request_id: id, bot: r.bot, reply: r.reply }];
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    try {
      if (req.method === "GET" && p === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && p === "/openapi.json") return send(res, 200, openapi());

      if (req.method === "POST" && p === "/reply") {
        if (!BOT_TOKEN || !authed(req, [BOT_TOKEN])) return send(res, 401, { error: "Unauthorized" });
        return send(res, ...reply(await readJson(req)));
      }

      // Caller (external agent) routes
      if (!CALLER_TOKENS.length || !authed(req, CALLER_TOKENS)) return send(res, 401, { error: "Unauthorized" });
      const caller = `agent-${CALLER_TOKENS.findIndex((k) => safeEqual(bearer(req), k)) + 1}`;
      if (req.method === "GET" && p === "/bots") return send(res, 200, { bots: Object.keys(config.bots) });
      if (req.method === "GET" && p.startsWith("/result/")) return send(res, ...result(decodeURIComponent(p.slice(8))));
      if (req.method === "POST" && p === "/ask") {
        if (!rateOk(bearer(req))) return send(res, 429, { error: "Rate limit exceeded" });
        return send(res, ...(await ask(await readJson(req), caller)));
      }
      return send(res, 404, { error: "Not found" });
    } catch (e) {
      return send(res, e.status || 500, { error: e.status ? e.message : "Internal error" });
    }
  }

  return { handle, ask, reply, result, pending };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!CALLER_TOKENS.length) console.warn("warning: CALLER_TOKENS is empty; /ask is disabled");
  if (!BOT_TOKEN) console.warn("warning: BOT_TOKEN is empty; /reply is disabled");
  const config = loadConfig();
  const bridge = createBridge({ config });
  http.createServer(bridge.handle).listen(PORT, HOST, () =>
    console.log(`rakazo-bridge on http://${HOST}:${PORT} → ${config.rakazoUrl} (${Object.keys(config.bots).length} bots)`));
}
