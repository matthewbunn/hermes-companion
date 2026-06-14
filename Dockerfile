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
# Bind/port configurable via COMPANION_BIND / COMPANION_PORT. Default binds all
# interfaces; set COMPANION_BIND=127.0.0.1 to keep it loopback-only behind a proxy.
CMD ["sh", "-c", "uvicorn server:app --host ${COMPANION_BIND:-0.0.0.0} --port ${COMPANION_PORT:-8410} --no-access-log"]
