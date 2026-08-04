#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

usage() {
  printf '%s\n' \
    'Usage:' \
    '  ./scripts/release/publish-packages.sh bump <major|minor|patch|x.y.z>' \
    '  ./scripts/release/publish-packages.sh prepare' \
    '  ./scripts/release/publish-packages.sh publish'
}

command=${1:-}

case "$command" in
  bump)
    if [ "$#" -ne 2 ]; then
      usage >&2
      exit 2
    fi
    node scripts/release/release-version.mjs bump "$2"
    npm install --package-lock-only --ignore-scripts --offline
    node scripts/release/release-version.mjs check
    ;;
  prepare)
    if [ "$#" -ne 1 ]; then
      usage >&2
      exit 2
    fi
    node scripts/release/release-version.mjs check
    version=$(node scripts/release/release-version.mjs current)
    release_root="artifacts/$version"
    if [ -e "$release_root" ]; then
      printf 'Release artifacts are immutable and already exist: %s\n' "$release_root" >&2
      exit 1
    fi
    node scripts/release/build-packages.mjs \
      --source-metadata \
      --out "$release_root/packages" \
      --index "$release_root/package-index.json"
    node scripts/release/inspect-packages.mjs \
      --packages "$release_root/packages" \
      --index "$release_root/package-index.json" \
      --output "$release_root/package-inspection.json"
    node scripts/release/test-consumers.mjs --packages "$release_root/packages"
    printf 'Prepared @pixel-point release %s in %s\n' "$version" "$release_root"
    ;;
  publish)
    if [ "$#" -ne 1 ]; then
      usage >&2
      exit 2
    fi
    node scripts/release/release-version.mjs check
    version=$(node scripts/release/release-version.mjs current)
    release_root="artifacts/$version"
    if [ ! -f "$release_root/package-index.json" ] || [ ! -d "$release_root/packages" ]; then
      printf 'Prepared release artifacts are missing; run prepare first for %s.\n' "$version" >&2
      exit 1
    fi
    node scripts/release/test-consumers.mjs --packages "$release_root/packages"
    node scripts/release/publish-public-packages.mjs \
      --packages "$release_root/packages" \
      --index "$release_root/package-index.json" \
      --execute
    ;;
  help|-h|--help)
    if [ "$#" -ne 1 ]; then
      usage >&2
      exit 2
    fi
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
