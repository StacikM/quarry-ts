#!/bin/bash
# Installation script of the Quarry.ts egg. Pterodactyl runs it once (and again on "Reinstall") in a
# Node.js 24 container with the server's folder mounted at /mnt/server.
# Reinstalling updates the program but keeps world/, server.json, ops.json and velocity.json (git ignores them).
set -e

TARGET="${INSTALL_DIR:-/mnt/server}"
REPO="${GIT_REPO:-https://github.com/StacikM/quarry-ts}"
BRANCH="${GIT_BRANCH:-mc-1.21.11}"

mkdir -p "$TARGET"
cd "$TARGET"

# This script runs as root, but the folder belongs to the panel's user (a reinstall finds the .git of the first
# install), and git refuses a repository owned by somebody else ("dubious ownership"). The folder is ours.
git config --global --add safe.directory "$TARGET"

echo "Downloading Quarry.ts ($BRANCH) from $REPO"
git init -q
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"
git fetch --depth 1 origin "$BRANCH"
git checkout -q -f -B "$BRANCH" FETCH_HEAD

echo "Installing dependencies"
npm install --no-audit --no-fund

echo "Building the server"
npm run build

# The built server needs none of the development tools, which are most of the download.
npm prune --omit=dev --no-audit --no-fund

echo "Quarry.ts is installed. Start the server from the panel."
