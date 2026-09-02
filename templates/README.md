# Templates

One Pulumi template, `single_node_server_worker`, provisioning a single machine
that is both Nomad server and worker, with MinIO and tusd as systemd units.

## What a reviewer needs

- **Multipass** and **Pulumi** on the host machine
- **Node.js 18 or newer**
- No account anywhere: the template uses a local Pulumi backend and a vendored
  provider SDK, so nothing is fetched from a registry at deploy time

```bash
# 1. Build the provider SDK — see "The provider is not installable from npm" below
./scripts/setup-provider-sdk.sh

# 2. Deploy
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

Step 1 is a one-off. It clones the provider at a pinned tag, builds its Node SDK
and installs it under `vendor/`, which is what `npm install` then resolves.

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

## The provider is not installable from npm

`scripts/setup-provider-sdk.sh` exists because the provider cannot currently be
consumed from the registry.

`@incsteps/pulumi-multipass@0.1.0` on npm ships the SDK's TypeScript sources
with no `main` field and no compiled JavaScript. `npm install` succeeds, and
`pulumi preview` then fails with:

```
node_modules/@incsteps/pulumi-multipass/index.ts:4
import * as pulumi from "@pulumi/pulumi";
^^^^^^
SyntaxError: Cannot use import statement outside a module
```

The fix is merged upstream as
[incsteps/pulumi-provider-multipass#2](https://github.com/incsteps/pulumi-provider-multipass/pull/2),
but it is not yet released: the corrected package is version 0.1.1, and no
0.1.1 plugin release or npm publish exists. Until both land, the SDK has to be
built from source, which is what the script does.

The script pins the provider to tag **v0.1.0** rather than tracking `main`. The
SDK embeds the plugin version it will ask Pulumi to download, so it must name a
version that has a GitHub release; `main` is already 0.1.1, and asking for a
plugin that was never released fails with a 404 during `pulumi preview`.
Override with `PROVIDER_REF=v0.1.1 ./scripts/setup-provider-sdk.sh` once that
release exists.

**When 0.1.1 is published**, this script and the `file:` dependency in
`templates/single_node_server_worker/package.json` can both be dropped in favour
of a normal `"@incsteps/pulumi-multipass": "^0.1.1"` dependency.
