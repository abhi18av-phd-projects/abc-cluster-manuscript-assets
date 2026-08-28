# Provision a cluster

From a bare laptop to a running cluster. Two topologies are available; start with single-node.

## Prerequisites

| | Version | Notes |
|---|---|---|
| [Multipass](https://multipass.run) | current | macOS or Linux |
| [Pulumi CLI](https://www.pulumi.com/docs/install/) | current | a local file backend is sufficient, no Pulumi Cloud account needed |
| Node.js | 18 or later | the templates are Pulumi TypeScript projects |
| Disk and memory | see per-template notes | single-server-with-workers runs several VMs at once |

Use a local Pulumi backend so no account is required:

```bash
pulumi login --local
```

## Install the Multipass provider

The templates depend on the Pulumi native provider for Canonical Multipass,
[`incsteps/pulumi-provider-multipass`](https://github.com/incsteps/pulumi-provider-multipass),
Apache 2.0.

It is **not yet in the public Pulumi registry**. The registry submission is
[pulumi/registry#12177](https://github.com/pulumi/registry/pull/12177), open at the time of
writing, so the plugin installs from GitHub release assets against a pinned version:

```bash
pulumi plugin install resource multipass v0.1.0 --server github://api.github.com/incsteps/pulumi-provider-multipass
```

Verify:

```bash
pulumi plugin ls | grep multipass
```

If the registry submission has merged, `pulumi plugin install resource multipass v0.1.0`
resolves without the `--server` flag.

## Topology A — single-node

One VM, Nomad in development mode, no persistence and no access-control enforcement. A single
fault domain, suitable for evaluating the platform and for the worked example. Not for sustained
use.

```bash
cd templates/single_node_server_worker
npm install
pulumi stack init eval
pulumi up
```

The stack outputs the VM address and the Nomad API endpoint.

## Topology B — single-server with workers

One server VM running Nomad server and client, plus N worker VMs. Persistence and per-user
access control are enabled, and `abc-auth-svc` brokers the single login.

```bash
cd templates/single_server_with_workers
npm install
pulumi stack init lab
pulumi config set workerCount 2
pulumi config set overlay tailscale   # or: nebula
pulumi up
```

Substitute every `<angle-bracket>` placeholder in `Pulumi.yaml` before running.

## Verify each component

Run these after `pulumi up` reports success. Each maps to a claim in the manuscript, so a
failure here is a failure of the paper's description, not only of your deployment.

| Component | Check | Expected |
|---|---|---|
| Nomad | `nomad node status` | every worker `ready`; on single-node, one node |
| Nomad ACL | `nomad acl token self` | a token on topology B; an error on topology A, which has no access control |
| MinIO | `mc alias set local <endpoint> <key> <secret> && mc ls local` | the platform buckets are listed |
| Overlay | `tailscale status` or `nebula-cert print` | server and workers on one flat address space |
| `abc-auth-svc` | `curl -sf <auth-endpoint>/healthz` | healthy on topology B; **not deployed on topology A** |
| JupyterHub | open `https://<server>/hub/login` | login page, authenticated by `abc-auth-svc` |
| tus ingestion | `abc data upload <file>`, interrupt it, re-run | resumes from the last offset rather than from zero |

## Install and point the CLI

```bash
curl -fsSL -H "Accept: application/vnd.github.raw+json" \
  "https://api.github.com/repos/abc-cluster/abc-cluster-cli/contents/scripts/install-abc.sh?ref=main" | sh

abc config init
abc auth context add eval --address <nomad-endpoint> --access-token <token> --workspace default
abc auth context use eval
abc cluster doctor
```

`abc cluster doctor` is the single check that the platform is serviceable end to end. Proceed to
[Run](02-run-workload.md) once it passes.

## Local testing of each workload class

Confirm all three classes before running the worked example.

```bash
# batch: annotated shell job
abc job run hello.sh --submit --watch

# batch: pipeline at a pinned revision
abc pipeline run https://github.com/nf-core/rnaseq --revision 3.14.0

# interactive: browser notebook, one credential
abc workbench start && abc workbench url

# data-app: publish a long-running browser application
abc app deploy <app-dir> --plane private && abc app list
```

## Teardown

```bash
pulumi destroy && pulumi stack rm
```

Multipass VMs are removed with the stack. Confirm with `multipass list`.
