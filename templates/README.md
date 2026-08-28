# Templates

Two templates, one per deployment topology the manuscript describes. Both are sanitised for
publication: every site-specific value is a placeholder in angle brackets, and must be
substituted before deploying.

| Template | Identifier in the manuscript | Nomad mode | Access control | Users |
|---|---|---|---|---|
| `single_node_server_worker/` | `single_node_server_worker` | development, combined server and client | none | 1 |
| `single_server_with_workers/` | `single_server_with_workers` | server and client, persistent | enabled | 2–20 |

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

The overlay network is configurable between Tailscale and Nebula. The platform depends only on
the flat addressing an overlay provides, not on any feature particular to either.

## Not included

A multi-server quorum topology is possible and is deliberately absent here. Quorum brings leader
election, split-brain recovery and coordinated rolling upgrades, and those presume
platform-engineering capacity the target setting does not have.

Nothing here provisions an HPC bridge, an admission engine, a policy engine or an audit ledger.
The manuscript records their absence as a design decision, and this repository holds that line.

## A note on JupyterHub

JupyterHub is installed separately during host provisioning rather than orchestrated by the
platform. The platform contributes the login only, so one credential admits a researcher to both
the command-line client and the notebook. The templates reflect that split.
