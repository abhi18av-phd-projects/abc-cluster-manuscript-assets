#!/usr/bin/env node
// Repair the published @incsteps/pulumi-multipass package after npm install.
//
// WHY THIS EXISTS
//   Every version published to npm — 0.1.0 through 0.3.3 — is unloadable as
//   shipped. The package declares `main: bin/index.js` and `files: ["bin"]`, but
//   bin/utilities.js reads the SDK version with
//
//       require('./package.json')
//
//   which resolves to bin/package.json — a file the tarball does not contain.
//   `npm install` succeeds and the failure surfaces only at `pulumi preview`:
//
//       Error: Cannot find module './package.json'
//       Require stack:
//         .../@incsteps/pulumi-multipass/bin/utilities.js
//
//   (0.1.0 fails earlier and differently: it shipped TypeScript sources with no
//   compiled JavaScript at all. Fixed upstream in 0.2.0 by
//   https://github.com/incsteps/pulumi-provider-multipass/pull/2.)
//
//   Copying the manifest into bin/ is the whole fix. Upstream can close this by
//   shipping bin/package.json, or by reading '../package.json' instead.
//
// Runs from `postinstall`. Idempotent, and it fails loudly rather than leaving a
// broken install to be discovered during a deploy.
const fs = require("fs");
const path = require("path");

const base = process.env.INIT_CWD || process.cwd();
const root = path.join(base, "node_modules", "@incsteps", "pulumi-multipass");

if (!fs.existsSync(root)) {
  console.error(`fix-provider-sdk: @incsteps/pulumi-multipass not found under ${base}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(root, "bin", "index.js"))) {
  console.error(`fix-provider-sdk: no bin/index.js in ${root} — the package layout changed, re-check this patch`);
  process.exit(1);
}

const dst = path.join(root, "bin", "package.json");
if (fs.existsSync(dst)) process.exit(0);

const src = path.join(root, "package.json");
fs.copyFileSync(src, dst);
console.log(
  `fix-provider-sdk: copied package.json into bin/ for @incsteps/pulumi-multipass@${
    JSON.parse(fs.readFileSync(src, "utf8")).version
  }`,
);
