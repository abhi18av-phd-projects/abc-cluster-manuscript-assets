# Templates

One Pulumi template, `single_node_server_worker`, provisioning a single machine
that is both Nomad server and worker, with MinIO and tusd as systemd units.

## What a reviewer needs

- **Multipass** and **Pulumi** on the host machine
- **Node.js 18 or newer**
- No account anywhere: the template uses a local Pulumi backend. The provider SDK
  comes from public npm and its plugin binary from the provider's GitHub
  releases, so the only thing needed is network access on the first deploy
- `npm install` must be allowed to run its `postinstall` step, which repairs a
  packaging defect in every published version of the provider SDK — see
  **Provider version** below

```bash
cd templates/single_node_server_worker
npm install
pulumi login --local
pulumi stack init review
# set the size BEFORE the first `pulumi up` — see the warning below
pulumi config set cpus 8
pulumi config set memory 32G
pulumi config set disk 80G
pulumi up
```

> **Set the size before the first `pulumi up`.** Changing `cpus`, `memory` or
> `disk` on a stack that is already deployed is reported by the provider as an
> in-place update and exits successfully, but the instance is destroyed and not
> recreated. Recover with `pulumi refresh && pulumi destroy && pulumi up`. Track
> this against the provider, not the template.

## Sizing

The template defaults to 4 vCPU / 16 GB / 20 GB. That is enough to deploy and to
run the first two pipeline classes, and it is not enough for the rest — nf-core
`process_low` alone requests 12 GB, and container images for the larger
pipelines will not fit in a 20 GB disk.

Pick the row for the heaviest pipeline you intend to run, and set it before the
first `pulumi up`.

| Class | Pipelines | cpus | memory | disk |
| --- | --- | --- | --- | --- |
| **A — executor check** | `nextflow-io/hello` | 2 | 8G | 20G |
| **B — small real workflow** | `nextflow-io/rnaseq-nf` | 4 | 12G | 30G |
| **C — everything in this protocol** | + `nf-core/demo`, `detaxizer`, `viralrecon` | **8** | **20G** | **60G** |

**8 vCPU / 20 GB / 60 GB is the recommended size.** It is the smallest
configuration on which all five pipelines complete, verified one at a time with
nothing else scheduled:

| Pipeline | Processes | Wall clock | Peak memory | Peak load |
| --- | ---: | ---: | ---: | ---: |
| `nextflow-io/hello` | 4 | 1 min 16 s | 1.3 GB | 1.2 |
| `nextflow-io/rnaseq-nf` | 4 | 3 min 16 s | 1.6 GB | 2.5 |
| `nf-core/demo` | 8 | 3 min 16 s | 2.3 GB | 4.1 |
| `nf-core/detaxizer` | 54 | 7 min 47 s | 2.7 GB | 2.5 |
| `nf-core/viralrecon` | 200 | 57 min 1 s | 9.7 GB | 5.2 |

Requires **nf-nomad 0.5.0-edge5 or newer**. No Nextflow configuration files are
supplied or required.

### Why 20 GB and not less

Memory is the binding dimension, and it is set by the largest single *request*
rather than by observed usage. Nomad places a task on what it reserves, so the
node must fit the biggest process a pipeline declares, plus the pipeline head.

`nf-core/detaxizer` and `viralrecon` both cap their `test` profile at
`resourceLimits = [cpus: 4, memory: '15.GB']`. The pipeline head reserves a
further 2 GB on the same node, so 17 GB is the floor and a 16 GB node fails:

```
Placement Failure
  * Dimension "memory" exhausted on 1 nodes
```

That failure is silent in the sense that matters — the job neither errors nor
runs, it waits indefinitely — so prefer the extra headroom. 20 GB leaves ~3 GB
spare.

CPU is less tight: with 4-core tasks on 8 cores, two run side by side and the
rest queue, which costs wall-clock rather than correctness. `viralrecon` takes
57 minutes at this size against 38 on a 16-core node.

