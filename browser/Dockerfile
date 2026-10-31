FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium xvfb fonts-dejavu-core fonts-liberation fonts-noto-color-emoji ca-certificates curl tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 app

# tailscaled + CLI; the worker's browser exits through the owner's tailnet (see start.sh).
COPY --from=docker.io/tailscale/tailscale:v1.102.5 /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py start.sh ./

ENV PYTHONUNBUFFERED=1 CHROME_PATH=/usr/bin/chromium
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["/app/start.sh"]
