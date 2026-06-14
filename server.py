"""
Hermes Companion — a secured mobile PWA front-end + reverse proxy for the
Hermes Agent dashboard API (:30433) and OpenAI-compatible chat gateway (:30432).

Design:
  * Holds all upstream secrets server-side (dashboard bearer token, gateway key).
    The browser never sees them.
  * One password login -> signed, httpOnly session cookie. Everything except the
    login page / static shell requires a valid session.
  * Reverse-proxies /api/* to the Hermes dashboard, injecting the bearer token.
  * Proxies /__chat to the gateway with SSE streaming.
  * Serves the PWA and handles Web Push (VAPID) for alerts.
  * A background watcher polls status + cron health and pushes notifications
    on bad transitions (gateway down, platform disconnect, cron failure).

Intended to run bound to loopback behind a TLS-terminating reverse proxy on a
private network; not exposed directly to the public internet.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import (
    StreamingResponse,
    JSONResponse,
    FileResponse,
    HTMLResponse,
)
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# ---------------------------------------------------------------------------
# Config (from environment, set by the deploy)
# ---------------------------------------------------------------------------
DASH_URL = os.environ.get("HERMES_DASH_URL", "http://127.0.0.1:30433").rstrip("/")
GW_URL = os.environ.get("HERMES_GW_URL", "http://127.0.0.1:30432").rstrip("/")
GATEWAY_KEY = os.environ.get("GATEWAY_KEY", "")
GATEWAY_MODEL = os.environ.get("GATEWAY_MODEL", "hermes-router")
PASSWORD = os.environ.get("COMPANION_PASSWORD", "")
SECRET = os.environ.get("COMPANION_SECRET", "change-me-please")
DASH_TOKEN_OVERRIDE = os.environ.get("HERMES_DASH_TOKEN", "")
DATA_DIR = Path(os.environ.get("COMPANION_DATA", "/data"))
STATIC_DIR = Path(__file__).parent / "static"
COOKIE = "hsid"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days
COOKIE_SECURE = os.environ.get("COMPANION_COOKIE_SECURE", "1") != "0"  # 0 only for local HTTP test
WATCH_INTERVAL = int(os.environ.get("COMPANION_WATCH_INTERVAL", "60"))

# Web Push (VAPID) — auto-generated & persisted on first boot if not supplied
VAPID_PUBLIC = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUB = os.environ.get("VAPID_SUBJECT", "mailto:admin@example.com")
VAPID_FILE = Path(os.environ.get("COMPANION_DATA", "/data")) / "vapid.json"


def ensure_vapid():
    """Load or generate a VAPID keypair so Web Push works with zero setup."""
    global VAPID_PUBLIC, VAPID_PRIVATE
    if VAPID_PUBLIC and VAPID_PRIVATE:
        return
    if VAPID_FILE.exists():
        try:
            d = json.loads(VAPID_FILE.read_text())
            VAPID_PUBLIC, VAPID_PRIVATE = d["public"], d["private"]
            return
        except Exception:
            pass
    try:
        import base64
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives import serialization
        key = ec.generate_private_key(ec.SECP256R1())
        pem = key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ).decode()
        pub_point = key.public_key().public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        pub_b64 = base64.urlsafe_b64encode(pub_point).rstrip(b"=").decode()
        VAPID_PUBLIC, VAPID_PRIVATE = pub_b64, pem
        VAPID_FILE.write_text(json.dumps({"public": pub_b64, "private": pem}))
    except Exception:
        VAPID_PUBLIC = VAPID_PRIVATE = ""

DATA_DIR.mkdir(parents=True, exist_ok=True)
SUBS_FILE = DATA_DIR / "push_subscriptions.json"
STATE_FILE = DATA_DIR / "watch_state.json"

signer = URLSafeTimedSerializer(SECRET, salt="hermes-companion-session")

# ---------------------------------------------------------------------------
# App + shared HTTP client + dashboard token cache
# ---------------------------------------------------------------------------
app = FastAPI(title="Hermes Companion", docs_url=None, redoc_url=None, openapi_url=None)
client: Optional[httpx.AsyncClient] = None
_dash_token: str = DASH_TOKEN_OVERRIDE
_token_lock = asyncio.Lock()

TOKEN_RE = re.compile(r'__HERMES_SESSION_TOKEN__="([^"]+)"')


async def scrape_dash_token() -> str:
    """Read the static bearer the dashboard injects into its HTML (insecure mode)."""
    global _dash_token
    async with _token_lock:
        try:
            r = await client.get(f"{DASH_URL}/", timeout=8)
            m = TOKEN_RE.search(r.text)
            if m:
                _dash_token = m.group(1)
        except Exception:
            pass
        return _dash_token


def dash_headers() -> dict:
    h = {}
    if _dash_token:
        h["Authorization"] = f"Bearer {_dash_token}"
    return h


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------
def make_session() -> str:
    return signer.dumps({"u": "owner", "t": int(time.time())})


def valid_session(req: Request) -> bool:
    tok = req.cookies.get(COOKIE)
    if not tok:
        return False
    try:
        signer.loads(tok, max_age=COOKIE_MAX_AGE)
        return True
    except (BadSignature, SignatureExpired):
        return False


# Paths reachable without a session (the shell + login machinery).
PUBLIC_PREFIXES = ("/__login", "/healthz", "/manifest.webmanifest", "/sw.js",
                   "/icons/", "/assets/", "/styles.css", "/app.js", "/favicon")
PUBLIC_EXACT = {"/", "/index.html", "/login", "/__push/key"}


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    path = request.url.path
    if path in PUBLIC_EXACT or any(path.startswith(p) for p in PUBLIC_PREFIXES):
        return await call_next(request)
    if not valid_session(request):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def _startup():
    global client
    client = httpx.AsyncClient(follow_redirects=False)
    ensure_vapid()
    if not DASH_TOKEN_OVERRIDE:
        await scrape_dash_token()
    asyncio.create_task(watcher_loop())


@app.on_event("shutdown")
async def _shutdown():
    if client:
        await client.aclose()


@app.get("/healthz")
async def healthz():
    return {"ok": True, "dash_token": bool(_dash_token), "gateway_key": bool(GATEWAY_KEY)}


# ---------------------------------------------------------------------------
# Companion auth endpoints
# ---------------------------------------------------------------------------
@app.post("/__login")
async def login(request: Request):
    body = await request.json()
    if not PASSWORD or body.get("password") != PASSWORD:
        # small delay to blunt brute-force
        await asyncio.sleep(1.0)
        raise HTTPException(status_code=401, detail="bad password")
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        COOKIE, make_session(), max_age=COOKIE_MAX_AGE,
        httponly=True, secure=COOKIE_SECURE, samesite="lax", path="/",
    )
    return resp


@app.post("/__logout")
async def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.get("/__me")
async def me():
    return {"ok": True, "push": bool(VAPID_PUBLIC), "model": GATEWAY_MODEL}


# ---------------------------------------------------------------------------
# Chat proxy -> OpenAI-compatible gateway (SSE streaming)
# ---------------------------------------------------------------------------
@app.post("/__chat")
async def chat(request: Request):
    body = await request.json()
    body.setdefault("model", GATEWAY_MODEL)
    stream = body.get("stream", True)
    headers = {"Authorization": f"Bearer {GATEWAY_KEY}", "Content-Type": "application/json"}

    if not stream:
        r = await client.post(f"{GW_URL}/v1/chat/completions", json=body,
                              headers=headers, timeout=300)
        return Response(content=r.content, status_code=r.status_code,
                        media_type=r.headers.get("content-type", "application/json"))

    async def gen():
        async with client.stream("POST", f"{GW_URL}/v1/chat/completions",
                                 json=body, headers=headers, timeout=300) as r:
            async for chunk in r.aiter_raw():
                yield chunk

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Web Push
# ---------------------------------------------------------------------------
def load_subs() -> list:
    try:
        return json.loads(SUBS_FILE.read_text())
    except Exception:
        return []


def save_subs(subs: list):
    SUBS_FILE.write_text(json.dumps(subs))


@app.get("/__push/key")
async def push_key():
    return {"key": VAPID_PUBLIC, "enabled": bool(VAPID_PUBLIC)}


@app.post("/__push/subscribe")
async def push_subscribe(request: Request):
    sub = await request.json()
    subs = load_subs()
    if sub not in subs:
        subs.append(sub)
        save_subs(subs)
    return {"ok": True, "count": len(subs)}


def _send_push(payload: dict):
    """Best-effort fan-out to all subscriptions; prune dead ones."""
    if not (VAPID_PUBLIC and VAPID_PRIVATE):
        return
    try:
        from pywebpush import webpush, WebPushException
    except Exception:
        return
    subs = load_subs()
    alive = []
    for s in subs:
        try:
            webpush(subscription_info=s, data=json.dumps(payload),
                    vapid_private_key=VAPID_PRIVATE,
                    vapid_claims={"sub": VAPID_SUB})
            alive.append(s)
        except WebPushException as e:
            code = getattr(getattr(e, "response", None), "status_code", None)
            if code not in (404, 410):  # keep unless gone
                alive.append(s)
        except Exception:
            alive.append(s)
    if len(alive) != len(subs):
        save_subs(alive)


@app.post("/__push/test")
async def push_test():
    await asyncio.to_thread(_send_push, {
        "title": "Hermes Companion",
        "body": "Push notifications are working ✅",
        "tag": "test",
    })
    return {"ok": True, "subs": len(load_subs())}


# ---------------------------------------------------------------------------
# Background watcher: push alerts on bad transitions
# ---------------------------------------------------------------------------
def _load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def _save_state(s: dict):
    STATE_FILE.write_text(json.dumps(s))


async def watcher_loop():
    await asyncio.sleep(15)
    prev = _load_state()
    while True:
        try:
            alerts = []
            r = await client.get(f"{DASH_URL}/api/status", headers=dash_headers(), timeout=10)
            if r.status_code == 401:
                await scrape_dash_token()
                r = await client.get(f"{DASH_URL}/api/status", headers=dash_headers(), timeout=10)
            if r.status_code == 200:
                st = r.json()
                gw = st.get("gateway_state")
                if prev.get("gateway_state") and prev["gateway_state"] != gw and gw != "running":
                    alerts.append(("Gateway " + str(gw), "Hermes gateway is no longer running."))
                for name, info in (st.get("gateway_platforms") or {}).items():
                    pstate = info.get("state")
                    pkey = f"plat_{name}"
                    if prev.get(pkey) == "connected" and pstate != "connected":
                        alerts.append((f"{name} disconnected", info.get("error_message") or f"{name} is {pstate}."))
                    prev[pkey] = pstate
                prev["gateway_state"] = gw

            # cron failures
            try:
                cr = await client.get(f"{DASH_URL}/api/cron/jobs", headers=dash_headers(), timeout=10)
                if cr.status_code == 200:
                    data = cr.json()
                    jobs = data if isinstance(data, list) else data.get("jobs", [])
                    for j in jobs:
                        jid = j.get("id") or j.get("job_id") or j.get("name")
                        status = (j.get("last_status") or j.get("last_run_status") or "").lower()
                        run_at = j.get("last_run_at") or j.get("last_run")
                        key = f"cron_{jid}"
                        sig = f"{status}@{run_at}"
                        if status and status not in ("ok", "success", "succeeded", "") and prev.get(key) != sig:
                            alerts.append((f"Cron failed: {j.get('name', jid)}", f"Last run: {status}"))
                        prev[key] = sig
            except Exception:
                pass

            for title, body in alerts:
                await asyncio.to_thread(_send_push, {"title": title, "body": body, "tag": "alert"})
            _save_state(prev)
        except Exception:
            pass
        await asyncio.sleep(WATCH_INTERVAL)


# ---------------------------------------------------------------------------
# Reverse proxy: /api/* -> Hermes dashboard (token injected, retry on 401)
# ---------------------------------------------------------------------------
HOP = {"host", "content-length", "connection", "keep-alive", "transfer-encoding",
       "te", "trailer", "upgrade", "authorization", "cookie"}


@app.api_route("/api/{path:path}",
               methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"])
async def proxy_api(path: str, request: Request):
    url = f"{DASH_URL}/api/{path}"
    body = await request.body()
    fwd = {k: v for k, v in request.headers.items() if k.lower() not in HOP}

    async def do():
        return await client.request(
            request.method, url, params=request.query_params,
            content=body, headers={**fwd, **dash_headers()}, timeout=120,
        )

    r = await do()
    if r.status_code == 401:
        await scrape_dash_token()
        r = await do()

    media = r.headers.get("content-type", "application/json")
    out = {k: v for k, v in r.headers.items()
           if k.lower() not in ("content-encoding", "content-length", "transfer-encoding", "connection")}
    return Response(content=r.content, status_code=r.status_code, media_type=media, headers=out)


# ---------------------------------------------------------------------------
# Static PWA + SPA fallback
# ---------------------------------------------------------------------------
@app.get("/manifest.webmanifest")
async def manifest():
    return FileResponse(STATIC_DIR / "manifest.webmanifest",
                        media_type="application/manifest+json")


@app.get("/sw.js")
async def sw():
    return FileResponse(STATIC_DIR / "sw.js", media_type="application/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


def _cache_headers(name: str) -> dict:
    # html/js/css revalidate every load; icons may cache long
    if name.endswith((".png", ".ico", ".jpg", ".svg")):
        return {"Cache-Control": "public, max-age=86400"}
    return {"Cache-Control": "no-cache"}


@app.get("/{full_path:path}")
async def spa(full_path: str):
    # serve a real file if it exists, else the app shell (client-side routing)
    candidate = (STATIC_DIR / full_path).resolve()
    if candidate.is_file() and str(candidate).startswith(str(STATIC_DIR.resolve())):
        return FileResponse(candidate, headers=_cache_headers(candidate.name))
    return FileResponse(STATIC_DIR / "index.html", media_type="text/html",
                        headers={"Cache-Control": "no-cache"})