> **Historical note.** Before nf-nomad 0.5.0-edge5, `process.resourceLimits`
> was not applied to the generated job specification, so `detaxizer` requested
> 12 cores and 80 GB for a process whose measured peak was 0.8 GB, and the same
> workload needed a 96 GB node. That is fixed upstream; the sizes above assume
> the fix.

## Addons

`cloud-init/` holds the base configuration and a set of addons merged in by
`index.ts` according to stack configuration. Each is a `#cloud-config` fragment
merged key by key across `packages`, `bootcmd`, `write_files` and `runcmd`.

| Addon | Config key | Default | What it adds |
| --- | --- | --- | --- |
| `base.yaml` | always | on | Nomad (dev mode), MinIO, tusd as systemd units |
| `node-pool-addon.yaml` | `enableNodePool` | on | the `compute` node pool, the `abc-apps` namespace, and a boot-time unit that reapplies the namespace |
| `env-tools-addon.yaml` | `enableEnvTools` | on | pixi and micromamba for `--runtime` jobs |
| `nextflow-volumes-addon.yaml` | `enableNextflow` | on | host volumes and `s5cmd` for pipeline work |
| `fx-tusd-hook-addon.yaml` | always | on | the resumable-upload hook as a Nomad job |
| `obs-addon.yaml` | `observability` | off | metrics, logs, traces and Grafana |
| `https-addon.yaml` | `enableHttps` | off | Caddy in front of MinIO |
| `apptainer-driver-addon.yaml` | `enableApptainerDriver` | off | the Apptainer task driver |

Ordering matters: anything a later step needs to exist is written in `bootcmd`,
because Nomad refuses to start if a declared `host_volume` path is missing, and
a failed `scripts_user` stage silently skips every addon `runcmd` after it.

## Provider version

The templates pin `@incsteps/pulumi-multipass` to **0.2.0** exactly, the lockfiles
record it, and `postinstall` applies a one-file repair to it. All three parts are
load-bearing.

**Why 0.2.0 and not higher.** 0.3.0 removed the `Snapshot` resource and the
`restore` function from the provider. Both templates use
`multipass.resources.Snapshot` to capture the post-provisioning baseline, so
against 0.3.x they do not even compile. The provider is now in the public Pulumi
registry as `incsteps/multipass`, but the registry serves only its latest version
— currently 0.3.3 — and a specific older version cannot be requested through it.
The plugin binary for 0.2.0 comes instead from the provider's own GitHub releases,
which is where the SDK points Pulumi by default; `protocol/01` gives the explicit
command.

**Why 0.2.0 and not lower.** `0.1.0` shipped the SDK's TypeScript sources with no
compiled JavaScript, so `pulumi preview` failed with `SyntaxError: Cannot use
import statement outside a module`. That was fixed upstream in
[#2](https://github.com/incsteps/pulumi-provider-multipass/pull/2) and released in
0.2.0. An earlier revision of this repository worked around it by cloning the
provider and building its SDK into `vendor/`; that step is gone.

**Why the repair.** Every published version, 0.1.0 through 0.3.3, is still
unloadable exactly as shipped. The package sets `main: bin/index.js` and
`files: ["bin"]`, while `bin/utilities.js` reads its version with
`require('./package.json')` — resolving to `bin/package.json`, which the tarball
does not contain. `npm install` reports success and the failure appears only at
deploy time:

```
Error: Cannot find module './package.json'
Require stack:
  .../@incsteps/pulumi-multipass/bin/utilities.js
```

`scripts/fix-provider-sdk.cjs` copies the manifest into `bin/`. It runs from
`postinstall`, is idempotent, and exits non-zero if the package layout changes, so
a future version that moves things cannot pass silently. If you install with
`--ignore-scripts`, run it by hand before `pulumi preview`:

```bash
node ../../scripts/fix-provider-sdk.cjs
```

Upstream can retire the script by shipping `bin/package.json` or by reading
`../package.json`.
