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

### If Multipass is installed as a snap

Set `TMPDIR` to a directory the snap can read, and export it in the shell you
run `pulumi` from:

```bash
mkdir -p ~/abc-pulumi-tmp && export TMPDIR=~/abc-pulumi-tmp
```

The Pulumi provider writes each instance's merged cloud-init to a temporary file
and passes the path to `multipass launch`. Snap confinement grants the snap
`@{HOME}/[^.]**` — everything under the home directory *except* hidden paths —
and nothing under `/tmp`. With the default `TMPDIR` every launch fails on:

```
Could not load cloud-init configuration: bad file: /tmp/multipass-cloudinit-<n>.yaml
Please ensure that Multipass can read it.
```

The message points at the file, but the file is fine; it is the location that is
unreadable. Note the `[^.]` in that rule: a hidden directory such as
`~/.abc-pulumi-tmp` fails in exactly the same way, so the directory must not
start with a dot.

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

JupyterHub runs on the **server**, not on a worker. The Littlest JupyterHub
manages per-user notebooks as systemd units on a single machine, so it cannot
spread users across the cluster; keeping it on the server leaves every worker
free for the batch jobs and apps they are sized for.

### Home directories

Each slot has one home, `/data/workbench/<slot>/home`, which is also the Linux
passwd home of `jupyter-<slot>`. Login shells, `ssh`, `cron` and the JupyterLab
spawner therefore all resolve `~` to the same directory. This matches the
production deployment (ADR-0064) and is what the rest of the stack assumes:
`abc data upload` writes to `/data/workbench/<slot>/home/data/`, and the
credential broker's slot diagnostic asserts the directory exists and is owned by
`jupyter-<slot>`. Stock TLJH would place the home at `/home/jupyter-<slot>`
instead, so `jupyterhub_config.d/10-abc-unified-home.py` creates the account
with the correct home from a pre-spawn hook, before TLJH's own `useradd` runs.

One difference from production: there, `/data` is a dedicated volume. Here it is
a directory on the server's root disk, so home directories count against
`serverDisk` (40 GB by default) and do not survive the instance being deleted.

### Seeded accounts

Provisioning ends by seeding the slot store, so the workbench is usable without
any manual setup. Group and member names are drawn at random per deployment —
no two clusters share identities — and the chosen names are printed in
`/var/log/abc-workbench-seed.log`:

```
sudo cat /var/log/abc-workbench-seed.log
```

Three research groups are created, each with one member, plus a `reviewer`
account. Each group gets a Nomad namespace and MinIO bucket named
`su-<group>`, a `su-<group>-member` policy in both Nomad and MinIO, and a
PocketBase group record. Each member gets a MinIO user, a Nomad client token
named `pool-<slot>`, a JupyterHub user, and an unclaimed slot.

`reviewer` is a super-admin: a Nomad *management* token, so `/auth/me` reports
`groups: ["*"]` and `namespace: "*"`; the MinIO `consoleAdmin` policy plus every
group's member policy; and JupyterHub admin rights.

Credentials and claim codes land in `/run/abc-seed-out.json`, root-readable
only. To use an account, claim its slot — the response is a ready-to-use `abc`
CLI context:

```
sudo python3 -c 'import json;d=json.load(open("/run/abc-seed-out.json"));print(d["reviewer"]["claim_code"])'
```

```
curl -X POST http://<server>:4182/slots/claim -H 'Content-Type: application/json' -d '{"claim_code":"<code>","name":"Reviewer","email":"reviewer@example.org"}'
```

Log in at `/auth/login` with the slot's MinIO access key as the username and its
secret key as the password — the broker validates those against MinIO, not
against a password database of its own.

Names are load-bearing in ways that are easy to get wrong, so the seed script
documents each convention at the top. The one worth repeating: PocketBase group
names are stored **bare** (`oryx-genomics`), because the broker prepends `su-`
when it renders a slot's CLI config. Storing `su-oryx-genomics` yields a
namespace of `su-su-oryx-genomics`.

## Known issues

**Traefik is not yet healthy.** The job now passes validation — the invalid
`ignore_warnings` field has been removed from its `check_restart` block — but its
tasks still restart under their health check. Everything else in the deployment
is unaffected: pipelines, object storage, the credential broker and the
workbench are reached directly and do not route through Traefik. Browser-facing
routing on a single published port still needs it.
