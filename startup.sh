#!/bin/sh
set -eu
cd /workspace

# Load server-only xAI credentials for WorldClaw inference (never shipped to client)
if [ -f /workspace/.xai_env ]; then
  # shellcheck disable=SC1091
  . /workspace/.xai_env
fi

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi

export XAI_API_KEY="${XAI_API_KEY:-}"
npm run dev >>/tmp/app-startup.log 2>&1 &
