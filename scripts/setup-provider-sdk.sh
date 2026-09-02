#!/usr/bin/env bash
# Fetch and build the Pulumi Multipass provider SDK.
#
# WHY THIS EXISTS
#   The template imports @incsteps/pulumi-multipass. The build published to npm
#   as 0.1.0 ships TypeScript sources with no `main` and no compiled JavaScript,
#   so `npm install` succeeds and `pulumi preview` then fails with:
#       SyntaxError: Cannot use import statement outside a module
#   Fix in flight: https://github.com/incsteps/pulumi-provider-multipass/pull/2
#
#   Until 0.1.1 is on npm, the SDK is built from source into vendor/ and the
#   template depends on that path. Once 0.1.1 is published this script and the
#   `file:` dependency can both be dropped in favour of the registry.
set -euo pipefail

REPO=https://github.com/incsteps/pulumi-provider-multipass.git
# Pinned to a tag, not a branch: the SDK carries the plugin version it will ask
# Pulumi to download, so it must name a version that has a GitHub release.
# main is currently 0.1.1, for which no plugin release exists yet.
REF=${PROVIDER_REF:-v0.1.0}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VENDOR="$ROOT/vendor/pulumi-multipass-sdk"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

command -v node >/dev/null || { echo "node is required (18 or newer)"; exit 1; }
command -v git  >/dev/null || { echo "git is required"; exit 1; }

echo "==> cloning $REPO ($REF)"
git clone --depth 1 --branch "$REF" "$REPO" "$WORK/provider" >/dev/null 2>&1

echo "==> building the nodejs SDK"
cd "$WORK/provider/sdk/nodejs"
npm install --no-audit --no-fund >/dev/null 2>&1
npm run build >/dev/null 2>&1

[ -f bin/index.js ] || { echo "build produced no bin/index.js; aborting"; exit 1; }

echo "==> installing into vendor/pulumi-multipass-sdk"
rm -rf "$VENDOR"; mkdir -p "$VENDOR"
cp -R bin/. "$VENDOR/"
# bin/utilities.js does require("./package.json") to read the version, so the
# manifest has to sit beside index.js rather than one level up. The compiled
# output therefore becomes the package root.
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync("package.json", "utf8"));
  p.main = "index.js";
  p.types = "index.d.ts";
  delete p.files;
  delete p.scripts;
  fs.writeFileSync(process.argv[1] + "/package.json", JSON.stringify(p, null, 2) + "\n");
' "$VENDOR"

echo "==> done: $VENDOR"
echo "    now run: cd templates/single_node_server_worker && npm install"
