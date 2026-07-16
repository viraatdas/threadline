#!/bin/sh
set -eu

umask 077

install -d -m 0700 -o node -g node "${CODEX_HOME:-/data/codex}"
install -d -m 0555 -o node -g node "${CODEX_WORKDIR:-/var/empty/threadline-codex}"

if [ -f "${CODEX_HOME:-/data/codex}/auth.json" ]; then
  chown node:node "${CODEX_HOME:-/data/codex}/auth.json"
  chmod 0600 "${CODEX_HOME:-/data/codex}/auth.json"
fi

exec gosu node:node node --import tsx worker/codex/main.ts
