#!/usr/bin/env bash
# Interactive installer for Quarry.ts (Linux and macOS): checks Node.js, installs, builds,
# then asks how you want the server set up. Run it with:  bash install.sh
set -e
cd "$(dirname "$0")"

echo "=== Quarry.ts installer (Minecraft 1.8.9) ==="

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Quarry.ts needs Node.js 24 or newer: https://nodejs.org/"
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  echo "Your Node.js is $(node --version), but Quarry.ts needs version 24 or newer: https://nodejs.org/"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. It normally comes with Node.js: https://nodejs.org/"
  exit 1
fi

echo
echo "Installing dependencies (this can take a minute)..."
npm install --no-audit --no-fund

echo
echo "Building the server..."
npm run build

node scripts/setup.cjs

echo
read -r -p "Start the server now? [Y/n] " start || start=n
case "$start" in
  [nN]*) echo "Start it later with:  npm start" ;;
  *) exec npm start ;;
esac
