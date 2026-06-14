FROM python:3.12-slim

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY static ./static

ENV COMPANION_DATA=/data \
    HERMES_DASH_URL=http://127.0.0.1:30433 \
    HERMES_GW_URL=http://127.0.0.1:30432
EXPOSE 8410
# Binds all interfaces: reached at the host LAN IP over the Tailscale subnet route
# (encrypted by the tailnet); password-gated. Set host via COMPANION_BIND if needed.
CMD ["sh", "-c", "uvicorn server:app --host ${COMPANION_BIND:-0.0.0.0} --port ${COMPANION_PORT:-8410} --no-access-log"]
