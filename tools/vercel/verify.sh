#!/usr/bin/env bash
# Checks that the lockfile's hash for the pinned Vercel CLI equals the one Vercel publishes for
# that release. Runs in the check job (so a bad bump fails its pull request) and before every
# deploy. See README.md.
set -euo pipefail
cd "$(dirname "$0")"
version=$(jq -r '.dependencies.vercel' package.json)
locked=$(jq -r '.packages["node_modules/vercel"].integrity' package-lock.json)
published=$(curl -fsS --retry 3 --retry-all-errors \
  "https://vercel.com/docs/cli/release-notes/npm/$version/integrity")
if [ "$locked" != "$published" ]; then
  echo "::error::vercel@$version: lockfile hash $locked does not match Vercel's published $published"
  exit 1
fi
echo "vercel@$version matches Vercel's published hash"
