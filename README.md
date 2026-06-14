# Hermes Companion

A secured, installable mobile **PWA + reverse proxy** for the
[Hermes Agent](https://github.com/NousResearch/hermes) (Nous Research) — chat with
and operate your self-hosted Hermes from your phone.

Hermes already exposes a rich dashboard REST API and an OpenAI-compatible chat
gateway, but both are typically unauthenticated and meant for a desktop browser.
Hermes Companion puts a **phone-native, password-gated face** over them, so you can
safely use Hermes from an iPhone/Android home-screen app over a private network you
control.

> It does **not** reimplement Hermes — it proxies Hermes' own API and gateway and
> serves a mobile UI. Point it at any Hermes instance you control.

## Features

- **Chat** — streaming, multimodal: text, **photos** (vision), **video** (client-side
  frame sampling → vision), **voice notes** (record → transcribe), and **spoken
  replies** (tap to hear, TTS). Uses Hermes' OpenAI-compatible gateway + audio API.
- **Status** — live gateway/channel health, host stats, sessions, long-term memory.
- **Ops** — cron jobs (run/pause/resume), gateway start/stop/restart, session
  browse/prune, doctor/backup/security-audit, logs.
- **Settings** — model assignment, skill toggles, env vars, raw config editor.
- **More** — usage analytics, Kanban, profiles, webhooks, MCP servers, achievements.
- **Web Push** alerts (when served over HTTPS) on gateway-down / channel-disconnect /
  cron-failure. VAPID keys auto-generate on first boot.
- **Installable PWA** — add to home screen, runs full-screen, offline app shell.

## Security model

- One **password** → signed, httpOnly session cookie. Everything except the login
  page and static shell requires a valid session.
- All upstream secrets (the gateway key, the dashboard token) are held **server-side**
  and injected by the proxy. The browser never sees them.
- Intended to run **bound to loopback and exposed only over a private network**
  (a reverse proxy, VPN, or a LAN you trust). Don't expose it to the public internet
  without putting a TLS terminator and your own hardening in front.

## Quick start (Docker)

```bash
cp .env.example .env        # then edit .env
docker build -t hermes-companion:1 .
docker run -d --name hermes-companion --network host \
  --env-file .env -v "$PWD/data:/data" hermes-companion:1
# open http://127.0.0.1:8410/  (or your private-network address)
```

Or with Compose: copy `docker-compose.example.yml` to `docker-compose.yml`, edit the
environment, and `docker compose up -d`.

### HTTPS (required for voice recording + push)

Browsers only grant microphone access and Web Push in a **secure context** (HTTPS or
localhost). Over plain HTTP you still get text, photos, video and spoken replies, but
not voice-note *recording* or push.

To enable them, serve the app over HTTPS with a certificate your phone trusts — put it
behind any TLS-terminating reverse proxy or private tunnel you prefer. Keep the app
itself bound to loopback (`COMPANION_BIND=127.0.0.1`) and let the proxy handle TLS and
exposure. (If you serve it over plain HTTP on a private address instead, set
`COMPANION_COOKIE_SECURE=0`.)

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `COMPANION_PASSWORD` | *(required)* | Login passphrase |
| `COMPANION_SECRET` | `change-me-please` | Cookie-signing secret (set a strong random value) |
| `GATEWAY_KEY` | *(empty)* | Bearer key for the Hermes OpenAI gateway |
| `GATEWAY_MODEL` | `hermes-router` | Model name sent to the gateway |
| `HERMES_DASH_URL` | `http://127.0.0.1:30433` | Hermes dashboard base URL |
| `HERMES_GW_URL` | `http://127.0.0.1:30432` | Hermes gateway base URL |
| `HERMES_DASH_TOKEN` | *(auto)* | Dashboard bearer; auto-scraped if Hermes runs in insecure mode |
| `COMPANION_BIND` | `0.0.0.0` | Bind address |
| `COMPANION_PORT` | `8410` | Bind port |
| `COMPANION_COOKIE_SECURE` | `1` | Set `0` only when serving over plain HTTP |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Contact for Web Push |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | *(auto)* | Auto-generated + persisted to `data/vapid.json` if unset |

## How it talks to Hermes

- **Chat** → `POST {HERMES_GW_URL}/v1/chat/completions` (OpenAI-compatible, streaming),
  with the gateway key. Multimodal content uses standard `image_url` parts; audio uses
  Hermes' `/api/audio/transcribe` and `/api/audio/speak`.
- **Everything else** → proxied to `{HERMES_DASH_URL}/api/*` with the dashboard token.

## Tech

Single-file FastAPI backend (`server.py`), dependency-free vanilla-JS PWA front-end
(`static/`). No build step.

## License

MIT — see [LICENSE](LICENSE).
