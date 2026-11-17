#!/usr/bin/env bash
# Mirror the MinIO binaries the templates pin onto a release of this repository.
#
# WHY THIS EXISTS
#   MinIO's community edition is end-of-life. dl.min.io answers HTTP 410 and
#   the container images are gone; the only place the pinned builds can still
#   be downloaded is the release assets of the archived upstream repositories.
#   The templates try that first and fall back to a copy on this repository's
#   own release. This script makes that copy.
#
#   It attaches, for each pinned build, the unmodified binary and the source
#   tarball of the same tag. The binaries are AGPL-3.0: redistributing them
#   means offering the corresponding source alongside, which is what the
#   tarballs are for. See NOTICE.
#
# USAGE
#   scripts/mirror-object-store-binaries.sh --check     # download and verify only
#   scripts/mirror-object-store-binaries.sh 1.0.2       # verify, then attach to release 1.0.2
#
#   The release must already exist. The templates name the tag 1.0.2 in their
#   fallback URLs; mirror to a different tag and those URLs need changing too.
#
#   Needs curl, and gh for the upload. Nothing is uploaded unless every
#   checksum matches.
set -euo pipefail

# repo | tag | asset name | sha256 of the binary
PINS='
minio/minio|RELEASE.2024-12-18T13-15-44Z|minio.linux-amd64.RELEASE.2024-12-18T13-15-44Z|88182336ab5793488f2caad54846056b330f0dcb5c488b60d52434beeebae3ca
minio/minio|RELEASE.2024-11-07T00-52-20Z|minio.linux-amd64.RELEASE.2024-11-07T00-52-20Z|c27873d791b56d33518de11f12c5bfae4be88ebac00e12c6dd0027b08123fd80
minio/mc|RELEASE.2025-08-13T08-35-41Z|mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z|01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891
'

[ $# -eq 1 ] || { sed -n '2,25p' "$0" >&2; exit 2; }
target=$1

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
files=()

while IFS='|' read -r repo tag asset want; do
  [ -n "$repo" ] || continue
  echo "== $asset"
  curl -fsSL --retry 3 -o "$work/$asset" "https://github.com/$repo/releases/download/$tag/$asset"
  got=$(sha256 "$work/$asset")
  if [ "$got" != "$want" ]; then
    echo "sha256 mismatch for $asset: got $got, want $want" >&2
    exit 1
  fi
  echo "   sha256 ok"
  src="${repo##*/}-$tag.src.tar.gz"
  curl -fsSL --retry 3 -o "$work/$src" "https://github.com/$repo/archive/refs/tags/$tag.tar.gz"
  echo "   source $src ($(wc -c < "$work/$src" | tr -d ' ') bytes)"
  files+=("$work/$asset" "$work/$src")
done <<< "$PINS"

if [ "$target" = "--check" ]; then
  echo "all checksums match; nothing uploaded"
  exit 0
fi

gh release view "$target" >/dev/null
gh release upload "$target" "${files[@]}" --clobber
echo "attached ${#files[@]} files to release $target"
