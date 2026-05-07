# Spec: Agent over Telegram (the agent lives outside the browser)

## Goal

Let users talk to the same agent from a Telegram chat. Inbound message → agent runs with Composio tools → reply delivered as a Telegram message. The agent can authorize Composio toolkits (Gmail, Calendar, etc.) inline by replying with the OAuth link.

## Use case (validated demo)

User in Telegram (`@myai_composio_bot`): *"fetch my latest emails"*

Agent on first run (Gmail not connected for this Telegram chat) replies with a Composio OAuth URL. User clicks → grants Gmail access → returns to Telegram → re-asks → agent fetches emails and replies.

This proves the full pipeline: Telegram → webhook → secret check → background agent → Composio tools → reply back to Telegram.

## In scope (v1)

1. **Telegram bot** registered via [@BotFather](https://t.me/BotFather), token in `.env.local`.
2. **Webhook handler** at `/api/telegram-webhook` — validates Telegram's `x-telegram-bot-api-secret-token` header, parses `update.message`, dispatches the agent in the background, and returns `{ok:true}` immediately.
3. **`lib/telegram.ts`** — thin Telegram Bot API client: `sendTelegramMessage`, `getWebhookInfo`, `setWebhook`, `deleteWebhook`, `getBotInfo`.
4. **`/telegram` admin page** — server component with server actions to inspect bot info, register/delete webhook, send a test message. Useful for tutorial walk-through and for re-registering after ngrok URL changes.
5. **Per-Telegram-chat Composio identity** — `composio.create(chatId)` uses Telegram's `chat.id` as the Composio external user ID. Each Telegram chat is its own Composio user with its own connections.
6. **Background execution via `after()`** — the webhook returns `200 OK` within milliseconds; the agent runs in `next/server` `after()` so we don't hit Telegram's strict response time limit and our request can take 30–120s.

## Explicitly NOT in scope (v1)

- **Account linking between Telegram and the web app.** A user logged in to the web app (`User.id` in Postgres) is *not* the same identity as their Telegram chat. Per-app, per-channel Composio accounts. See "Multi-tenant / B2B section" below.
- **Group chats.** Webhook handler explicitly filters `chat.type === "private"`. Anything else is dropped.
- **File attachments / voice / images.** Only `message.text` is read.
- **Streaming responses.** We use `generateText` (one-shot) because Telegram doesn't have a "typing partial token" UX. Each agent turn is a single Telegram message.
- **Session memory across messages.** Each inbound message is a fresh agent turn — no message history. Pair with Supermemory if you want persistence (homework).
- **Chat history into the web app sidebar.** Telegram messages don't persist into the `Chat` / `Message_v2` tables.

## ⚠️ Local dev caveats (read before testing)

Anyone working on this codebase will hit these.

### 1. Telegram requires HTTPS for webhooks

The webhook URL must be public HTTPS — Telegram won't deliver to `localhost`. Two options for local dev:

- **ngrok** (used during this build): `ngrok http 3000` gives you `https://<random>.ngrok-free.app` → use that as the webhook URL.
- **Deployed preview**: every Vercel preview deploy gets a stable HTTPS URL; use that.

### 2. ngrok URLs change on every restart (free tier)

Each `ngrok http 3000` produces a new subdomain. After restarting ngrok, the registered webhook is dead and Telegram silently drops messages. Symptoms: no errors, just nothing happens.

**Fix**: re-register via the `/telegram` page or with curl:

```bash
TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' .env.local | cut -d= -f2-)
SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' .env.local | cut -d= -f2-)
NEW_URL="https://<your-ngrok-host>/api/telegram-webhook"

curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"${NEW_URL}\",\"secret_token\":\"${SECRET}\",\"allowed_updates\":[\"message\"]}"

# Verify
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | python3 -m json.tool
```

### 3. Env vars require a dev server restart

Adding `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` to `.env.local` after `pnpm dev` is already running won't pick them up. Restart the dev server.

Symptom: webhook returns `503 {"error":"Telegram not configured"}`.

### 4. Webhook auth bypass is not optional

Anyone who guesses your webhook URL can POST malformed updates. Always set `TELEGRAM_WEBHOOK_SECRET` (any random string), and the handler's `timingSafeEqual` check rejects anything else. Telegram automatically includes the secret in the `x-telegram-bot-api-secret-token` header for every delivery if you registered with `secret_token`.

### 5. Test workflow (local)

```bash
# 1. Start ngrok
ngrok http 3000

# 2. Visit http://localhost:3000/telegram → "Register webhook"
#    (uses the ngrok URL automatically)

# 3. On your phone, open Telegram, search @<your_bot_username>, send any message.

# 4. Watch the dev terminal — should see:
#    POST /api/telegram-webhook 200 in <ms>

# 5. Agent reply should arrive in Telegram within 5–30s.
```

To simulate an inbound message without using Telegram (useful for CI / debugging):

```bash
SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' .env.local | cut -d= -f2-)
curl -X POST http://localhost:3000/api/telegram-webhook \
  -H "Content-Type: application/json" \
  -H "x-telegram-bot-api-secret-token: ${SECRET}" \
  -d '{
    "update_id": 1,
    "message": {
      "message_id": 1,
      "date": '$(date +%s)',
      "chat": {"id": 123456789, "type": "private"},
      "from": {"id": 123456789, "first_name": "Test"},
      "text": "fetch my latest emails"
    }
  }'
```

(Reply will fail to deliver because chat_id is fake — that's expected; it proves the handler runs.)

### 6. Production verification

After deploy:

1. Re-register the webhook to point at the Vercel URL (one-time):
   ```bash
   curl -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{"url":"https://your-app.vercel.app/api/telegram-webhook","secret_token":"<secret>","allowed_updates":["message"]}'
   ```
2. `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `COMPOSIO_API_KEY`, `AI_GATEWAY_API_KEY` (or OIDC) must be set in Vercel env vars.
3. Send a test message to the bot. Watch Vercel function logs for `POST /api/telegram-webhook`.

## Architecture

```
┌─────────────┐         POST /api/telegram-webhook
│  Telegram   │  ─────────────────────────────────► ┌────────────────────┐
│   user      │  with header                        │  Webhook handler   │
└─────────────┘  x-telegram-bot-api-secret-token    │ (Next route)       │
                                                    │                    │
                                                    │ 1. timingSafeEqual │
                                                    │    secret check    │
                                                    │ 2. parse update    │
                                                    │ 3. after(runAgent) │
                                                    │ 4. return 200      │
                                                    └─────────┬──────────┘
                                                              │
                              (background, up to maxDuration) │
                                                              ▼
                                                    ┌────────────────────┐
                                                    │  runAgent(chatId,  │
                                                    │           text)    │
                                                    │                    │
                                                    │ composio.create    │
                                                    │   (chatId)         │
                                                    │   .tools()         │
                                                    │                    │
                                                    │ generateText({...})│
                                                    │                    │
                                                    │ sendTelegram-      │
                                                    │   Message(chatId,  │
                                                    │   reply)           │
                                                    └─────────┬──────────┘
                                                              │
                            POST /sendMessage to Bot API      │
┌─────────────┐  ◄──────────────────────────────────────────┘
│  Telegram   │  reply lands in user's chat
│   user      │
└─────────────┘
```

## Multi-tenant / B2B SaaS — how does this scale?

You asked: "Is the Telegram stuff only on a 1-1 basis? How would it sync with the rest of a user's chats if they authenticate through the web app?"

The honest answer: **as built, yes, it's per-Telegram-chat with no link to web user accounts.**

### Why

In `app/api/telegram-webhook/route.ts`:

```ts
const composio = new Composio({ provider: new VercelProvider() });
const session = await composio.create(chatId); // <-- Telegram chat.id
```

Composio scopes all connections by external user ID. Since we pass the Telegram `chat.id`:

- Each Telegram chat = its own Composio user → its own Gmail / Calendar connections.
- A user logged into the web app at `https://your-app.com` with `User.id = abc-123` is a *different* Composio user than the same human's Telegram chat with `chat.id = 987654321`. They'll be asked to reconnect Gmail in each channel.

### What "linking" looks like (homework)

To unify identities for B2B / multi-tenant:

1. **Add a `TelegramLink` table:**
   ```sql
   CREATE TABLE "TelegramLink" (
     "telegramChatId" varchar PRIMARY KEY,
     "userId"         uuid NOT NULL REFERENCES "User"("id"),
     "linkedAt"       timestamptz NOT NULL DEFAULT now()
   );
   ```
2. **Add a `/settings` flow on the web app** that generates a one-time link code (e.g. 6 digits) per logged-in user, stored in a short-lived table.
3. **Special-case `/link <code>` in the webhook handler:** look up the code, insert the `TelegramLink` row, reply "linked".
4. **In `runAgent`**, replace `composio.create(chatId)` with:
   ```ts
   const link = await getTelegramLink(chatId);
   const composioUserId = link?.userId ?? chatId;  // fall back to chat-only
   const session = await composio.create(composioUserId);
   ```

After that, `chatId X linked to userId Y` means a Telegram message from chat X uses Y's Gmail connection — same connection the web app uses.

### What about a B2B SaaS with one bot per customer?

Two patterns, pick one:

| Pattern | When to use | How |
|---|---|---|
| **One bot, account linking** (recommended) | You own the bot. Customers' employees link their personal Telegram. | `TelegramLink` table as above; one bot in BotFather; works for unlimited tenants. |
| **One bot per customer** | Each customer organization has its own branded bot. | Each tenant gets a `botToken` row in DB; webhook URL has the tenant ID baked in (`/api/telegram-webhook/<tenantId>`); each tenant runs `setWebhook` with their own token. |

For most B2B AI products, pattern #1 is enough. Pattern #2 only matters if you're white-labeling Telegram bots.

### What about chat history / sidebar sync?

Currently, Telegram messages don't get persisted into your `Chat` / `Message_v2` tables. To unify:

- After agent reply, also INSERT a row into the user's "Telegram" chat in your DB (auto-create the Chat on first Telegram message).
- The web sidebar then shows a single "📱 Telegram" thread with the same messages.
- Out of v1 scope but ~30 lines.

## Core files

| File | Purpose |
|---|---|
| `app/api/telegram-webhook/route.ts` | POST handler — secret check, parse, dispatch agent in `after()` |
| `lib/telegram.ts` | Bot API helpers: `sendTelegramMessage`, `getWebhookInfo`, `setWebhook`, `deleteWebhook`, `getBotInfo` |
| `app/telegram/page.tsx` | Server component admin: bot info, webhook status, register/delete forms, send test message |
| `.env.local` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (any random string) |

## Required env vars

| Var | Where it comes from | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` | Authenticates calls to Telegram Bot API |
| `TELEGRAM_WEBHOOK_SECRET` | You invent it (any random string, ≥32 chars recommended) | Header secret Telegram sends with every delivery — proves the request is from Telegram |
| `COMPOSIO_API_KEY` | [Composio dashboard](https://app.composio.dev) | Tool integrations |
| `AI_GATEWAY_API_KEY` *(or OIDC)* | Vercel AI Gateway | Model access |

## Reference docs

These are the canonical sources we built against. Bookmark them.

- **[Telegram Bot API](https://core.telegram.org/bots/api)** — full method reference. Search this page for `setWebhook`, `sendMessage`, `Update`, `Message`.
- **[Marvin's Marvellous Guide to All Things Webhook](https://core.telegram.org/bots/webhooks)** — webhook setup, IP allowlists, certs, debugging tips.
- **[Bots: An introduction for developers](https://core.telegram.org/bots)** — high-level overview, BotFather walkthrough.
- **[Bot API changelog](https://core.telegram.org/bots/api-changelog)** — track breaking changes.
- **[Bots FAQ](https://core.telegram.org/bots/faq)** — common gotchas.

### Specific methods used

- [`setWebhook`](https://core.telegram.org/bots/api#setwebhook) — register the URL Telegram should POST updates to. Accepts `secret_token` and `allowed_updates`.
- [`getWebhookInfo`](https://core.telegram.org/bots/api#getwebhookinfo) — see current registration, pending updates, last error.
- [`deleteWebhook`](https://core.telegram.org/bots/api#deletewebhook) — clear it (e.g. when switching to long polling locally).
- [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) — send a reply. Supports `parse_mode: "Markdown"`.
- [`getMe`](https://core.telegram.org/bots/api#getme) — bot info / token validation.
- [`Update`](https://core.telegram.org/bots/api#update) — incoming payload shape.
- [`Message`](https://core.telegram.org/bots/api#message) — `chat.id`, `text`, `from`, etc.

## Production correctness (v1)

- **Per-chat isolation**: every webhook call uses `chat.id` as the Composio external user ID. No cross-chat leakage.
- **Auth**: `timingSafeEqual` on the secret header. Rejects everything that isn't from your registered Telegram webhook.
- **Group chats blocked**: `chat.type !== "private"` short-circuits to `{ok:true}` without running anything.
- **Telegram timeout safe**: handler responds in <100ms; agent runs in `after()` for up to `maxDuration: 300` seconds.
- **Reply length**: clipped to 4096 chars (Telegram's per-message limit).

## Build order (if rebuilding)

1. Create bot with [@BotFather](https://t.me/BotFather), copy token to `.env.local` as `TELEGRAM_BOT_TOKEN`.
2. Generate a random `TELEGRAM_WEBHOOK_SECRET` (any string).
3. Add `lib/telegram.ts` (Bot API client).
4. Add `app/api/telegram-webhook/route.ts` (handler).
5. Add `app/telegram/page.tsx` (admin UI).
6. Restart `pnpm dev`, start `ngrok http 3000`, register webhook via `/telegram`.
7. Send a test message from your phone.
