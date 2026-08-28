# Templates

Two templates, one per deployment topology the manuscript describes. Both are sanitised for
publication: every site-specific value is a placeholder in angle brackets, and must be
substituted before deploying.

| Template | Nomad mode | Access control | Users | Status |
|---|---|---|---|---|
| `single_node_server_worker/` | development, combined server and client | none | 1 | shipped and verified |
| `single_server_with_workers/` | server and client, persistent | enabled | 2–20 | **not yet ported** |

Only the single-node template is shipped here. The multi-user template has not
been through the same end-to-end verification, and publishing an unverified
template alongside a paper that claims reproducibility would be the wrong trade.

Each is a standard Pulumi TypeScript project: `npm install && pulumi up`. Dependencies are
declared in `package.json`; no `node_modules` or lockfile state ships here. See
[Provision](../protocol/01-provision.md) for the full path from a bare laptop, including how to
install the Multipass provider while its
[registry submission](https://github.com/pulumi/registry/pull/12177) is open.

## What differs between them

`single_node_server_worker/` runs Nomad in development mode on one VM, managed by systemd
alongside the platform services it needs: MinIO for object storage, tusd for resumable
ingestion, and optionally Caddy for HTTPS. Nomad itself has no access-control enforcement in
this mode, so any client that can reach the API port holds full cluster control. It is a single
fault domain, and it is the right choice for evaluating the platform and for reproducing the
worked example. It is not intended for sustained use.

`single_server_with_workers/` runs a server VM alongside worker VMs, with persistence and
per-user access control, and deploys `abc-auth-svc` to broker the single login. `single_node_server_worker/`
does not deploy the broker, because there is no access control to broker.

`single_server_with_workers/` also carries the optional observability stack: metrics, logs and
traces collection with a dashboard, plus threshold alerts routed to a notification service. It is
disabled by default and enabled with a single Pulumi config flag, matching the manuscript's
description of it as an operator option rather than a requirement.

The overlay network is configurable between Tailscale and Nebula. The platform depends only on
the flat addressing an overlay provides, not on any feature particular to either.

## Not included

A multi-server quorum topology is possible and is deliberately absent here. Quorum brings leader
election, split-brain recovery and coordinated rolling upgrades, and those presume
platform-engineering capacity the target setting does not have.

Nothing here provisions an admission engine, a policy engine or an audit ledger.
The manuscript records their absence as a design decision, and this repository holds that line.

## Sizing

The default is 4 vCPU / 16 GB, set in `index.ts` and overridable with
`pulumi config set cpus|memory|disk`. 16 GB is not arbitrary: one nf-core FASTQC
task requests `Cores 2 / MemoryMB 12288`, because nf-core's `base.config` gives
`process_low` 12 GB, and the Nextflow head reserves a further 2 GB. Below that,
every pipeline task fails placement with
`Dimension "memory" exhausted on 1 nodes`.

Capping this with a `-c` resourceLimits file does **not** help unless that file
is readable inside the head container. A path on your own workstation is
silently ignored.

## Running a pipeline

Two flags are required on a single-node deployment, because both CLI defaults
assume a multi-node cluster with DNS:

```bash
abc pipeline run <url> --revision <rev> \
  --head-pool compute \
  --head-nomad-addr http://<node-ip>:4646 \
  --work-dir s3://nf-work/<run>/
```

`--head-pool` is needed because the head otherwise targets a `platform` pool
that no single-node deployment has. `--head-nomad-addr` is needed because
`NOMAD_ADDR` otherwise reaches the head container as `127.0.0.1:4646`, which it
cannot route to.

## On Linux: snap-confined Multipass

If `multipass launch` fails with
`Could not load cloud-init configuration: bad file: /tmp/...`, the provider is
writing cloud-init to `/tmp`, which a snap-installed Multipass cannot read. Set
`TMPDIR` to a path under your home directory:

```bash
export TMPDIR="$HOME/mp-tmp" && mkdir -p "$TMPDIR"
```

Fixed upstream in incsteps/pulumi-provider-multipass#1; the workaround is only
needed until that lands.

## A note on JupyterHub

JupyterHub is installed separately during host provisioning rather than orchestrated by the
platform. The platform contributes the login only, so one credential admits a researcher to both
the command-line client and the notebook. The templates reflect that split.
