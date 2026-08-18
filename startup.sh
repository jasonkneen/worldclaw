#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

# Load server-only model-committee credentials for WorldClaw inference (never shipped to client).
# vite.config.ts also loads .xai_env so a bare `npm run dev` still sees keys.
if [ -f "$SCRIPT_DIR/.xai_env" ]; then
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.xai_env"
fi

if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi

export XAI_API_KEY="${XAI_API_KEY:-}"
export GEMINI_API_KEY="${GEMINI_API_KEY:-}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-}"
export AI_GATEWAY_API_KEY="${AI_GATEWAY_API_KEY:-}"
export XAI_TEXT_MODEL="${XAI_TEXT_MODEL:-grok-4.6}"
export GEMINI_TEXT_MODEL="${GEMINI_TEXT_MODEL:-gemini-3.6-flash}"
export GEMINI_IMAGE_MODEL="${GEMINI_IMAGE_MODEL:-gemini-3-pro-image}"
export OPENAI_TEXT_MODEL="${OPENAI_TEXT_MODEL:-gpt-5.6-sol}"
export OPENAI_IMAGE_MODEL="${OPENAI_IMAGE_MODEL:-gpt-image-2}"
export CLAUDE_MODEL="${CLAUDE_MODEL:-anthropic/claude-opus-5}"
nohup npm run dev >>/tmp/app-startup.log 2>&1 </dev/null &
