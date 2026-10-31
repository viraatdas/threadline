FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium xvfb fonts-liberation fonts-noto-color-emoji ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 app

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY worker.py start.sh ./

ENV PYTHONUNBUFFERED=1 CHROME_PATH=/usr/bin/chromium
EXPOSE 8080
ENTRYPOINT ["tini", "--"]
CMD ["/app/start.sh"]
