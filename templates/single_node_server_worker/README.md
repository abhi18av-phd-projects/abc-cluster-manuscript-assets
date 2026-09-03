# single_node_server_worker

One VM running Nomad in development mode as a combined server and client, with the
object store, resumable upload endpoint and Nextflow support installed as systemd
services beside it.

This is the intended starting point. It needs no cloud account and no
institutional hardware, and it runs on a laptop with Multipass installed. It is a
single fault domain with no access-control enforcement, which is what makes it
simple; for the operator / admin / user split, and for work spread across separate
Nomad nodes, use
[`single_server_with_workers`](../single_server_with_workers/README.md).

The full walkthrough lives in the protocol documents, not here:
[provision](../../protocol/01-provision.md) →
[run](../../protocol/02-run-workload.md) →
[expected output](../../protocol/03-expected-output.md).

## Prerequisites

See [protocol/01](../../protocol/01-provision.md), which covers the provider
install and, on Linux, the `TMPDIR` that a snap-confined Multipass requires.
Without that setting every launch fails on `bad file`, naming a cloud-init file
that is perfectly valid.

## Deploy

```bash
cd templates/single_node_server_worker
npm install
pulumi stack init eval

# Size explicitly — see the note below
pulumi config set cpus 8
pulumi config set memory 20G
pulumi config set disk 60G

pulumi up
```

## Sizing

The defaults are 4 vCPU / 16 GB / 20 GB, which is enough for the executor check
and the smaller workflows. It is **not** enough for the full pipeline set: the
manuscript reports 8 vCPU / 20 GB / 60 GB as the smallest configuration on which
every pipeline completes, and `nf-core/viralrecon` alone peaks at 9.7 GB against a
60 GB disk.

Set the three values explicitly rather than relying on defaults, so the stack file
records what is deployed. A lost `Pulumi.<stack>.yaml` otherwise falls back to
defaults that differ from the running VM, and the next `pulumi up` replaces it.

## Config options

| Option | Default | Effect |
| --- | --- | --- |
| `cpus` / `memory` / `disk` | 4 / 16G / 20G | VM size |
| `enableNodePool` | `true` | registers the client into the `compute` pool the CLI targets |
| `enableEnvTools` | `true` | publishes `pixi` and `micromamba` for `--runtime` jobs |
| `enableNextflow` | `true` | Nextflow work volumes |
| `enableHttps` | `false` | terminates TLS through Caddy |
| `observability` | `false` | Grafana, VictoriaMetrics, VictoriaLogs, Alloy |
| `enableApptainerDriver` | `false` | adds the Apptainer task driver |

## What the deployment provides

| Component | Notes |
| --- | --- |
| Nomad | development mode, combined server and client, **no ACLs** |
| MinIO | object store, systemd service on the same VM |
| tusd + `fx-tusd-hook` | resumable ingestion for `abc data upload` |
| `abc-apps` namespace | applied on every boot, not once at provisioning |

Nomad runs here in `-dev` mode, which discards server state on restart, and the
program snapshots after cloud-init, which stops the instance. A namespace applied
once from a `runcmd` therefore looks like it worked and is gone before anyone uses
the deployment: `abc app deploy` then fails with `job "app-..." is in nonexistent
namespace "abc-apps"`. A boot-time unit re-applies it instead. The compute node
pool needs no equivalent, because the client declares it in its own config and
Nomad recreates the pool on every registration.

## Verify

```bash
pulumi stack output instanceSize nodePool nomadAddr
```

The stack emits a complete CLI context, so no context file is written by hand:

```bash
pulumi stack output abcContext > abc.yaml
export ABC_CLI_CONFIG_FILE=$PWD/abc.yaml
abc doctor
```

Then follow [protocol/02](../../protocol/02-run-workload.md).
