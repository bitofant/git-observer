#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Build into a staging dir and swap it in, rather than letting vite's
# emptyOutDir wipe dist/web under the live server: during that window every
# request 404s (and used to crash the process), and a build interrupted
# half-way left a permanently broken dist that systemd then crash-looped on.
STAGE=dist/web.next
PREV=dist/web.prev

echo "Building UI..."
rm -rf "$STAGE"
npm run build -- --outDir "$STAGE" --emptyOutDir

# Swap: two renames, so dist/web is only ever the whole old tree or the new one.
rm -rf "$PREV"
if [ -d dist/web ]; then mv dist/web "$PREV"; fi
mv "$STAGE" dist/web
rm -rf "$PREV"

echo "Build complete."
