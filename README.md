# rakazo-bridge

Let external AI agents (or scripts) **message your self-hosted [Rakazo](https://github.com/elie222/rakazo) bots and get the reply back**, over plain HTTP or a CLI.

Rakazo bots can already be started by a webhook, but the webhook only returns a run id, not the bot's answer. rakazo-bridge closes the loop:

```
Agent ──POST /ask──► rakazo-bridge ──POST /api/v1/bots/:id/webhook──► Rakazo bot
  ▲                     │ (holds the request open)                        │
  └────── reply ────────┘◄──── POST /reply  (OpenAPI tool the bot calls) ─┘
```

There are no changes to Rakazo and no npm dependencies. It needs Node 18 or newer.

## Quick start

```bash
git clone <this repo> rakazo-bridge && cd rakazo-bridge
cp .env.example .env            # fill CALLER_TOKENS and BOT_TOKEN (openssl rand -hex 32)
cp bots.example.json bots.json  # fill rakazoUrl and your bots
npm start                       # or: docker compose -f compose.example.yml up -d
```

## Set up each bot in Rakazo

1. **Webhook routine.** In the bot's routines, add a routine that runs **on webhook**. Copy its URL (the `botId` is in `/api/v1/bots/<botId>/webhook`) and its **signing secret** into `bots.json`. Suggested routine instructions:

   > This is a message from an external agent. Read `message`, answer it, then call `reply_to_external_agent` with the same `request_id` and your full answer as `text`. Always reply, even if you can't help.

2. **Reply tool.** Under **Integrations**, add an **OpenAPI** source:
   - URL: `<PUBLIC_URL>/openapi.json`
   - Auth: bearer token = your `BOT_TOKEN`
   - Limit it to the bots you're bridging.

3. **Approval.** Webhook runs follow your approval mode. Add `reply_to_external_agent` to **Always allow**, or every reply will wait for a human.

### Letting Rakazo reach a private bridge

By default, Rakazo refuses tool URLs on private addresses: localhost, LAN, Tailscale `100.x`, and docker networks. If the bridge runs on your own network, you have two options.

- **Allow private endpoints.** In Rakazo's `.env`, set:

  ```
  MCP_ALLOW_PRIVATE_ENDPOINT=true
  ```

  Then restart the api and worker:

  ```bash
  docker compose --env-file .env -f docker-compose.images.yml up -d api worker
  ```

  Point the OpenAPI source at an address the Rakazo containers can reach, such as the host's LAN or Tailscale IP (`PUBLIC_URL`). The trade-off is that every bot's MCP and OpenAPI tools can now reach your private network.
- **Serve the bridge over public HTTPS.** Use a reverse proxy or a Cloudflare tunnel, and expose only `/reply` and `/openapi.json`.

To check that the Rakazo containers can reach the bridge:

```bash
docker exec rakazo-api-1 node -e 'fetch("http://<PUBLIC_URL host>:7480/health").then(r=>r.text()).then(console.log)'
```

## Use it

**HTTP**

```bash
curl -s -X POST $BRIDGE_URL/ask \
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H 'content-type: application/json' \
  -d '{"bot":"assistant","message":"What did you work on today?"}'
# 200 {"status":"done","request_id":"…","bot":"assistant","reply":"…"}
# 202 {"status":"pending","request_id":"…","poll":"/result/…"}   (took longer than ASK_TIMEOUT_S)
```

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/ask` | caller token | `{bot, message, from?, timeout_s?}`, waits for the reply |
| GET | `/result/:request_id` | caller token | Poll a pending answer |
| GET | `/bots` | caller token | List addressable bot names |
| POST | `/reply` | `BOT_TOKEN` | `{request_id, text}`, called by the bot's tool |
| GET | `/openapi.json` | none | Tool spec for Rakazo |
| GET | `/health` | none | Liveness |

**CLI** (good for agents that have SSH access to the host)

```bash
export BRIDGE_URL=http://127.0.0.1:7480 BRIDGE_TOKEN=…
./bin/rakazo-ask.mjs --list
./bin/rakazo-ask.mjs assistant "Summarize your last run"
echo "long prompt…" | ./bin/rakazo-ask.mjs assistant
# remote agent: ssh myhost 'BRIDGE_TOKEN=… rakazo-bridge/bin/rakazo-ask.mjs assistant "hi"'
```

The CLI keeps polling pending answers for up to `RAKAZO_ASK_MAX_WAIT_S` (600 by default).

## Configuration

All settings are in `.env.example`: `HOST`, `PORT`, `PUBLIC_URL`, `CALLER_TOKENS` (comma-separated, one per agent), `BOT_TOKEN`, `BOTS_CONFIG`, `RAKAZO_URL`, `ASK_TIMEOUT_S`, `RESULT_TTL_S`, `RATE_LIMIT_PER_MIN`, `MAX_MESSAGE_CHARS`.

## Security notes

- Keep the bridge on a private network (localhost, LAN, Tailscale). Anyone with a caller token can make your bots run.
- Agents and bots use separate tokens, and tokens are compared in constant time. `/ask` is rate-limited per token.
- Only bots listed in `bots.json` can be reached. Webhook secrets never leave the bridge.
- Rakazo treats webhook text as untrusted outside input. Keep the bot's **Always allow** list narrow.
- Pending results are held in memory and are lost if the bridge restarts.

## Development

```bash
npm test
```

## License

MIT
