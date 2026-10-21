#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -f "$SCRIPT_DIR/package.json" ]]; then
  PROJECT_DIR="$SCRIPT_DIR"
elif [[ -f "$SCRIPT_DIR/../package.json" ]]; then
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo "Could not find wa-scribe package.json beside this launcher or in its parent folder."
  read -r -p "Press Return to close. " _ || true
  exit 1
fi

cd "$PROJECT_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "wa-scribe needs Node.js 24.x or 26.x. Download either from https://nodejs.org/en/download/ and run this launcher again."
  read -r -p "Press Return to close. " _ || true
  exit 1
fi

if ! node scripts/assert-node.mjs; then
  echo "Install Node.js 24.x or 26.x from https://nodejs.org/en/download/ and run this launcher again."
  read -r -p "Press Return to close. " _ || true
  exit 1
fi

if [[ ! -f node_modules/@playwright/test/package.json || ! -x node_modules/.bin/playwright ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm is missing. Install Node.js 24.x or 26.x from https://nodejs.org/en/download/; it includes npm."
    read -r -p "Press Return to close. " _ || true
    exit 1
  fi
  npm ci
fi

if [[ ! -f local-dist/main.mjs ]]; then
  npm run local:build
fi
npx --no-install playwright install chromium
exec node local-dist/main.mjs "$@"
