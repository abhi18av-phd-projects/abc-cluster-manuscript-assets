# single_server_with_workers

A Nomad **server** plus **N worker** VMs on one host, with access control enabled.

This is the multi-node counterpart to `single_node_server_worker`. Use it when
you want to see work distributed across separate Nomad nodes, or to exercise the
operator / admin / user split, which the single-node template cannot show
because it runs Nomad without ACLs.

## Prerequisites

- **Multipass** and **Pulumi** on the host
- **Node.js 18 or newer**
- The provider SDK built once: `./scripts/setup-provider-sdk.sh` from the
  repository root (see [../README.md](../README.md) for why)

## Deploy

```bash
cd templates/single_server_with_workers
npm install
pulumi login --local
pulumi stack init multi

# Set every value explicitly — see the warning below
pulumi config set clientCount 2
pulumi config set enableWorkbench false
pulumi config set serverCpus 4
pulumi config set serverMemory 8G
pulumi config set serverDisk 40G
pulumi config set clientCpus 4
pulumi config set clientMemory 12G
pulumi config set clientDisk 40G

pulumi up
```

A two-worker deployment takes roughly four minutes.

> **Set every config value, and do not re-initialise the stack.** Config lives in
> `Pulumi.<stack>.yaml`. If that file is lost — `pulumi stack rm` followed by
> `stack init` will do it — the program falls back to defaults, which almost
> certainly differ from what is deployed. The next `pulumi up` then replaces the
> server and every VM with it, without warning. Check `pulumi preview` for
> `to replace` before running `up` on an existing stack.

## Sizing

| Class | Pipelines | clientCount | clientCpus | clientMemory | clientDisk |
| --- | --- | --- | --- | --- | --- |
| Executor check | `nextflow-io/hello` | 1 | 2 | 8G | 30G |
| Small workflows | + `rnaseq-nf`, `nf-core/demo` | 2 | 4 | 12G | 40G |
| Full pipelines | + `detaxizer`, `viralrecon` | 2 | 8 | 20G | 60G |

Memory is per worker and is set by the largest single process request, not by
observed usage — see the sizing discussion in [../README.md](../README.md).
The server itself runs no workloads and stays at 4 vCPU / 8 GB.

## What the deployment provides

| Component | Where | Notes |
| --- | --- | --- |
| Nomad server | `abc-server` | ACL enabled, bootstrap token at `/etc/nomad-bootstrap-token` |
| Nomad clients | `abc-worker-N` | register into the **`compute`** node pool |
| `abc-tools` volume | each worker | read-only host volume carrying `s5cmd` and `rclone` |
| `nf-work` volume | each worker | shared Nextflow work dir, NFS-mounted from the server |
| MinIO | one worker | object store for S3 work dirs |

Workers register into `compute` because the CLI generates user jobs targeting
that pool. A client that omits it lands in `default`, and the first
`abc job run` fails with `job "..." is in nonexistent node pool "compute"`.

The platform's own jobs (MinIO, tusd, forward-auth, Traefik) are pinned to
`compute` for the same reason, in the opposite direction: a job with no pool
targets `default`, finds no clients there and never places, reporting
`Placement Failure: No nodes were eligible for evaluation`.

## Verify

```bash
# both workers ready, in the compute pool
TOKEN=$(multipass exec abc-server -- sudo awk '/^Secret ID/ {print $NF}' /etc/nomad-bootstrap-token)
multipass exec abc-server -- sudo env NOMAD_ADDR=http://127.0.0.1:4646 \
  NOMAD_TOKEN=$TOKEN nomad node status
```

```
ID        Node Pool  DC   Name          Drain  Eligibility  Status
565ebc8a  compute    dc1  abc-worker-0  false  eligible     ready
b4db99f1  compute    dc1  abc-worker-1  false  eligible     ready
```

The tools volume should carry both binaries:

```bash
multipass exec abc-worker-0 -- ls /opt/abc/tools/bin    # rclone  s5cmd
```

## The server can be replaced safely

Workers address the server by its Multipass DNS name, not its IP, so replacing
the server does not strand them: they re-join the new instance on their own.
This was verified by a replacement mid-run — the server moved address and both
workers re-registered without intervention.

## Interactive workbench

`enableWorkbench` (default on) adds JupyterHub, PocketBase and `abc-auth-svc` to
the server. It adds several minutes to provisioning because `abc-auth-svc` is
compiled from source, and it is only useful in this topology, where ACLs give
the broker real per-user tokens to issue. Set it to `false` for pipeline testing.

## Known issues

**Traefik does not deploy.** `deploy-traefik` fails validation:

```
service[0] "abc-traefik" validation failed:
  ignore_warnings on check_restart only supported for Consul service checks
```

`ignore_warnings` is only valid for Consul-registered checks, and this job uses
Nomad service discovery. Everything else in the deployment is unaffected —
pipelines, object storage and the credential broker do not route through
Traefik — but browser-facing routing for the workbench will need it. To be
fixed by removing `ignore_warnings` from the `check_restart` block, or moving
the job to a Consul check.
